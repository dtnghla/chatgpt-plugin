import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArtifactService, MemoryArtifactBackend } from "../../src/artifacts/store.js";
import type { MigrationBundle } from "../../src/migration/types.js";
import { retailBundle } from "../helpers.js";

const BASE_BUNDLE = retailBundle();
const SIGNING_SECRET = "test-signing-secret";

function makeBundle(id: string): MigrationBundle {
  return { ...BASE_BUNDLE, id };
}

function signature(id: string, expires: number, secret = SIGNING_SECRET): string {
  return createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex");
}

describe("MemoryArtifactBackend", () => {
  it("stores bundles until they expire", async () => {
    const backend = new MemoryArtifactBackend();
    const bundle = makeBundle("0123456789abcdef");
    const expiresAt = Date.now() + 60_000;
    await backend.save(bundle, expiresAt);
    expect(await backend.load(bundle.id, Date.now())).toBe(bundle);
    expect(await backend.load(bundle.id, expiresAt)).toBeUndefined();
    expect(await backend.load(bundle.id, Date.now())).toBeUndefined();
  });

  it("returns the generated ZIP for a download", async () => {
    const backend = new MemoryArtifactBackend();
    const bundle = makeBundle("fedcba9876543210");
    await backend.save(bundle, Date.now() + 60_000);
    const download = await backend.download(bundle.id, Date.now());
    expect(download?.fileName).toBe(`retail-${bundle.id}.zip`);
    expect(Buffer.from(download?.data ?? new Uint8Array()).equals(Buffer.from(bundle.zip))).toBe(
      true,
    );
  });

  it("evicts the oldest bundles beyond the entry limit", async () => {
    const backend = new MemoryArtifactBackend(2);
    const now = Date.now();
    await backend.save(makeBundle("0000000000000001"), now + 60_000);
    await backend.save(makeBundle("0000000000000002"), now + 60_000);
    await backend.save(makeBundle("0000000000000003"), now + 60_000);
    expect(await backend.load("0000000000000001", now)).toBeUndefined();
    expect(await backend.load("0000000000000002", now)).toBeDefined();
    expect(await backend.load("0000000000000003", now)).toBeDefined();
  });

  it("removes expired bundles on cleanup", async () => {
    const backend = new MemoryArtifactBackend();
    const now = Date.now();
    await backend.save(makeBundle("0000000000000004"), now - 1);
    await backend.save(makeBundle("0000000000000005"), now + 60_000);
    backend.cleanup(now);
    expect(await backend.load("0000000000000004", now)).toBeUndefined();
    expect(await backend.load("0000000000000005", now)).toBeDefined();
  });
});

describe("ArtifactService", () => {
  it("saves bundles without a link when no public URL is configured", async () => {
    const service = new ArtifactService(new MemoryArtifactBackend(), {
      signingSecret: SIGNING_SECRET,
      ttlSeconds: 900,
    });
    const bundle = makeBundle("1111111111111111");
    const before = Date.now();
    const saved = await service.save(bundle);
    expect(saved.url).toBeUndefined();
    expect(saved.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(saved.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(await service.load(bundle.id)).toBeDefined();
    await service.close();
  });

  it("rejects malformed bundle identifiers", async () => {
    const service = new ArtifactService(new MemoryArtifactBackend(), {
      signingSecret: SIGNING_SECRET,
      ttlSeconds: 900,
    });
    expect(await service.load("not-a-bundle")).toBeUndefined();
    expect(await service.load("ABCDEF0123456789")).toBeUndefined();
    expect(await service.load("0123456789abcde")).toBeUndefined();
    expect(await service.download("nope", Date.now() + 60_000, "signature")).toBeUndefined();
    await service.close();
  });

  it("returns an HMAC-signed download URL when a public base URL is configured", async () => {
    const service = new ArtifactService(new MemoryArtifactBackend(), {
      publicBaseUrl: "https://migration.example.com/",
      signingSecret: SIGNING_SECRET,
      ttlSeconds: 900,
    });
    const bundle = makeBundle("2222222222222222");
    const saved = await service.save(bundle);
    expect(saved.url).toBeDefined();
    const url = new URL(saved.url ?? "");
    expect(url.origin).toBe("https://migration.example.com");
    expect(url.pathname).toBe(`/artifacts/${bundle.id}/download`);
    expect(Number(url.searchParams.get("expires"))).toBe(saved.expiresAt);
    expect(url.searchParams.get("signature")).toBe(signature(bundle.id, saved.expiresAt));

    const download = await service.download(
      bundle.id,
      saved.expiresAt,
      url.searchParams.get("signature") ?? "",
    );
    expect(download?.fileName).toBe(`retail-${bundle.id}.zip`);
    expect(download?.data.byteLength).toBe(bundle.zip.byteLength);
    await service.close();
  });

  it("rejects tampered, expired and unauthenticated downloads", async () => {
    const service = new ArtifactService(new MemoryArtifactBackend(), {
      signingSecret: SIGNING_SECRET,
      ttlSeconds: 900,
    });
    const bundle = makeBundle("3333333333333333");
    const saved = await service.save(bundle);
    const expires = saved.expiresAt;
    const valid = signature(bundle.id, expires);

    expect(await service.download(bundle.id, expires, `${valid.slice(0, -1)}0`)).toBeUndefined();
    expect(await service.download(bundle.id, expires, "")).toBeUndefined();
    expect(
      await service.download(bundle.id, expires, signature("4444444444444444", expires)),
    ).toBeUndefined();
    expect(await service.download(bundle.id, Date.now() - 1, valid)).toBeUndefined();
    expect(await service.download(bundle.id, expires, valid)).toBeDefined();
    await service.close();
  });

  it("uses the signing secret to authenticate download links", async () => {
    const backend = new MemoryArtifactBackend();
    const signer = new ArtifactService(backend, {
      publicBaseUrl: "https://migration.example.com",
      signingSecret: SIGNING_SECRET,
      ttlSeconds: 900,
    });
    const bundle = makeBundle("5555555555555555");
    const saved = await signer.save(bundle);
    const attacker = new ArtifactService(backend, {
      publicBaseUrl: "https://migration.example.com",
      signingSecret: "another-secret",
      ttlSeconds: 900,
    });
    expect(
      await attacker.download(bundle.id, saved.expiresAt, signature(bundle.id, saved.expiresAt)),
    ).toBeUndefined();
    expect(
      await signer.download(bundle.id, saved.expiresAt, signature(bundle.id, saved.expiresAt)),
    ).toBeDefined();
    await signer.close();
    await attacker.close();
  });

  it("treats bundles as expired once the TTL elapses", async () => {
    const service = new ArtifactService(new MemoryArtifactBackend(), {
      signingSecret: SIGNING_SECRET,
      ttlSeconds: 0,
    });
    const bundle = makeBundle("6666666666666666");
    const saved = await service.save(bundle);
    expect(await service.load(bundle.id)).toBeUndefined();
    expect(
      await service.download(bundle.id, saved.expiresAt, signature(bundle.id, saved.expiresAt)),
    ).toBeUndefined();
    await service.close();
  });
});
