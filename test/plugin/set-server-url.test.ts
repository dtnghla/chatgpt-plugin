import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { setServerUrl } from "../../scripts/set-server-url.js";
import { validatePlugin } from "../../scripts/validate-plugin.js";

const SOURCE = fileURLToPath(new URL("../../plugins/time-zone-planner", import.meta.url));
const MCP_JSON = "plugins/time-zone-planner/mcp.json";
const AGENT_YAML = "plugins/time-zone-planner/skills/plan-meeting/agents/openai.yaml";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tzp-url-"));
  tempDirs.push(root);
  await cp(SOURCE, path.join(root, "plugins/time-zone-planner"), { recursive: true });
  return root;
}

const read = (root: string, file: string): Promise<string> =>
  readFile(path.join(root, file), "utf8");

describe("setServerUrl", () => {
  it("rewrites mcp.json and openai.yaml", async () => {
    const root = await makeRoot();
    const yamlBefore = await read(root, AGENT_YAML);
    const changes = await setServerUrl(root, "https://plan.example.org/mcp");

    expect(changes.map((change) => change.file)).toEqual([MCP_JSON, AGENT_YAML]);
    const mcpText = await read(root, MCP_JSON);
    expect(mcpText.endsWith("\n")).toBe(true);
    expect(JSON.parse(mcpText).mcpServers["time-zone-planner"].url).toBe(
      "https://plan.example.org/mcp",
    );
    expect(mcpText).toContain('\n  "mcpServers": {\n    "time-zone-planner": {\n');

    const yamlAfter = await read(root, AGENT_YAML);
    expect(yamlAfter).toBe(
      yamlBefore.replace("http://localhost:3000/mcp", "https://plan.example.org/mcp"),
    );
  });

  it("keeps the package valid", async () => {
    const root = await makeRoot();
    await setServerUrl(root, "https://plan.timezones.dev/mcp");
    const result = await validatePlugin(path.join(root, "plugins/time-zone-planner"), {
      release: false,
    });
    expect(result.errors).toEqual([]);
  });

  it("is idempotent", async () => {
    const root = await makeRoot();
    await setServerUrl(root, "https://plan.example.org/mcp");
    const [mcp, agent] = await Promise.all([read(root, MCP_JSON), read(root, AGENT_YAML)]);
    const changes = await setServerUrl(root, "https://plan.example.org/mcp");
    expect(changes).toEqual([]);
    expect(await read(root, MCP_JSON)).toBe(mcp);
    expect(await read(root, AGENT_YAML)).toBe(agent);
  });

  it("allows resetting to localhost over http", async () => {
    const root = await makeRoot();
    const original = await Promise.all([read(root, MCP_JSON), read(root, AGENT_YAML)]);
    await setServerUrl(root, "https://plan.example.org/mcp");
    await setServerUrl(root, "http://localhost:3000/mcp");
    expect(await Promise.all([read(root, MCP_JSON), read(root, AGENT_YAML)])).toEqual(original);
  });

  it.each([
    ["http for a non-loopback host", "http://plan.example.org/mcp", /https/],
    ["a missing /mcp path", "https://plan.example.org/", /\/mcp/],
    ["a different path", "https://plan.example.org/api", /\/mcp/],
    ["a query string", "https://plan.example.org/mcp?x=1", /query/],
    ["a fragment", "https://plan.example.org/mcp#top", /fragment/],
    ["credentials", "https://user:pw@plan.example.org/mcp", /credentials/],
    ["a non-URL", "not a url", /valid URL/],
  ])("rejects %s", async (_label, url, message) => {
    const root = await makeRoot();
    const before = await read(root, MCP_JSON);
    await expect(setServerUrl(root, url)).rejects.toThrow(message);
    expect(await read(root, MCP_JSON)).toBe(before);
  });

  it("fails without touching files when the yaml has no single url line", async () => {
    const root = await makeRoot();
    const yamlPath = path.join(root, AGENT_YAML);
    await writeFile(yamlPath, 'interface:\n  display_name: "x"\n');
    const before = await read(root, MCP_JSON);
    await expect(setServerUrl(root, "https://plan.example.org/mcp")).rejects.toThrow(/exactly one/);
    expect(await read(root, MCP_JSON)).toBe(before);
  });
});
