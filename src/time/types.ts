/**
 * Shared contract between the time-zone logic (src/time), the MCP tools
 * (src/tools, src/server.ts) and the widget (web/src). Everything here is plain
 * JSON-serialisable data.
 *
 * Conventions
 * - Time zones are IANA identifiers (e.g. "America/New_York"); "UTC" is allowed.
 * - Local date-times are ISO strings without offset: "YYYY-MM-DDTHH:mm" (seconds omitted).
 * - Dates are "YYYY-MM-DD". Clock times are "HH:mm" (24-hour).
 * - Instants are UTC ISO strings ending in "Z": "YYYY-MM-DDTHH:mm:ssZ".
 * - Offsets are "+HH:mm" / "-HH:mm".
 * - Weekdays are ISO numbers 1 (Monday) to 7 (Sunday).
 */

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Participant {
  /** Display name, 1 to 60 characters. Unique (case-insensitive) within a request. */
  name: string;
  /** IANA time zone identifier. */
  time_zone: string;
  /** Start of working hours, "HH:mm". Default "09:00". */
  work_start: string;
  /**
   * End of working hours, "HH:mm". Default "17:00". If it is earlier than or equal to
   * work_start the shift ends on the following calendar day (overnight shift).
   * A work_start equal to work_end means a 24-hour shift.
   */
  work_end: string;
  /** ISO weekdays on which a shift STARTS. Default [1,2,3,4,5]. */
  work_days: IsoWeekday[];
}

// ---------------------------------------------------------------- convert_time

export interface ConvertInput {
  date_time: string; // local, "YYYY-MM-DDTHH:mm"
  from_time_zone: string;
  to_time_zones: string[]; // 1 to 24 entries
}

export type DstAdjustment = "none" | "gap" | "overlap";

export interface ZonedMoment {
  time_zone: string;
  local_date_time: string; // "YYYY-MM-DDTHH:mm"
  utc_offset: string;
  weekday: IsoWeekday;
  /** Whole calendar days between this local date and the source local date. */
  day_offset: number;
  is_dst: boolean;
}

export interface ConvertResult {
  /** The source moment AFTER resolving DST ambiguity (see dst_adjustment). */
  source: ZonedMoment;
  /** The date_time that was requested, echoed back. */
  requested_date_time: string;
  /**
   * "gap": the requested local time does not exist (clocks jumped forward) and was moved
   * forward by the length of the gap (Temporal "compatible" disambiguation).
   * "overlap": the requested local time occurs twice; the EARLIER occurrence is used.
   * "none": unambiguous.
   */
  dst_adjustment: DstAdjustment;
  utc: string; // instant, "YYYY-MM-DDTHH:mm:ssZ"
  targets: ZonedMoment[]; // same order as to_time_zones
}

// ---------------------------------------------------------- find_meeting_times

export interface FindInput {
  participants: Participant[]; // 1 to 20; participants[0] is the organizer
  /** First day of the search window, in the ORGANIZER's time zone. */
  start_date: string;
  /** Number of calendar days (organizer zone) to search, 1 to 14. */
  days: number;
  duration_minutes: number; // 15 to 480
  step_minutes: 15 | 30 | 60;
  max_results: number; // 1 to 20
}

export interface ParticipantSlotView {
  name: string;
  time_zone: string;
  local_start: string; // "YYYY-MM-DDTHH:mm"
  local_end: string;
  utc_offset: string; // offset at slot start
  weekday: IsoWeekday; // weekday of local_start
  available: boolean;
  /** Present when available is false: "outside_working_hours" | "non_working_day". */
  reason?: "outside_working_hours" | "non_working_day";
}

export interface MeetingSlot {
  start_utc: string;
  end_utc: string;
  available_count: number;
  total_participants: number;
  all_available: boolean;
  participants: ParticipantSlotView[];
}

export interface FindResult {
  /** True when at least one slot has every participant available. */
  has_full_overlap: boolean;
  /**
   * Full-overlap slots (best first) when has_full_overlap, otherwise the best partial
   * slots (most participants available first). At most max_results entries.
   */
  slots: MeetingSlot[];
  searched: { start_date: string; days: number; organizer_time_zone: string };
  /** Human-readable explanation, always set. */
  summary: string;
}

// ------------------------------------------------------------- planner grid

export interface GridInput {
  participants: Participant[]; // 1 to 20; participants[0] is the organizer
  /** Date in the organizer's time zone; the grid starts at that zone's local midnight. */
  date: string;
}

export type CellState = "working" | "off";

export interface GridCell {
  /** Instant at which the hour begins, "YYYY-MM-DDTHH:mm:ssZ". */
  start_utc: string;
  /** Local "HH:mm" at the start of the hour for this participant. */
  local_time: string;
  /** Local date "YYYY-MM-DD" for this participant at the start of the hour. */
  local_date: string;
  state: CellState;
}

export interface GridRow {
  name: string;
  time_zone: string;
  /** Offset at the start of the grid (organizer midnight). */
  utc_offset: string;
  cells: GridCell[]; // exactly 24, consecutive hours from the organizer's local midnight
}

export interface PlannerGrid {
  date: string;
  organizer_time_zone: string;
  start_utc: string; // organizer local midnight as an instant
  rows: GridRow[];
  /** Indexes (0 to 23) of columns where EVERY participant is "working". */
  overlap_columns: number[];
}

/** Thrown for invalid user input; message is safe to show to the model and user. */
export class TimeInputError extends Error {
  override readonly name = "TimeInputError";
}
