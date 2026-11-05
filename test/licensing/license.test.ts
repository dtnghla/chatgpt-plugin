import { describe, expect, it } from "vitest";
import { generateLicenseKey, verifyLicenseKey } from "../../src/licensing/license.js";

const SECRET = "monetization-test-signing-secret";

describe("license keys", () => {
  it("mints a key that verifies with its fields intact", () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const key = generateLicenseKey(
      { tier: "pro", subject: "alice@example.com", days: 365, issuedAt },
      SECRET,
    );
    expect(key).toMatch(/^PTA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const verification = verifyLicenseKey(key, SECRET);
    expect(verification).toMatchObject({
      ok: true,
      license: {
        tier: "pro",
        subject: "alice@example.com",
        issuedAt,
        expiresAt: issuedAt + 365 * 86_400,
        key,
      },
    });
  });

  it("mints perpetual keys without expiry", () => {
    const key = generateLicenseKey({ subject: "bob@example.com" }, SECRET);
    const verification = verifyLicenseKey(key, SECRET);
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.license.expiresAt).toBeUndefined();
    }
  });

  it("rejects keys signed with a different secret", () => {
    const key = generateLicenseKey({ subject: "alice@example.com" }, SECRET);
    const verification = verifyLicenseKey(key, "another-signing-secret-entirely");
    expect(verification).toMatchObject({ ok: false, reason: "signature" });
  });

  it("rejects tampered payloads", () => {
    const key = generateLicenseKey({ subject: "alice@example.com" }, SECRET);
    const [prefix, payload, signature] = key.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ t: "pro", s: "mallory@example.com" }),
      "utf8",
    ).toString("base64url");
    expect(prefix).toBe("PTA1");
    expect(forgedPayload).not.toBe(payload);
    const verification = verifyLicenseKey(`${prefix}.${forgedPayload}.${signature}`, SECRET);
    expect(verification).toMatchObject({ ok: false, reason: "signature" });
  });

  it("rejects expired keys", () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const key = generateLicenseKey({ days: 1, issuedAt }, SECRET);
    const verification = verifyLicenseKey(key, SECRET);
    expect(verification).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects malformed keys", () => {
    for (const key of ["", "not-a-key", "PTA1.only-two", "PTA1.!!!.???", "PTA1.ABCD.ABCD"]) {
      const verification = verifyLicenseKey(key, SECRET);
      expect(verification.ok, key).toBe(false);
    }
  });

  it("rejects payloads with an unknown tier", () => {
    const key = generateLicenseKey({ subject: "alice@example.com" }, SECRET);
    const [, , signature] = key.split(".");
    const forged = Buffer.from(JSON.stringify({ t: "enterprise" }), "utf8").toString("base64url");
    const verification = verifyLicenseKey(`PTA1.${forged}.${signature}`, SECRET);
    expect(verification.ok).toBe(false);
  });

  it("rejects minting with a weak secret and oversized subjects", () => {
    expect(() => generateLicenseKey({}, "short")).toThrow(/at least 16 characters/);
    expect(() => generateLicenseKey({ subject: "x".repeat(201) }, SECRET)).toThrow(
      /at most 200 characters/,
    );
    expect(() => generateLicenseKey({ days: 0 }, SECRET)).toThrow(/positive number/);
  });
});
