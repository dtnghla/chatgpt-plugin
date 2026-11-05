import { randomBytes } from "node:crypto";

export type ArtifactStoreKind = "memory" | "s3";
export type LicenseMode = "off" | "enforced";

export interface Config {
  port: number;
  host: string;
  /** Hostnames (port-agnostic, IPv6 in brackets) accepted in the Host header of /mcp requests. */
  allowedHosts: string[];
  /** Token served at /.well-known/openai-apps-challenge for OpenAI domain verification. */
  challengeToken: string | undefined;
  /** Hostnames from which uploaded project files may be downloaded. */
  fileHostAllowlist: string[];
  /** Dedicated origin advertised to ChatGPT for the MCP Apps widget. */
  widgetDomain: string | undefined;
  /** Where generated bundles are kept between tool calls. */
  artifactStore: ArtifactStoreKind;
  artifactBucket: string | undefined;
  awsRegion: string;
  artifactSigningSecret: string;
  /** Public origin used in artifact download links. */
  publicBaseUrl: string | undefined;
  artifactTtlSeconds: number;
  /** Monetization: off keeps every tool unlimited; enforced activates free-tier gates. */
  licenseMode: LicenseMode;
  licenseSigningSecret: string | undefined;
  /** Purchase page shown in free-tier upgrade messages, e.g. a Stripe payment link. */
  upgradeUrl: string | undefined;
  freeMaxFiles: number;
  freeMaxSteps: number;
  freeDailyBundles: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const HOSTNAME_PATTERN = /^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/;
const CHALLENGE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,256}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got "${raw}".`);
  }
  return port;
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const hosts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  for (const host of hosts) {
    if (!HOSTNAME_PATTERN.test(host)) {
      throw new ConfigError(
        `ALLOWED_HOSTS entry "${host}" is not a bare hostname. Use e.g. "mcp.example.org" (no scheme, port or path).`,
      );
    }
  }
  return [...new Set(hosts)];
}

function parseChallengeToken(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  if (token === undefined || token === "") return undefined;
  if (!CHALLENGE_TOKEN_PATTERN.test(token)) {
    throw new ConfigError(
      "OPENAI_APPS_CHALLENGE_TOKEN must be 8-256 characters of letters, digits, '.', '_', '~' or '-'.",
    );
  }
  return token;
}

function parseFileHosts(raw: string | undefined): string[] {
  const hosts = (raw === undefined ? "oaiusercontent.com,openai.com" : raw)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  for (const host of hosts) {
    if (!HOSTNAME_PATTERN.test(host) || host.startsWith("[")) {
      throw new ConfigError(
        `FILE_HOST_ALLOWLIST entry "${host}" must be a bare DNS hostname such as "oaiusercontent.com".`,
      );
    }
    if (isLoopbackHost(host) || host === "0.0.0.0") {
      throw new ConfigError(`FILE_HOST_ALLOWLIST must not contain the loopback host "${host}".`);
    }
  }
  if (hosts.length === 0) {
    throw new ConfigError("FILE_HOST_ALLOWLIST must contain at least one hostname.");
  }
  return [...new Set(hosts)];
}

function parseOrigin(raw: string | undefined, name: string): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute https URL.`);
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError(`${name} must use https (http is only allowed for loopback hosts).`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} must not contain credentials, a query string or a fragment.`);
  }
  return url.origin;
}

function parseArtifactStore(raw: string | undefined): ArtifactStoreKind {
  const value = (raw ?? "memory").trim().toLowerCase();
  if (value !== "memory" && value !== "s3") {
    throw new ConfigError('ARTIFACT_STORE must be "memory" or "s3".');
  }
  return value;
}

function parseBucket(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  if (!BUCKET_PATTERN.test(value) || value.includes("..")) {
    throw new ConfigError(`ARTIFACT_BUCKET "${value}" is not a valid S3 bucket name.`);
  }
  return value;
}

function parseRegion(raw: string | undefined): string {
  const value = (raw ?? "us-east-1").trim();
  if (!REGION_PATTERN.test(value)) {
    throw new ConfigError(`AWS_REGION "${value}" is not a valid AWS region.`);
  }
  return value;
}

function parseTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 900;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
    throw new ConfigError("ARTIFACT_TTL_SECONDS must be an integer between 60 and 86400.");
  }
  return seconds;
}

function parseLicenseMode(raw: string | undefined): LicenseMode {
  const value = (raw ?? "off").trim().toLowerCase();
  if (value !== "off" && value !== "enforced") {
    throw new ConfigError('LICENSE_MODE must be "off" or "enforced".');
  }
  return value;
}

function parseSigningSecret(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  if (value.length < 16) {
    throw new ConfigError("LICENSE_SIGNING_SECRET must be at least 16 characters.");
  }
  return value;
}

/** Absolute HTTPS link (path and query allowed, no credentials or fragment) shown to users. */
function parseUpgradeUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("UPGRADE_URL must be an absolute https URL.");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError("UPGRADE_URL must use https (http is only allowed for loopback hosts).");
  }
  if (url.username || url.password || url.hash) {
    throw new ConfigError("UPGRADE_URL must not contain credentials or a fragment.");
  }
  return url.href;
}

function parseIntInRange(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = parsePort(env.PORT);
  const configuredHosts = parseAllowedHosts(env.ALLOWED_HOSTS);
  const loopback = isLoopbackHost(host);

  if (!loopback && configuredHosts.length === 0) {
    throw new ConfigError(
      `HOST is "${host}", which is reachable from other machines. Set ALLOWED_HOSTS to the public hostname(s) of this server (comma-separated, e.g. ALLOWED_HOSTS=mcp.example.org) so Host header validation can protect it.`,
    );
  }

  const allowedHosts = loopback
    ? [...new Set([...LOOPBACK_HOSTNAMES, ...configuredHosts])]
    : configuredHosts;

  const artifactStore = parseArtifactStore(env.ARTIFACT_STORE);
  const artifactBucket = parseBucket(env.ARTIFACT_BUCKET);
  if (artifactStore === "s3" && artifactBucket === undefined) {
    throw new ConfigError("ARTIFACT_BUCKET is required when ARTIFACT_STORE=s3.");
  }

  const publicBaseUrl = parseOrigin(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  const widgetDomain = parseOrigin(env.WIDGET_DOMAIN, "WIDGET_DOMAIN");

  const licenseMode = parseLicenseMode(env.LICENSE_MODE);
  const licenseSigningSecret = parseSigningSecret(env.LICENSE_SIGNING_SECRET);
  if (licenseMode === "enforced" && licenseSigningSecret === undefined) {
    throw new ConfigError(
      "LICENSE_SIGNING_SECRET is required when LICENSE_MODE=enforced: without it no license key can be verified.",
    );
  }

  return {
    port,
    host,
    allowedHosts,
    challengeToken: parseChallengeToken(env.OPENAI_APPS_CHALLENGE_TOKEN),
    fileHostAllowlist: parseFileHosts(env.FILE_HOST_ALLOWLIST),
    widgetDomain,
    artifactStore,
    artifactBucket,
    awsRegion: parseRegion(env.AWS_REGION),
    artifactSigningSecret: env.ARTIFACT_SIGNING_SECRET?.trim() || randomBytes(32).toString("hex"),
    publicBaseUrl,
    artifactTtlSeconds: parseTtl(env.ARTIFACT_TTL_SECONDS),
    licenseMode,
    licenseSigningSecret,
    upgradeUrl: parseUpgradeUrl(env.UPGRADE_URL),
    freeMaxFiles: parseIntInRange(env.FREE_MAX_FILES, "FREE_MAX_FILES", 5, 1, 50),
    freeMaxSteps: parseIntInRange(env.FREE_MAX_STEPS, "FREE_MAX_STEPS", 75, 1, 100_000),
    freeDailyBundles: parseIntInRange(env.FREE_DAILY_BUNDLES, "FREE_DAILY_BUNDLES", 3, 0, 10_000),
  };
}
