import { describe, expect, it } from "vitest";
import { hostAllowed, isPrivateAddress } from "../../src/ingest/fetch-file.js";

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not an address",
  ])("treats %s as unsafe", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "203.114.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "treats %s as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("hostAllowed", () => {
  const allowlist = ["oaiusercontent.com", "openai.com"];

  it("accepts exact hosts and subdomains case-insensitively", () => {
    expect(hostAllowed("openai.com", allowlist)).toBe(true);
    expect(hostAllowed("files.oaiusercontent.com", allowlist)).toBe(true);
    expect(hostAllowed("FILES.OAIUSERCONTENT.COM.", allowlist)).toBe(true);
  });

  it("rejects other hosts and suffix tricks", () => {
    expect(hostAllowed("evilopenai.com", allowlist)).toBe(false);
    expect(hostAllowed("openai.com.evil.example", allowlist)).toBe(false);
    expect(hostAllowed("example.com", allowlist)).toBe(false);
    expect(hostAllowed("openai.com", [])).toBe(false);
  });

  it("normalises leading dots and trailing dots in allowlist entries", () => {
    expect(hostAllowed("cdn.example.com", [".example.com."])).toBe(true);
  });
});
