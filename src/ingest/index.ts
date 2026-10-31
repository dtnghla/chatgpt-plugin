import path from "node:path";
import { downloadProjectFile } from "./fetch-file.js";
import { expandInlineFiles } from "./inline.js";
import type { FileReference, InlineFile, InputFile, UploadLimits } from "./types.js";
import { DEFAULT_UPLOAD_LIMITS, IngestError } from "./types.js";
import { isZip, normalizeArchivePath, unzipProject } from "./unzip.js";

export { hostAllowed, isPrivateAddress } from "./fetch-file.js";
export * from "./types.js";
export { isZip, normalizeArchivePath, unzipProject } from "./unzip.js";
export { boolAt, child, children, node, parseXml, stringAt, text, xmlToJson } from "./xml.js";

export interface ProjectInput {
  files: InputFile[];
  skipped: string[];
  sourceBytes: number;
}

export interface ReadProjectOptions {
  allowlist: string[];
  limits?: UploadLimits;
}

function safeBaseName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const base = path.posix.basename(normalized);
  if (!base || base === "." || base === "..") return "upload";
  return base;
}

function uniquePath(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const parsed = path.posix.parse(candidate);
  for (let index = 2; index < 1000; index += 1) {
    const next = path.posix.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
  throw new IngestError(`Too many files with the same name "${candidate}".`);
}

export async function readProjectInput(
  references: FileReference[],
  inlineFiles: InlineFile[],
  options: ReadProjectOptions,
): Promise<ProjectInput> {
  const limits = options.limits ?? DEFAULT_UPLOAD_LIMITS;
  if (references.length + inlineFiles.length === 0) {
    throw new IngestError(
      "Provide at least one Pentaho file, ZIP archive or inline file. Attach .ktr/.kjb files or paste their XML in inline_files.",
    );
  }
  if (references.length > 50) throw new IngestError("At most 50 uploaded files are allowed.");
  const downloaded: { name: string; data: Uint8Array; archive: boolean }[] = [];
  let sourceBytes = 0;
  for (const reference of references) {
    const file = await downloadProjectFile(reference, {
      allowlist: options.allowlist,
      limits,
    });
    sourceBytes += file.data.byteLength;
    downloaded.push({
      name: safeBaseName(file.fileName),
      data: file.data,
      archive: isZip(file.data),
    });
  }

  const archives = downloaded.filter((file) => file.archive);
  const files: InputFile[] = [];
  const skipped: string[] = [];
  const used = new Set<string>();
  const addFile = (candidate: string, data: Uint8Array) => {
    const safe = normalizeArchivePath(candidate);
    files.push({ path: uniquePath(safe, used), data });
  };

  for (const file of downloaded) {
    if (!file.archive) {
      addFile(file.name, file.data);
      continue;
    }
    const extracted = unzipProject(file.data, limits);
    const prefix = archives.length > 1 ? `${file.name.replace(/\.zip$/i, "")}/` : "";
    for (const entry of extracted.files) addFile(`${prefix}${entry.path}`, entry.data);
    skipped.push(...extracted.skipped.map((entry) => `${prefix}${entry}`));
  }

  const inline = expandInlineFiles(inlineFiles, limits);
  for (const file of inline.files) addFile(file.path, file.data);
  skipped.push(...inline.skipped);

  let total = 0;
  for (const file of files) {
    total += file.data.byteLength;
    if (total > limits.maxUncompressedBytes) {
      throw new IngestError("The combined project exceeds the 50 MB limit.");
    }
  }
  if (files.length === 0) throw new IngestError("No usable files were found in the upload.");
  return { files, skipped, sourceBytes };
}
