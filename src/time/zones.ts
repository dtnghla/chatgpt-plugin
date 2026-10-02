import { Temporal } from "temporal-polyfill";
import { TimeInputError } from "./types.js";

const IANA_SHAPE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+$/;
const ABBREVIATION_SHAPE = /^[A-Za-z]{2,5}$/;
const NUMERIC_OFFSET_SHAPE = /^[+-]\d{1,2}(?::?\d{2})?$/;

/**
 * Validates a time zone id and returns it as Temporal reports it. Temporal fixes the
 * letter case but keeps link names as given, so "asia/calcutta" becomes "Asia/Calcutta"
 * and is NOT rewritten to "Asia/Kolkata".
 */
export function canonicalTimeZone(id: string): string {
  if (typeof id !== "string") {
    throw new TimeInputError('Time zone must be a string such as "America/New_York".');
  }
  const trimmed = id.trim();
  if (trimmed === "") {
    throw new TimeInputError(
      'Time zone must not be empty. Use an IANA name such as "America/New_York" or "UTC".',
    );
  }
  if (trimmed.toUpperCase() === "UTC") {
    return "UTC";
  }
  if (NUMERIC_OFFSET_SHAPE.test(trimmed)) {
    throw new TimeInputError(
      `"${trimmed}" is a numeric UTC offset, which is not supported because it cannot follow daylight saving rules. Use an IANA time zone name such as "America/New_York" or "Asia/Kolkata".`,
    );
  }
  if (ABBREVIATION_SHAPE.test(trimmed)) {
    throw new TimeInputError(
      `"${trimmed}" is an ambiguous time zone abbreviation (for example CST can mean US Central, China or Cuba time). Use an IANA time zone name such as "America/Chicago" instead.`,
    );
  }
  if (!IANA_SHAPE.test(trimmed)) {
    throw invalidZone(trimmed);
  }
  try {
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(trimmed).timeZoneId;
  } catch {
    throw invalidZone(trimmed);
  }
}

function invalidZone(id: string): TimeInputError {
  return new TimeInputError(
    `"${id}" is not a known IANA time zone. Use a name such as "America/New_York", "Europe/London" or "Asia/Kolkata".`,
  );
}

export function zonedAt(epochMs: number, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
}
