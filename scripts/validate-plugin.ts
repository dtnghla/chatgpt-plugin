import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

export interface Issue {
  code: string;
  message: string;
  file: string;
}

export interface ValidateOptions {
  release: boolean;
  repoRoot?: string;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

type Rec = Record<string, unknown>;
type ServerUrls = Map<string, string | undefined>;

interface Ctx {
  dir: string;
  release: boolean;
  repoRoot: string;
  errors: Issue[];
  warnings: Issue[];
  releaseGaps: string[];
}

interface Dims {
  width: number;
  height: number;
}

interface TextRule {
  code: string;
  max: number;
  oneLine: boolean;
  required: boolean;
  missingCode?: string;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_PLUGIN_DIR = path.join(DEFAULT_REPO_ROOT, "plugins", "time-zone-planner");
const SCHEMA_DIR = path.join(DEFAULT_REPO_ROOT, "schemas", "agent-plugins", "1.0.0");

const CATEGORIES = [
  "Productivity",
  "Creativity",
  "Developer Tools",
  "Business & Operations",
  "Data & Analytics",
  "Communication",
  "Education & Research",
  "Security",
  "Finance",
  "Healthcare",
  "Travel",
  "Entertainment",
  "Other",
];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_SIZE = 48;
const MAX_IMAGE_SIZE = 4096;
const UNSUPPORTED_TEXT = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECRET_NAME = /authorization|api[-_]?key|token|secret|password|cookie|credential/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const LISTING_URLS = [
  { key: "websiteURL", code: "plugin_website_url" },
  { key: "privacyPolicyURL", code: "plugin_privacy_policy_url" },
  { key: "termsOfServiceURL", code: "plugin_terms_of_service_url" },
  { key: "supportURL", code: "plugin_support_url" },
] as const;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function addIssue(list: Issue[], code: string, message: string, file: string): void {
  list.push({ code, message, file });
}

const fail = (ctx: Ctx, code: string, message: string, file: string): void =>
  addIssue(ctx.errors, code, message, file);
const warn = (ctx: Ctx, code: string, message: string, file: string): void =>
  addIssue(ctx.warnings, code, message, file);

function releaseGap(ctx: Ctx, code: string, message: string, file: string): void {
  if (ctx.release) fail(ctx, code, message, file);
  else ctx.releaseGaps.push(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (host.startsWith("[")) return /^\[(?:f[cd]|fe80)/.test(host);
  return !host.includes(".") || /\.(?:local|internal|lan|home|corp|test|invalid)$/.test(host);
}

function isPlaceholderHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return /(?:^|\.)example(?:\.|$)/.test(host) || /your[-_]?(?:domain|server|host)/.test(host);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const value = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

interface Validators {
  plugin: ValidateFunction;
  mcp: ValidateFunction;
}

let validatorsPromise: Promise<Validators> | undefined;

async function loadValidators(): Promise<Validators> {
  const read = async (name: string): Promise<object> =>
    JSON.parse(await readFile(path.join(SCHEMA_DIR, name), "utf8")) as object;
  const [pluginSchema, mcpSchema] = await Promise.all([
    read("plugin.schema.json"),
    read("mcp.schema.json"),
  ]);
  const ajv = new Ajv2020Module.default({ allErrors: true, strict: true });
  return { plugin: ajv.compile(pluginSchema), mcp: ajv.compile(mcpSchema) };
}

function getValidators(): Promise<Validators> {
  validatorsPromise ??= loadValidators();
  return validatorsPromise;
}

function describeSchemaError(error: ErrorObject): string {
  const location = error.instancePath || "/";
  const extra =
    error.keyword === "additionalProperties" ? ` "${error.params.additionalProperty}"` : "";
  return `${location} ${error.message ?? "is invalid"}${extra}`;
}

function runSchema(
  ctx: Ctx,
  validate: ValidateFunction,
  data: unknown,
  code: string,
  file: string,
) {
  if (validate(data)) return;
  const messages = new Set((validate.errors ?? []).map(describeSchemaError));
  for (const message of [...messages].slice(0, 10)) fail(ctx, code, message, file);
}

interface JsonCodes {
  missing: string;
  notFile: string;
  unreadable: string;
  malformed: string;
  notObject: string;
}

async function readJsonObject(
  ctx: Ctx,
  file: string,
  codes: JsonCodes,
  required: boolean,
): Promise<Rec | undefined> {
  const abs = path.join(ctx.dir, file);
  const info = await lstat(abs).catch(() => undefined);
  if (!info) {
    const report = required ? fail : warn;
    report(ctx, codes.missing, `${file} not found`, file);
    return undefined;
  }
  if (!info.isFile()) {
    fail(ctx, codes.notFile, `${file} must be a regular file`, file);
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(abs));
  } catch (error) {
    fail(
      ctx,
      codes.unreadable,
      `${file} must be readable UTF-8 text: ${describeError(error)}`,
      file,
    );
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRec(parsed)) return parsed;
    fail(ctx, codes.notObject, `${file} must contain a JSON object at the top level`, file);
  } catch (error) {
    fail(ctx, codes.malformed, `${file} is not valid JSON: ${describeError(error)}`, file);
  }
  return undefined;
}

function checkText(ctx: Ctx, file: string, value: unknown, rule: TextRule): string | undefined {
  const label = rule.code;
  if (value === undefined || value === null) {
    if (rule.required) {
      fail(ctx, rule.missingCode ?? `${label}_empty`, `${label} is required`, file);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    fail(ctx, `${label}_wrong_type`, `${label} must be a string`, file);
    return undefined;
  }
  if (value.trim() === "") {
    fail(ctx, `${label}_empty`, `${label} must not be empty`, file);
    return undefined;
  }
  if ([...value].length > rule.max) {
    fail(ctx, `${label}_too_long`, `${label} must be ${rule.max} characters or fewer`, file);
  }
  const checked = rule.oneLine ? value : value.replaceAll("\n", "");
  if (UNSUPPORTED_TEXT.test(checked)) {
    const detail = rule.oneLine
      ? "must be one line of supported text"
      : "contains unsupported characters";
    fail(ctx, `${label}_character_unsupported`, `${label} ${detail}`, file);
  }
  return value;
}

function checkListingUrl(ctx: Ctx, file: string, value: unknown, code: string, max: number): void {
  if (typeof value !== "string") {
    fail(ctx, `${code}_wrong_type`, `${code} must be a string`, file);
    return;
  }
  if (value.trim() === "") {
    fail(ctx, `${code}_empty`, `${code} must not be empty`, file);
    return;
  }
  if (value.length > max)
    fail(ctx, `${code}_too_long`, `${code} must be ${max} characters or fewer`, file);
  try {
    const url = new URL(value);
    const valid =
      url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
    if (!valid)
      fail(
        ctx,
        `${code}_format`,
        `${code} must be an https URL with a host and no credentials`,
        file,
      );
  } catch {
    fail(ctx, `${code}_format`, `${code} must be an https URL`, file);
  }
}

function checkIdentity(ctx: Ctx, manifest: Rec, file: string): void {
  const { name, version } = manifest;
  if (typeof name === "string") {
    if ([...name].length > 64)
      fail(ctx, "plugin_name_too_long", "name must be 64 characters or fewer", file);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      fail(
        ctx,
        "plugin_name_format",
        "name must start with an ASCII letter or digit and contain only ASCII letters, digits, _ or -",
        file,
      );
    }
  } else {
    fail(ctx, "plugin_name_missing", "name is required and must be a string", file);
  }
  if (typeof version !== "string" || version.trim() === "") {
    fail(ctx, "plugin_version_missing", "version is required and must be a non-empty string", file);
    return;
  }
  if (version.length > 64)
    fail(ctx, "plugin_version_too_long", "version must be 64 characters or fewer", file);
  if (!SEMVER.test(version)) {
    fail(ctx, "plugin_version_not_semver", `version "${version}" is not a semantic version`, file);
  }
}

function checkAuthor(ctx: Ctx, manifest: Rec, file: string): string | undefined {
  const { author } = manifest;
  if (author === undefined) {
    fail(ctx, "plugin_developer_missing", "author.name is required", file);
    return undefined;
  }
  if (!isRec(author)) {
    fail(ctx, "plugin_author_wrong_type", "author must be an object", file);
    return undefined;
  }
  if (author.url !== undefined) checkListingUrl(ctx, file, author.url, "plugin_author_url", 2048);
  return checkText(ctx, file, author.name, {
    code: "plugin_author_name",
    max: 120,
    oneLine: true,
    required: true,
    missingCode: "plugin_developer_missing",
  });
}

function checkTopLevel(ctx: Ctx, manifest: Rec, file: string): void {
  checkIdentity(ctx, manifest, file);
  checkText(ctx, file, manifest.description, {
    code: "plugin_description",
    max: 1024,
    oneLine: false,
    required: true,
    missingCode: "plugin_description_missing",
  });
  if (manifest.homepage !== undefined) {
    checkListingUrl(ctx, file, manifest.homepage, "plugin_homepage", 2048);
  }
}

function normalizePrompt(prompt: string): string {
  return prompt.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function checkPrompts(ctx: Ctx, iface: Rec, file: string): void {
  const raw = iface.defaultPrompt;
  if (raw === undefined) return;
  const prompts = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(prompts)) {
    fail(
      ctx,
      "plugin_default_prompt_wrong_type",
      "defaultPrompt must be a string or list of strings",
      file,
    );
    return;
  }
  if (prompts.length > 3) {
    fail(
      ctx,
      "plugin_default_prompt_too_many",
      "defaultPrompt must contain at most 3 prompts",
      file,
    );
  }
  const seen = new Set<string>();
  for (const prompt of prompts) {
    const text = checkText(ctx, file, prompt, {
      code: "plugin_default_prompt",
      max: 128,
      oneLine: true,
      required: true,
    });
    if (text === undefined) continue;
    if (text.includes("@")) {
      fail(
        ctx,
        "plugin_default_prompt_mention",
        `prompt "${text}" must not contain an @ mention`,
        file,
      );
    }
    const key = normalizePrompt(text);
    if (seen.has(key)) {
      fail(ctx, "plugin_default_prompt_duplicate", `prompt "${text}" is a duplicate`, file);
    }
    seen.add(key);
  }
}

function checkCapabilities(ctx: Ctx, iface: Rec, file: string): void {
  const { capabilities } = iface;
  if (capabilities === undefined) return;
  if (!Array.isArray(capabilities)) {
    fail(ctx, "plugin_capabilities_wrong_type", "capabilities must be a list of strings", file);
    return;
  }
  if (capabilities.length > 20) {
    fail(
      ctx,
      "plugin_capabilities_too_many",
      "capabilities must contain 20 entries or fewer",
      file,
    );
  }
  for (const capability of capabilities) {
    checkText(ctx, file, capability, {
      code: "plugin_capability",
      max: 120,
      oneLine: true,
      required: true,
    });
  }
}

function checkBrandColor(
  ctx: Ctx,
  iface: Rec,
  key: string,
  code: string,
  background: string,
  file: string,
): void {
  const value = iface[key];
  if (value === undefined) return;
  if (typeof value !== "string") {
    fail(ctx, `${code}_wrong_type`, `${key} must be a string`, file);
    return;
  }
  if (!HEX_COLOR.test(value)) {
    fail(ctx, `${code}_format`, `${key} must be a six-digit hex color such as #1ABCFE`, file);
    return;
  }
  const ratio = contrastRatio(value, background);
  if (ratio < 2) {
    fail(
      ctx,
      `${code}_contrast`,
      `${key} ${value} has contrast ${ratio.toFixed(2)}:1 against ${background}; at least 2:1 is required`,
      file,
    );
  }
}

function checkCategory(ctx: Ctx, iface: Rec, file: string): void {
  const { category } = iface;
  if (category === undefined) return;
  if (typeof category !== "string") {
    fail(ctx, "plugin_category_wrong_type", "category must be a string", file);
  } else if (!CATEGORIES.includes(category)) {
    fail(
      ctx,
      "plugin_category_unknown",
      `category "${category}" must be one of: ${CATEGORIES.join(", ")}`,
      file,
    );
  }
}

function checkListingUrls(ctx: Ctx, iface: Rec, file: string): void {
  for (const { key, code } of LISTING_URLS) {
    if (iface[key] === undefined) {
      releaseGap(
        ctx,
        `release_${code.replace("plugin_", "")}_missing`,
        `interface.${key} is missing`,
        file,
      );
    } else {
      checkListingUrl(ctx, file, iface[key], code, 1024);
    }
  }
}

function checkInterfaceText(ctx: Ctx, iface: Rec, file: string): void {
  const rules: [string, TextRule][] = [
    ["displayName", { code: "plugin_display_name", max: 30, oneLine: true, required: true }],
    [
      "shortDescription",
      {
        code: "plugin_short_description",
        max: 30,
        oneLine: true,
        required: true,
        missingCode: "plugin_short_description_missing",
      },
    ],
    [
      "longDescription",
      { code: "plugin_long_description", max: 4000, oneLine: false, required: true },
    ],
  ];
  for (const [key, rule] of rules) checkText(ctx, file, iface[key], rule);
}

function checkInterface(ctx: Ctx, iface: Rec, authorName: string | undefined, file: string): void {
  checkInterfaceText(ctx, iface, file);
  const developer = checkText(ctx, file, iface.developerName, {
    code: "plugin_developer_name",
    max: 80,
    oneLine: true,
    required: true,
  });
  if (developer !== undefined && authorName !== undefined && developer !== authorName) {
    fail(
      ctx,
      "developer_name_mismatch",
      `interface.developerName "${developer}" must equal author.name "${authorName}"`,
      file,
    );
  }
  checkCategory(ctx, iface, file);
  checkCapabilities(ctx, iface, file);
  checkPrompts(ctx, iface, file);
  checkBrandColor(ctx, iface, "brandColor", "plugin_brand_color", "#FFFFFF", file);
  checkBrandColor(ctx, iface, "brandColorDark", "plugin_brand_color_dark", "#212121", file);
  checkListingUrls(ctx, iface, file);
}

function readInterface(ctx: Ctx, manifest: Rec, file: string): Rec | undefined {
  const extensions = manifest.extensions;
  const openai = isRec(extensions) ? extensions["com.openai"] : undefined;
  if (!isRec(openai) || openai.interface === undefined) {
    fail(ctx, "plugin_interface_missing", 'extensions["com.openai"].interface is required', file);
    return undefined;
  }
  if (!isRec(openai.interface)) {
    fail(ctx, "plugin_interface_wrong_type", "interface must be a JSON object", file);
    return undefined;
  }
  return openai.interface;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface AssetFile {
  abs: string;
  ext: string;
}

async function resolveAsset(
  ctx: Ctx,
  field: string,
  value: unknown,
  file: string,
): Promise<AssetFile | undefined> {
  const problem = (code: string, message: string): undefined => {
    fail(ctx, code, `${field}: ${message}`, file);
    return undefined;
  };
  if (typeof value !== "string")
    return problem("declared_asset_path_wrong_type", "must be a file path string");
  if (value === "") return problem("declared_asset_path_empty", "must not be empty");
  if (value !== value.trim()) {
    return problem(
      "declared_asset_path_has_outer_whitespace",
      "must not begin or end with whitespace",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return problem(
      "declared_asset_path_has_control_character",
      "must not contain control characters",
    );
  }
  if (!value.startsWith("./"))
    return problem("branding_asset_path_missing_root_prefix", 'must start with "./"');
  const segments = value.split("/");
  if (value.includes("\\") || /^[A-Za-z]:/.test(value) || segments.includes("..")) {
    return problem(
      "declared_asset_path_unsafe",
      `"${value}" must be a relative path without ".." segments`,
    );
  }
  const abs = path.resolve(ctx.dir, value);
  const info = await lstat(abs).catch(() => undefined);
  if (!info) return problem("declared_asset_file_missing", `"${value}" does not exist`);
  const [realFile, realDir] = await Promise.all([realpath(abs), realpath(ctx.dir)]);
  if (!isInside(realDir, realFile)) {
    return problem("declared_asset_path_outside_package", `"${value}" resolves outside the plugin`);
  }
  if (!(await stat(abs)).isFile()) {
    return problem("declared_asset_not_regular_file", `"${value}" must be a regular file`);
  }
  return { abs, ext: path.extname(value).toLowerCase() };
}

function readPngSize(buf: Buffer): Dims | undefined {
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegSize(buf: Buffer): Dims | undefined {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return undefined;
    const marker = buf[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame)
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return undefined;
}

function readWebpSize(buf: Buffer): Dims | undefined {
  if (buf.length < 30) return undefined;
  const kind = buf.toString("latin1", 12, 16);
  if (kind === "VP8X") {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (kind === "VP8L" && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 " && buf.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

type RasterFormat = "png" | "jpeg" | "webp";

function detectRaster(buf: Buffer): RasterFormat | undefined {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP")
    return "webp";
  return undefined;
}

const RASTER_EXTENSIONS: Record<string, RasterFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};

function readRasterSize(buf: Buffer, format: RasterFormat): Dims | undefined {
  try {
    if (format === "png") return readPngSize(buf);
    if (format === "jpeg") return readJpegSize(buf);
    return readWebpSize(buf);
  } catch {
    return undefined;
  }
}

function checkDimensions(
  ctx: Ctx,
  prefix: "raster_image" | "svg",
  field: string,
  dims: Dims,
  square: boolean,
  file: string,
): void {
  const { width, height } = dims;
  const label = `${field} (${width}x${height})`;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
    fail(ctx, `${prefix}_dimensions_not_positive`, `${label} must have positive dimensions`, file);
    return;
  }
  if (square && width !== height)
    fail(
      ctx,
      prefix === "svg" ? "svg_dimensions_not_square" : "raster_image_not_square",
      `${label} must be square`,
      file,
    );
  const tooSmall = Math.min(width, height) < MIN_IMAGE_SIZE;
  if (tooSmall) {
    const code = `${prefix}_dimensions_too_small`;
    fail(ctx, code, `${label} must be at least ${MIN_IMAGE_SIZE}x${MIN_IMAGE_SIZE}`, file);
  }
  if (prefix === "raster_image" && Math.max(width, height) > MAX_IMAGE_SIZE) {
    fail(
      ctx,
      "raster_image_dimensions_too_large",
      `${label} must not exceed ${MAX_IMAGE_SIZE}x${MAX_IMAGE_SIZE}`,
      file,
    );
  }
}

interface SvgElement {
  name: string;
  attrs: Map<string, string>;
}

interface SvgParse {
  root?: SvgElement;
  elements: SvgElement[];
  error?: string;
}

const TAG_OPEN =
  /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/;
const TAG_CLOSE = /^<\/([A-Za-z_][\w.:-]*)\s*>/;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

function parseAttributes(source: string): Map<string, string> | undefined {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1] ?? "";
    if (attrs.has(name)) return undefined;
    attrs.set(name, match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function skipPast(text: string, pos: number, end: string): number {
  const index = text.indexOf(end, pos);
  return index === -1 ? -1 : index + end.length;
}

function parseSvg(text: string): SvgParse {
  const result: SvgParse = { elements: [] };
  const stack: string[] = [];
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const bad = (message: string): SvgParse => ({ ...result, error: message });
  while (pos < text.length) {
    if (text[pos] !== "<") {
      const next = text.indexOf("<", pos);
      const chunk = text.slice(pos, next === -1 ? text.length : next);
      if (stack.length === 0 && chunk.trim() !== "") return bad("text outside the root element");
      pos = next === -1 ? text.length : next;
      continue;
    }
    const rest = text.slice(pos);
    if (rest.startsWith("<!--")) {
      pos = skipPast(text, pos + 4, "-->");
    } else if (rest.startsWith("<![CDATA[")) {
      pos = skipPast(text, pos + 9, "]]>");
    } else if (rest.startsWith("<?")) {
      pos = skipPast(text, pos + 2, "?>");
    } else if (rest.startsWith("<!")) {
      return bad("DOCTYPE and entity declarations are not allowed");
    } else if (rest.startsWith("</")) {
      const close = TAG_CLOSE.exec(rest);
      if (!close || stack.pop() !== close[1]) return bad("mismatched closing tag");
      pos += close[0].length;
    } else {
      const open = TAG_OPEN.exec(rest);
      const attrs = open ? parseAttributes(open[2] ?? "") : undefined;
      if (!open || !attrs) return bad("malformed start tag");
      if (stack.length === 0 && result.root) return bad("multiple root elements");
      const element = { name: open[1] ?? "", attrs };
      result.root ??= element;
      result.elements.push(element);
      if (open[3] !== "/") stack.push(element.name);
      pos += open[0].length;
    }
    if (pos === -1) return bad("unterminated comment, CDATA section or processing instruction");
  }
  if (stack.length > 0) return bad("unclosed element");
  return result.root ? result : bad("no root element");
}

function svgNumber(value: string | undefined): number | undefined {
  return value !== undefined && NUMBER.test(value.trim()) ? Number(value) : undefined;
}

function svgDimensionSets(root: SvgElement): Dims[] | string {
  const sets: Dims[] = [];
  const viewBox = root.attrs.get("viewBox");
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/);
    const numbers = parts.map(svgNumber);
    const [, , width, height] = numbers;
    if (numbers.length !== 4 || width === undefined || height === undefined)
      return "svg_dimensions_not_numeric";
    sets.push({ width, height });
  }
  const [widthAttr, heightAttr] = [root.attrs.get("width"), root.attrs.get("height")];
  if (widthAttr !== undefined || heightAttr !== undefined) {
    const width = svgNumber(widthAttr);
    const height = svgNumber(heightAttr);
    if (width === undefined || height === undefined) return "svg_dimensions_not_numeric";
    sets.push({ width, height });
  }
  return sets.length > 0 ? sets : "svg_dimensions_missing";
}

function checkSvgSafety(ctx: Ctx, svg: SvgParse, text: string, field: string, file: string): void {
  const banned = ["script", "foreignobject", "iframe", "object", "embed"];
  for (const element of svg.elements) {
    const local = element.name.toLowerCase().split(":").pop() ?? "";
    if (banned.includes(local)) {
      fail(
        ctx,
        "svg_unsafe_content",
        `${field}: <${element.name}> is not allowed in SVG assets`,
        file,
      );
    }
    for (const [name, value] of element.attrs) {
      if (/^on/i.test(name))
        fail(ctx, "svg_unsafe_content", `${field}: event handler "${name}" is not allowed`, file);
      if (/(?:^|:)href$/i.test(name) && !value.startsWith("#")) {
        fail(
          ctx,
          "svg_external_reference",
          `${field}: external reference "${value}" is not allowed`,
          file,
        );
      }
    }
  }
  if (/url\(\s*['"]?(?!#)/i.test(text) || /@import/i.test(text)) {
    fail(
      ctx,
      "svg_external_reference",
      `${field}: external url()/@import references are not allowed`,
      file,
    );
  }
}

async function checkSvg(
  ctx: Ctx,
  field: string,
  abs: string,
  square: boolean,
  file: string,
): Promise<void> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(abs));
  } catch {
    fail(ctx, "svg_xml_malformed", `${field}: SVG must be valid UTF-8`, file);
    return;
  }
  const svg = parseSvg(text);
  if (svg.error || !svg.root) {
    fail(ctx, "svg_xml_malformed", `${field}: SVG is not well-formed XML (${svg.error})`, file);
    return;
  }
  if (svg.root.name !== "svg") {
    fail(
      ctx,
      "svg_root_element_invalid",
      `${field}: root element must be <svg>, found <${svg.root.name}>`,
      file,
    );
    return;
  }
  if (!svg.root.attrs.has("xmlns"))
    warn(ctx, "svg_namespace_missing", `${field}: root <svg> has no xmlns`, file);
  checkSvgSafety(ctx, svg, text, field, file);
  const sets = svgDimensionSets(svg.root);
  if (typeof sets === "string") {
    fail(
      ctx,
      sets,
      `${field}: SVG must define numeric viewBox or numeric width and height without units`,
      file,
    );
    return;
  }
  for (const dims of sets) checkDimensions(ctx, "svg", field, dims, square, file);
}

async function checkRaster(
  ctx: Ctx,
  field: string,
  abs: string,
  ext: string,
  square: boolean,
  file: string,
): Promise<Dims | undefined> {
  const buf = await readFile(abs);
  const format = detectRaster(buf);
  const dims = format ? readRasterSize(buf, format) : undefined;
  if (!format || !dims) {
    fail(
      ctx,
      "raster_image_decode_failed",
      `${field}: could not read a PNG, JPEG or WebP header`,
      file,
    );
    return undefined;
  }
  if (RASTER_EXTENSIONS[ext] !== format) {
    fail(
      ctx,
      "raster_image_extension_content_mismatch",
      `${field}: ${ext} file contains ${format} data`,
      file,
    );
  }
  checkDimensions(ctx, "raster_image", field, dims, square, file);
  return dims;
}

async function checkImage(
  ctx: Ctx,
  field: string,
  value: unknown,
  opts: { square: boolean },
  file: string,
): Promise<Dims | undefined> {
  const asset = await resolveAsset(ctx, field, value, file);
  if (!asset) return undefined;
  if (!IMAGE_EXTENSIONS.includes(asset.ext)) {
    fail(
      ctx,
      "image_file_format_unsupported",
      `${field}: extension must be one of ${IMAGE_EXTENSIONS.join(", ")}`,
      file,
    );
    return undefined;
  }
  const info = await stat(asset.abs);
  if (info.size > MAX_IMAGE_BYTES) {
    fail(ctx, "image_file_too_large", `${field}: image must not exceed 5 MiB`, file);
    return undefined;
  }
  if (asset.ext === ".svg") {
    await checkSvg(ctx, field, asset.abs, opts.square, file);
    return undefined;
  }
  return checkRaster(ctx, field, asset.abs, asset.ext, opts.square, file);
}

async function checkRequiredImage(
  ctx: Ctx,
  iface: Rec,
  key: "logo" | "composerIcon",
  missingCode: string,
  file: string,
): Promise<void> {
  if (iface[key] === undefined) {
    fail(ctx, missingCode, `interface.${key} is required and must reference a square image`, file);
    return;
  }
  await checkImage(ctx, `interface.${key}`, iface[key], { square: true }, file);
}

async function checkScreenshots(ctx: Ctx, iface: Rec, file: string): Promise<void> {
  const { screenshots } = iface;
  if (screenshots === undefined) return;
  warn(
    ctx,
    "screenshots_custom_ui_only",
    "screenshots are only allowed for plugins with custom UI; provide one PNG or JPEG per starter prompt, 706px wide and 400-860px tall",
    file,
  );
  if (!Array.isArray(screenshots)) {
    fail(
      ctx,
      "declared_asset_path_wrong_type",
      "interface.screenshots must be a list of file paths",
      file,
    );
    return;
  }
  for (const [index, shot] of screenshots.entries()) {
    const field = `interface.screenshots[${index}]`;
    const dims = await checkImage(ctx, field, shot, { square: false }, file);
    if (dims && (dims.width !== 706 || dims.height < 400 || dims.height > 860)) {
      warn(
        ctx,
        "screenshot_dimensions",
        `${field} is ${dims.width}x${dims.height}; expected 706 wide and 400-860 tall`,
        file,
      );
    }
  }
}

function checkMcpUrl(ctx: Ctx, server: string, value: string, file: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(ctx, "mcp_url_invalid", `server "${server}": "${value}" is not a valid URL`, file);
    return;
  }
  const loopback = isLoopbackHost(url.hostname);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!secure) {
    fail(
      ctx,
      "mcp_url_insecure",
      `server "${server}": URL must be https (http only for loopback hosts)`,
      file,
    );
  }
  if (url.username || url.password) {
    fail(ctx, "mcp_url_credentials", `server "${server}": URL must not contain credentials`, file);
  }
  if (url.hash || value.includes("#")) {
    fail(ctx, "mcp_url_fragment", `server "${server}": URL must not contain a fragment`, file);
  }
  const reason = publicUrlProblem(url);
  if (reason) {
    releaseGap(ctx, "release_mcp_url_not_public", `server "${server}": ${reason}`, file);
  }
}

function publicUrlProblem(url: URL): string | undefined {
  if (isLoopbackHost(url.hostname))
    return `release requires a public host, found loopback "${url.host}"`;
  if (isPrivateHost(url.hostname))
    return `release requires a public host, found private-looking "${url.host}"`;
  if (isPlaceholderHost(url.hostname))
    return `release requires a real host, found placeholder "${url.host}"`;
  if (url.protocol !== "https:")
    return `release requires an https URL, found ${url.protocol}//${url.host}`;
  return undefined;
}

function checkSecretNames(
  ctx: Ctx,
  server: string,
  label: string,
  values: unknown,
  file: string,
): void {
  if (!isRec(values)) return;
  for (const name of Object.keys(values)) {
    if (SECRET_NAME.test(name)) {
      fail(
        ctx,
        "mcp_secret_in_config",
        `server "${server}": ${label} "${name}" looks like a secret; do not ship secrets in mcp.json`,
        file,
      );
    }
  }
}

function checkMcpServers(ctx: Ctx, mcp: Rec, file: string): ServerUrls {
  const urls: ServerUrls = new Map();
  if (!isRec(mcp.mcpServers)) return urls;
  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (name.trim() === "")
      fail(ctx, "mcp_server_name_empty", "MCP server names must not be blank", file);
    if (!isRec(server)) {
      fail(ctx, "mcp_server_wrong_type", `server "${name}" must be an object`, file);
      continue;
    }
    const url = typeof server.url === "string" ? server.url : undefined;
    urls.set(name, url);
    if (url !== undefined) checkMcpUrl(ctx, name, url, file);
    checkSecretNames(ctx, name, "header", server.headers, file);
    checkSecretNames(ctx, name, "env var", server.env, file);
  }
  return urls;
}

function schemaVersion(schemaUrl: unknown): string | undefined {
  return typeof schemaUrl === "string" ? /\/schemas\/([^/]+)\//.exec(schemaUrl)?.[1] : undefined;
}

async function checkMcp(ctx: Ctx, manifest: Rec | undefined): Promise<ServerUrls> {
  const file = "mcp.json";
  const mcp = await readJsonObject(
    ctx,
    file,
    {
      missing: "mcp_manifest_missing",
      notFile: "mcp_manifest_not_file",
      unreadable: "mcp_manifest_unreadable",
      malformed: "mcp_manifest_json_malformed",
      notObject: "mcp_manifest_wrong_type",
    },
    false,
  );
  if (!mcp) return new Map();
  const { mcp: validate } = await getValidators();
  runSchema(ctx, validate, mcp, "mcp_schema_invalid", file);
  const [pluginVersion, mcpVersion] = [
    schemaVersion(manifest?.$schema),
    schemaVersion(mcp.$schema),
  ];
  if (pluginVersion !== mcpVersion) {
    fail(
      ctx,
      "schema_version_mismatch",
      `mcp.json $schema version (${mcpVersion ?? "none"}) must equal plugin.json $schema version (${pluginVersion ?? "none"})`,
      file,
    );
  }
  return checkMcpServers(ctx, mcp, file);
}

async function checkPackageVersion(ctx: Ctx, manifest: Rec): Promise<void> {
  if (!isInside(ctx.repoRoot, ctx.dir)) return;
  const raw = await readFile(path.join(ctx.repoRoot, "package.json"), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return;
  try {
    const pkg: unknown = JSON.parse(raw);
    const version = isRec(pkg) ? pkg.version : undefined;
    if (
      typeof version === "string" &&
      typeof manifest.version === "string" &&
      version !== manifest.version
    ) {
      fail(
        ctx,
        "version_mismatch",
        `plugin.json version ${manifest.version} differs from package.json version ${version}`,
        "plugin.json",
      );
    }
  } catch {
    warn(
      ctx,
      "package_json_unreadable",
      "package.json could not be parsed; skipped version comparison",
      "package.json",
    );
  }
}

interface Frontmatter {
  data: unknown;
  body: string;
}

function splitFrontmatter(ctx: Ctx, text: string, file: string): Frontmatter | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    fail(
      ctx,
      "skill_frontmatter_missing",
      "SKILL.md must start with YAML front matter between --- lines",
      file,
    );
    return undefined;
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) {
    fail(ctx, "skill_frontmatter_unclosed", "SKILL.md front matter must end with ---", file);
    return undefined;
  }
  try {
    const data: unknown = parseYaml(lines.slice(1, end).join("\n"));
    return { data, body: lines.slice(end + 1).join("\n") };
  } catch (error) {
    fail(
      ctx,
      "skill_frontmatter_yaml_malformed",
      `front matter is not valid YAML: ${describeError(error)}`,
      file,
    );
    return undefined;
  }
}

