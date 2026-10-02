import { Temporal } from "temporal-polyfill";
import type { IsoWeekday } from "./types.js";
import { TimeInputError } from "./types.js";

const MS_PER_MINUTE = 60_000;
const NS_PER_MINUTE = 60_000_000_000;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const CLOCK_SHAPE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const minutesToMs = (minutes: number): number => minutes * MS_PER_MINUTE;

export function parseDate(text: string, label: string): Temporal.PlainDate {
  if (typeof text !== "string" || !DATE_SHAPE.test(text)) {
    throw new TimeInputError(
      `${label} must be a date in the form YYYY-MM-DD, got "${String(text)}".`,
    );
  }
  try {
    return Temporal.PlainDate.from(text, { overflow: "reject" });
  } catch {
    throw new TimeInputError(`${label} "${text}" is not a real calendar date.`);
  }
}

export function parseLocalDateTime(text: string): Temporal.PlainDateTime {
  if (typeof text !== "string" || !LOCAL_DATE_TIME_SHAPE.test(text)) {
    throw new TimeInputError(
      `date_time must be a local time in the form YYYY-MM-DDTHH:mm with no offset or "Z" (got "${String(text)}"). The zone is given separately in from_time_zone.`,
    );
  }
  try {
    return Temporal.PlainDateTime.from(text, { overflow: "reject" });
  } catch {
    throw new TimeInputError(`date_time "${text}" is not a real calendar date and time.`);
  }
}

export function parseClock(text: string, label: string): Temporal.PlainTime {
  if (typeof text !== "string" || !CLOCK_SHAPE.test(text)) {
    throw new TimeInputError(
      `${label} must be a 24-hour time HH:mm between 00:00 and 23:59, got "${String(text)}".`,
    );
  }
  return Temporal.PlainTime.from(text);
}

export function isClock(text: string): boolean {
  return CLOCK_SHAPE.test(text);
}

export function toIsoWeekday(dayOfWeek: number): IsoWeekday {
  switch (dayOfWeek) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
      return dayOfWeek;
    default:
      throw new Error(`Unexpected ISO weekday ${dayOfWeek}`);
  }
}

export function formatLocalDateTime(zoned: Temporal.ZonedDateTime): string {
  return zoned.toPlainDateTime().toString({ smallestUnit: "minute" });
}

export function formatInstant(epochMs: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toString({ smallestUnit: "second" });
}

export function formatOffset(offsetNanoseconds: number): string {
  const totalMinutes = Math.trunc(Math.abs(offsetNanoseconds) / NS_PER_MINUTE);
  const sign = offsetNanoseconds < 0 ? "-" : "+";
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}
