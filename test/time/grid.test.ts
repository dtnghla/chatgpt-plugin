import { describe, expect, it } from "vitest";
import {
  buildPlannerGrid,
  normalizeParticipants,
  type ParticipantInput,
  type PlannerGrid,
  TimeInputError,
} from "../../src/time/index.js";

const NY = "America/New_York";
const LONDON = "Europe/London";
const TOKYO = "Asia/Tokyo";
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function grid(people: ParticipantInput[], date: string): PlannerGrid {
  return buildPlannerGrid({ participants: normalizeParticipants(people), date });
}

const workingHours = (result: PlannerGrid, row: number): number[] =>
  (result.rows[row]?.cells ?? []).flatMap((cell, index) =>
    cell.state === "working" ? [index] : [],
  );

describe("buildPlannerGrid", () => {
  const result = grid(
    [
      { name: "Ann", time_zone: NY },
      { name: "Bob", time_zone: LONDON },
    ],
    "2026-01-12",
  );

  it("describes the grid", () => {
    expect(result.date).toBe("2026-01-12");
    expect(result.organizer_time_zone).toBe(NY);
    expect(result.start_utc).toBe("2026-01-12T05:00:00Z");
    expect(result.rows.map((row) => row.name)).toEqual(["Ann", "Bob"]);
    expect(result.rows.map((row) => row.utc_offset)).toEqual(["-05:00", "+00:00"]);
  });

  it("has exactly 24 consecutive hourly cells per participant", () => {
    for (const row of result.rows) {
      expect(row.cells).toHaveLength(24);
      row.cells.forEach((cell, hour) => {
        const expected = Date.parse("2026-01-12T05:00:00Z") + hour * 3_600_000;
        expect(Date.parse(cell.start_utc)).toBe(expected);
      });
    }
    expect(result.rows[0]?.cells[0]?.start_utc).toBe("2026-01-12T05:00:00Z");
    expect(result.rows[0]?.cells[23]?.start_utc).toBe("2026-01-13T04:00:00Z");
  });

  it("shows each participant's local time and date at the start of the hour", () => {
    expect(result.rows[0]?.cells[0]).toMatchObject({
      local_time: "00:00",
      local_date: "2026-01-12",
    });
    expect(result.rows[0]?.cells[23]).toMatchObject({
      local_time: "23:00",
      local_date: "2026-01-12",
    });
    expect(result.rows[1]?.cells[0]).toMatchObject({
      local_time: "05:00",
      local_date: "2026-01-12",
    });
    expect(result.rows[1]?.cells[19]).toMatchObject({
      local_time: "00:00",
      local_date: "2026-01-13",
    });
  });

  it("marks working hours (09:00-17:00 local means cells starting 09:00 to 16:00)", () => {
    expect(workingHours(result, 0)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(workingHours(result, 1)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("computes the overlap columns for New York and London", () => {
    expect(result.overlap_columns).toEqual([9, 10, 11]);
  });

  it("has no overlap columns when the participants never work at the same time", () => {
    const apart = grid(
      [
        { name: "Ann", time_zone: NY },
        { name: "Tom", time_zone: TOKYO },
      ],
      "2026-01-12",
    );
    expect(apart.overlap_columns).toEqual([]);
  });

  it("treats a single participant's working hours as the overlap", () => {
    const solo = grid([{ name: "Ann", time_zone: NY }], "2026-01-12");
    expect(solo.overlap_columns).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("marks everything off on a non-working day", () => {
    const sunday = grid([{ name: "Ann", time_zone: NY }], "2026-01-11");
    expect(workingHours(sunday, 0)).toEqual([]);
    expect(sunday.overlap_columns).toEqual([]);
  });
});

describe("buildPlannerGrid: half-hour zones", () => {
  const result = grid(
    [
      { name: "Ann", time_zone: NY },
      { name: "Asha", time_zone: "Asia/Kolkata" },
      { name: "Nima", time_zone: "Asia/Kathmandu" },
    ],
    "2026-01-12",
  );

  it("shows :30 and :45 local times", () => {
    expect(result.rows[1]?.utc_offset).toBe("+05:30");
    expect(result.rows[1]?.cells[0]).toMatchObject({
      local_time: "10:30",
      local_date: "2026-01-12",
    });
    expect(result.rows[1]?.cells[13]).toMatchObject({
      local_time: "23:30",
      local_date: "2026-01-12",
    });
    expect(result.rows[1]?.cells[14]).toMatchObject({
      local_time: "00:30",
      local_date: "2026-01-13",
    });
    expect(result.rows[2]?.utc_offset).toBe("+05:45");
    expect(result.rows[2]?.cells[0]).toMatchObject({
      local_time: "10:45",
      local_date: "2026-01-12",
    });
  });

  it("works an hour cell when it starts inside the shift", () => {
    expect(workingHours(result, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 23]);
  });

  it("finds no overlap between New York and Kolkata", () => {
    expect(result.overlap_columns).toEqual([]);
  });
});

describe("buildPlannerGrid: DST days for the organizer", () => {
  it("runs an hour into the next local day on the spring-forward day", () => {
    const result = grid([{ name: "Ann", time_zone: NY, work_days: [...ALL_DAYS] }], "2026-03-08");
    expect(result.start_utc).toBe("2026-03-08T05:00:00Z");
    expect(result.rows[0]?.utc_offset).toBe("-05:00");
    const cells = result.rows[0]?.cells ?? [];
    expect(cells).toHaveLength(24);
    expect(cells.slice(0, 4).map((c) => c.local_time)).toEqual([
      "00:00",
      "01:00",
      "03:00",
      "04:00",
    ]);
    expect(cells[22]).toMatchObject({ local_time: "23:00", local_date: "2026-03-08" });
    expect(cells[23]).toMatchObject({
      start_utc: "2026-03-09T04:00:00Z",
      local_time: "00:00",
      local_date: "2026-03-09",
    });
    expect(workingHours(result, 0)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("stops an hour short of the next local day on the fall-back day", () => {
    const result = grid([{ name: "Ann", time_zone: NY, work_days: [...ALL_DAYS] }], "2026-11-01");
    expect(result.start_utc).toBe("2026-11-01T04:00:00Z");
    expect(result.rows[0]?.utc_offset).toBe("-04:00");
    const cells = result.rows[0]?.cells ?? [];
    expect(cells).toHaveLength(24);
    expect(cells.slice(0, 4).map((c) => c.local_time)).toEqual([
      "00:00",
      "01:00",
      "01:00",
      "02:00",
    ]);
    expect(cells[23]).toMatchObject({
      start_utc: "2026-11-02T03:00:00Z",
      local_time: "22:00",
      local_date: "2026-11-01",
    });
    expect(workingHours(result, 0)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("keeps London and New York aligned in the weeks when only the US has changed", () => {
    const result = grid(
      [
        { name: "Ann", time_zone: NY },
        { name: "Bob", time_zone: LONDON },
      ],
      "2026-03-16",
    );
    expect(result.start_utc).toBe("2026-03-16T04:00:00Z");
    expect(result.rows.map((r) => r.utc_offset)).toEqual(["-04:00", "+00:00"]);
    expect(result.overlap_columns).toEqual([9, 10, 11, 12]);
  });
});

describe("buildPlannerGrid: overnight shifts", () => {
  const night: ParticipantInput = {
    name: "Night",
    time_zone: TOKYO,
    work_start: "22:00",
    work_end: "06:00",
  };

  it("counts shifts that started the previous local day", () => {
    const tuesday = grid([night], "2026-01-13");
    expect(tuesday.start_utc).toBe("2026-01-12T15:00:00Z");
    expect(workingHours(tuesday, 0)).toEqual([0, 1, 2, 3, 4, 5, 22, 23]);
  });

  it("has no early-morning shift when the previous day is not a work day", () => {
    const monday = grid([night], "2026-01-12");
    expect(workingHours(monday, 0)).toEqual([22, 23]);
  });

  it("continues Friday's shift into Saturday but not Saturday's own evening", () => {
    const saturday = grid([night], "2026-01-17");
    expect(workingHours(saturday, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("finds the overlap between a London day worker and a Tokyo night worker", () => {
    const result = grid(
      [
        { name: "Day", time_zone: LONDON },
        { ...night, name: "Night" },
      ],
      "2026-01-12",
    );
    expect(result.overlap_columns).toEqual([13, 14, 15, 16]);
    expect(result.rows[1]?.cells[13]).toMatchObject({
      local_time: "22:00",
      local_date: "2026-01-12",
    });
  });

  it("treats equal start and end as an all-day shift", () => {
    const result = grid(
      [
        {
          name: "Always",
          time_zone: NY,
          work_start: "08:00",
          work_end: "08:00",
          work_days: [...ALL_DAYS],
        },
      ],
      "2026-01-13",
    );
    expect(workingHours(result, 0)).toHaveLength(24);
  });
});

describe("buildPlannerGrid: validation", () => {
  it("rejects bad dates and participant lists", () => {
    const participants = normalizeParticipants([{ name: "Ann", time_zone: NY }]);
    for (const date of ["2026-02-30", "01/12/2026", "", "2026-01-12T00:00"]) {
      expect(() => buildPlannerGrid({ participants, date })).toThrow(TimeInputError);
    }
    expect(() => buildPlannerGrid({ participants: [], date: "2026-01-12" })).toThrow(
      TimeInputError,
    );
  });

  it("normalises raw participants defensively", () => {
    const result = buildPlannerGrid({
      participants: [
        {
          name: " Ann ",
          time_zone: "america/new_york",
          work_start: "09:00",
          work_end: "17:00",
          work_days: [1, 2, 3, 4, 5],
        },
      ],
      date: "2026-01-12",
    });
    expect(result.rows[0]).toMatchObject({ name: "Ann", time_zone: NY });
  });
});