function checkSkillName(ctx: Ctx, front: Rec, dirName: string, file: string): string | undefined {
  const name = checkText(ctx, file, front.name, {
    code: "skill_name",
    max: 64,
    oneLine: true,
    required: true,
    missingCode: "skill_name_missing",
  });
  if (name === undefined) return undefined;
  if (!SKILL_NAME.test(name)) {
    fail(
      ctx,
      "skill_name_format",
      `name "${name}" must use lowercase letters, digits and single hyphens`,
      file,
    );
  }
  if (name !== dirName) {
    fail(
      ctx,
      "skill_name_dir_mismatch",
      `name "${name}" must equal its directory name "${dirName}"`,
      file,
    );
  }
  return name;
}

async function readUtf8(abs: string): Promise<string | undefined> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(abs));
  } catch {
    return undefined;
  }
}

async function checkSkillManifest(
  ctx: Ctx,
  pluginName: string,
  dirName: string,
  seen: Set<string>,
): Promise<void> {
  const file = `skills/${dirName}/SKILL.md`;
  const abs = path.join(ctx.dir, file);
  const info = await lstat(abs).catch(() => undefined);
  if (!info) {
    fail(ctx, "skill_manifest_missing", `skill "${dirName}" must contain SKILL.md`, file);
    return;
  }
  if (!info.isFile()) {
    fail(ctx, "skill_manifest_not_regular_file", "SKILL.md must be a regular file", file);
    return;
  }
  const text = await readUtf8(abs);
  if (text === undefined) {
    fail(ctx, "skill_manifest_invalid_utf8", "SKILL.md must be valid UTF-8", file);
    return;
  }
  const parsed = splitFrontmatter(ctx, text, file);
  if (!parsed) return;
  if (!isRec(parsed.data)) {
    fail(ctx, "skill_frontmatter_wrong_type", "front matter must be a YAML mapping", file);
    return;
  }
  const name = checkSkillName(ctx, parsed.data, dirName, file);
  checkText(ctx, file, parsed.data.description, {
    code: "skill_description",
    max: 1024,
    oneLine: false,
    required: true,
    missingCode: "skill_description_missing",
  });
  if (parsed.body.trim() === "")
    fail(ctx, "skill_body_empty", "SKILL.md instructions must not be empty", file);
  if (name === undefined) return;
  if (`${pluginName}:${name}`.length > 64) {
    fail(
      ctx,
      "skill_identity_too_long",
      `"${pluginName}:${name}" must be 64 characters or fewer`,
      file,
    );
  }
  if (seen.has(name))
    fail(ctx, "skill_identity_duplicate", `skill name "${name}" is not unique`, file);
  seen.add(name);
}

