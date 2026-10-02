import { isClock } from "./clock.js";
import type { IsoWeekday, Participant } from "./types.js";
import { TimeInputError } from "./types.js";
import { canonicalTimeZone } from "./zones.js";

export interface ParticipantInput {
  name: string;
  time_zone: string;
  work_start?: string;
  work_end?: string;
  work_days?: IsoWeekday[];
}

export const MIN_PARTICIPANTS = 1;
export const MAX_PARTICIPANTS = 20;
const MAX_NAME_LENGTH = 60;
const DEFAULT_WORK_START = "09:00";
const DEFAULT_WORK_END = "17:00";
const DEFAULT_WORK_DAYS: IsoWeekday[] = [1, 2, 3, 4, 5];

export function normalizeParticipants(raw: ParticipantInput[]): Participant[] {
  if (!Array.isArray(raw) || raw.length < MIN_PARTICIPANTS || raw.length > MAX_PARTICIPANTS) {
    throw new TimeInputError(
      `Provide between ${MIN_PARTICIPANTS} and ${MAX_PARTICIPANTS} participants.`,
    );
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const participant = normalizeParticipant(entry, index);
    const key = participant.name.toLowerCase();
    if (seen.has(key)) {
      throw new TimeInputError(
        `Participant names must be unique (case-insensitive); "${participant.name}" appears more than once.`,
      );
    }
    seen.add(key);
    return participant;
  });
}

function normalizeParticipant(entry: ParticipantInput, index: number): Participant {
  const position = `Participant ${index + 1}`;
  const name = normalizeName(entry.name, position);
  const label = `${position} ("${name}")`;
  return {
    name,
    time_zone: canonicalTimeZoneFor(entry.time_zone, label),
    work_start: normalizeClock(entry.work_start ?? DEFAULT_WORK_START, "work_start", label),
    work_end: normalizeClock(entry.work_end ?? DEFAULT_WORK_END, "work_end", label),
    work_days: normalizeWorkDays(entry.work_days ?? DEFAULT_WORK_DAYS, label),
  };
}

function normalizeName(name: unknown, position: string): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TimeInputError(`${position} needs a non-empty name.`);
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new TimeInputError(`${position} has a name longer than ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

function canonicalTimeZoneFor(timeZone: string, label: string): string {
  try {
    return canonicalTimeZone(timeZone);
  } catch (error) {
    if (error instanceof TimeInputError) {
      throw new TimeInputError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

function normalizeClock(value: string, field: string, label: string): string {
  if (typeof value !== "string" || !isClock(value)) {
    throw new TimeInputError(
      `${label}: ${field} must be a 24-hour time HH:mm between 00:00 and 23:59, got "${String(value)}".`,
    );
  }
  return value;
}

function isIsoWeekday(value: unknown): value is IsoWeekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7;
}

function normalizeWorkDays(days: unknown, label: string): IsoWeekday[] {
  if (!Array.isArray(days) || days.length === 0) {
    throw new TimeInputError(
      `${label}: work_days must list at least one ISO weekday (1 = Monday to 7 = Sunday).`,
    );
  }
  if (!days.every(isIsoWeekday)) {
    throw new TimeInputError(
      `${label}: work_days values must be integers from 1 (Monday) to 7 (Sunday), got ${JSON.stringify(days)}.`,
    );
  }
  return [...new Set<IsoWeekday>(days)].sort((a, b) => a - b);
}
