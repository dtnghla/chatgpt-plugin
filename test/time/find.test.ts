import { describe, expect, it } from "vitest";
import {
  type FindInput,
  type FindResult,
  findMeetingTimes,
  type MeetingSlot,
  normalizeParticipants,
  type ParticipantInput,
  TimeInputError,
} from "../../src/time/index.js";

function search(
  people: ParticipantInput[],
  overrides: Partial<Omit<FindInput, "participants">> = {},
): FindResult {
  return findMeetingTimes({
    participants: normalizeParticipants(people),
    start_date: "2026-01-12",
    days: 1,
    duration_minutes: 60,
    step_minutes: 60,
    max_results: 20,
    ...overrides,
  });
}

const localStarts = (result: FindResult, participantIndex = 0): string[] =>
  result.slots.map((slot) => slot.participants[participantIndex]?.local_start ?? "");

const NY = "America/New_York";
const LONDON = "Europe/London";
const BERLIN = "Europe/Berlin";
const TOKYO = "Asia/Tokyo";

function overlapsAny(slots: MeetingSlot[]): boolean {
  return slots.some((a, i) =>
    slots.slice(i + 1).some((b) => a.start_utc < b.end_utc && b.start_utc < a.end_utc),
  );
}

describe("findMeetingTimes: full overlap", () => {
  const people: ParticipantInput[] = [
    { name: "Ann", time_zone: NY },
    { name: "Bob", time_zone: LONDON },
    { name: "Cy", time_zone: BERLIN },
  ];

  it("finds the narrow morning overlap (14:00Z-16:00Z in January)", () => {
    const result = search(people, { days: 3, step_minutes: 30, max_results: 5 });
    expect(result.has_full_overlap).toBe(true);
    expect(result.slots.length).toBeGreaterThan(0);
    for (const slot of result.slots) {
      expect(slot.all_available).toBe(true);
      expect(slot.available_count).toBe(3);
      expect(slot.total_participants).toBe(3);
      expect(slot.start_utc.slice(11)).toMatch(/^(14:00|14:30|15:00):00Z$/);
      expect(slot.end_utc > slot.start_utc).toBe(true);
    }
  });

  it("ranks the slot closest to everyone's shift centres first", () => {
    const [best] = search(people, { days: 3, step_minutes: 30, max_results: 5 }).slots;
    expect(best?.start_utc).toBe("2026-01-12T14:00:00Z");
    expect(best?.end_utc).toBe("2026-01-12T15:00:00Z");
    expect(best?.participants).toEqual([
      {
        name: "Ann",
        time_zone: NY,
        local_start: "2026-01-12T09:00",
        local_end: "2026-01-12T10:00",
        utc_offset: "-05:00",
        weekday: 1,
        available: true,
      },
      {
        name: "Bob",
        time_zone: LONDON,
        local_start: "2026-01-12T14:00",
        local_end: "2026-01-12T15:00",
        utc_offset: "+00:00",
        weekday: 1,
        available: true,
      },
      {
        name: "Cy",
        time_zone: BERLIN,
        local_start: "2026-01-12T15:00",
        local_end: "2026-01-12T16:00",
        utc_offset: "+01:00",
        weekday: 1,
        available: true,
      },
    ]);
  });

  it("reports the searched window and a full-overlap summary", () => {
    const result = search(people, { days: 3, max_results: 3 });
    expect(result.searched).toEqual({
      start_date: "2026-01-12",
      days: 3,
      organizer_time_zone: NY,
    });
    expect(result.summary).toBe(
      "Found 3 meeting times where all 3 participants are within working hours.",
    );
  });

  it("uses the singular for one slot and one participant", () => {
    const one = search([{ name: "Ann", time_zone: NY, work_start: "09:00", work_end: "10:00" }]);
    expect(one.slots).toHaveLength(1);
    expect(one.summary).toBe("Found 1 meeting time where the participant is within working hours.");
  });

  it("returns only full slots even if partial ones exist", () => {
    const result = search(people, { days: 3 });
    expect(result.slots.every((slot) => slot.all_available)).toBe(true);
  });

  it("honours max_results", () => {
    expect(search(people, { days: 5, max_results: 2 }).slots).toHaveLength(2);
    expect(search(people, { days: 5, max_results: 1 }).slots).toHaveLength(1);
  });

  it("uses the new offsets once the US is on EDT but London is still on GMT", () => {
    const result = search(people, { start_date: "2026-03-16", step_minutes: 30 });
    expect(result.has_full_overlap).toBe(true);
    for (const slot of result.slots) {
      expect(slot.participants[0]?.utc_offset).toBe("-04:00");
      expect(slot.participants[1]?.utc_offset).toBe("+00:00");
      expect(slot.participants[2]?.utc_offset).toBe("+01:00");
      expect(slot.start_utc.slice(11, 16) >= "13:00").toBe(true);
      expect(slot.end_utc.slice(11, 16) <= "16:00").toBe(true);
    }
  });
});

