import { createHmac, timingSafeEqual } from "node:crypto";

export type LicenseTier = "pro";

export interface LicenseInfo {
  tier: LicenseTier;
  /** Customer identifier recorded at mint time, usually an email address. */
  subject?: string;
  /** Epoch seconds the key was minted. */
  issuedAt?: number;
  /** Epoch seconds after which the key stops verifying. Absent for perpetual keys. */
  expiresAt?: number;
}

export interface VerifiedLicense extends LicenseInfo {
  /** The exact key string that verified. */
  key: string;
}

export type LicenseVerification =
  | { ok: true; license: VerifiedLicense }
  | { ok: false; reason: "format" | "signature" | "payload" | "expired" };

/**
 * Signed, offline-verifiable license keys. Format:
 * `PTA1.<base64url payload>.<base64url signature>` where the payload is a
 * compact JSON object and the signature is HMAC-SHA256 over `PTA1.<payload>`
 * with the deployment's signing secret. Verification needs only the secret,
 * so the server never calls out to a license service.
 */
const LICENSE_PREFIX = "PTA1";
const KEY_PATTERN = /^PTA1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const MAX_SUBJECT_CHARS = 200;

function sign(payloadSegment: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${LICENSE_PREFIX}.${payloadSegment}`).digest();
}

export interface MintLicenseInput {
  tier?: LicenseTier;
  subject?: string;
  issuedAt?: number;
  /** Key lifetime in days. Omit for a perpetual key. */
  days?: number;
}

export function generateLicenseKey(input: MintLicenseInput, secret: string): string {
  if (secret.trim().length < 16) {
    throw new Error("The signing secret must be at least 16 characters.");
  }
  const subject = input.subject?.trim();
  if (subject && subject.length > MAX_SUBJECT_CHARS) {
    throw new Error(`The license subject must be at most ${MAX_SUBJECT_CHARS} characters.`);
  }
  const issuedAt = Math.floor(input.issuedAt ?? Date.now() / 1000);
  const payload: Record<string, unknown> = { t: input.tier ?? "pro" };
  if (subject) payload.s = subject;
  payload.i = issuedAt;
  if (input.days !== undefined) {
    if (!Number.isFinite(input.days) || input.days <= 0) {
      throw new Error("License days must be a positive number.");
    }
    payload.x = issuedAt + Math.floor(input.days * 86_400);
  }
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signatureSegment = sign(payloadSegment, secret).toString("base64url");
  return `${LICENSE_PREFIX}.${payloadSegment}.${signatureSegment}`;
}

function decodePayload(segment: string): Record<string, unknown> | undefined {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function verifyLicenseKey(key: string, secret: string): LicenseVerification {
  const trimmed = key.trim();
  const match = KEY_PATTERN.exec(trimmed);
  if (!match) return { ok: false, reason: "format" };
  const payloadSegment = match[1];
  const signatureSegment = match[2];
  if (payloadSegment === undefined || signatureSegment === undefined) {
    return { ok: false, reason: "format" };
  }
  const expected = sign(payloadSegment, secret);
  const provided = Buffer.from(signatureSegment, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "signature" };
  }
  const payload = decodePayload(payloadSegment);
  if (!payload) return { ok: false, reason: "payload" };
  const { t, s, i, x } = payload;
  if (t !== "pro") return { ok: false, reason: "payload" };
  if (s !== undefined && (typeof s !== "string" || s.length > MAX_SUBJECT_CHARS)) {
    return { ok: false, reason: "payload" };
  }
  if (i !== undefined && (typeof i !== "number" || !Number.isInteger(i))) {
    return { ok: false, reason: "payload" };
  }
  if (x !== undefined) {
    if (typeof x !== "number" || !Number.isInteger(x)) return { ok: false, reason: "payload" };
    if (x <= Date.now() / 1000) return { ok: false, reason: "expired" };
  }
  const license: VerifiedLicense = {
    key: trimmed,
    tier: "pro",
    ...(s !== undefined ? { subject: s } : {}),
    ...(i !== undefined ? { issuedAt: i } : {}),
    ...(x !== undefined ? { expiresAt: x } : {}),
  };
  return { ok: true, license };
}

/** HTTP header that carries a license key for hosts that support custom connection headers. */
export const LICENSE_HEADER = "x-pentaho-license-key";
