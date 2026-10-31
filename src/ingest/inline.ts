import type { InlineFile, InputFile, UploadLimits } from "./types.js";
import { IngestError } from "./types.js";
import { isZip, normalizeArchivePath, unzipProject } from "./unzip.js";

function decodeBase64(value: string): Uint8Array {
  const cleaned = value.replace(/\s+/g, "");
  if (cleaned === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
    throw new IngestError("inline_files content_base64 is not valid base64.");
  }
  try {
    return new Uint8Array(Buffer.from(cleaned, "base64"));
  } catch {
    throw new IngestError("inline_files content_base64 is not valid base64.");
  }
}

export function expandInlineFiles(
  inlineFiles: InlineFile[],
  limits: UploadLimits,
): { files: InputFile[]; skipped: string[] } {
  let total = 0;
  const files: InputFile[] = [];
  const skipped: string[] = [];
  for (const inline of inlineFiles) {
    if (inline.content !== undefined && inline.content_base64 !== undefined) {
      throw new IngestError(
        `inline_files entry "${inline.name}" must set only one of content or content_base64.`,
      );
    }
    if (inline.content === undefined && inline.content_base64 === undefined) {
      throw new IngestError(
        `inline_files entry "${inline.name}" must set content or content_base64.`,
      );
    }
    let bytes: Uint8Array;
    if (inline.content !== undefined) {
      bytes = new TextEncoder().encode(inline.content);
    } else {
      bytes = decodeBase64(inline.content_base64 ?? "");
    }
    if (bytes.length > limits.maxInlineFileBytes) {
      throw new IngestError(
        `inline_files entry "${inline.name}" is larger than the 1 MB inline limit.`,
      );
    }
    total += bytes.length;
    if (total > limits.maxInlineTotalBytes) {
      throw new IngestError("inline_files total size exceeds the 5 MB limit.");
    }
    const name = normalizeArchivePath(inline.name);
    if (isZip(bytes)) {
      const nested = unzipProject(bytes, limits);
      files.push(...nested.files.map((file) => ({ ...file, path: `${name}/${file.path}` })));
      skipped.push(...nested.skipped.map((entry) => `${name}/${entry}`));
    } else {
      files.push({ path: name, data: bytes });
    }
  }
  if (files.length > limits.maxFiles) {
    throw new IngestError(`Project contains more than ${limits.maxFiles} files.`);
  }
  return { files, skipped };
}
