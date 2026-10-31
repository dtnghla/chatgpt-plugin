import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { expandInlineFiles } from "../../src/ingest/inline.js";
import { DEFAULT_UPLOAD_LIMITS, IngestError } from "../../src/ingest/types.js";
import { isZip, normalizeArchivePath, unzipProject } from "../../src/ingest/unzip.js";

function limits(overrides: Partial<typeof DEFAULT_UPLOAD_LIMITS> = {}) {
  return { ...DEFAULT_UPLOAD_LIMITS, ...overrides };
}

describe("normalizeArchivePath", () => {
  it("normalises separators", () => {
    expect(normalizeArchivePath("folder\\sub/file.ktr")).toBe("folder/sub/file.ktr");
  });

  it.each([
    "",
    "/etc/passwd",
    "C:/temp/file.ktr",
    "../evil.ktr",
    "a/../b.ktr",
    "a/./b.ktr",
    "a//b.ktr",
  ])("rejects %j", (name) => {
    expect(() => normalizeArchivePath(name)).toThrow(IngestError);
  });

  it("rejects a NUL byte in a path segment", () => {
    expect(() => normalizeArchivePath("a/\0b.ktr")).toThrow(/NUL/);
  });
});

describe("unzipProject", () => {
  it("recognises a ZIP by magic bytes", () => {
    const data = zipSync({ "a.txt": strToU8("hello") });
    expect(isZip(data)).toBe(true);
    expect(isZip(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("returns sorted files and ignores directory entries", () => {
    const data = zipSync({
      "jobs/nightly.kjb": strToU8("<job/>"),
      "transforms/orders.ktr": strToU8("<transformation/>"),
      "transforms/": new Uint8Array(),
    });
    const result = unzipProject(data, limits());
    expect(result.files.map((file) => file.path)).toEqual([
      "jobs/nightly.kjb",
      "transforms/orders.ktr",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("maps backslash names to safe paths", () => {
    const data = zipSync({ "folder\\orders.ktr": strToU8("<transformation/>") });
    const result = unzipProject(data, limits());
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("folder/orders.ktr");
    expect(new TextDecoder().decode(result.files[0]?.data)).toContain("transformation");
  });

  it("rejects path traversal, absolute paths and duplicates", () => {
    expect(() => unzipProject(zipSync({ "../evil.ktr": strToU8("x") }), limits())).toThrow(
      /unsafe path/,
    );
    expect(() => unzipProject(zipSync({ "/etc/passwd": strToU8("x") }), limits())).toThrow(
      /absolute path/,
    );
    const duplicate = zipSync({
      "a/orders.ktr": strToU8("one"),
      "a\\orders.ktr": strToU8("two"),
    });
    expect(() => unzipProject(duplicate, limits())).toThrow(/duplicate/);
  });

  it("enforces the per-file uncompressed limit before extraction", () => {
    const data = zipSync({ "big.csv": new Uint8Array(2000) });
    expect(() =>
      unzipProject(data, limits({ maxUncompressedFileBytes: 1024, maxUncompressedBytes: 10_000 })),
    ).toThrow(/per-file limit/);
  });

  it("enforces the cumulative uncompressed limit before extraction", () => {
    const chunk = new Uint8Array(700);
    const data = zipSync({
      "one.csv": chunk,
      "two.csv": chunk,
      "three.csv": chunk,
    });
    expect(() =>
      unzipProject(data, limits({ maxUncompressedFileBytes: 1024, maxUncompressedBytes: 1500 })),
    ).toThrow(/total limit/);
  });

  it("enforces the entry-count and archive-size limits", () => {
    const data = zipSync({ "a.ktr": strToU8("a"), "b.ktr": strToU8("b") });
    expect(() => unzipProject(data, limits({ maxArchiveEntries: 1 }))).toThrow(/entries/);
    expect(() => unzipProject(data, limits({ maxArchiveBytes: 4 }))).toThrow(/larger than/);
  });

  it("reports malformed archives", () => {
    expect(() => unzipProject(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), limits())).toThrow(
      IngestError,
    );
    expect(() => unzipProject(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), limits())).toThrow(
      /ZIP/,
    );
  });
});

describe("expandInlineFiles", () => {
  it("expands UTF-8 and base64 entries", () => {
    const result = expandInlineFiles(
      [
        { name: "transforms/a.ktr", content: "<transformation/>" },
        { name: "jobs/b.kjb", content_base64: Buffer.from("<job/>").toString("base64") },
      ],
      limits(),
    );
    expect(result.files.map((file) => file.path)).toEqual(["transforms/a.ktr", "jobs/b.kjb"]);
    expect(new TextDecoder().decode(result.files[0]?.data)).toBe("<transformation/>");
    expect(result.skipped).toEqual([]);
  });

  it("expands nested ZIP entries under the inline name", () => {
    const nested = zipSync({
      "transforms/orders.ktr": strToU8("<transformation/>"),
      "jobs/nightly.kjb": strToU8("<job/>"),
    });
    const result = expandInlineFiles(
      [{ name: "project.zip", content_base64: Buffer.from(nested).toString("base64") }],
      limits(),
    );
    expect(result.files.map((file) => file.path)).toEqual([
      "project.zip/jobs/nightly.kjb",
      "project.zip/transforms/orders.ktr",
    ]);
  });

  it("rejects ambiguous and missing content", () => {
    expect(() =>
      expandInlineFiles(
        [{ name: "a.ktr", content: "x", content_base64: Buffer.from("y").toString("base64") }],
        limits(),
      ),
    ).toThrow(/only one/);
    expect(() => expandInlineFiles([{ name: "a.ktr" }], limits())).toThrow(/must set content/);
  });

  it("rejects invalid base64 and inline size limits", () => {
    expect(() =>
      expandInlineFiles([{ name: "a.ktr", content_base64: "not base64!" }], limits()),
    ).toThrow(/valid base64/);
    expect(() => expandInlineFiles([{ name: "a.ktr", content_base64: "" }], limits())).toThrow(
      /valid base64/,
    );
    expect(() =>
      expandInlineFiles([{ name: "a.ktr", content: "abcdef" }], limits({ maxInlineFileBytes: 3 })),
    ).toThrow(/inline limit/);
    expect(() =>
      expandInlineFiles(
        [
          { name: "a.ktr", content: "abcd" },
          { name: "b.ktr", content: "efgh" },
        ],
        limits({ maxInlineTotalBytes: 6 }),
      ),
    ).toThrow(/total size/);
  });

  it("enforces the file-count limit after expanding archives", () => {
    expect(() =>
      expandInlineFiles(
        [
          { name: "a.ktr", content: "a" },
          { name: "b.ktr", content: "b" },
        ],
        limits({ maxFiles: 1 }),
      ),
    ).toThrow(/more than 1 files/);
  });
});
