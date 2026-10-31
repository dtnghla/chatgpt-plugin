import { XMLParser, XMLValidator } from "fast-xml-parser";
import { IngestError } from "./types.js";

export type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set([
  "step",
  "hop",
  "entry",
  "connection",
  "field",
  "condition",
  "parameter",
  "calculation",
  "meta",
  "key",
  "case",
  "rule",
  "argument",
  "value",
  "partition",
  "cluster",
  "slave",
  "server",
  "attribute",
  "property",
  "variable",
  "schedule",
  "file",
  "sheet",
  "row",
  "transform",
  "job",
  "transformation",
  "repository",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

function decodeCodePoint(code: number): string {
  if (
    code <= 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
  ) {
    throw new IngestError("XML contains an invalid character reference.");
  }
  return String.fromCodePoint(code);
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);|&([A-Za-z][A-Za-z0-9._:-]*);/g,
    (match, entity: string | undefined, unknown: string | undefined) => {
      if (unknown !== undefined) {
        throw new IngestError(`XML contains the unsupported entity &${unknown};.`);
      }
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default: {
          if (entity === undefined) return match;
          if (entity.startsWith("#x")) {
            return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
          }
          return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
        }
      }
    },
  );
}

function decodeTree(value: unknown): unknown {
  if (typeof value === "string") return decodeEntities(value);
  if (Array.isArray(value)) return value.map(decodeTree);
  if (value !== null && typeof value === "object") {
    const result: XmlNode = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = decodeTree(child);
    }
    return result;
  }
  return value;
}

export function parseXml(data: Uint8Array, file: string): XmlNode {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new IngestError(`${file} is not valid UTF-8.`);
  }
  if (text.includes("\0")) throw new IngestError(`${file} contains a NUL byte.`);
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new IngestError(
      `${file} contains a DOCTYPE or ENTITY declaration, which is not allowed.`,
    );
  }
  const validation = XMLValidator.validate(text, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw new IngestError(
      `${file} is not well-formed XML: ${validation.err.msg} (line ${validation.err.line}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw new IngestError(
      `${file} could not be parsed as XML: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IngestError(`${file} does not contain an XML document.`);
  }
  return decodeTree(parsed) as XmlNode;
}

export function node(value: unknown): XmlNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function child(value: unknown, key: string): XmlNode | undefined {
  return node(first(node(value)?.[key]));
}

export function children(value: unknown, key: string): XmlNode[] {
  const found = node(value)?.[key];
  if (Array.isArray(found)) {
    return found.flatMap((entry) => {
      const parsed = node(entry);
      return parsed ? [parsed] : [];
    });
  }
  const single = node(found);
  return single ? [single] : [];
}

export function text(value: unknown): string | undefined {
  const unwrapped = first(value);
  if (typeof unwrapped === "string") return unwrapped.trim();
  if (typeof unwrapped === "number" || typeof unwrapped === "boolean") return String(unwrapped);
  const obj = node(unwrapped);
  if (!obj) return undefined;
  const inner = obj["#text"];
  if (typeof inner === "string") return inner.trim();
  return undefined;
}

export function stringAt(value: unknown, key: string): string | undefined {
  return text(node(value)?.[key]);
}

export function nodeAt(value: unknown, key: string): XmlNode | undefined {
  return child(value, key);
}

export function numberAt(value: unknown, key: string): number | undefined {
  const raw = stringAt(value, key);
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function boolAt(value: unknown, key: string): boolean | undefined {
  const raw = stringAt(value, key)?.toUpperCase();
  if (raw === "Y" || raw === "TRUE" || raw === "1") return true;
  if (raw === "N" || raw === "FALSE" || raw === "0") return false;
  return undefined;
}

export function xmlToJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(xmlToJson);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      result[key] = xmlToJson(childValue);
    }
    return result;
  }
  return value;
}
