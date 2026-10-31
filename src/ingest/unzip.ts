import path from "node:path";
import { unzipSync } from "fflate";
import type { InputFile, UploadLimits } from "./types.js";
import { IngestError } from "./types.js";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isZip(data: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => data[index] === byte);
}

export function normalizeArchivePath(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (normalized === "" || normalized.endsWith("/")) {
    throw new IngestError("Archive contains an empty file name.");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new IngestError(`Archive entry "${name}" uses an absolute path.`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new IngestError(`Archive entry "${name}" contains an unsafe path segment.`);
  }
  if (segments.some((segment) => segment.includes("\0"))) {
    throw new IngestError("Archive entry name contains a NUL byte.");
  }
  return segments.join("/");
}

export function unzipProject(
  data: Uint8Array,
  limits: UploadLimits,
): { files: InputFile[]; skipped: string[] } {
  if (data.length > limits.maxArchiveBytes) {
    throw new IngestError(
      `ZIP archive is larger than the ${Math.floor(limits.maxArchiveBytes / (1024 * 1024))} MB limit.`,
    );
  }
  const entries: { original: string; safe: string }[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  try {
    unzipSync(data, {
      filter: (file) => {
        if (file.name.endsWith("/")) return false;
        const safe = normalizeArchivePath(file.name);
        if (file.originalSize > limits.maxUncompressedFileBytes) {
          throw new IngestError(
            `Archive entry "${safe}" is larger than the ${Math.floor(limits.maxUncompressedFileBytes / (1024 * 1024))} MB per-file limit.`,
          );
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > limits.maxUncompressedBytes) {
          throw new IngestError(
            `ZIP archive expands beyond the ${Math.floor(limits.maxUncompressedBytes / (1024 * 1024))} MB total limit.`,
          );
        }
        if (seen.has(safe))
          throw new IngestError(`ZIP archive contains duplicate entry "${safe}".`);
        seen.add(safe);
        entries.push({ original: file.name, safe });
        return false;
      },
    });
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(
      `Could not read ZIP archive: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (entries.length > limits.maxArchiveEntries) {
    throw new IngestError(
      `ZIP archive has ${entries.length} entries; the limit is ${limits.maxArchiveEntries}.`,
    );
  }
  entries.sort((a, b) => (a.safe < b.safe ? -1 : a.safe > b.safe ? 1 : 0));

  let unpacked: Record<string, Uint8Array>;
  let extractTotal = 0;
  try {
    unpacked = unzipSync(data, {
      filter: (file) => {
        if (file.name.endsWith("/")) return false;
        const safe = normalizeArchivePath(file.name);
        if (file.originalSize > limits.maxUncompressedFileBytes) {
          throw new IngestError(
            `Archive entry "${safe}" is larger than the ${Math.floor(limits.maxUncompressedFileBytes / (1024 * 1024))} MB per-file limit.`,
          );
        }
        extractTotal += file.originalSize;
        if (extractTotal > limits.maxUncompressedBytes) {
          throw new IngestError(
            `ZIP archive expands beyond the ${Math.floor(limits.maxUncompressedBytes / (1024 * 1024))} MB total limit.`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(
      `Could not extract ZIP archive: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  let total = 0;
  const files: InputFile[] = [];
  const skipped: string[] = [];
  for (const { original, safe } of entries) {
    const bytes = unpacked[original];
    if (!bytes) {
      skipped.push(safe);
      continue;
    }
    if (bytes.length > limits.maxUncompressedFileBytes) {
      throw new IngestError(
        `Archive entry "${safe}" expands beyond the ${Math.floor(limits.maxUncompressedFileBytes / (1024 * 1024))} MB per-file limit.`,
      );
    }
    total += bytes.length;
    if (total > limits.maxUncompressedBytes) {
      throw new IngestError(
        `ZIP archive expands beyond the ${Math.floor(limits.maxUncompressedBytes / (1024 * 1024))} MB total limit.`,
      );
    }
    files.push({ path: safe, data: bytes });
  }
  if (files.length > limits.maxFiles) {
    throw new IngestError(`Project contains more than ${limits.maxFiles} files.`);
  }
  return { files, skipped };
}

export function baseName(filePath: string): string {
  return path.posix.basename(filePath.replaceAll("\\", "/"));
}
