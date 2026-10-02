import { describe, expect, it } from "vitest";
import { ConfigError, isLoopbackHost, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to a loopback bind on port 3000 with localhost hosts allowed", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 3000,
      host: "127.0.0.1",
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      challengeToken: undefined,
    });
  });

  it("refuses a public bind without ALLOWED_HOSTS", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(ConfigError);
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/ALLOWED_HOSTS/);
  });

  it("accepts a public bind with explicit hosts and normalises them", () => {
    const config = loadConfig({
      HOST: "0.0.0.0",
      ALLOWED_HOSTS: " Plan.Example.org, api.example.org ,,",
    });
    expect(config.allowedHosts).toEqual(["plan.example.org", "api.example.org"]);
  });

  it("keeps loopback names when extra hosts are configured on a loopback bind", () => {
    const config = loadConfig({ ALLOWED_HOSTS: "plan.example.org" });
    expect(config.allowedHosts).toEqual(["localhost", "127.0.0.1", "[::1]", "plan.example.org"]);
  });

  it.each([
    "https://plan.example.org",
    "plan.example.org:3000",
    "plan.example.org/mcp",
    "bad host",
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
