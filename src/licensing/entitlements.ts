import { type LicenseVerification, type VerifiedLicense, verifyLicenseKey } from "./license.js";

export interface FreeLimits {
  /** Maximum project files (after archive extraction) a free-tier call may contain. */
  maxFiles: number;
  /** Maximum workflow steps (transformation steps plus job entries) per free-tier call. */
  maxSteps: number;
  /** Bundle generations allowed per free tier per rolling 24 hours. */
  dailyBundles: number;
}

export interface LicensingSettings {
  /** True when LICENSE_MODE=enforced: free-tier gates are active. */
  enforced: boolean;
  signingSecret: string | undefined;
  /** Purchase page shown in upgrade messages, e.g. a Stripe payment link. */
  upgradeUrl: string | undefined;
  free: FreeLimits;
}

/**
 * In-memory rolling 24-hour counter of free-tier bundle generations.
 * It lives in one server process: replicas keep separate counts, which only
 * ever over-charges the free tier, never under-charges paying users.
 */
export class BundleQuota {
  private readonly hits: number[] = [];

  constructor(private readonly windowMs: number = 24 * 60 * 60 * 1000) {}

  used(now: number = Date.now()): number {
    this.prune(now);
    return this.hits.length;
  }

  record(now: number = Date.now()): void {
    this.prune(now);
    this.hits.push(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (;;) {
      const oldest = this.hits[0];
      if (oldest === undefined || oldest > cutoff) break;
      this.hits.shift();
    }
  }
}

export interface LicensingContext {
  settings: LicensingSettings;
  quota: BundleQuota;
}

export type ResolvedEntitlement =
  | { tier: "pro"; error?: undefined }
  | { tier: "free"; error?: undefined }
  | { tier: "free"; error: string };

/**
 * Decide the tier for one tool call. A license passed as a tool argument wins
 * over the connection header so users can retry with a fresh key without
 * reconnecting. With licensing disabled or not enforced, everything is pro.
 */
export function resolveEntitlement(
  licensing: LicensingContext | undefined,
  licenseArg: string | undefined,
  headerLicense: VerifiedLicense | undefined,
): ResolvedEntitlement {
  if (!licensing || !licensing.settings.enforced) return { tier: "pro" };
  if (licenseArg !== undefined) {
    const verification = verifyLicenseKey(licenseArg, licensing.settings.signingSecret ?? "");
    if (!verification.ok) {
      return { tier: "free", error: invalidKeyMessage(licensing.settings) };
    }
    return { tier: "pro" };
  }
  if (headerLicense) return { tier: "pro" };
  return { tier: "free" };
}

function upgradeSuffix(settings: LicensingSettings): string {
  return settings.upgradeUrl ? `\nUpgrade to Pro: ${settings.upgradeUrl}` : "";
}

export function invalidKeyMessage(settings: LicensingSettings): string {
  const base =
    "The license_key argument is not a valid license for this server: it is malformed, signed by a different secret, or expired. Check the key and pass it again.";
  if (settings.upgradeUrl) return `${base} To buy a license: ${settings.upgradeUrl}`;
  return base;
}

export function projectLimitMessage(
  settings: LicensingSettings,
  files: number,
  steps: number,
): string {
  const { maxFiles, maxSteps } = settings.free;
  const parts: string[] = [];
  if (files > maxFiles) parts.push(`${files} files (free tier limit: ${maxFiles})`);
  if (steps > maxSteps) parts.push(`${steps} workflow steps (free tier limit: ${maxSteps})`);
  return [
    `This project exceeds the free tier: ${parts.join(" and ")}.`,
    "Pass a Pro license key with the license_key argument (or the x-pentaho-license-key header) to analyze projects of any size.",
    upgradeSuffix(settings),
  ].join("\n");
}

export function quotaMessage(settings: LicensingSettings, used: number): string {
  const { dailyBundles } = settings.free;
  return [
    `Free tier bundle generation is limited to ${dailyBundles} per rolling 24 hours (${used} used).`,
    "Pass a Pro license key with the license_key argument (or the x-pentaho-license-key header) for unlimited generations, or try again after the window frees up.",
    upgradeSuffix(settings),
  ].join("\n");
}

/** Resolve the license carried on the HTTP connection, if any. */
export function licenseFromHeader(
  settings: LicensingSettings | undefined,
  headerValue: string | undefined,
): VerifiedLicense | undefined {
  if (!settings?.signingSecret || headerValue === undefined || headerValue.trim() === "") {
    return undefined;
  }
  const verification: LicenseVerification = verifyLicenseKey(headerValue, settings.signingSecret);
  return verification.ok ? verification.license : undefined;
}
