import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/app.js";
import { ArtifactService, MemoryArtifactBackend } from "../../src/artifacts/store.js";
import { retailBundle } from "../helpers.js";
import { type RunningServer, startServer } from "./harness.js";

const SIGNING_SECRET = "http-test-signing-secret";
const BUNDLE = retailBundle();
const servers: RunningServer[] = [];

function artifactService(): ArtifactService {
  return new ArtifactService(new MemoryArtifactBackend(), {
    signingSecret: SIGNING_SECRET,
    ttlSeconds: 900,
  });
}

function signature(id: string, expires: number): string {
  return createHmac("sha256", SIGNING_SECRET).update(`${id}:${expires}`).digest("hex");
}

async function serve(
  overrides: Parameters<typeof startServer>[0] = {},
  options: Parameters<typeof startServer>[1] = {},
): Promise<RunningServer> {
  const server = await startServer(overrides, options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close();
  }
});

describe("HTTP endpoints", () => {
  it("serves a no-store health check", async () => {
    const server = await serve();
    const response = await fetch(new URL("/healthz", server.origin));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("does not serve the challenge route unless a token is configured", async () => {
    const withoutToken = await serve();
    expect(
      (await fetch(new URL("/.well-known/openai-apps-challenge", withoutToken.origin))).status,
    ).toBe(404);

    const withToken = await serve({ challengeToken: "challenge-abc" });
    const response = await fetch(new URL("/.well-known/openai-apps-challenge", withToken.origin));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("challenge-abc");
  });

  it("rejects an unexpected Host header on /mcp", async () => {
    const server = await serve({ allowedHosts: ["localhost"] });
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("rejects a cross-origin request on /mcp", async () => {
    const server = await serve();
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("accepts a same-origin request and returns a JSON-RPC error for an empty payload", async () => {
    const server = await serve();
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.origin,
      },
      body: "{}",
    });
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns a JSON-RPC error for malformed JSON", async () => {
    const server = await serve();
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Invalid JSON." },
      id: null,
    });
  });

  it("rejects request bodies over 256 KB", async () => {
    const server = await serve();
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(300_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Request body too large." },
      id: null,
    });
  });
});

describe("artifact downloads", () => {
  it("serves the signed ZIP with safe download headers", async () => {
    const artifacts = artifactService();
    const saved = await artifacts.save(BUNDLE);
    const server = await serve({}, { artifacts });
    const query = new URLSearchParams({
      expires: String(saved.expiresAt),
      signature: signature(BUNDLE.id, saved.expiresAt),
    });
    const response = await fetch(
      new URL(`/artifacts/${BUNDLE.id}/download?${query.toString()}`, server.origin),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="retail-${BUNDLE.id}.zip"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(BUNDLE.zip.byteLength);
    expect(Buffer.from(body).equals(Buffer.from(BUNDLE.zip))).toBe(true);
  });

  it("returns 404 for tampered, expired and missing signatures", async () => {
    const artifacts = artifactService();
    const saved = await artifacts.save(BUNDLE);
    const server = await serve({}, { artifacts });
    const download = (query: URLSearchParams) =>
      fetch(new URL(`/artifacts/${BUNDLE.id}/download?${query.toString()}`, server.origin));
    const valid = signature(BUNDLE.id, saved.expiresAt);

    const tampered = await download(
      new URLSearchParams({
        expires: String(saved.expiresAt),
        signature: `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`,
      }),
    );
    expect(tampered.status).toBe(404);
    expect(await tampered.json()).toEqual({ error: "Artifact not found." });

    const missing = await download(new URLSearchParams());
    expect(missing.status).toBe(404);

    const expiredAt = Date.now() - 1_000;
    const expired = await download(
      new URLSearchParams({
        expires: String(expiredAt),
        signature: signature(BUNDLE.id, expiredAt),
      }),
    );
    expect(expired.status).toBe(404);
  });

  it("returns 404 for an unknown bundle with a valid signature", async () => {
    const server = await serve({}, { artifacts: artifactService() });
    const id = "aaaaaaaaaaaaaaaa";
    const expires = Date.now() + 60_000;
    const response = await fetch(
      new URL(
        `/artifacts/${id}/download?expires=${expires}&signature=${signature(id, expires)}`,
        server.origin,
      ),
    );
    expect(response.status).toBe(404);
  });

  it("logs request metadata without tool arguments or file contents", async () => {
    const info: string[] = [];
    const logger: Logger = {
      info: (message) => info.push(message),
      error: (message) => info.push(`ERROR ${message}`),
    };
    const server = await serve({}, { logger });
    await fetch(new URL("/healthz", server.origin));
    await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"password":"SuperSecret!23"}',
    });
    expect(info.length).toBeGreaterThanOrEqual(2);
    expect(info.some((line) => line.includes("GET /healthz 200"))).toBe(true);
    expect(info.some((line) => line.includes("POST /mcp"))).toBe(true);
    for (const line of info) {
      expect(line).not.toContain("SuperSecret!23");
      expect(line).not.toContain("password");
    }
  });
});