async function checkAgentIcon(
  ctx: Ctx,
  skillDir: string,
  key: string,
  value: unknown,
  file: string,
): Promise<void> {
  const code = `skill_agent_${key}`;
  if (typeof value !== "string") {
    fail(ctx, `${code}_wrong_type`, `interface.${key} must be a string`, file);
    return;
  }
  if (value.trim() === "") {
    fail(ctx, `${code}_empty`, `interface.${key} must not be empty`, file);
    return;
  }
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    fail(
      ctx,
      "declared_asset_path_unsafe",
      `interface.${key} must be relative without ".." segments`,
      file,
    );
    return;
  }
  const info = await stat(path.join(skillDir, value)).catch((): Stats | undefined => undefined);
  if (!info?.isFile()) {
    fail(ctx, "declared_asset_file_missing", `interface.${key} "${value}" does not exist`, file);
  }
}

async function checkAgentInterface(
  ctx: Ctx,
  skillDir: string,
  agent: Rec,
  file: string,
): Promise<void> {
  const iface = agent.interface;
  if (iface === undefined) {
    fail(ctx, "skill_agent_interface_missing", "interface is required", file);
    return;
  }
  if (!isRec(iface)) {
    fail(ctx, "skill_agent_interface_wrong_type", "interface must be a mapping", file);
    return;
  }
  for (const key of ["display_name", "short_description"]) {
    checkText(ctx, file, iface[key], {
      code: `skill_agent_${key}`,
      max: 1024,
      oneLine: true,
      required: true,
      missingCode: `skill_agent_${key}_missing`,
    });
  }
  for (const key of ["icon_small", "icon_large"]) {
    if (iface[key] !== undefined) await checkAgentIcon(ctx, skillDir, key, iface[key], file);
  }
  if (
    iface.brand_color !== undefined &&
    !(typeof iface.brand_color === "string" && HEX_COLOR.test(iface.brand_color))
  ) {
    fail(
      ctx,
      "skill_agent_brand_color_format",
      "interface.brand_color must be a six-digit hex color",
      file,
    );
  }
  if (iface.default_prompt !== undefined) {
    checkText(ctx, file, iface.default_prompt, {
      code: "skill_agent_default_prompt",
      max: 1024,
      oneLine: true,
      required: false,
    });
  }
}

