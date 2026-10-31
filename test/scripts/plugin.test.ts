import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerUrl, setServerUrl } from "../../scripts/set-server-url.js";
import { contrastRatio, isLoopbackHost, validatePlugin } from "../../scripts/validate-plugin.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "pentaho-to-aws");

async function copyPlugin(): Promise<{ root: string; plugin: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pentaho-plugin-"));
  await cp(path.join(PLUGIN_DIR), path.join(root, "plugins", "pentaho-to-aws"), {
    recursive: true,
  });
  return { root, plugin: path.join(root, "plugins", "pentaho-to-aws") };
}

describe("validate-plugin", () => {
  it("recognizes loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["example.com", "10.0.0.1", "mcp.example.com", "[fd00::1]"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("computes contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#0F766E", "#ffffff")).toBeGreaterThan(4.5);
  });

  it("accepts the committed plugin package", async () => {
    const result = await validatePlugin(PLUGIN_DIR, { release: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain("release_not_ready");
  });

  it("reports release gaps without failing package validation", async () => {
    const result = await validatePlugin(PLUGIN_DIR, { release: false });
    const warning = result.warnings.find((entry) => entry.code === "release_not_ready");
    expect(warning?.message).toContain("release requires a public host");
  });

  it("rejects an insecure public MCP URL", async () => {
    const { root, plugin } = await copyPlugin();
    try {
      const mcpPath = path.join(plugin, "mcp.json");
      const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
        mcpServers: Record<string, { url: string }>;
      };
      const server = mcp.mcpServers["pentaho-to-aws"];
      if (!server) throw new Error("fixture server missing");
      server.url = "http://mcp.example.com/mcp";
      await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      const result = await validatePlugin(plugin, { release: false, repoRoot: root });
      expect(result.errors.map((error) => error.code)).toContain("mcp_url_insecure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("set-server-url", () => {
  it("accepts public HTTPS and loopback HTTP MCP URLs", () => {
    expect(parseServerUrl("https://mcp.example.com/mcp").href).toBe("https://mcp.example.com/mcp");
    expect(parseServerUrl("http://localhost:3000/mcp").href).toBe("http://localhost:3000/mcp");
    expect(parseServerUrl("http://127.0.0.1:3000/mcp").href).toBe("http://127.0.0.1:3000/mcp");
  });

  it("rejects unsafe or malformed URLs", () => {
    expect(() => parseServerUrl("http://mcp.example.com/mcp")).toThrow(/https/);
    expect(() => parseServerUrl("ftp://mcp.example.com/mcp")).toThrow(/https/);
    expect(() => parseServerUrl("https://user:pass@mcp.example.com/mcp")).toThrow(/credentials/);
    expect(() => parseServerUrl("https://mcp.example.com/mcp?x=1")).toThrow(/query/);
    expect(() => parseServerUrl("https://mcp.example.com/mcp#x")).toThrow(/fragment/);
    expect(() => parseServerUrl("https://mcp.example.com/api")).toThrow(/\/mcp/);
    expect(() => parseServerUrl("not a url")).toThrow(/valid URL/);
  });

  it("rewrites mcp.json and the skill agent URL together", async () => {
    const { root } = await copyPlugin();
    try {
      const changes = await setServerUrl(root, "https://mcp.example.com/mcp");
      expect(changes).toHaveLength(2);
      expect(changes.map((change) => change.from)).toEqual([
        "http://localhost:3000/mcp",
        "http://localhost:3000/mcp",
      ]);
      for (const change of changes) expect(change.to).toBe("https://mcp.example.com/mcp");

      const mcp = JSON.parse(
        await readFile(path.join(root, "plugins/pentaho-to-aws/mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, { url: string }> };
      expect(mcp.mcpServers["pentaho-to-aws"]?.url).toBe("https://mcp.example.com/mcp");
      const agent = await readFile(
        path.join(root, "plugins/pentaho-to-aws/skills/migrate-pentaho/agents/openai.yaml"),
        "utf8",
      );
      expect(agent).toContain('url: "https://mcp.example.com/mcp"');
      expect((await setServerUrl(root, "https://mcp.example.com/mcp")).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
