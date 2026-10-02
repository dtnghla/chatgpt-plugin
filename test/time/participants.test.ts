import { describe, expect, it } from "vitest";
import {
  type IsoWeekday,
  normalizeParticipants,
  type ParticipantInput,
  TimeInputError,
} from "../../src/time/index.js";

const ann: ParticipantInput = { name: "Ann", time_zone: "America/New_York" };

describe("normalizeParticipants", () => {
  it("applies the defaults", () => {
    expect(normalizeParticipants([ann])).toEqual([
      {
        name: "Ann",
        time_zone: "America/New_York",
        work_start: "09:00",
        work_end: "17:00",
        work_days: [1, 2, 3, 4, 5],
      },
    ]);
  });

  it("keeps explicit values", () => {
    const [p] = normalizeParticipants([
      {
        name: "Ann",
        time_zone: "Asia/Kolkata",
        work_start: "22:00",
        work_end: "06:00",
        work_days: [7],
      },
    ]);
    expect(p).toEqual({
      name: "Ann",
      time_zone: "Asia/Kolkata",
      work_start: "22:00",
      work_end: "06:00",
      work_days: [7],
    });
  });

  it("trims names and canonicalises zones", () => {
    const [p] = normalizeParticipants([{ name: "  Ann Lee ", time_zone: "europe/london" }]);
    expect(p?.name).toBe("Ann Lee");
    expect(p?.time_zone).toBe("Europe/London");
  });

  it("dedupes and sorts work_days", () => {
    const [p] = normalizeParticipants([{ ...ann, work_days: [5, 1, 3, 1, 5, 7] }]);
    expect(p?.work_days).toEqual([1, 3, 5, 7]);
  });

  it("accepts the boundary clock values", () => {
    const [p] = normalizeParticipants([{ ...ann, work_start: "00:00", work_end: "23:59" }]);
    expect(p).toMatchObject({ work_start: "00:00", work_end: "23:59" });
  });

  it("does not mutate the input", () => {
    const input: ParticipantInput = { ...ann, work_days: [3, 1] };
    normalizeParticipants([input]);
    expect(input).toEqual({ ...ann, work_days: [3, 1] });
  });

  it("is idempotent", () => {
    const once = normalizeParticipants([
      { name: " Bob ", time_zone: "asia/kathmandu", work_days: [2, 2, 1] },
      ann,
    ]);
    expect(normalizeParticipants(once)).toEqual(once);
  });

  it("accepts 1 to 20 participants", () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `P${i}`, time_zone: "UTC" }));
    expect(normalizeParticipants(make(1))).toHaveLength(1);
    expect(normalizeParticipants(make(20))).toHaveLength(20);
    expect(() => normalizeParticipants(make(0))).toThrow(/between 1 and 20/);
    expect(() => normalizeParticipants(make(21))).toThrow(/between 1 and 20/);
  });

  it("rejects duplicate names case-insensitively", () => {
    expect(() =>
      normalizeParticipants([ann, { name: " ANN ", time_zone: "Europe/London" }]),
    ).toThrow(/unique.*"ANN"/);
  });

  it.each(["", "   "])("rejects the empty name %j", (name) => {
    expect(() => normalizeParticipants([{ name, time_zone: "UTC" }])).toThrow(/non-empty name/);
  });

  it("rejects names longer than 60 characters", () => {
    expect(() => normalizeParticipants([{ name: "x".repeat(61), time_zone: "UTC" }])).toThrow(
      /60 characters/,
    );
    expect(normalizeParticipants([{ name: "x".repeat(60), time_zone: "UTC" }])).toHaveLength(1);
  });

  it("names the participant when the time zone is invalid", () => {
    expect(() => normalizeParticipants([ann, { name: "Priya", time_zone: "IST" }])).toThrow(
      /Participant 2 \("Priya"\).*ambiguous/,
    );
    expect(() => normalizeParticipants([{ name: "Priya", time_zone: "+05:30" }])).toThrow(
      TimeInputError,
    );
  });

  it.each(["9:00", "24:00", "09:60", "0900", "09:00:00", "", "ab:cd", "9am"])(
    "rejects the clock time %j",
    (value) => {
      expect(() => normalizeParticipants([{ ...ann, work_start: value }])).toThrow(
        /work_start must be a 24-hour time/,
      );
      expect(() => normalizeParticipants([{ ...ann, work_end: value }])).toThrow(
        /work_end must be a 24-hour time/,
      );
    },
  );

  it("rejects empty or invalid work_days", () => {
    expect(() => normalizeParticipants([{ ...ann, work_days: [] }])).toThrow(/at least one/);
    for (const bad of [[0], [8], [1.5], [-1]]) {
      expect(() =>
        normalizeParticipants([{ ...ann, work_days: bad as unknown as IsoWeekday[] }]),
      ).toThrow(/from 1 \(Monday\) to 7 \(Sunday\)/);
    }
  });

  it("only throws TimeInputError for malformed entries", () => {
    const malformed = [
      { name: 5, time_zone: "UTC" },
      { name: "A", time_zone: 7 },
      { name: "A", time_zone: "UTC", work_days: "1" },
    ] as unknown as ParticipantInput[];
    for (const entry of malformed) {
      expect(() => normalizeParticipants([entry])).toThrow(TimeInputError);
    }
    expect(() => normalizeParticipants(undefined as unknown as ParticipantInput[])).toThrow(
      TimeInputError,
    );
  });
});
