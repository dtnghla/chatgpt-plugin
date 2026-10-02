export interface Config {
  port: number;
  host: string;
  /** Hostnames (port-agnostic, IPv6 in brackets) accepted in the Host header of /mcp requests. */
  allowedHosts: string[];
  /** Token served at /.well-known/openai-apps-challenge for OpenAI domain verification. */
  challengeToken: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const HOSTNAME_PATTERN = /^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/;
const CHALLENGE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,256}$/;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got "${raw}".`);
  }
  return port;
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const hosts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  for (const host of hosts) {
    if (!HOSTNAME_PATTERN.test(host)) {
      throw new ConfigError(
        `ALLOWED_HOSTS entry "${host}" is not a bare hostname. Use e.g. "plan.example.org" (no scheme, port or path).`,
      );
    }
  }
  return [...new Set(hosts)];
}

function parseChallengeToken(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  if (token === undefined || token === "") return undefined;
  if (!CHALLENGE_TOKEN_PATTERN.test(token)) {
    throw new ConfigError(
      "OPENAI_APPS_CHALLENGE_TOKEN must be 8-256 characters of letters, digits, '.', '_', '~' or '-'.",
    );
  }
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = parsePort(env.PORT);
  const configuredHosts = parseAllowedHosts(env.ALLOWED_HOSTS);
  const loopback = isLoopbackHost(host);

  if (!loopback && configuredHosts.length === 0) {
    throw new ConfigError(
      `HOST is "${host}", which is reachable from other machines. Set ALLOWED_HOSTS to the public hostname(s) of this server (comma-separated, e.g. ALLOWED_HOSTS=plan.example.org) so Host header validation can protect it.`,
    );
  }

  const allowedHosts = loopback
    ? [...new Set([...LOOPBACK_HOSTNAMES, ...configuredHosts])]
    : configuredHosts;

  return {
    port,
    host,
    allowedHosts,
    challengeToken: parseChallengeToken(env.OPENAI_APPS_CHALLENGE_TOKEN),
  };
}