function checkAgentPolicy(ctx: Ctx, agent: Rec, file: string): void {
  const { policy } = agent;
  if (policy === undefined) return;
  if (!isRec(policy)) {
    fail(ctx, "skill_agent_policy_wrong_type", "policy must be a mapping", file);
    return;
  }
  const { products, allow_implicit_invocation: implicit } = policy;
  const unknownKeys = Object.keys(policy).filter(
    (key) => key !== "products" && key !== "allow_implicit_invocation",
  );
  const badProducts =
    products !== undefined &&
    !(Array.isArray(products) && products.every((item) => item === "CHAT" || item === "CODEX"));
  if (
    unknownKeys.length > 0 ||
    badProducts ||
    (implicit !== undefined && typeof implicit !== "boolean")
  ) {
    fail(
      ctx,
      "skill_agent_allow_implicit_invocation_wrong_type",
      "policy may contain only products (CHAT, CODEX) and boolean allow_implicit_invocation",
      file,
    );
  }
}

function checkMcpDependency(ctx: Ctx, tool: Rec, servers: ServerUrls, file: string): void {
  const { value, url } = tool;
  if (typeof value !== "string" || !servers.has(value)) {
    fail(
      ctx,
      "mcp_dependency_unknown_server",
      `MCP dependency "${String(value)}" has no matching server in mcp.json`,
      file,
    );
    return;
  }
  const expected = servers.get(value);
  if (url !== undefined && url !== expected) {
    fail(
      ctx,
      "mcp_url_mismatch",
      `dependency url "${String(url)}" differs from mcp.json url "${expected}"`,
      file,
    );
  }
}

