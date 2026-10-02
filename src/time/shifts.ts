import { Temporal } from "temporal-polyfill";
import { parseClock } from "./clock.js";
import type { Participant } from "./types.js";
import { zonedAt } from "./zones.js";

const MS_PER_MINUTE = 60_000;

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

export interface ShiftTimeline {
  /** Individual shifts, ordered by start; used for the comfort score. */
  shifts: Interval[];
  /** Shifts with overlapping or exactly touching neighbours merged; used for availability. */
  merged: Interval[];
}

/**
 * Builds every shift of a participant that could intersect [fromMs, toMs]. A shift belongs
 * to the local day it starts on, so the day before the range is included for overnight
 * shifts. Boundary times that fall in a DST gap or overlap use "compatible" resolution.
 */
export function buildShiftTimeline(
  participant: Participant,
  fromMs: number,
  toMs: number,
): ShiftTimeline {
  const { time_zone: timeZone } = participant;
  const workStart = parseClock(participant.work_start, "work_start");
  const workEnd = parseClock(participant.work_end, "work_end");
  const endsNextDay = participant.work_end <= participant.work_start;
  const workDays = new Set<number>(participant.work_days);

  const firstDay = zonedAt(fromMs, timeZone).toPlainDate().subtract({ days: 1 });
  const lastDay = zonedAt(toMs, timeZone).toPlainDate().add({ days: 1 });

  const shifts: Interval[] = [];
  for (
    let day: Temporal.PlainDate = firstDay;
    Temporal.PlainDate.compare(day, lastDay) <= 0;
    day = day.add({ days: 1 })
  ) {
    if (!workDays.has(day.dayOfWeek)) {
      continue;
    }
    const endDay = endsNextDay ? day.add({ days: 1 }) : day;
    const start = day.toZonedDateTime({ timeZone, plainTime: workStart }).epochMilliseconds;
    const end = endDay.toZonedDateTime({ timeZone, plainTime: workEnd }).epochMilliseconds;
    if (end > start) {
      shifts.push({ start, end });
    }
  }
  return { shifts, merged: mergeIntervals(shifts) };
}

export function mergeIntervals(sorted: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function containsInstant(intervals: Interval[], instant: number): boolean {
  return intervals.some((interval) => interval.start <= instant && instant < interval.end);
}

export function containsSpan(intervals: Interval[], start: number, end: number): boolean {
  return intervals.some((interval) => interval.start <= start && end <= interval.end);
}

/** Minutes between the span's midpoint and the middle of the shift holding that midpoint. */
export function distanceFromShiftCentre(
  timeline: ShiftTimeline,
  start: number,
  end: number,
): number {
  const midpoint = (start + end) / 2;
  const holder =
    timeline.shifts.find((shift) => shift.start <= midpoint && midpoint < shift.end) ??
    timeline.merged.find((shift) => shift.start <= midpoint && midpoint < shift.end);
  if (holder === undefined) {
    return 0;
  }
  return Math.abs(midpoint - (holder.start + holder.end) / 2) / MS_PER_MINUTE;
}
