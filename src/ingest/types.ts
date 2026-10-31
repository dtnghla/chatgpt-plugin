export interface InputFile {
  /** Normalized path inside the uploaded project, e.g. "transforms/orders.ktr". */
  path: string;
  data: Uint8Array;
}

export interface FileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface InlineFile {
  name: string;
  content?: string;
  content_base64?: string;
}

export interface UploadLimits {
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  maxArchiveBytes: number;
  maxArchiveEntries: number;
  maxUncompressedBytes: number;
  maxUncompressedFileBytes: number;
  maxInlineFileBytes: number;
  maxInlineTotalBytes: number;
  maxFiles: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxDownloadBytes: 25 * 1024 * 1024,
  downloadTimeoutMs: 15_000,
  maxArchiveBytes: 25 * 1024 * 1024,
  maxArchiveEntries: 500,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxUncompressedFileBytes: 10 * 1024 * 1024,
  maxInlineFileBytes: 1024 * 1024,
  maxInlineTotalBytes: 5 * 1024 * 1024,
  maxFiles: 500,
};

export class IngestError extends Error {
  override readonly name = "IngestError";
}