function checkAgentDependencies(ctx: Ctx, agent: Rec, servers: ServerUrls, file: string): void {
  const { dependencies } = agent;
  if (dependencies === undefined) return;
  if (!isRec(dependencies)) {
    fail(ctx, "skill_agent_dependencies_wrong_type", "dependencies must be a mapping", file);
    return;
  }
  if (Object.keys(dependencies).some((key) => key !== "tools")) {
    fail(ctx, "skill_agent_dependency_unsupported", "only dependencies.tools is supported", file);
  }
  const { tools } = dependencies;
  if (tools === undefined) return;
  if (!Array.isArray(tools)) {
    fail(ctx, "skill_agent_dependencies_wrong_type", "dependencies.tools must be a list", file);
    return;
  }
  for (const tool of tools) {
    if (isRec(tool) && tool.type === "mcp") checkMcpDependency(ctx, tool, servers, file);
  }
}

async function checkAgentYaml(ctx: Ctx, dirName: string, servers: ServerUrls): Promise<void> {
  const file = `skills/${dirName}/agents/openai.yaml`;
  const abs = path.join(ctx.dir, file);
  const info = await lstat(abs).catch(() => undefined);
  if (!info) return;
  if (!info.isFile()) {
    fail(ctx, "skill_agent_not_regular_file", "agents/openai.yaml must be a regular file", file);
    return;
  }
  const text = await readUtf8(abs);
  if (text === undefined) {
    fail(ctx, "skill_agent_invalid_utf8", "agents/openai.yaml must be valid UTF-8", file);
    return;
  }
  let agent: unknown;
  try {
    agent = parseYaml(text);
  } catch (error) {
    fail(ctx, "skill_agent_yaml_malformed", `not valid YAML: ${describeError(error)}`, file);
    return;
  }
  if (!isRec(agent)) {
    fail(
      ctx,
      "skill_agent_top_level_wrong_type",
      "agents/openai.yaml must be a YAML mapping",
      file,
    );
    return;
  }
  await checkAgentInterface(ctx, path.join(ctx.dir, "skills", dirName), agent, file);
  checkAgentPolicy(ctx, agent, file);
  checkAgentDependencies(ctx, agent, servers, file);
}

