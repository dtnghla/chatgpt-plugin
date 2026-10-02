import type {
  CellState,
  GridCell,
  GridRow,
  IsoWeekday,
  Participant,
  RenderOutput,
} from "../../src/time/types.js";

export const HOURS_PER_DAY = 24;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/;
const MS_PER_DAY = 86_400_000;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseDateParts(date: string): DateParts | null {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function toEpochDay(parts: DateParts): number {
  return Math.round(Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY);
}

export function isIsoDate(value: string): boolean {
  return parseDateParts(value) !== null;
}

/** Adds whole calendar days to a "YYYY-MM-DD" string using UTC arithmetic only. */
export function shiftDate(date: string, days: number): string {
  const parts = parseDateParts(date);
  if (!parts) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  const shifted = new Date((toEpochDay(parts) + days) * MS_PER_DAY);
  const year = String(shifted.getUTCFullYear()).padStart(4, "0");
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  const a = parseDateParts(from);
  const b = parseDateParts(to);
  if (!a || !b) {
    throw new RangeError(`Invalid date: ${!a ? from : to}`);
  }
  return toEpochDay(b) - toEpochDay(a);
}

// ------------------------------------------------------------------ validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseParticipant(value: unknown): Participant | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, time_zone, work_start, work_end, work_days } = value;
  if (
    !isString(name) ||
    !isString(time_zone) ||
    !isString(work_start) ||
    !isString(work_end) ||
    !Array.isArray(work_days)
  ) {
    return null;
  }
  if (!CLOCK_PATTERN.test(work_start) || !CLOCK_PATTERN.test(work_end)) {
    return null;
  }
  const days: IsoWeekday[] = [];
  for (const day of work_days) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7) {
      return null;
    }
    days.push(day as IsoWeekday);
  }
  return { name, time_zone, work_start, work_end, work_days: days };
}

function parseCell(value: unknown): GridCell | null {
  if (!isRecord(value)) {
    return null;
  }
  const { start_utc, local_time, local_date, state } = value;
  if (
    !isString(start_utc) ||
    !isString(local_time) ||
    !isString(local_date) ||
    !CLOCK_PATTERN.test(local_time) ||
    !isIsoDate(local_date)
  ) {
    return null;
  }
  if (state !== "working" && state !== "off") {
    return null;
  }
  return { start_utc, local_time, local_date, state: state as CellState };
}

function parseRow(value: unknown): GridRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, time_zone, utc_offset, cells } = value;
  if (
    !isString(name) ||
    !isString(time_zone) ||
    !isString(utc_offset) ||
    !OFFSET_PATTERN.test(utc_offset) ||
    !Array.isArray(cells) ||
    cells.length !== HOURS_PER_DAY
  ) {
    return null;
  }
  const parsed: GridCell[] = [];
  for (const cell of cells) {
    const next = parseCell(cell);
    if (!next) {
      return null;
    }
    parsed.push(next);
  }
  return { name, time_zone, utc_offset, cells: parsed };
}

/** Validates untrusted structuredContent and returns it as a RenderOutput, or null. */
export function parseRenderOutput(value: unknown): RenderOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const { date, organizer_time_zone, start_utc, rows, overlap_columns, participants } = value;
  if (
    !isString(date) ||
    !isIsoDate(date) ||
    !isString(organizer_time_zone) ||
    !isString(start_utc) ||
    !Array.isArray(rows) ||
    rows.length === 0 ||
    !Array.isArray(overlap_columns) ||
    !Array.isArray(participants)
  ) {
    return null;
  }

  const parsedRows: GridRow[] = [];
  for (const row of rows) {
    const next = parseRow(row);
    if (!next) {
      return null;
    }
    parsedRows.push(next);
  }

  const columns: number[] = [];
  for (const column of overlap_columns) {
    if (
      typeof column !== "number" ||
      !Number.isInteger(column) ||
      column < 0 ||
      column >= HOURS_PER_DAY
    ) {
      return null;
    }
    columns.push(column);
  }

  const parsedParticipants: Participant[] = [];
  for (const participant of participants) {
    const next = parseParticipant(participant);
    if (!next) {
      return null;
    }
    parsedParticipants.push(next);
  }

  return {
    date,
    organizer_time_zone,
    start_utc,
    rows: parsedRows,
    overlap_columns: [...new Set(columns)].sort((a, b) => a - b),
    participants: parsedParticipants,
  };
}

// ------------------------------------------------------------------- grid text

