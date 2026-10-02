import { describe, expect, it } from "vitest";
import type { GridCell, GridRow, RenderOutput } from "../../src/time/types.js";
import {
  cellDescription,
  dayMarker,
  daysBetween,
  headerText,
  hourLabel,
  modelContextText,
  noOverlapMessage,
  offsetLabel,
  parseRenderOutput,
  scheduleMessageText,
  shiftDate,
  summarizeSelection,
} from "../../web/src/model.js";

function cell(utcHour: number, localTime: string, localDate: string, working: boolean): GridCell {
  return {
    start_utc: `2026-04-14T${String(utcHour).padStart(2, "0")}:00:00Z`,
    local_time: localTime,
    local_date: localDate,
    state: working ? "working" : "off",
  };
}

function organizerRow(): GridRow {
  const cells: GridCell[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const utcHour = (hour + 4) % 24;
    cells.push(
      cell(utcHour, `${String(hour).padStart(2, "0")}:00`, "2026-04-14", hour >= 9 && hour < 17),
    );
  }
  return { name: "Ava", time_zone: "America/New_York", utc_offset: "-04:00", cells };
}

function kolkataRow(): GridRow {
  const cells: GridCell[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const minutes = hour * 60 + 570;
    const dayShift = Math.floor(minutes / 1440);
    const within = minutes % 1440;
    const hh = String(Math.floor(within / 60)).padStart(2, "0");
    const mm = String(within % 60).padStart(2, "0");
    const date = dayShift === 0 ? "2026-04-14" : "2026-04-15";
    const localHour = Math.floor(within / 60);
    cells.push(cell((hour + 4) % 24, `${hh}:${mm}`, date, localHour >= 9 && localHour < 18));
  }
  return { name: "Priya", time_zone: "Asia/Kolkata", utc_offset: "+05:30", cells };
}

function sample(): RenderOutput {
  const rows = [organizerRow(), kolkataRow()];
  return {
    date: "2026-04-14",
    organizer_time_zone: "America/New_York",
    start_utc: "2026-04-14T04:00:00Z",
    rows,
    overlap_columns: [9, 10],
    participants: [
      {
        name: "Ava",
        time_zone: "America/New_York",
        work_start: "09:00",
        work_end: "17:00",
        work_days: [1, 2, 3, 4, 5],
      },
      {
        name: "Priya",
        time_zone: "Asia/Kolkata",
        work_start: "09:00",
        work_end: "18:00",
        work_days: [1, 2, 3, 4, 5],
      },
    ],
  };
}