async function checkSkills(ctx: Ctx, pluginName: string, servers: ServerUrls): Promise<void> {
  const entries = await readdir(path.join(ctx.dir, "skills"), { withFileTypes: true }).catch(
    () => undefined,
  );
  if (!entries) {
    fail(
      ctx,
      "skills_directory_missing",
      "skills/ directory with at least one skill is required",
      "skills",
    );
    return;
  }
  const seen = new Set<string>();
  let skillCount = 0;
  for (const entry of entries) {
    const file = `skills/${entry.name}`;
    if (entry.isSymbolicLink()) {
      warn(ctx, "skill_symlink_ignored", `${file} is a symbolic link and is not imported`, file);
    } else if (!entry.isDirectory()) {
      warn(
        ctx,
        "skill_file_ignored",
        `${file} is not inside a skill directory and is not imported`,
        file,
      );
    } else if (entry.name.startsWith(".")) {
      fail(ctx, "skill_directory_hidden", "skill directory names must not begin with .", file);
    } else {
      skillCount += 1;
      await checkSkillManifest(ctx, pluginName, entry.name, seen);
      await checkAgentYaml(ctx, entry.name, servers);
    }
  }
  if (skillCount === 0)
    fail(
      ctx,
      "skills_directory_empty",
      "skills/ must contain at least one skill directory",
      "skills",
    );
}

