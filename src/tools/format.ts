import type {
  ConvertResult,
  FindResult,
  IsoWeekday,
  MeetingSlot,
  ParticipantSlotView,
  RenderOutput,
  ZonedMoment,
} from "../time/types.js";

const WEEKDAY_NAMES: Record<IsoWeekday, string> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

function utc(offset: string): string {
  return `UTC${offset}`;
}

function dayShift(offset: number): string {
  if (offset === 0) return "same day";
  if (offset === 1) return "next day";
  if (offset === -1) return "previous day";
  return `${offset > 0 ? "+" : ""}${offset} days`;
}

function describeMoment(moment: ZonedMoment): string {
  return `${WEEKDAY_NAMES[moment.weekday]} ${moment.local_date_time} (${utc(moment.utc_offset)}${moment.is_dst ? ", daylight time" : ""})`;
}

export function formatConvertResult(result: ConvertResult): string {
  const lines: string[] = [];
  const { source } = result;
  if (result.dst_adjustment === "gap") {
    lines.push(
      `${result.requested_date_time} does not exist in ${source.time_zone} (clocks move forward); using ${source.local_date_time} instead.`,
    );
  } else if (result.dst_adjustment === "overlap") {
    lines.push(
      `${result.requested_date_time} happens twice in ${source.time_zone} (clocks move back); using the earlier occurrence.`,
    );
  }
  lines.push(`Source: ${source.time_zone}: ${describeMoment(source)}`);
  lines.push(`UTC: ${result.utc}`);
  for (const target of result.targets) {
    lines.push(`- ${target.time_zone}: ${describeMoment(target)}, ${dayShift(target.day_offset)}`);
  }
  return lines.join("\n");
}

function formatLocalRange(view: ParticipantSlotView): string {
  const [startDate = "", startTime = ""] = view.local_start.split("T");
  const [endDate = "", endTime = ""] = view.local_end.split("T");
  const end = endDate === startDate ? endTime : `${endDate} ${endTime}`;
  return `${WEEKDAY_NAMES[view.weekday]} ${startDate} ${startTime}-${end} (${utc(view.utc_offset)})`;
}

function formatSlot(slot: MeetingSlot, index: number): string {
  const header = slot.all_available
    ? `${index + 1}. ${slot.start_utc} to ${slot.end_utc} (everyone available)`
    : `${index + 1}. ${slot.start_utc} to ${slot.end_utc} (${slot.available_count} of ${slot.total_participants} available)`;
  const people = slot.participants.map((view) => {
    const note = view.available
      ? ""
      : ` [unavailable: ${view.reason === "non_working_day" ? "non-working day" : "outside working hours"}]`;
    return `   - ${view.name} (${view.time_zone}): ${formatLocalRange(view)}${note}`;
  });
  return [header, ...people].join("\n");
}

export function formatFindResult(result: FindResult): string {
  if (result.slots.length === 0) return result.summary;
  return [result.summary, ...result.slots.map(formatSlot)].join("\n");
}

function toMinutes(clock: string): number {
  const [hours = "0", minutes = "0"] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function toClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const minutes = String(wrapped % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function overlapRanges(output: RenderOutput): string[] {
  const organizer = output.rows[0];
  if (organizer === undefined) return [];
  const ranges: string[] = [];
  let runStart: number | undefined;
  const flush = (lastColumn: number) => {
    if (runStart === undefined) return;
    const first = organizer.cells[runStart];
    const last = organizer.cells[lastColumn];
    if (first !== undefined && last !== undefined) {
      ranges.push(`${first.local_time}-${toClock(toMinutes(last.local_time) + 60)}`);
    }
    runStart = undefined;
  };
  for (let column = 0; column < organizer.cells.length; column += 1) {
    if (output.overlap_columns.includes(column)) {
      runStart ??= column;
    } else {
      flush(column - 1);
    }
  }
  flush(organizer.cells.length - 1);
  return ranges;
}

export function formatRenderOutput(output: RenderOutput): string {
  const ranges = overlapRanges(output);
  const overlap =
    ranges.length === 0
      ? "There is no hour on this day when everyone is within working hours."
      : `Hours when everyone is within working hours (${output.organizer_time_zone} time): ${ranges.join(", ")}.`;
  return `Planner for ${output.date} in ${output.organizer_time_zone} showing ${output.rows.length} participant${output.rows.length === 1 ? "" : "s"}. ${overlap}`;
}
