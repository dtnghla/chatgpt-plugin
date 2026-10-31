import { describe, expect, it } from "vitest";
import { ConfigError, isLoopbackHost, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to a loopback bind with safe artifact and upload settings", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3000,
      host: "127.0.0.1",
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      challengeToken: undefined,
      fileHostAllowlist: ["oaiusercontent.com", "openai.com"],
      widgetDomain: undefined,
      artifactStore: "memory",
      artifactBucket: undefined,
      awsRegion: "us-east-1",
      publicBaseUrl: undefined,
      artifactTtlSeconds: 900,
    });
    expect(config.artifactSigningSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(loadConfig({}).artifactSigningSecret).not.toBe(config.artifactSigningSecret);
  });

  it("refuses a public bind without ALLOWED_HOSTS", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(ConfigError);
    expect(() => loadConfig({ HOST: "::" })).toThrow(/ALLOWED_HOSTS/);
  });

  it("accepts a public bind with explicit hosts and normalises them", () => {
    const config = loadConfig({
      HOST: "0.0.0.0",
      ALLOWED_HOSTS: " MCP.Example.org, api.example.org ,,",
    });
    expect(config.allowedHosts).toEqual(["mcp.example.org", "api.example.org"]);
  });

  it("keeps loopback names when extra hosts are configured on a loopback bind", () => {
    expect(loadConfig({ ALLOWED_HOSTS: "mcp.example.org" }).allowedHosts).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "mcp.example.org",
    ]);
  });

  it.each([
    "https://mcp.example.org",
    "mcp.example.org:3000",
    "mcp.example.org/mcp",
    "bad host",
    ".example.org",
    "*.example.org",
  ])("rejects ALLOWED_HOSTS entry %s", (entry) => {
    expect(() => loadConfig({ HOST: "0.0.0.0", ALLOWED_HOSTS: entry })).toThrow(ConfigError);
  });

  it("accepts a bracketed IPv6 allowed host", () => {
    expect(loadConfig({ HOST: "::", ALLOWED_HOSTS: "[2001:db8::1]" }).allowedHosts).toEqual([
      "[2001:db8::1]",
    ]);
  });

  it.each(["abc", "-1", "70000", "3000.5"])("rejects PORT %s", (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });

  it("parses PORT", () => {
    expect(loadConfig({ PORT: "8080" }).port).toBe(8080);
    expect(loadConfig({ PORT: "0" }).port).toBe(0);
    expect(loadConfig({ PORT: "" }).port).toBe(3000);
  });

  it("validates the challenge token", () => {
    expect(loadConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "abc123_DEF-456" }).challengeToken).toBe(
      "abc123_DEF-456",
    );
    expect(loadConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "  " }).challengeToken).toBeUndefined();
    expect(() => loadConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "short" })).toThrow(
      /OPENAI_APPS_CHALLENGE_TOKEN/,
    );
    expect(() => loadConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "has space and <tags>" })).toThrow(
      ConfigError,
    );
  });

  it("validates and normalises FILE_HOST_ALLOWLIST", () => {
    expect(
      loadConfig({ FILE_HOST_ALLOWLIST: " Files.Example.com,openai.com,openai.com " })
        .fileHostAllowlist,
    ).toEqual(["files.example.com", "openai.com"]);
    expect(() => loadConfig({ FILE_HOST_ALLOWLIST: "" })).toThrow(/at least one hostname/);
    expect(() => loadConfig({ FILE_HOST_ALLOWLIST: "localhost" })).toThrow(/loopback/);
    expect(() => loadConfig({ FILE_HOST_ALLOWLIST: "127.0.0.1" })).toThrow(/loopback/);
    expect(() => loadConfig({ FILE_HOST_ALLOWLIST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ FILE_HOST_ALLOWLIST: "https://files.example.com" })).toThrow(
      /bare DNS hostname/,
    );
    expect(() => loadConfig({ FILE_HOST_ALLOWLIST: "[2001:db8::1]" })).toThrow(/bare DNS hostname/);
  });

  it("validates public origins and widget domains", () => {
    expect(loadConfig({ PUBLIC_BASE_URL: "https://MCP.Example.org/some/path" }).publicBaseUrl).toBe(
      "https://mcp.example.org",
    );
    expect(loadConfig({ WIDGET_DOMAIN: "http://localhost:3001" }).widgetDomain).toBe(
      "http://localhost:3001",
    );
    expect(loadConfig({ PUBLIC_BASE_URL: "http://127.0.0.1:3000" }).publicBaseUrl).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() => loadConfig({ PUBLIC_BASE_URL: "http://mcp.example.org" })).toThrow(/https/);
    expect(() => loadConfig({ PUBLIC_BASE_URL: "mcp.example.org" })).toThrow(/absolute https/);
    expect(() => loadConfig({ PUBLIC_BASE_URL: "https://user:pass@mcp.example.org" })).toThrow(
      /credentials/,
    );
    expect(() => loadConfig({ WIDGET_DOMAIN: "https://mcp.example.org/?a=1" })).toThrow(/query/);
    expect(() => loadConfig({ WIDGET_DOMAIN: "https://mcp.example.org/#x" })).toThrow(/fragment/);
  });

  it("validates the artifact store configuration", () => {
    expect(loadConfig({ ARTIFACT_STORE: " MEMORY " }).artifactStore).toBe("memory");
    expect(() => loadConfig({ ARTIFACT_STORE: "redis" })).toThrow(/ARTIFACT_STORE/);
    expect(() => loadConfig({ ARTIFACT_STORE: "s3" })).toThrow(/ARTIFACT_BUCKET/);
    expect(loadConfig({ ARTIFACT_STORE: "s3", ARTIFACT_BUCKET: "my-bucket" })).toMatchObject({
      artifactStore: "s3",
      artifactBucket: "my-bucket",
    });
    for (const bucket of ["ab", "MyBucket", "bucket_name", "a..b", "bucket."]) {
      expect(() => loadConfig({ ARTIFACT_STORE: "s3", ARTIFACT_BUCKET: bucket })).toThrow(
        /not a valid S3 bucket/,
      );
    }
  });

  it("validates the AWS region", () => {
    expect(loadConfig({ AWS_REGION: " eu-west-2 " }).awsRegion).toBe("eu-west-2");
    expect(loadConfig({ AWS_REGION: "us-gov-west-1" }).awsRegion).toBe("us-gov-west-1");
    for (const region of ["us-east", "us-east-1a", "not a region", ""]) {
      expect(() => loadConfig({ AWS_REGION: region })).toThrow(/AWS_REGION/);
    }
  });

  it("validates the artifact TTL", () => {
    expect(loadConfig({ ARTIFACT_TTL_SECONDS: "60" }).artifactTtlSeconds).toBe(60);
    expect(loadConfig({ ARTIFACT_TTL_SECONDS: "86400" }).artifactTtlSeconds).toBe(86_400);
    for (const ttl of ["0", "59", "86401", "900.5", "soon"]) {
      expect(() => loadConfig({ ARTIFACT_TTL_SECONDS: ttl })).toThrow(/ARTIFACT_TTL_SECONDS/);
    }
  });

  it("uses a configured signing secret or generates one", () => {
    expect(loadConfig({ ARTIFACT_SIGNING_SECRET: "  my-secret  " }).artifactSigningSecret).toBe(
      "my-secret",
    );
    expect(loadConfig({ ARTIFACT_SIGNING_SECRET: "   " }).artifactSigningSecret).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])(
    "%s is loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "::", "10.0.0.1", "example.org", "128.0.0.1"])(
    "%s is not loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});