async function checkManifest(ctx: Ctx, manifest: Rec): Promise<void> {
  const file = "plugin.json";
  const { plugin } = await getValidators();
  runSchema(ctx, plugin, manifest, "plugin_schema_invalid", file);
  checkTopLevel(ctx, manifest, file);
  const authorName = checkAuthor(ctx, manifest, file);
  const iface = readInterface(ctx, manifest, file);
  if (iface) {
    checkInterface(ctx, iface, authorName, file);
    await checkRequiredImage(ctx, iface, "logo", "plugin_logo_path_missing", file);
    await checkRequiredImage(ctx, iface, "composerIcon", "plugin_composer_icon_path_missing", file);
    await checkScreenshots(ctx, iface, file);
  }
  await checkPackageVersion(ctx, manifest);
}

export async function validatePlugin(
  pluginDir: string,
  opts: ValidateOptions,
): Promise<ValidationResult> {
  const ctx: Ctx = {
    dir: path.resolve(pluginDir),
    release: opts.release,
    repoRoot: path.resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT),
    errors: [],
    warnings: [],
    releaseGaps: [],
  };
  const manifest = await readJsonObject(
    ctx,
    "plugin.json",
    {
      missing: "plugin_manifest_missing",
      notFile: "plugin_manifest_not_file",
      unreadable: "plugin_manifest_unreadable",
      malformed: "plugin_manifest_json_malformed",
      notObject: "plugin_manifest_root_not_object",
    },
    true,
  );
  if (manifest) await checkManifest(ctx, manifest);
  const servers = await checkMcp(ctx, manifest);
  const pluginName = typeof manifest?.name === "string" ? manifest.name : "";
  await checkSkills(ctx, pluginName, servers);
  if (ctx.releaseGaps.length > 0) {
    const summary = ctx.releaseGaps.join("; ");
    warn(
      ctx,
      "release_not_ready",
      `release mode (--release) would still fail: ${summary}`,
      "plugin.json",
    );
  }
  return { errors: ctx.errors, warnings: ctx.warnings };
}

function formatIssue(level: "ERROR" | "WARN", issue: Issue): string {
  return `${level} ${issue.code}: ${issue.message} (${issue.file})`;
}

async function main(argv: string[]): Promise<number> {
  const release = argv.includes("--release");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = argv.filter((arg) => arg.startsWith("--") && arg !== "--release");
  if (unknown.length > 0 || positional.length > 1) {
    console.error("Usage: tsx scripts/validate-plugin.ts [--release] [path-to-plugin-dir]");
    return 1;
  }
  const dir = positional[0] ? path.resolve(positional[0]) : DEFAULT_PLUGIN_DIR;
  const { errors, warnings } = await validatePlugin(dir, { release });
  for (const issue of errors) console.log(formatIssue("ERROR", issue));
  for (const issue of warnings) console.log(formatIssue("WARN", issue));
  const mode = release ? "release" : "package";
  const summary = `${errors.length} error(s), ${warnings.length} warning(s)`;
  console.log(
    errors.length === 0
      ? `Plugin validation passed (${mode} mode): ${summary}`
      : `Plugin validation FAILED (${mode} mode): ${summary}`,
  );
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
