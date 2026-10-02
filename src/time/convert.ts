import { Temporal } from "temporal-polyfill";
import {
  formatInstant,
  formatLocalDateTime,
  formatOffset,
  parseLocalDateTime,
  toIsoWeekday,
} from "./clock.js";
import type { ConvertInput, ConvertResult, DstAdjustment, ZonedMoment } from "./types.js";
import { TimeInputError } from "./types.js";
import { canonicalTimeZone } from "./zones.js";

const MIN_TARGETS = 1;
const MAX_TARGETS = 24;

export function convertTime(input: ConvertInput): ConvertResult {
  const requested = parseLocalDateTime(input.date_time);
  const fromZone = canonicalTimeZone(input.from_time_zone);
  const targetZones = normalizeTargets(input.to_time_zones);

  const { resolved, adjustment } = resolveInZone(requested, fromZone);
  const sourceDate = resolved.toPlainDate();

  return {
    source: toMoment(resolved, sourceDate),
    requested_date_time: requested.toString({ smallestUnit: "minute" }),
    dst_adjustment: adjustment,
    utc: formatInstant(resolved.epochMilliseconds),
    targets: targetZones.map((zone) => toMoment(resolved.withTimeZone(zone), sourceDate)),
  };
}

function normalizeTargets(zones: string[]): string[] {
  if (!Array.isArray(zones) || zones.length < MIN_TARGETS || zones.length > MAX_TARGETS) {
    throw new TimeInputError(
      `to_time_zones must contain between ${MIN_TARGETS} and ${MAX_TARGETS} time zones.`,
    );
  }
  return zones.map(canonicalTimeZone);
}

function resolveInZone(
  requested: Temporal.PlainDateTime,
  timeZone: string,
): { resolved: Temporal.ZonedDateTime; adjustment: DstAdjustment } {
  const resolved = requested.toZonedDateTime(timeZone, { disambiguation: "compatible" });
  if (Temporal.PlainDateTime.compare(resolved.toPlainDateTime(), requested) !== 0) {
    return { resolved, adjustment: "gap" };
  }
  const later = requested.toZonedDateTime(timeZone, { disambiguation: "later" });
  const adjustment = later.epochMilliseconds === resolved.epochMilliseconds ? "none" : "overlap";
  return { resolved, adjustment };
}

function toMoment(zoned: Temporal.ZonedDateTime, sourceDate: Temporal.PlainDate): ZonedMoment {
  const localDate = zoned.toPlainDate();
  return {
    time_zone: zoned.timeZoneId,
    local_date_time: formatLocalDateTime(zoned),
    utc_offset: formatOffset(zoned.offsetNanoseconds),
    weekday: toIsoWeekday(zoned.dayOfWeek),
    day_offset: sourceDate.until(localDate, { largestUnit: "days" }).days,
    is_dst: isDaylightTime(zoned),
  };
}

/**
 * A zone is on daylight time when its offset exceeds the smallest offset it uses during the
 * same calendar year, sampled monthly. This also holds for southern-hemisphere zones and
 * for Europe/Dublin, whose tz database "standard" time is the summer one (negative DST):
 * the larger offset is reported as DST.
 */
function isDaylightTime(zoned: Temporal.ZonedDateTime): boolean {
  const { year, timeZoneId } = zoned;
  let smallest = zoned.offsetNanoseconds;
  for (let month = 1; month <= 12; month++) {
    const sample = Temporal.ZonedDateTime.from({
      year,
      month,
      day: 1,
      hour: 12,
      timeZone: timeZoneId,
    });
    smallest = Math.min(smallest, sample.offsetNanoseconds);
  }
  return zoned.offsetNanoseconds > smallest;
}
