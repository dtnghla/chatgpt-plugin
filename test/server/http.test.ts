import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_BODY_LIMIT } from "../../src/app.js";
import { type RunningServer, startServer } from "./harness.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("HTTP surface", () => {
  it("answers /healthz without MCP headers", async () => {
    running = await startServer();
    const response = await fetch(`${running.origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("exempts /healthz from Host validation but not /mcp", async () => {
    running = await startServer({ allowedHosts: ["plan.example.org"] });
    expect((await fetch(`${running.origin}/healthz`)).status).toBe(200);
    const blocked = await fetch(running.mcpUrl, {
      method: "POST",
      headers: MCP_HEADERS,
      body: LIST_TOOLS,
    });
    expect(blocked.status).toBe(403);
  });

  it("serves tools/list to an allowed Host as a bare JSON-RPC call", async () => {
    running = await startServer();
    const response = await fetch(running.mcpUrl, {
      method: "POST",
      headers: MCP_HEADERS,
      body: LIST_TOOLS,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("convert_time");
  });

  it("rejects a browser Origin that is not allowed", async () => {
    running = await startServer();
    const response = await fetch(running.mcpUrl, {
      method: "POST",
      headers: { ...MCP_HEADERS, Origin: "https://evil.example" },
      body: LIST_TOOLS,
    });
    expect(response.status).toBe(403);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    running = await startServer();
    const response = await fetch(running.mcpUrl, {
      method: "POST",
      headers: MCP_HEADERS,
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 } });
  });

  it(`rejects bodies over ${MCP_BODY_LIMIT}`, async () => {
    running = await startServer();
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { pad: "x".repeat(300_000) },
    });
    const response = await fetch(running.mcpUrl, {
      method: "POST",
      headers: MCP_HEADERS,
      body: huge,
    });
    expect(response.status).toBe(413);
  });

  it("does not expose the domain challenge route without a token", async () => {
    running = await startServer();
    expect((await fetch(`${running.origin}/.well-known/openai-apps-challenge`)).status).toBe(404);
  });

  it("serves the domain challenge token as plain text when configured", async () => {
    running = await startServer({ challengeToken: "token_ABC-123.xyz" });
    const response = await fetch(`${running.origin}/.well-known/openai-apps-challenge`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("token_ABC-123.xyz");
  });

  it("does not advertise Express", async () => {
    running = await startServer();
    const response = await fetch(`${running.origin}/healthz`);
    expect(response.headers.get("x-powered-by")).toBeNull();
  });
});

describe("built widget bundle", () => {
  it("is a single HTML file with no external URLs", async () => {
    const html = await readFile(
      new URL("../../dist/web/planner.html", import.meta.url),
      "utf8",
    ).catch(() => undefined);
    expect(html, 'run "npm run build:web" before the tests').toBeDefined();
    const urls = (html ?? "").match(/https?:\/\/[^\s"'<>)\\]+/g) ?? [];
    const external = urls.filter((url) => !/^https?:\/\/www\.w3\.org\//.test(url));
    expect(external).toEqual([]);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });
});
