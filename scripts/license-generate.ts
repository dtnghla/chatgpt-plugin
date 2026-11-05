import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generateLicenseKey, verifyLicenseKey } from "../src/licensing/license.js";

function usage(): string {
  return [
    "Mint or verify a Pro license key for this deployment.",
    "",
    "Mint:  npm run license:generate -- --email alice@example.com [--days 365] [--secret <secret>]",
    "Verify: npm run license:generate -- --verify PTA1.<payload>.<signature> [--secret <secret>]",
    "",
    "The secret comes from --secret or the LICENSE_SIGNING_SECRET environment variable and",
    "must match LICENSE_SIGNING_SECRET configured on the server. Omit --days for a perpetual key.",
  ].join("\n");
}

function resolveSecret(explicit: string | undefined): string {
  const secret = explicit?.trim() || process.env.LICENSE_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "No signing secret. Pass --secret or set LICENSE_SIGNING_SECRET (it must match the server's value).",
    );
  }
  return secret;
}

export interface MintOptions {
  email?: string;
  days?: number;
  secret: string;
  now?: number;
}

export function mintLicenseKey(options: MintOptions): string {
  return generateLicenseKey(
    {
      tier: "pro",
      subject: options.email,
      days: options.days,
      issuedAt: options.now,
    },
    options.secret,
  );
}

export function verifyWithSecret(key: string, secret: string): string {
  const verification = verifyLicenseKey(key, secret);
  if (!verification.ok) return `INVALID (${verification.reason})`;
  const { tier, subject, expiresAt } = verification.license;
  const expiry =
    expiresAt === undefined ? "never (perpetual)" : new Date(expiresAt * 1000).toISOString();
  return `VALID tier=${tier} subject=${subject ?? "-"} expires=${expiry}`;
}

function parseDays(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number of days, got "${raw}".`);
  }
  return days;
}

async function main(argv: string[]): Promise<number> {
  let values: {
    email?: string;
    days?: string;
    secret?: string;
    verify?: string;
  };
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: "string" },
        days: { type: "string" },
        secret: { type: "string" },
        verify: { type: "string" },
      },
      argv,
    }));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    return 1;
  }
  try {
    if (values.verify !== undefined) {
      const secret = resolveSecret(values.secret);
      console.log(verifyWithSecret(values.verify, secret));
      return 0;
    }
    const secret = resolveSecret(values.secret);
    const key = mintLicenseKey({
      email: values.email,
      days: parseDays(values.days),
      secret,
    });
    console.log(key);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
