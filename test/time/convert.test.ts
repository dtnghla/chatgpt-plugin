import { describe, expect, it } from "vitest";
import { convertTime, TimeInputError } from "../../src/time/index.js";

const NY = "America/New_York";

function convert(dateTime: string, from: string, ...to: string[]) {
  return convertTime({ date_time: dateTime, from_time_zone: from, to_time_zones: to });
}

describe("convertTime: basic conversions", () => {
  const result = convert(
    "2026-01-15T09:00",
    NY,
    "Europe/London",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Pacific/Kiritimati",
    "Pacific/Honolulu",
  );
  const [london, tokyo, kolkata, kathmandu, kiritimati, honolulu] = result.targets;

  it("describes the source moment", () => {
    expect(result.source).toEqual({
      time_zone: NY,
      local_date_time: "2026-01-15T09:00",
      utc_offset: "-05:00",
      weekday: 4,
      day_offset: 0,
      is_dst: false,
    });
    expect(result.requested_date_time).toBe("2026-01-15T09:00");
    expect(result.dst_adjustment).toBe("none");
    expect(result.utc).toBe("2026-01-15T14:00:00Z");
  });

  it("keeps the order of the requested targets", () => {
    expect(result.targets.map((t) => t.time_zone)).toEqual([
      "Europe/London",
      "Asia/Tokyo",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Pacific/Kiritimati",
      "Pacific/Honolulu",
    ]);
  });

  it("converts to London (GMT in January)", () => {
    expect(london).toMatchObject({
      local_date_time: "2026-01-15T14:00",
      utc_offset: "+00:00",
      weekday: 4,
      day_offset: 0,
      is_dst: false,
    });
  });

  it("converts to Tokyo", () => {
    expect(tokyo).toMatchObject({
      local_date_time: "2026-01-15T23:00",
      utc_offset: "+09:00",
      day_offset: 0,
    });
  });

  it("converts to Kolkata (+05:30)", () => {
    expect(kolkata).toMatchObject({ local_date_time: "2026-01-15T19:30", utc_offset: "+05:30" });
  });

  it("converts to Kathmandu (+05:45)", () => {
    expect(kathmandu).toMatchObject({ local_date_time: "2026-01-15T19:45", utc_offset: "+05:45" });
  });

  it("moves to the next day in Kiritimati (+14:00)", () => {
    expect(kiritimati).toMatchObject({
      local_date_time: "2026-01-16T04:00",
      utc_offset: "+14:00",
      weekday: 5,
      day_offset: 1,
    });
  });

  it("converts to Honolulu (-10:00, no DST)", () => {
    expect(honolulu).toMatchObject({
      local_date_time: "2026-01-15T04:00",
      utc_offset: "-10:00",
      day_offset: 0,
      is_dst: false,
    });
  });

  it("reports negative day offsets across the date line", () => {
    const back = convert("2026-01-16T04:00", "Pacific/Kiritimati", "Pacific/Honolulu", "UTC");
    expect(back.targets[0]).toMatchObject({ local_date_time: "2026-01-15T04:00", day_offset: -1 });
    expect(back.targets[1]).toMatchObject({
      local_date_time: "2026-01-15T14:00",
      utc_offset: "+00:00",
      day_offset: -1,
    });
  });

  it("reports a day offset of +1 when the target is past midnight", () => {
    const late = convert("2026-01-15T22:00", NY, "Asia/Tokyo");
    expect(late.targets[0]).toMatchObject({ local_date_time: "2026-01-16T12:00", day_offset: 1 });
  });

  it("formats UTC as +00:00 and echoes duplicates in order", () => {
    const dup = convert("2026-01-15T09:00", NY, "UTC", "utc", "Europe/Paris", "UTC");
    expect(dup.targets).toHaveLength(4);
    expect(dup.targets.map((t) => t.time_zone)).toEqual(["UTC", "UTC", "Europe/Paris", "UTC"]);
    expect(dup.targets[0]).toMatchObject({
      utc_offset: "+00:00",
      local_date_time: "2026-01-15T14:00",
    });
    expect(dup.targets[3]).toEqual(dup.targets[0]);
  });

  it("canonicalises zone ids in the output", () => {
    const r = convert("2026-01-15T09:00", "america/new_york", "europe/london");
    expect(r.source.time_zone).toBe(NY);
    expect(r.targets[0]?.time_zone).toBe("Europe/London");
  });

  it("accepts optional seconds but never prints them locally", () => {
    const r = convert("2026-01-15T09:00:30", NY, "Europe/London");
    expect(r.requested_date_time).toBe("2026-01-15T09:00");
    expect(r.source.local_date_time).toBe("2026-01-15T09:00");
    expect(r.utc).toBe("2026-01-15T14:00:30Z");
    expect(r.targets[0]?.local_date_time).toBe("2026-01-15T14:00");
  });
});

