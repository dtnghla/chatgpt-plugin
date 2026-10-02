import {
  formatInstant,
  formatLocalDateTime,
  formatOffset,
  minutesToMs,
  parseDate,
  toIsoWeekday,
} from "./clock.js";
import { normalizeParticipants } from "./participants.js";
import type { ShiftTimeline } from "./shifts.js";
import {
  buildShiftTimeline,
  containsInstant,
  containsSpan,
  distanceFromShiftCentre,
} from "./shifts.js";
import type {
  FindInput,
  FindResult,
  MeetingSlot,
  Participant,
  ParticipantSlotView,
} from "./types.js";
import { TimeInputError } from "./types.js";
import { zonedAt } from "./zones.js";

const STEP_CHOICES = [15, 30, 60];

interface Candidate {
  start: number;
  end: number;
  availableCount: number;
  comfort: number;
}

interface PlannedParticipant {
  participant: Participant;
  timeline: ShiftTimeline;
}

export function findMeetingTimes(input: FindInput): FindResult {
  const participants = normalizeParticipants(input.participants);
  const { days, duration_minutes: durationMinutes, step_minutes: stepMinutes } = input;
  validateSearch(input);

  const organizerZone = firstOf(participants).time_zone;
  const startDate = parseDate(input.start_date, "start_date");
  const windowStart = startDate.toZonedDateTime(organizerZone).epochMilliseconds;
  const windowEnd = startDate.add({ days }).toZonedDateTime(organizerZone).epochMilliseconds;

  const planned: PlannedParticipant[] = participants.map((participant) => ({
    participant,
    timeline: buildShiftTimeline(participant, windowStart, windowEnd),
  }));

  const candidates = scoreCandidates(
    planned,
    windowStart,
    windowEnd,
    minutesToMs(durationMinutes),
    minutesToMs(stepMinutes),
  );
  const total = participants.length;
  const hasFullOverlap = candidates.some((candidate) => candidate.availableCount === total);
  const bestCount = candidates.reduce((best, c) => Math.max(best, c.availableCount), 0);
  const pool = candidates.filter((candidate) => candidate.availableCount === bestCount);
  const picked = pickDistinct(pool.sort(compareCandidates), input.max_results);
  const slots = bestCount === 0 ? [] : picked.map((candidate) => toSlot(candidate, planned));

  return {
    has_full_overlap: hasFullOverlap,
    slots,
    searched: {
      start_date: input.start_date,
      days,
      organizer_time_zone: organizerZone,
    },
    summary: summarize({ slots, hasFullOverlap, total, days }),
  };
}

function firstOf(participants: Participant[]): Participant {
  const first = participants[0];
  if (first === undefined) {
    throw new TimeInputError("At least one participant is required.");
  }
  return first;
}

function requireInteger(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TimeInputError(
      `${field} must be a whole number from ${min} to ${max}, got ${String(value)}.`,
    );
  }
}

function validateSearch(input: FindInput): void {
  requireInteger(input.days, "days", 1, 14);
  requireInteger(input.duration_minutes, "duration_minutes", 15, 480);
  requireInteger(input.max_results, "max_results", 1, 20);
  if (!STEP_CHOICES.includes(input.step_minutes)) {
    throw new TimeInputError(
      `step_minutes must be one of ${STEP_CHOICES.join(", ")}, got ${String(input.step_minutes)}.`,
    );
  }
}

function scoreCandidates(
  planned: PlannedParticipant[],
  windowStart: number,
  windowEnd: number,
  durationMs: number,
  stepMs: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (let start = windowStart; start + durationMs <= windowEnd; start += stepMs) {
    const end = start + durationMs;
    let availableCount = 0;
    let comfort = 0;
    for (const { timeline } of planned) {
      if (containsSpan(timeline.merged, start, end)) {
        availableCount++;
        comfort += distanceFromShiftCentre(timeline, start, end);
      }
    }
    candidates.push({ start, end, availableCount, comfort });
  }
  return candidates.filter((candidate) => candidate.availableCount > 0);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return a.comfort - b.comfort || a.start - b.start;
}

function pickDistinct(sorted: Candidate[], limit: number): Candidate[] {
  const picked: Candidate[] = [];
  for (const candidate of sorted) {
    if (picked.length === limit) {
      break;
    }
    const overlaps = picked.some(
      (other) => candidate.start < other.end && other.start < candidate.end,
    );
    if (!overlaps) {
      picked.push(candidate);
    }
  }
  return picked;
}

function toSlot(candidate: Candidate, planned: PlannedParticipant[]): MeetingSlot {
  return {
    start_utc: formatInstant(candidate.start),
    end_utc: formatInstant(candidate.end),
    available_count: candidate.availableCount,
    total_participants: planned.length,
    all_available: candidate.availableCount === planned.length,
    participants: planned.map((entry) => toView(entry, candidate)),
  };
}

function toView(
  { participant, timeline }: PlannedParticipant,
  candidate: Candidate,
): ParticipantSlotView {
  const localStart = zonedAt(candidate.start, participant.time_zone);
  const localEnd = zonedAt(candidate.end, participant.time_zone);
  const weekday = toIsoWeekday(localStart.dayOfWeek);
  const view: ParticipantSlotView = {
    name: participant.name,
    time_zone: participant.time_zone,
    local_start: formatLocalDateTime(localStart),
    local_end: formatLocalDateTime(localEnd),
    utc_offset: formatOffset(localStart.offsetNanoseconds),
    weekday,
    available: containsSpan(timeline.merged, candidate.start, candidate.end),
  };
  if (!view.available) {
    view.reason = unavailableReason(participant, weekday, timeline, candidate.start);
  }
  return view;
}

/**
 * "non_working_day" when the slot starts on a weekday the participant does not work and no
 * shift from an earlier day (overnight) is still running at that moment; otherwise the
 * participant works that day but not at that time.
 */
function unavailableReason(
  participant: Participant,
  weekday: ParticipantSlotView["weekday"],
  timeline: ShiftTimeline,
  slotStart: number,
): "non_working_day" | "outside_working_hours" {
  const startsOnWorkDay = participant.work_days.includes(weekday);
  return startsOnWorkDay || containsInstant(timeline.merged, slotStart)
    ? "outside_working_hours"
    : "non_working_day";
}

interface SummaryContext {
  slots: MeetingSlot[];
  hasFullOverlap: boolean;
  total: number;
  days: number;
}

function summarize({ slots, hasFullOverlap, total, days }: SummaryContext): string {
  const best = slots[0];
  if (best === undefined) {
    return "No participant is within working hours in the searched window.";
  }
  if (hasFullOverlap) {
    const noun = slots.length === 1 ? "meeting time" : "meeting times";
    const people = total === 1 ? "the participant is" : `all ${total} participants are`;
    return `Found ${slots.length} ${noun} where ${people} within working hours.`;
  }
  const period = days === 1 ? "on the searched day" : `in the next ${days} days`;
  return `No time ${period} works for everyone. Showing the slots where the most people (${best.available_count} of ${total}) are available. ${describeUnavailable(slots)}`;
}

function unavailableNames(slot: MeetingSlot): string[] {
  return slot.participants.filter((p) => !p.available).map((p) => p.name);
}

function describeUnavailable(slots: MeetingSlot[]): string {
  const [first, ...rest] = slots;
  if (first === undefined) {
    return "";
  }
  const firstNames = unavailableNames(first);
  const consistent = rest.every(
    (slot) => unavailableNames(slot).join("\n") === firstNames.join("\n"),
  );
  const label = consistent ? "Unavailable" : "Unavailable in the first slot";
  return `${label}: ${firstNames.join(", ")}.`;
}