describe("findMeetingTimes: no full overlap", () => {
  const people: ParticipantInput[] = [
    { name: "Ann", time_zone: NY },
    { name: "Tom", time_zone: TOKYO },
  ];

  it("falls back to the slots with the most available people", () => {
    const result = search(people, { days: 2, step_minutes: 30, max_results: 3 });
    expect(result.has_full_overlap).toBe(false);
    expect(result.slots).toHaveLength(3);
    for (const slot of result.slots) {
      expect(slot.available_count).toBe(1);
      expect(slot.all_available).toBe(false);
      expect(slot.total_participants).toBe(2);
    }
    expect(result.summary).toMatch(
      /^No time in the next 2 days works for everyone\. Showing the slots where the most people \(1 of 2\) are available\./,
    );
  });

  it("marks the unavailable participant with a reason", () => {
    const [first] = search(people, { days: 2, step_minutes: 30 }).slots;
    expect(first?.participants[0]).toMatchObject({ name: "Ann", available: true });
    expect(first?.participants[0]?.reason).toBeUndefined();
    expect(first?.participants[1]).toMatchObject({
      name: "Tom",
      available: false,
      reason: "outside_working_hours",
    });
  });

  it("starts with Ann's shift-centred slot (12:30-13:30 New York, comfort 0)", () => {
    const [first] = search(people, { days: 2, step_minutes: 30 }).slots;
    expect(first?.participants[0]?.local_start).toBe("2026-01-12T12:30");
    expect(first?.start_utc).toBe("2026-01-12T17:30:00Z");
    expect(first?.participants[1]?.local_start).toBe("2026-01-13T02:30");
  });

  it("lists the unavailable names when they are the same in every slot", () => {
    const result = search(
      [
        { name: "Ann", time_zone: NY },
        { name: "Priya", time_zone: "Asia/Kolkata", work_days: [6] },
        { name: "Bob", time_zone: NY },
      ],
      { max_results: 3 },
    );
    expect(result.has_full_overlap).toBe(false);
    expect(result.slots.every((slot) => slot.available_count === 2)).toBe(true);
    expect(result.summary).toContain("(2 of 3) are available.");
    expect(result.summary.endsWith("Unavailable: Priya.")).toBe(true);
  });

  it("says which slot the unavailable names refer to when they vary", () => {
    const result = search(people, { days: 2, max_results: 3 });
    expect(result.summary).toMatch(/Unavailable in the first slot: (Ann|Tom)\.$/);
  });

  it("says 'on the searched day' for a one-day window", () => {
    const result = search(people, { days: 1 });
    expect(result.summary).toContain("No time on the searched day works for everyone.");
  });

  it("returns an empty list when nobody is ever within working hours", () => {
    const result = search([{ name: "Ann", time_zone: NY, work_days: [7] }]);
    expect(result.has_full_overlap).toBe(false);
    expect(result.slots).toEqual([]);
    expect(result.summary).toBe("No participant is within working hours in the searched window.");
  });

  it("fits a slot exactly as long as the shift", () => {
    const result = search([{ name: "Ann", time_zone: NY }], { duration_minutes: 480 });
    expect(localStarts(result)).toEqual(["2026-01-12T09:00"]);
  });

  it("returns an empty list when the duration exceeds every shift", () => {
    const result = search([{ name: "Ann", time_zone: NY, work_end: "12:00" }], {
      duration_minutes: 240,
    });
    expect(result.slots).toEqual([]);
    expect(result.has_full_overlap).toBe(false);
  });
});

