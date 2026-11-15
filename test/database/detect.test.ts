import { describe, expect, it } from "vitest";
import { detectEngine } from "../../src/database/detect.js";
import { fixtureFiles } from "../helpers.js";

function fixtureTexts(name: string): { path: string; text: string }[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return fixtureFiles(name).map((file) => ({ path: file.path, text: decoder.decode(file.data) }));
}

describe("detectEngine", () => {
  it("detects the oracle-hr fixture as oracle", () => {
    const detection = detectEngine(fixtureTexts("oracle-hr"));
    expect(detection.engine).toBe("oracle");
    expect(detection.perFile.get("schema/tables.sql")).toBe("oracle");
    expect(detection.perFile.get("plsql/emp_pkg.sql")).toBe("oracle");
  });

  it("detects the teradata-sales fixture as teradata", () => {
    const detection = detectEngine(fixtureTexts("teradata-sales"));
    expect(detection.engine).toBe("teradata");
    expect(detection.perFile.get("ddl/sales.sql")).toBe("teradata");
    expect(detection.perFile.get("bteq/nightly.btq")).toBe("teradata");
  });

  it("detects the hive-lake fixture as hive", () => {
    const detection = detectEngine(fixtureTexts("hive-lake"));
    expect(detection.engine).toBe("hive");
    expect(detection.perFile.get("hql/sales.hql")).toBe("hive");
  });

  it("returns undefined when nothing matches", () => {
    const detection = detectEngine([{ path: "t.sql", text: "CREATE TABLE t (id INTEGER);" }]);
    expect(detection.engine).toBeUndefined();
    expect(detection.perFile.get("t.sql")).toBeUndefined();
  });

  it("applies the extension bonus", () => {
    const detection = detectEngine([
      { path: "export.hql", text: "SELECT a FROM b WHERE c = 'x';" },
    ]);
    expect(detection.engine).toBe("hive");
    expect(detection.perFile.get("export.hql")).toBe("hive");
    const btq = detectEngine([{ path: "job.bteq", text: "SELECT 1;" }]);
    expect(btq.engine).toBe("teradata");
    const pk = detectEngine([{ path: "pkg.pks", text: "SELECT 1;" }]);
    expect(pk.engine).toBe("oracle");
  });

  it("breaks ties by the fixed engine order", () => {
    // BYTEINT scores 1 for teradata and 1 for netezza; teradata comes first.
    const detection = detectEngine([{ path: "t.sql", text: "CREATE TABLE t (a BYTEINT);" }]);
    expect(detection.engine).toBe("teradata");
  });

  it("ignores engine patterns inside comments", () => {
    const detection = detectEngine([
      { path: "t.sql", text: "-- VARCHAR2 NUMBER SYSDATE CLOB TABLESPACE\nSELECT 1;" },
    ]);
    expect(detection.engine).toBeUndefined();
  });
});
