import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import type { BundleFile } from "./types.js";

export const FIXED_MTIME = Date.UTC(2000, 0, 1, 12, 0, 0);

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

export function kindForPath(path: string): BundleFile["kind"] {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".sh")) return "shell";
  if (path.startsWith("stepfunctions/")) return "asl";
  if (path.startsWith("cloudformation/") || path.endsWith(".yaml")) return "cloudformation";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  return "text";
}

export function packageFiles(fileText: Map<string, string>): {
  id: string;
  zip: Uint8Array;
  files: BundleFile[];
  contents: Record<string, string>;
} {
  const paths = [...fileText.keys()].sort();
  const encoder = new TextEncoder();
  const zipEntries: Record<string, Uint8Array> = {};
  const files: BundleFile[] = paths.map((path) => {
    const content = fileText.get(path) ?? "";
    const bytes = encoder.encode(content);
    zipEntries[path] = bytes;
    return {
      path,
      bytes: bytes.byteLength,
      sha256: sha256(content),
      kind: kindForPath(path),
    };
  });
  const zip = zipSync(zipEntries, { level: 6, mtime: FIXED_MTIME });
  const id = sha256(zip).slice(0, 16);
  const contents: Record<string, string> = {};
  for (const path of paths) contents[path] = fileText.get(path) ?? "";
  return { id, zip, files, contents };
}
