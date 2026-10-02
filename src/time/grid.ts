import { formatInstant, formatOffset, parseDate } from "./clock.js";
import { normalizeParticipants } from "./participants.js";
import { buildShiftTimeline, containsInstant } from "./shifts.js";
import type { CellState, GridCell, GridInput, GridRow, Participant, PlannerGrid } from "./types.js";
import { TimeInputError } from "./types.js";
import { zonedAt } from "./zones.js";

const HOURS = 24;
const MS_PER_HOUR = 3_600_000;

export function buildPlannerGrid(input: GridInput): PlannerGrid {
  const participants = normalizeParticipants(input.participants);
  const organizer = participants[0];
  if (organizer === undefined) {
    throw new TimeInputError("At least one participant is required.");
  }
  const date = parseDate(input.date, "date");
  const startMs = date.toZonedDateTime(organizer.time_zone).epochMilliseconds;
  const endMs = startMs + HOURS * MS_PER_HOUR;

  const rows = participants.map((participant) => buildRow(participant, startMs, endMs));
  return {
    date: input.date,
    organizer_time_zone: organizer.time_zone,
    start_utc: formatInstant(startMs),
    rows,
    overlap_columns: overlapColumns(rows),
  };
}

function buildRow(participant: Participant, startMs: number, endMs: number): GridRow {
  const { merged } = buildShiftTimeline(participant, startMs, endMs);
  const cells: GridCell[] = [];
  for (let hour = 0; hour < HOURS; hour++) {
    const instant = startMs + hour * MS_PER_HOUR;
    const local = zonedAt(instant, participant.time_zone);
    const state: CellState = containsInstant(merged, instant) ? "working" : "off";
    cells.push({
      start_utc: formatInstant(instant),
      local_time: local.toPlainTime().toString({ smallestUnit: "minute" }),
      local_date: local.toPlainDate().toString(),
      state,
    });
  }
  return {
    name: participant.name,
    time_zone: participant.time_zone,
    utc_offset: formatOffset(zonedAt(startMs, participant.time_zone).offsetNanoseconds),
    cells,
  };
}

function overlapColumns(rows: GridRow[]): number[] {
  const columns: number[] = [];
  for (let hour = 0; hour < HOURS; hour++) {
    if (rows.every((row) => row.cells[hour]?.state === "working")) {
      columns.push(hour);
    }
  }
  return columns;
}
