import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLoopbackHost } from "./validate-plugin.js";

const PLUGIN_DIR = "plugins/pentaho-to-aws";
const MCP_JSON = `${PLUGIN_DIR}/mcp.json`;
const AGENT_YAML = `${PLUGIN_DIR}/skills/migrate-pentaho/agents/openai.yaml`;
const YAML_URL_LINE = /^(\s*(?:-\s+)?url:\s*)(["']?)([^"'\s#]*)(\2)(\s*(?:#.*)?)$/;

export interface UrlChange {
  file: string;
  from: string;
  to: string;
}

export function parseServerUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`"${input}" is not a valid URL`);
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("URL must use https (http is only allowed for localhost/loopback hosts)");
  }
  if (!url.hostname) throw new Error("URL must include a host");
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  if (url.search || input.includes("?")) throw new Error("URL must not contain a query string");
  if (url.hash || input.includes("#")) throw new Error("URL must not contain a fragment");
  if (!url.pathname.endsWith("/mcp")) throw new Error('URL path must end with "/mcp"');
  return url;
}

function rewriteMcpJson(raw: string, url: string): { text: string; from: string } {
  const parsed: unknown = JSON.parse(raw);
  const servers = (parsed as { mcpServers?: Record<string, { url?: unknown }> }).mcpServers;
  const names = Object.keys(servers ?? {});
  const server = names.length === 1 && servers ? servers[names[0] as string] : undefined;
  if (!server || typeof server.url !== "string") {
    throw new Error(`${MCP_JSON} must contain exactly one server entry with a "url"`);
  }
  const from = server.url;
  server.url = url;
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, from };
}

function rewriteAgentYaml(raw: string, url: string): { text: string; from: string } {
  const lines = raw.split("\n");
  const indexes = lines.flatMap((line, i) => (/^\s*(?:-\s+)?url:/.test(line) ? [i] : []));
  const index = indexes[0];
  const match =
    indexes.length === 1 && index !== undefined ? YAML_URL_LINE.exec(lines[index] ?? "") : null;
  if (!match || index === undefined) {
    throw new Error(
      `${AGENT_YAML}: expected exactly one simple "url:" line, found ${indexes.length}`,
    );
  }
  const [, prefix = "", quote = "", from = "", , suffix = ""] = match;
  lines[index] = `${prefix}${quote}${url}${quote}${suffix}`;
  return { text: lines.join("\n"), from };
}

export async function setServerUrl(rootDir: string, input: string): Promise<UrlChange[]> {
  const url = parseServerUrl(input).href;
  const mcpPath = path.join(rootDir, MCP_JSON);
  const yamlPath = path.join(rootDir, AGENT_YAML);
  const [mcpRaw, yamlRaw] = await Promise.all([
    readFile(mcpPath, "utf8"),
    readFile(yamlPath, "utf8"),
  ]);
  const mcp = rewriteMcpJson(mcpRaw, url);
  const agent = rewriteAgentYaml(yamlRaw, url);

  const changes: UrlChange[] = [];
  if (mcp.text !== mcpRaw) {
    await writeFile(mcpPath, mcp.text);
    changes.push({ file: MCP_JSON, from: mcp.from, to: url });
  }
  if (agent.text !== yamlRaw) {
    await writeFile(yamlPath, agent.text);
    changes.push({ file: AGENT_YAML, from: agent.from, to: url });
  }
  return changes;
}

async function main(argv: string[]): Promise<number> {
  const [target, ...rest] = argv;
  if (!target || rest.length > 0) {
    console.error("Usage: npm run plugin:set-url -- <https-url-ending-in-/mcp>");
    return 1;
  }
  try {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const changes = await setServerUrl(rootDir, target);
    if (changes.length === 0) console.log("MCP server URL already set; nothing to change.");
    for (const change of changes) {
      console.log(`Updated ${change.file}: ${change.from} -> ${change.to}`);
    }
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