describe("convertTime: DST in the source zone", () => {
  it("reports a gap and moves forward (US spring forward)", () => {
    const r = convert("2026-03-08T02:30", NY, "UTC", "Europe/London");
    expect(r.dst_adjustment).toBe("gap");
    expect(r.requested_date_time).toBe("2026-03-08T02:30");
    expect(r.source).toMatchObject({
      local_date_time: "2026-03-08T03:30",
      utc_offset: "-04:00",
      is_dst: true,
      weekday: 7,
    });
    expect(r.utc).toBe("2026-03-08T07:30:00Z");
    expect(r.targets[0]?.local_date_time).toBe("2026-03-08T07:30");
  });

  it("reports no adjustment just before and after the US gap", () => {
    const before = convert("2026-03-08T01:59", NY, "UTC");
    expect(before.dst_adjustment).toBe("none");
    expect(before.source.utc_offset).toBe("-05:00");
    const after = convert("2026-03-08T03:00", NY, "UTC");
    expect(after.dst_adjustment).toBe("none");
    expect(after.source.utc_offset).toBe("-04:00");
    expect(after.utc).toBe("2026-03-08T07:00:00Z");
  });

  it("reports an overlap and uses the earlier occurrence (US fall back)", () => {
    const r = convert("2026-11-01T01:30", NY, "UTC");
    expect(r.dst_adjustment).toBe("overlap");
    expect(r.source).toMatchObject({
      local_date_time: "2026-11-01T01:30",
      utc_offset: "-04:00",
      is_dst: true,
    });
    expect(r.utc).toBe("2026-11-01T05:30:00Z");
  });

  it("reports no adjustment just outside the US overlap", () => {
    const before = convert("2026-11-01T00:59", NY, "UTC");
    expect(before.dst_adjustment).toBe("none");
    const after = convert("2026-11-01T02:00", NY, "UTC");
    expect(after.dst_adjustment).toBe("none");
    expect(after.source).toMatchObject({ utc_offset: "-05:00", is_dst: false });
    expect(after.utc).toBe("2026-11-01T07:00:00Z");
  });

  it("handles the EU spring-forward gap in London (01:00 UTC on 2026-03-29)", () => {
    const r = convert("2026-03-29T01:30", "Europe/London", "UTC");
    expect(r.dst_adjustment).toBe("gap");
    expect(r.source).toMatchObject({ local_date_time: "2026-03-29T02:30", utc_offset: "+01:00" });
    expect(r.utc).toBe("2026-03-29T01:30:00Z");
  });

  it("handles the EU spring-forward gap in Berlin", () => {
    const r = convert("2026-03-29T02:30", "Europe/Berlin", "UTC");
    expect(r.dst_adjustment).toBe("gap");
    expect(r.source).toMatchObject({ local_date_time: "2026-03-29T03:30", utc_offset: "+02:00" });
    expect(r.utc).toBe("2026-03-29T01:30:00Z");
  });

  it("handles the EU fall-back overlap in London (2026-10-25)", () => {
    const r = convert("2026-10-25T01:30", "Europe/London", "UTC");
    expect(r.dst_adjustment).toBe("overlap");
    expect(r.source).toMatchObject({ local_date_time: "2026-10-25T01:30", utc_offset: "+01:00" });
    expect(r.utc).toBe("2026-10-25T00:30:00Z");
  });

  it("handles the EU fall-back overlap in Berlin (2026-10-25)", () => {
    const r = convert("2026-10-25T02:30", "Europe/Berlin", "UTC");
    expect(r.dst_adjustment).toBe("overlap");
    expect(r.source).toMatchObject({ local_date_time: "2026-10-25T02:30", utc_offset: "+02:00" });
    expect(r.utc).toBe("2026-10-25T00:30:00Z");
  });

  it("handles Lord Howe's half-hour overlap (DST ends 2026-04-05 02:00 -> 01:30)", () => {
    const r = convert("2026-04-05T01:45", "Australia/Lord_Howe", "UTC");
    expect(r.dst_adjustment).toBe("overlap");
    expect(r.source).toMatchObject({ utc_offset: "+11:00", is_dst: true });
    expect(r.utc).toBe("2026-04-04T14:45:00Z");
  });

  it("handles Lord Howe's half-hour gap (DST starts 2026-10-04 02:00 -> 02:30)", () => {
    const r = convert("2026-10-04T02:15", "Australia/Lord_Howe", "UTC");
    expect(r.dst_adjustment).toBe("gap");
    expect(r.source).toMatchObject({ local_date_time: "2026-10-04T02:45", utc_offset: "+11:00" });
    expect(r.utc).toBe("2026-10-03T15:45:00Z");
  });
});

