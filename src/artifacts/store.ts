import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { MigrationBundle } from "../migration/types.js";

export interface StoredDownload {
  data: Uint8Array;
  fileName: string;
}

export interface ArtifactBackend {
  save(bundle: MigrationBundle, expiresAt: number): Promise<void>;
  load(id: string, now: number): Promise<MigrationBundle | undefined>;
  download(id: string, now: number): Promise<StoredDownload | undefined>;
  cleanup?(now: number): void;
  link?(id: string, expiresAt: number): Promise<string | undefined>;
  close?(): Promise<void>;
}

function cloneWithoutZip(
  bundle: MigrationBundle,
): Omit<MigrationBundle, "zip"> & { zip?: Uint8Array } {
  const { zip: _zip, ...rest } = bundle;
  return rest;
}

export class MemoryArtifactBackend implements ArtifactBackend {
  private readonly entries = new Map<string, { bundle: MigrationBundle; expiresAt: number }>();

  private readonly maxEntries: number;

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries;
  }

  async save(bundle: MigrationBundle, expiresAt: number): Promise<void> {
    this.entries.set(bundle.id, { bundle, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async load(id: string, now: number): Promise<MigrationBundle | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.bundle;
  }

  async download(id: string, now: number): Promise<StoredDownload | undefined> {
    const bundle = await this.load(id, now);
    if (!bundle) return undefined;
    return { data: bundle.zip, fileName: `${bundle.projectName}-${bundle.id}.zip` };
  }

  cleanup(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

interface S3Metadata {
  expires_at: number;
  bundle: Omit<MigrationBundle, "zip">;
}

export class S3ArtifactBackend implements ArtifactBackend {
  constructor(
    private readonly bucket: string,
    private readonly region: string,
    private readonly ttlSeconds: number,
    private readonly prefix = "bundles",
  ) {}

  private async client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ region: this.region });
  }

  private key(id: string, suffix: "zip" | "json"): string {
    return `${this.prefix}/${id}.${suffix}`;
  }

  async save(bundle: MigrationBundle, expiresAt: number): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.client();
    const metadata: S3Metadata = { expires_at: expiresAt, bundle: cloneWithoutZip(bundle) };
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(bundle.id, "zip"),
        Body: bundle.zip,
        ContentType: "application/zip",
        ServerSideEncryption: "AES256",
        Metadata: { expires_at: String(expiresAt) },
      }),
    );
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(bundle.id, "json"),
        Body: JSON.stringify(metadata),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async load(id: string, now: number): Promise<MigrationBundle | undefined> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.client();
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id, "json") }),
      );
      const raw = await response.Body?.transformToString();
      if (!raw) return undefined;
      const metadata = JSON.parse(raw) as S3Metadata;
      if (metadata.expires_at <= now) return undefined;
      return { ...metadata.bundle, zip: new Uint8Array() } as MigrationBundle;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NoSuchKey" || name === "NotFound") return undefined;
      throw error;
    }
  }

  async download(id: string, now: number): Promise<StoredDownload | undefined> {
    const bundle = await this.load(id, now);
    if (!bundle) return undefined;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.client();
    const response = await client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id, "zip") }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) return undefined;
    return {
      data: new Uint8Array(bytes),
      fileName: `${bundle.projectName}-${id}.zip`,
    };
  }

  async link(id: string, expiresAt: number): Promise<string | undefined> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await this.client();
    const remaining = Math.max(
      1,
      Math.min(this.ttlSeconds, Math.floor((expiresAt - Date.now()) / 1000)),
    );
    return await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(id, "zip"),
        ResponseContentDisposition: `attachment; filename="${id}.zip"`,
      }),
      { expiresIn: remaining },
    );
  }

  async close(): Promise<void> {
    // No persistent client is held.
  }
}

export interface ArtifactServiceOptions {
  publicBaseUrl?: string;
  signingSecret: string;
  ttlSeconds: number;
}

function sign(secret: string, id: string, expires: number): string {
  return createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex");
}

export class ArtifactService {
  readonly ttlSeconds: number;
  private readonly publicBaseUrl: string | undefined;
  private readonly signingSecret: string;
  private readonly backend: ArtifactBackend;
  private readonly cleanup: NodeJS.Timeout | undefined;

  constructor(backend: ArtifactBackend, options: ArtifactServiceOptions) {
    this.backend = backend;
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, "");
    this.signingSecret = options.signingSecret;
    this.ttlSeconds = options.ttlSeconds;
    if (backend instanceof MemoryArtifactBackend) {
      this.cleanup = setInterval(() => {
        this.backend.cleanup?.(Date.now());
      }, 15 * 60_000);
      this.cleanup.unref();
    }
  }

  static fromConfig(config: Config): ArtifactService {
    const backend: ArtifactBackend =
      config.artifactStore === "s3"
        ? new S3ArtifactBackend(
            config.artifactBucket ?? "",
            config.awsRegion,
            config.artifactTtlSeconds,
          )
        : new MemoryArtifactBackend();
    return new ArtifactService(backend, {
      publicBaseUrl: config.publicBaseUrl,
      signingSecret: config.artifactSigningSecret,
      ttlSeconds: config.artifactTtlSeconds,
    });
  }

  async save(bundle: MigrationBundle): Promise<{ url?: string; expiresAt: number }> {
    const expiresAt = Date.now() + this.ttlSeconds * 1000;
    await this.backend.save(bundle, expiresAt);
    if (this.backend.link) {
      const url = await this.backend.link(bundle.id, expiresAt);
      return { url, expiresAt };
    }
    if (this.publicBaseUrl) {
      const signature = sign(this.signingSecret, bundle.id, expiresAt);
      return {
        url: `${this.publicBaseUrl}/artifacts/${bundle.id}/download?expires=${expiresAt}&signature=${signature}`,
        expiresAt,
      };
    }
    return { expiresAt };
  }

  async load(id: string): Promise<MigrationBundle | undefined> {
    if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
    return await this.backend.load(id, Date.now());
  }

  async download(
    id: string,
    expires: number,
    signature: string,
  ): Promise<StoredDownload | undefined> {
    if (!/^[a-f0-9]{16}$/.test(id) || !Number.isFinite(expires) || expires <= Date.now()) {
      return undefined;
    }
    const expected = sign(this.signingSecret, id, expires);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    return await this.backend.download(id, Date.now());
  }

  async close(): Promise<void> {
    if (this.cleanup) clearInterval(this.cleanup);
    await this.backend.close?.();
  }
}

export function artifactServiceFromConfig(config: Config): ArtifactService {
  return ArtifactService.fromConfig(config);
}