describe("findMeetingTimes: unavailable reasons", () => {
  it("uses non_working_day when the slot starts on a day the person does not work", () => {
    const result = search(
      [
        { name: "Ann", time_zone: NY },
        { name: "Sam", time_zone: NY, work_days: [6, 7] },
      ],
      { start_date: "2026-01-17" },
    );
    const [first] = result.slots;
    expect(first?.participants[0]).toMatchObject({
      name: "Ann",
      available: false,
      reason: "non_working_day",
      weekday: 6,
    });
    expect(first?.participants[1]?.available).toBe(true);
  });

  it("uses outside_working_hours when the person works that weekday", () => {
    const result = search([
      { name: "Day", time_zone: TOKYO },
      { name: "Night", time_zone: TOKYO, work_start: "22:00", work_end: "06:00", work_days: [1] },
    ]);
    const [first] = result.slots;
    expect(first?.participants[0]).toMatchObject({ name: "Day", available: true });
    expect(first?.participants[1]).toMatchObject({
      name: "Night",
      available: false,
      reason: "outside_working_hours",
      weekday: 1,
    });
  });

  it("uses non_working_day for a weekday after the person's only shift day", () => {
    const result = search(
      [
        { name: "Day", time_zone: TOKYO, work_days: [2] },
        { name: "Night", time_zone: TOKYO, work_start: "22:00", work_end: "06:00", work_days: [1] },
      ],
      { start_date: "2026-01-13" },
    );
    const daySlot = result.slots.find((slot) => slot.participants[0]?.available);
    expect(daySlot?.participants[1]).toMatchObject({
      name: "Night",
      available: false,
      reason: "non_working_day",
      weekday: 2,
    });
  });

  it("uses outside_working_hours when an overnight shift from the previous day is still running at the slot start", () => {
    const result = search(
      [
        { name: "Early", time_zone: TOKYO, work_start: "05:30", work_end: "06:30", work_days: [2] },
        { name: "Night", time_zone: TOKYO, work_start: "22:00", work_end: "06:00", work_days: [1] },
      ],
      { start_date: "2026-01-13", step_minutes: 30 },
    );
    const earlySlot = result.slots.find((slot) => slot.participants[0]?.available);
    expect(earlySlot?.participants[0]?.local_start).toBe("2026-01-13T05:30");
    expect(earlySlot?.participants[1]).toMatchObject({
      available: false,
      reason: "outside_working_hours",
    });
  });
});

describe("findMeetingTimes: overnight shifts", () => {
  it("finds overlap with a night-shift participant in another zone", () => {
    const result = search(
      [
        { name: "Day", time_zone: LONDON },
        { name: "Night", time_zone: TOKYO, work_start: "22:00", work_end: "06:00" },
      ],
      { max_results: 10 },
    );
    expect(result.has_full_overlap).toBe(true);
    expect(result.slots.map((s) => s.start_utc)).toEqual([
      "2026-01-12T13:00:00Z",
      "2026-01-12T14:00:00Z",
      "2026-01-12T15:00:00Z",
      "2026-01-12T16:00:00Z",
    ]);
    const crossing = result.slots[3]?.participants[1];
    expect(crossing).toMatchObject({
      local_start: "2026-01-13T01:00",
      local_end: "2026-01-13T02:00",
      weekday: 2,
      available: true,
    });
  });

  it("covers a shift that started on the day before the window", () => {
    const result = search(
      [{ name: "Night", time_zone: TOKYO, work_start: "22:00", work_end: "06:00", work_days: [1] }],
      { start_date: "2026-01-13", max_results: 10 },
    );
    expect(localStarts(result)).toEqual([
      "2026-01-13T01:00",
      "2026-01-13T02:00",
      "2026-01-13T00:00",
      "2026-01-13T03:00",
      "2026-01-13T04:00",
      "2026-01-13T05:00",
    ]);
  });

  it("does not invent a shift for a non-working day before the window", () => {
    const result = search(
      [{ name: "Night", time_zone: TOKYO, work_start: "22:00", work_end: "06:00", work_days: [1] }],
      { start_date: "2026-01-12", max_results: 10 },
    );
    expect(localStarts(result)).toEqual(["2026-01-12T23:00", "2026-01-12T22:00"]);
  });

  it("treats equal start and end as a 24-hour shift and merges exactly touching shifts", () => {
    const result = search(
      [
        {
          name: "Always",
          time_zone: NY,
          work_start: "08:00",
          work_end: "08:00",
          work_days: [1, 2],
        },
        { name: "Morning", time_zone: NY, work_start: "06:00", work_end: "10:00", work_days: [2] },
      ],
      { start_date: "2026-01-12", days: 2, duration_minutes: 240, step_minutes: 60 },
    );
    expect(result.has_full_overlap).toBe(true);
    expect(localStarts(result, 1)).toEqual(["2026-01-13T06:00"]);
  });

  it("does not merge shifts separated by a gap", () => {
    const result = search([{ name: "Ann", time_zone: NY }], {
      days: 2,
      duration_minutes: 480,
      step_minutes: 60,
    });
    expect(result.slots).toHaveLength(2);
    expect(localStarts(result).sort()).toEqual(["2026-01-12T09:00", "2026-01-13T09:00"]);
  });
});