/** "13" for a whole-hour start, "05:30" for any other start. */
export function hourLabel(localTime: string): string {
  return localTime.endsWith(":00") ? localTime.slice(0, 2) : localTime;
}

/** "UTC+05:45" from "+05:45". */
export function offsetLabel(utcOffset: string): string {
  return OFFSET_PATTERN.test(utcOffset) ? `UTC${utcOffset}` : utcOffset;
}

function formatDayDelta(delta: number): string {
  return `${delta > 0 ? "+" : "-"}${Math.abs(delta)}d`;
}

/**
 * Day marker for cell `index` of a row: the signed day difference from the organizer's
 * grid date ("+1d", "-1d"), shown on the first cell of each new local day, or null.
 */
export function dayMarker(
  cells: readonly GridCell[],
  index: number,
  gridDate: string,
): string | null {
  const cell = cells[index];
  if (!cell) {
    return null;
  }
  const previous = index > 0 ? cells[index - 1] : undefined;
  const startsNewDay = previous ? previous.local_date !== cell.local_date : true;
  if (!startsNewDay) {
    return null;
  }
  const delta = daysBetween(gridDate, cell.local_date);
  return delta === 0 ? null : formatDayDelta(delta);
}

export function formatLongDate(date: string, locale: string): string {
  const parts = parseDateParts(date);
  if (!parts) {
    return date;
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

export function formatWeekday(date: string, locale: string): string {
  const parts = parseDateParts(date);
  if (!parts) {
    return date;
  }
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day)),
  );
}

export function headerText(grid: RenderOutput, locale: string): string {
  return `${formatLongDate(grid.date, locale)} - your time zone: ${grid.organizer_time_zone}`;
}

export function cellDescription(
  row: GridRow,
  index: number,
  gridDate: string,
  locale: string,
): string {
  const cell = row.cells[index];
  if (!cell) {
    return "";
  }
  const state = cell.state === "working" ? "working" : "off";
  const day = formatWeekday(cell.local_date, locale);
  const marker = dayMarker(row.cells, index, gridDate);
  return `${row.name}: ${day} ${cell.local_time}, ${state}${marker ? ` (${marker})` : ""}`;
}

// ------------------------------------------------------------------- selection

export interface SlotLine {
  name: string;
  time_zone: string;
  weekday: string;
  local_time: string;
  local_date: string;
  /** "Priya (Asia/Kolkata): Wed 17:30" */
  text: string;
}

export interface SlotSummary {
  column: number;
  start_utc: string;
  organizer: SlotLine;
  /** "Tue, 14 Apr 2026 13:00 (America/New_York)" */
  organizer_readable: string;
  lines: SlotLine[];
}

/** Returns null when the column is not an overlap column of the grid. */
export function summarizeSelection(
  grid: RenderOutput,
  column: number,
  locale: string,
): SlotSummary | null {
  if (!grid.overlap_columns.includes(column)) {
    return null;
  }
  const lines: SlotLine[] = [];
  for (const row of grid.rows) {
    const cell = row.cells[column];
    if (!cell) {
      return null;
    }
    const weekday = formatWeekday(cell.local_date, locale);
    lines.push({
      name: row.name,
      time_zone: row.time_zone,
      weekday,
      local_time: cell.local_time,
      local_date: cell.local_date,
      text: `${row.name} (${row.time_zone}): ${weekday} ${cell.local_time}`,
    });
  }
  const organizer = lines[0];
  const organizerCell = grid.rows[0]?.cells[column];
  if (!organizer || !organizerCell) {
    return null;
  }
  return {
    column,
    start_utc: organizerCell.start_utc,
    organizer,
    organizer_readable: `${formatLongDate(organizer.local_date, locale)} ${organizer.local_time} (${organizer.time_zone})`,
    lines,
  };
}

/** Short note for the model about the slot the user currently has selected. */
export function modelContextText(summary: SlotSummary): string {
  return [
    `The user selected a meeting slot at which every participant is within working hours: ${summary.organizer_readable} (${summary.start_utc}).`,
    `Local times: ${summary.lines.map((line) => line.text).join("; ")}.`,
  ].join("\n");
}

/** User-role message sent when the user presses "Use this time". */
export function scheduleMessageText(summary: SlotSummary): string {
  return `Let's schedule the meeting for ${summary.organizer_readable} (${summary.start_utc}). Local times: ${summary.lines.map((line) => line.text).join("; ")}.`;
}

export function noOverlapMessage(): string {
  return "No hour works for everyone on this day.";
}