describe("shiftDate", () => {
  it("moves within a month", () => {
    expect(shiftDate("2026-04-14", 1)).toBe("2026-04-15");
    expect(shiftDate("2026-04-14", -1)).toBe("2026-04-13");
    expect(shiftDate("2026-04-14", 0)).toBe("2026-04-14");
  });

  it("crosses month and year boundaries", () => {
    expect(shiftDate("2026-04-30", 1)).toBe("2026-05-01");
    expect(shiftDate("2026-05-01", -1)).toBe("2026-04-30");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles leap days", () => {
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDate("2028-02-29", 1)).toBe("2028-03-01");
    expect(shiftDate("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftDate("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("handles larger shifts and DST-transition dates without drift", () => {
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDate("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftDate("2026-01-01", 365)).toBe("2027-01-01");
  });

  it("rejects invalid dates", () => {
    expect(() => shiftDate("2026-02-30", 1)).toThrow(RangeError);
    expect(() => shiftDate("not-a-date", 1)).toThrow(RangeError);
  });
});

describe("daysBetween", () => {
  it("counts signed calendar days", () => {
    expect(daysBetween("2026-04-14", "2026-04-15")).toBe(1);
    expect(daysBetween("2026-04-14", "2026-04-13")).toBe(-1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
});

describe("parseRenderOutput", () => {
  it("accepts a valid payload", () => {
    const parsed = parseRenderOutput(JSON.parse(JSON.stringify(sample())));
    expect(parsed).not.toBeNull();
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.overlap_columns).toEqual([9, 10]);
  });

  it("drops unknown properties and sorts and dedupes overlap columns", () => {
    const input = { ...sample(), overlap_columns: [10, 9, 10], extra: "x" };
    const parsed = parseRenderOutput(input);
    expect(parsed?.overlap_columns).toEqual([9, 10]);
    expect(parsed).not.toHaveProperty("extra");
  });

  it("rejects non-objects", () => {
    expect(parseRenderOutput(null)).toBeNull();
    expect(parseRenderOutput(undefined)).toBeNull();
    expect(parseRenderOutput("text")).toBeNull();
    expect(parseRenderOutput([])).toBeNull();
  });

  it("rejects missing fields", () => {
    for (const key of [
      "date",
      "organizer_time_zone",
      "start_utc",
      "rows",
      "overlap_columns",
      "participants",
    ]) {
      const copy: Record<string, unknown> = { ...sample() };
      delete copy[key];
      expect(parseRenderOutput(copy), key).toBeNull();
    }
  });

  it("rejects wrong types and invalid values", () => {
    expect(parseRenderOutput({ ...sample(), date: 20260414 })).toBeNull();
    expect(parseRenderOutput({ ...sample(), date: "2026-02-30" })).toBeNull();
    expect(parseRenderOutput({ ...sample(), date: "14/04/2026" })).toBeNull();
    expect(parseRenderOutput({ ...sample(), organizer_time_zone: 5 })).toBeNull();
    expect(parseRenderOutput({ ...sample(), overlap_columns: [24] })).toBeNull();
    expect(parseRenderOutput({ ...sample(), overlap_columns: [-1] })).toBeNull();
    expect(parseRenderOutput({ ...sample(), overlap_columns: [1.5] })).toBeNull();
    expect(parseRenderOutput({ ...sample(), overlap_columns: ["3"] })).toBeNull();
  });

  it("rejects non-array rows and empty rows", () => {
    expect(parseRenderOutput({ ...sample(), rows: "nope" })).toBeNull();
    expect(parseRenderOutput({ ...sample(), rows: { length: 1 } })).toBeNull();
    expect(parseRenderOutput({ ...sample(), rows: [] })).toBeNull();
    expect(parseRenderOutput({ ...sample(), rows: [null] })).toBeNull();
  });

  it("rejects rows with the wrong cell count", () => {
    const data = sample();
    const short = { ...organizerRow(), cells: organizerRow().cells.slice(0, 23) };
    const long = { ...organizerRow(), cells: [...organizerRow().cells, organizerRow().cells[0]] };
    expect(parseRenderOutput({ ...data, rows: [short] })).toBeNull();
    expect(parseRenderOutput({ ...data, rows: [long] })).toBeNull();
    expect(parseRenderOutput({ ...data, rows: [{ ...organizerRow(), cells: "x" }] })).toBeNull();
  });

  it("rejects malformed cells and rows", () => {
    const badState = organizerRow();
    badState.cells[3] = { ...badState.cells[3], state: "busy" } as unknown as GridCell;
    expect(parseRenderOutput({ ...sample(), rows: [badState] })).toBeNull();

    const badTime = organizerRow();
    badTime.cells[0] = { ...badTime.cells[0], local_time: "25:00" } as GridCell;
    expect(parseRenderOutput({ ...sample(), rows: [badTime] })).toBeNull();

    const badDate = organizerRow();
    badDate.cells[0] = { ...badDate.cells[0], local_date: "x" } as GridCell;
    expect(parseRenderOutput({ ...sample(), rows: [badDate] })).toBeNull();

    expect(
      parseRenderOutput({ ...sample(), rows: [{ ...organizerRow(), utc_offset: "UTC+5" }] }),
    ).toBeNull();
    expect(parseRenderOutput({ ...sample(), rows: [{ ...organizerRow(), name: 4 }] })).toBeNull();
  });

  it("rejects malformed participants", () => {
    const data = sample();
    expect(parseRenderOutput({ ...data, participants: "x" })).toBeNull();
    expect(parseRenderOutput({ ...data, participants: [{ name: "A" }] })).toBeNull();
    const [first] = data.participants;
    expect(parseRenderOutput({ ...data, participants: [{ ...first, work_days: [0] }] })).toBeNull();
    expect(
      parseRenderOutput({ ...data, participants: [{ ...first, work_start: "9am" }] }),
    ).toBeNull();
  });
});

describe("hourLabel", () => {
  it("shows only the hour for whole-hour starts", () => {
    expect(hourLabel("13:00")).toBe("13");
    expect(hourLabel("00:00")).toBe("00");
    expect(hourLabel("05:00")).toBe("05");
  });

  it("keeps minutes for non-whole-hour starts", () => {
    expect(hourLabel("05:30")).toBe("05:30");
    expect(hourLabel("23:45")).toBe("23:45");
  });
});

describe("offsetLabel", () => {
  it("prefixes UTC", () => {
    expect(offsetLabel("+05:45")).toBe("UTC+05:45");
    expect(offsetLabel("-03:30")).toBe("UTC-03:30");
    expect(offsetLabel("+00:00")).toBe("UTC+00:00");
  });
});

describe("dayMarker", () => {
  const dates = (list: string[]): GridCell[] =>
    list.map((local_date) => ({
      start_utc: "2026-04-14T00:00:00Z",
      local_time: "00:00",
      local_date,
      state: "off",
    }));

  it("is null while the date does not change", () => {
    const cells = dates(["2026-04-14", "2026-04-14", "2026-04-14"]);
    expect([0, 1, 2].map((i) => dayMarker(cells, i, "2026-04-14"))).toEqual([null, null, null]);
  });

  it("marks the first cell of a following day", () => {
    const cells = dates(["2026-04-14", "2026-04-14", "2026-04-15", "2026-04-15"]);
    expect([0, 1, 2, 3].map((i) => dayMarker(cells, i, "2026-04-14"))).toEqual([
      null,
      null,
      "+1d",
      null,
    ]);
  });

  it("marks a participant who starts on the previous day and rolls over", () => {
    const cells = dates(["2026-04-13", "2026-04-13", "2026-04-14", "2026-04-14"]);
    expect([0, 1, 2, 3].map((i) => dayMarker(cells, i, "2026-04-14"))).toEqual([
      "-1d",
      null,
      null,
      null,
    ]);
  });

  it("is null for an out-of-range index", () => {
    expect(dayMarker(dates(["2026-04-14"]), 5, "2026-04-14")).toBeNull();
  });

  it("works on the sample grid", () => {
    const row = kolkataRow();
    const markers = row.cells.map((_, i) => dayMarker(row.cells, i, "2026-04-14"));
    expect(markers.filter((m) => m !== null)).toEqual(["+1d"]);
    expect(markers[15]).toBe("+1d");
  });

  it("handles month boundaries", () => {
    const cells = dates(["2026-04-30", "2026-05-01"]);
    expect(dayMarker(cells, 1, "2026-04-30")).toBe("+1d");
  });
});

describe("text formatting", () => {
  it("builds the header text", () => {
    expect(headerText(sample(), "en-US")).toBe(
      "Tue, Apr 14, 2026 - your time zone: America/New_York",
    );
    expect(headerText(sample(), "en-GB")).toContain("14 Apr 2026");
  });

  it("describes a cell", () => {
    const grid = sample();
    const row = grid.rows[1];
    if (!row) throw new Error("missing row");
    expect(cellDescription(row, 15, grid.date, "en-US")).toBe("Priya: Wed 00:30, off (+1d)");
    expect(cellDescription(row, 6, grid.date, "en-US")).toBe("Priya: Tue 15:30, working");
    expect(cellDescription(row, 99, grid.date, "en-US")).toBe("");
  });

  it("returns the clear no-overlap message", () => {
    expect(noOverlapMessage()).toBe("No hour works for everyone on this day.");
  });
});

describe("selection summary", () => {
  it("returns null for columns that are not overlap columns", () => {
    expect(summarizeSelection(sample(), 3, "en-US")).toBeNull();
    expect(summarizeSelection(sample(), 99, "en-US")).toBeNull();
  });

  it("lists each participant's local time with weekday", () => {
    const summary = summarizeSelection(sample(), 9, "en-US");
    expect(summary).not.toBeNull();
    expect(summary?.lines.map((line) => line.text)).toEqual([
      "Ava (America/New_York): Tue 09:00",
      "Priya (Asia/Kolkata): Tue 18:30",
    ]);
    expect(summary?.start_utc).toBe("2026-04-14T13:00:00Z");
    expect(summary?.organizer_readable).toBe("Tue, Apr 14, 2026 09:00 (America/New_York)");
  });

  it("uses the next weekday when a participant is past midnight", () => {
    const grid = sample();
    const summary = summarizeSelection({ ...grid, overlap_columns: [15] }, 15, "en-US");
    expect(summary?.lines[1]?.text).toBe("Priya (Asia/Kolkata): Wed 00:30");
  });

  it("builds the model context text", () => {
    const summary = summarizeSelection(sample(), 10, "en-US");
    if (!summary) throw new Error("no summary");
    expect(modelContextText(summary)).toBe(
      [
        "The user selected a meeting slot at which every participant is within working hours: Tue, Apr 14, 2026 10:00 (America/New_York) (2026-04-14T14:00:00Z).",
        "Local times: Ava (America/New_York): Tue 10:00; Priya (Asia/Kolkata): Tue 19:30.",
      ].join("\n"),
    );
  });

  it("builds the sendMessage text", () => {
    const summary = summarizeSelection(sample(), 10, "en-US");
    if (!summary) throw new Error("no summary");
    expect(scheduleMessageText(summary)).toBe(
      "Let's schedule the meeting for Tue, Apr 14, 2026 10:00 (America/New_York) (2026-04-14T14:00:00Z). Local times: Ava (America/New_York): Tue 10:00; Priya (Asia/Kolkata): Tue 19:30.",
    );
  });
});
