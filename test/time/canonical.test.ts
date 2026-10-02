import { describe, expect, it } from "vitest";
import { canonicalTimeZone, TimeInputError } from "../../src/time/index.js";

describe("canonicalTimeZone", () => {
  it.each([
    "America/New_York",
    "Europe/London",
    "Asia/Kathmandu",
    "Etc/GMT+5",
    "Pacific/Kiritimati",
  ])("accepts %s unchanged", (id) => {
    expect(canonicalTimeZone(id)).toBe(id);
  });

  it("accepts multi-segment ids", () => {
    expect(canonicalTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("accepts UTC in any case", () => {
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("Utc")).toBe("UTC");
  });

  it("fixes the letter case of region names", () => {
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalTimeZone("EUROPE/LONDON")).toBe("Europe/London");
    expect(canonicalTimeZone("etc/gmt+5")).toBe("Etc/GMT+5");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalTimeZone("  Europe/Berlin ")).toBe("Europe/Berlin");
  });

  it("keeps link (alias) names as given instead of rewriting them", () => {
    // temporal-polyfill only normalises case: "Asia/Calcutta" stays "Asia/Calcutta"
    // and is not replaced by "Asia/Kolkata". Both resolve to the same rules.
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Calcutta");
    expect(canonicalTimeZone("asia/calcutta")).toBe("Asia/Calcutta");
    expect(canonicalTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("US/Eastern")).toBe("US/Eastern");
  });

  it.each(["IST", "CST", "EST", "PST", "BST", "cet", "GMT"])(
    "rejects the abbreviation %s as ambiguous and suggests an IANA name",
    (abbreviation) => {
      expect(() => canonicalTimeZone(abbreviation)).toThrow(TimeInputError);
      expect(() => canonicalTimeZone(abbreviation)).toThrow(/ambiguous/);
      expect(() => canonicalTimeZone(abbreviation)).toThrow(/America\/Chicago/);
    },
  );

  it.each(["+05:00", "-08:00", "+0530", "+5"])("rejects the numeric offset %s", (offset) => {
    expect(() => canonicalTimeZone(offset)).toThrow(TimeInputError);
    expect(() => canonicalTimeZone(offset)).toThrow(/offset/);
  });

  it.each([
    "",
    "   ",
    "Mars/Olympus",
    "America/New_Yorkk",
    "America/New_York/",
    "/America/New_York",
    "UTC+5",
    "EST5EDT",
    "Z",
    "2026-01-01T00:00[America/New_York]",
    "America/New York",
  ])("rejects %j", (id) => {
    expect(() => canonicalTimeZone(id)).toThrow(TimeInputError);
  });

  it("never leaks a raw RangeError", () => {
    for (const id of ["Mars/Olympus", "+99:99", "Not/AZone", "\u0000/x"]) {
      try {
        canonicalTimeZone(id);
        expect.unreachable(`${id} should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(TimeInputError);
      }
    }
  });

  it("rejects non-string input", () => {
    expect(() => canonicalTimeZone(undefined as unknown as string)).toThrow(TimeInputError);
  });
});