describe("convertTime: DST in the target zone", () => {
  it("shows Lord Howe on +10:30 in winter and +11:00 in summer", () => {
    const winter = convert("2026-07-15T12:00", "UTC", "Australia/Lord_Howe");
    expect(winter.targets[0]).toMatchObject({
      local_date_time: "2026-07-15T22:30",
      utc_offset: "+10:30",
      is_dst: false,
    });
    const summer = convert("2026-01-15T12:00", "UTC", "Australia/Lord_Howe");
    expect(summer.targets[0]).toMatchObject({
      local_date_time: "2026-01-15T23:00",
      utc_offset: "+11:00",
      is_dst: true,
    });
  });

  it("shows the Lord Howe half-hour shift against a fixed zone across the transition", () => {
    const before = convert("2026-04-04T12:00", "Australia/Lord_Howe", "UTC");
    const after = convert("2026-04-06T12:00", "Australia/Lord_Howe", "UTC");
    expect(before.utc).toBe("2026-04-04T01:00:00Z");
    expect(after.utc).toBe("2026-04-06T01:30:00Z");
  });

  it("covers the weeks when New York is on EDT but London is still on GMT", () => {
    const march = convert("2026-03-15T09:00", NY, "Europe/London");
    expect(march.targets[0]).toMatchObject({
      local_date_time: "2026-03-15T13:00",
      utc_offset: "+00:00",
      is_dst: false,
    });
    expect(march.source).toMatchObject({ utc_offset: "-04:00", is_dst: true });

    const january = convert("2026-01-15T09:00", NY, "Europe/London");
    expect(january.targets[0]?.local_date_time).toBe("2026-01-15T14:00");

    const april = convert("2026-04-15T09:00", NY, "Europe/London");
    expect(april.targets[0]).toMatchObject({
      local_date_time: "2026-04-15T14:00",
      utc_offset: "+01:00",
      is_dst: true,
    });
  });

  it("flags southern-hemisphere DST correctly (Sydney)", () => {
    const january = convert("2026-01-15T12:00", "UTC", "Australia/Sydney");
    expect(january.targets[0]).toMatchObject({
      local_date_time: "2026-01-15T23:00",
      utc_offset: "+11:00",
      is_dst: true,
    });
    const july = convert("2026-07-15T12:00", "UTC", "Australia/Sydney");
    expect(july.targets[0]).toMatchObject({
      local_date_time: "2026-07-15T22:00",
      utc_offset: "+10:00",
      is_dst: false,
    });
  });

  it("reports is_dst false for zones without DST", () => {
    for (const month of ["01", "07"]) {
      const r = convert(`2026-${month}-15T12:00`, "UTC", "Asia/Tokyo", "Asia/Kolkata", "UTC");
      expect(r.targets.every((t) => !t.is_dst)).toBe(true);
    }
  });

  it("treats the larger offset as DST in Europe/Dublin (negative DST in the tz database)", () => {
    const summer = convert("2026-07-15T12:00", "UTC", "Europe/Dublin");
    expect(summer.targets[0]).toMatchObject({ utc_offset: "+01:00", is_dst: true });
    const winter = convert("2026-01-15T12:00", "UTC", "Europe/Dublin");
    expect(winter.targets[0]).toMatchObject({ utc_offset: "+00:00", is_dst: false });
  });

  it("flips is_dst exactly at the transition instant", () => {
    const before = convert("2026-03-08T06:59", "UTC", NY);
    const after = convert("2026-03-08T07:00", "UTC", NY);
    expect(before.targets[0]).toMatchObject({ local_date_time: "2026-03-08T01:59", is_dst: false });
    expect(after.targets[0]).toMatchObject({ local_date_time: "2026-03-08T03:00", is_dst: true });
  });
});

describe("convertTime: invalid input", () => {
  const valid = { from_time_zone: NY, to_time_zones: ["UTC"] };

  it.each([
    "2026-01-15T09:00Z",
    "2026-01-15T09:00+01:00",
    "2026-01-15T09:00:00.000Z",
    "2026-01-15T09:00[America/New_York]",
    "2026-01-15",
    "2026-01-15 09:00",
    "9:00",
    "",
    "tomorrow",
  ])("rejects the format %j", (date_time) => {
    expect(() => convertTime({ ...valid, date_time })).toThrow(TimeInputError);
  });

  it("explains that the time must be local with no offset", () => {
    expect(() => convertTime({ ...valid, date_time: "2026-01-15T09:00Z" })).toThrow(/no offset/);
  });

  it.each(["2026-02-30T09:00", "2026-13-01T09:00", "2026-01-15T25:00", "2026-01-15T09:60"])(
    "rejects the impossible date-time %s",
    (date_time) => {
      expect(() => convertTime({ ...valid, date_time })).toThrow(TimeInputError);
    },
  );

  it("rejects a bad source zone and bad target zones", () => {
    const date_time = "2026-01-15T09:00";
    expect(() => convertTime({ ...valid, date_time, from_time_zone: "EST" })).toThrow(/ambiguous/);
    expect(() =>
      convertTime({ ...valid, date_time, to_time_zones: ["UTC", "Mars/Olympus"] }),
    ).toThrow(TimeInputError);
    expect(() => convertTime({ ...valid, date_time, from_time_zone: "" })).toThrow(TimeInputError);
  });

  it("requires between 1 and 24 targets", () => {
    const date_time = "2026-01-15T09:00";
    expect(() => convertTime({ ...valid, date_time, to_time_zones: [] })).toThrow(TimeInputError);
    const twentyFour = Array.from({ length: 24 }, () => "UTC");
    expect(convertTime({ ...valid, date_time, to_time_zones: twentyFour }).targets).toHaveLength(
      24,
    );
    expect(() =>
      convertTime({ ...valid, date_time, to_time_zones: [...twentyFour, "UTC"] }),
    ).toThrow(TimeInputError);
  });
});