describe("findMeetingTimes: working days", () => {
  it("skips weekends", () => {
    const result = search([{ name: "Ann", time_zone: NY }], {
      start_date: "2026-01-16",
      days: 4,
      max_results: 20,
    });
    const days = new Set(localStarts(result).map((s) => s.slice(0, 10)));
    expect([...days].sort()).toEqual(["2026-01-16", "2026-01-19"]);
    expect(result.slots).toHaveLength(16);
    expect(result.slots.every((s) => [1, 5].includes(s.participants[0]?.weekday ?? 0))).toBe(true);
  });

  it("respects different work weeks in different zones", () => {
    const result = search(
      [
        { name: "Ann", time_zone: NY },
        {
          name: "Dubai",
          time_zone: "Asia/Dubai",
          work_days: [7, 1, 2, 3, 4],
          work_start: "09:00",
          work_end: "17:00",
        },
      ],
      { start_date: "2026-01-15", days: 4, max_results: 20, step_minutes: 30 },
    );
    expect(result.has_full_overlap).toBe(false);
    for (const slot of result.slots) {
      expect(slot.available_count).toBe(1);
    }
  });
});

describe("findMeetingTimes: DST", () => {
  it("reflects the US spring-forward in the organizer's window", () => {
    const result = search([{ name: "Ann", time_zone: NY }], {
      start_date: "2026-03-06",
      days: 4,
      max_results: 20,
    });
    expect(result.slots).toHaveLength(16);
    const byLocal = new Map(result.slots.map((s) => [s.participants[0]?.local_start, s]));
    expect(byLocal.get("2026-03-06T09:00")?.start_utc).toBe("2026-03-06T14:00:00Z");
    expect(byLocal.get("2026-03-06T09:00")?.participants[0]?.utc_offset).toBe("-05:00");
    expect(byLocal.get("2026-03-09T09:00")?.start_utc).toBe("2026-03-09T13:00:00Z");
    expect(byLocal.get("2026-03-09T09:00")?.participants[0]?.utc_offset).toBe("-04:00");
  });

  it("makes the spring-forward day a 23 hour window", () => {
    const result = search(
      [
        {
          name: "Ann",
          time_zone: NY,
          work_start: "00:00",
          work_end: "00:00",
          work_days: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
      {
        start_date: "2026-03-08",
        days: 1,
        duration_minutes: 480,
        step_minutes: 60,
        max_results: 20,
      },
    );
    expect(result.slots.length).toBeGreaterThan(0);
    for (const slot of result.slots) {
      expect(slot.start_utc >= "2026-03-08T05:00:00Z").toBe(true);
      expect(slot.end_utc <= "2026-03-09T04:00:00Z").toBe(true);
    }
  });

  it("makes the fall-back day a 25 hour window", () => {
    const result = search(
      [{ name: "Ann", time_zone: NY, work_start: "23:00", work_end: "00:00", work_days: [7] }],
      { start_date: "2026-11-01", days: 1 },
    );
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({
      start_utc: "2026-11-02T04:00:00Z",
      end_utc: "2026-11-02T05:00:00Z",
    });
    expect(result.slots[0]?.participants[0]?.local_start).toBe("2026-11-01T23:00");
  });

  it("moves a shift boundary that falls into the gap forward (compatible)", () => {
    const result = search(
      [{ name: "Ann", time_zone: NY, work_start: "02:30", work_end: "04:30", work_days: [7] }],
      { start_date: "2026-03-08", duration_minutes: 15, step_minutes: 15, max_results: 20 },
    );
    expect(result.slots.map((s) => s.start_utc).sort()).toEqual([
      "2026-03-08T07:30:00Z",
      "2026-03-08T07:45:00Z",
      "2026-03-08T08:00:00Z",
      "2026-03-08T08:15:00Z",
    ]);
  });

  it("uses a non-organizer's own DST rules across the UK change on 2026-03-29", () => {
    const result = search([{ name: "Bob", time_zone: LONDON }], {
      start_date: "2026-03-27",
      days: 4,
      max_results: 20,
    });
    const byLocal = new Map(result.slots.map((s) => [s.participants[0]?.local_start, s]));
    expect(byLocal.get("2026-03-27T09:00")?.start_utc).toBe("2026-03-27T09:00:00Z");
    expect(byLocal.get("2026-03-30T09:00")?.start_utc).toBe("2026-03-30T08:00:00Z");
    expect(byLocal.get("2026-03-30T09:00")?.participants[0]?.utc_offset).toBe("+01:00");
  });

  it("shifts the New York / London overlap by an hour once the US is on EDT", () => {
    const people: ParticipantInput[] = [
      { name: "Ann", time_zone: NY },
      { name: "Bob", time_zone: LONDON },
    ];
    const winter = search(people, { start_date: "2026-03-02" });
    expect(winter.slots.map((s) => s.start_utc)).toEqual([
      "2026-03-02T14:00:00Z",
      "2026-03-02T15:00:00Z",
      "2026-03-02T16:00:00Z",
    ]);
    const split = search(people, { start_date: "2026-03-09" });
    expect(split.slots.map((s) => s.start_utc)).toEqual([
      "2026-03-09T13:00:00Z",
      "2026-03-09T14:00:00Z",
      "2026-03-09T15:00:00Z",
      "2026-03-09T16:00:00Z",
    ]);
    expect(split.slots[0]?.participants[0]).toMatchObject({
      local_start: "2026-03-09T09:00",
      utc_offset: "-04:00",
    });
    expect(split.slots[0]?.participants[1]).toMatchObject({
      local_start: "2026-03-09T13:00",
      utc_offset: "+00:00",
    });
  });
});

describe("findMeetingTimes: result shaping", () => {
  it("de-duplicates overlapping candidates greedily by comfort", () => {
    const result = search([{ name: "Ann", time_zone: NY }], {
      step_minutes: 15,
      max_results: 20,
    });
    expect(overlapsAny(result.slots)).toBe(false);
    expect(localStarts(result).sort()).toEqual([
      "2026-01-12T09:30",
      "2026-01-12T10:30",
      "2026-01-12T11:30",
      "2026-01-12T12:30",
      "2026-01-12T13:30",
      "2026-01-12T14:30",
      "2026-01-12T15:30",
    ]);
  });

  it("returns slots ordered by comfort, then earlier start", () => {
    const result = search([{ name: "Ann", time_zone: NY }], { step_minutes: 15, max_results: 3 });
    expect(localStarts(result)).toEqual([
      "2026-01-12T12:30",
      "2026-01-12T11:30",
      "2026-01-12T13:30",
    ]);
  });

  it("allows back-to-back slots that merely touch", () => {
    const result = search([{ name: "Ann", time_zone: NY }], { step_minutes: 30, max_results: 20 });
    const ordered = [...result.slots].sort((a, b) => a.start_utc.localeCompare(b.start_utc));
    const touching = ordered.some((slot, i) => ordered[i + 1]?.start_utc === slot.end_utc);
    expect(touching).toBe(true);
    expect(overlapsAny(result.slots)).toBe(false);
  });

  it("aligns every start to the step counted from the organizer's local midnight", () => {
    const result = search(
      [
        { name: "Asha", time_zone: "Asia/Kolkata" },
        { name: "Bob", time_zone: LONDON },
      ],
      { max_results: 20 },
    );
    expect(result.has_full_overlap).toBe(true);
    expect(result.slots.map((s) => s.start_utc)).toEqual([
      "2026-01-12T09:30:00Z",
      "2026-01-12T10:30:00Z",
    ]);
    expect(result.slots[0]?.participants[0]?.local_start).toBe("2026-01-12T15:00");
  });

  it("steps by exact elapsed time", () => {
    const result = search([{ name: "Ann", time_zone: NY }], {
      step_minutes: 15,
      duration_minutes: 15,
      max_results: 20,
    });
    const minutes = result.slots.map((s) => new Date(s.start_utc).getUTCMinutes());
    expect(minutes.every((m) => m % 15 === 0)).toBe(true);
  });

  it("keeps slot lengths equal to duration_minutes", () => {
    const result = search([{ name: "Ann", time_zone: NY }], {
      duration_minutes: 45,
      step_minutes: 15,
    });
    for (const slot of result.slots) {
      expect(Date.parse(slot.end_utc) - Date.parse(slot.start_utc)).toBe(45 * 60_000);
    }
  });

  it("works for a single participant with default hours", () => {
    const result = search([{ name: "Ann", time_zone: NY }]);
    expect(result.has_full_overlap).toBe(true);
    expect(result.slots[0]?.all_available).toBe(true);
  });

  it("does not require the input to be pre-normalised", () => {
    const result = findMeetingTimes({
      participants: [
        {
          name: " Ann ",
          time_zone: "america/new_york",
          work_start: "09:00",
          work_end: "17:00",
          work_days: [3, 1, 1],
        },
      ],
      start_date: "2026-01-12",
      days: 1,
      duration_minutes: 60,
      step_minutes: 60,
      max_results: 20,
    });
    expect(result.searched.organizer_time_zone).toBe(NY);
    expect(result.slots[0]?.participants[0]?.name).toBe("Ann");
    expect(result.slots[0]?.participants[0]?.time_zone).toBe(NY);
  });
});

describe("findMeetingTimes: validation", () => {
  const base = {
    participants: normalizeParticipants([{ name: "Ann", time_zone: NY }]),
    start_date: "2026-01-12",
    days: 3,
    duration_minutes: 60,
    step_minutes: 30 as const,
    max_results: 5,
  };

  it.each([
    ["days 0", { days: 0 }],
    ["days 15", { days: 15 }],
    ["days 1.5", { days: 1.5 }],
    ["duration 14", { duration_minutes: 14 }],
    ["duration 481", { duration_minutes: 481 }],
    ["duration 20.5", { duration_minutes: 20.5 }],
    ["step 45", { step_minutes: 45 as unknown as 15 }],
    ["step 5", { step_minutes: 5 as unknown as 15 }],
    ["max_results 0", { max_results: 0 }],
    ["max_results 21", { max_results: 21 }],
    ["start_date wrong order", { start_date: "01/12/2026" }],
    ["start_date month 13", { start_date: "2026-13-01" }],
    ["start_date Feb 30", { start_date: "2026-02-30" }],
    ["start_date with time", { start_date: "2026-01-12T00:00" }],
    ["start_date empty", { start_date: "" }],
    ["NaN days", { days: Number.NaN }],
  ])("rejects %s", (_label, override) => {
    expect(() => findMeetingTimes({ ...base, ...override })).toThrow(TimeInputError);
  });

  it("accepts the boundary values", () => {
    expect(() =>
      findMeetingTimes({
        ...base,
        days: 14,
        duration_minutes: 480,
        step_minutes: 15,
        max_results: 20,
      }),
    ).not.toThrow();
    expect(() =>
      findMeetingTimes({
        ...base,
        days: 1,
        duration_minutes: 15,
        step_minutes: 60,
        max_results: 1,
      }),
    ).not.toThrow();
  });

  it("rejects 0 and 21 participants", () => {
    expect(() => findMeetingTimes({ ...base, participants: [] })).toThrow(TimeInputError);
    const many = Array.from({ length: 21 }, (_, i) => ({
      name: `P${i}`,
      time_zone: "UTC",
      work_start: "09:00",
      work_end: "17:00",
      work_days: [1, 2, 3, 4, 5] as FindInput["participants"][number]["work_days"],
    }));
    expect(() => findMeetingTimes({ ...base, participants: many })).toThrow(TimeInputError);
  });
});

describe("findMeetingTimes: performance", () => {
  it("handles 20 participants x 14 days x 15-minute steps in under a second", () => {
    const zones = [
      NY,
      LONDON,
      BERLIN,
      TOKYO,
      "Asia/Kolkata",
      "Australia/Sydney",
      "Pacific/Auckland",
      "America/Los_Angeles",
      "Asia/Kathmandu",
      "Pacific/Kiritimati",
    ];
    const people: ParticipantInput[] = Array.from({ length: 20 }, (_, i) => ({
      name: `Person ${i}`,
      time_zone: zones[i % zones.length] ?? "UTC",
      work_start: i % 3 === 0 ? "22:00" : "08:30",
      work_end: i % 3 === 0 ? "06:00" : "18:00",
    }));
    const started = performance.now();
    const result = search(people, {
      start_date: "2026-03-01",
      days: 14,
      duration_minutes: 15,
      step_minutes: 15,
      max_results: 20,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result.slots.length).toBeGreaterThan(0);
  });
});
