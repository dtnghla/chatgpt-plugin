import { describe, expect, it } from "vitest";
import {
  BundleQuota,
  invalidKeyMessage,
  type LicensingContext,
  type LicensingSettings,
  licenseFromHeader,
  projectLimitMessage,
  quotaMessage,
  resolveEntitlement,
} from "../../src/licensing/entitlements.js";
import { generateLicenseKey } from "../../src/licensing/license.js";

const SECRET = "entitlement-test-signing-secret";

function settings(overrides: Partial<LicensingSettings> = {}): LicensingSettings {
  return {
    enforced: true,
    signingSecret: SECRET,
    upgradeUrl: "https://buy.example.com/pro",
    free: { maxFiles: 2, maxSteps: 10, dailyBundles: 1 },
    ...overrides,
  };
}

function context(overrides: Partial<LicensingSettings> = {}): LicensingContext {
  return { settings: settings(overrides), quota: new BundleQuota() };
}

describe("BundleQuota", () => {
  it("counts uses inside the rolling window and forgets old ones", () => {
    const quota = new BundleQuota();
    const start = Date.now();
    expect(quota.used(start)).toBe(0);
    quota.record(start);
    quota.record(start + 1_000);
    expect(quota.used(start + 2_000)).toBe(2);
    expect(quota.used(start + 25 * 60 * 60 * 1000)).toBe(0);
  });
});

describe("resolveEntitlement", () => {
  it("grants pro when licensing is disabled or not enforced", () => {
    expect(resolveEntitlement(undefined, undefined, undefined)).toEqual({ tier: "pro" });
    expect(resolveEntitlement(context({ enforced: false }), undefined, undefined)).toEqual({
      tier: "pro",
    });
  });

  it("resolves free for callers without a key", () => {
    expect(resolveEntitlement(context(), undefined, undefined)).toEqual({ tier: "free" });
  });

  it("resolves pro for a valid license key argument", () => {
    const key = generateLicenseKey({ subject: "alice@example.com" }, SECRET);
    expect(resolveEntitlement(context(), key, undefined)).toEqual({ tier: "pro" });
  });

  it("returns an error message for an invalid license key argument", () => {
    const resolved = resolveEntitlement(context(), "PTA1.BOGUS.BOGUS", undefined);
    expect(resolved.tier).toBe("free");
    expect(resolved.error).toContain("not a valid license");
    expect(resolved.error).toContain("https://buy.example.com/pro");
  });

  it("prefers the license argument over the connection header", () => {
    const header = generateLicenseKey({}, SECRET);
    expect(resolveEntitlement(context(), "garbage", undefined).error).toBeDefined();
    const resolved = resolveEntitlement(
      context(),
      undefined,
      licenseFromHeader(settings(), header),
    );
    expect(resolved).toEqual({ tier: "pro" });
  });

  it("falls back to free when the header license is missing", () => {
    expect(resolveEntitlement(context(), undefined, undefined)).toEqual({ tier: "free" });
    expect(resolveEntitlement(context(), undefined, undefined)).not.toHaveProperty("error");
  });
});

describe("licenseFromHeader", () => {
  it("verifies a valid header value and rejects invalid ones", () => {
    const key = generateLicenseKey({ subject: "header@example.com" }, SECRET);
    expect(licenseFromHeader(settings(), key)).toMatchObject({
      tier: "pro",
      subject: "header@example.com",
    });
    expect(licenseFromHeader(settings(), "PTA1.BOGUS.BOGUS")).toBeUndefined();
    expect(licenseFromHeader(settings({ signingSecret: undefined }), key)).toBeUndefined();
    expect(licenseFromHeader(undefined, key)).toBeUndefined();
    expect(licenseFromHeader(settings(), "   ")).toBeUndefined();
  });
});

describe("limit messages", () => {
  it("lists both over-limit dimensions and the upgrade URL", () => {
    const message = projectLimitMessage(settings(), 7, 38);
    expect(message).toContain("7 files (free tier limit: 2)");
    expect(message).toContain("38 workflow steps (free tier limit: 10)");
    expect(message).toContain("license_key argument");
    expect(message).toContain("https://buy.example.com/pro");
  });

  it("describes quota exhaustion", () => {
    const message = quotaMessage(settings(), 1);
    expect(message).toContain("limited to 1 per rolling 24 hours (1 used)");
    expect(message).toContain("https://buy.example.com/pro");
  });

  it("omits the upgrade line when no URL is configured", () => {
    const noUrl = settings({ upgradeUrl: undefined });
    expect(projectLimitMessage(noUrl, 7, 1)).not.toContain("Upgrade to Pro");
    expect(invalidKeyMessage(noUrl)).not.toContain("To buy a license");
  });
});
