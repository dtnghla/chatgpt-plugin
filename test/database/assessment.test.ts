import { describe, expect, it } from "vitest";
import {
  assessDatabaseProject,
  truncateDatabaseAssessment,
} from "../../src/database/assessment.js";
import { parseDatabaseProject } from "../../src/database/parse.js";
import { fixtureFiles } from "../helpers.js";

function assess(name: "oracle-hr" | "teradata-sales" | "hive-lake") {
  return assessDatabaseProject(parseDatabaseProject(fixtureFiles(name)));
}

describe("oracle-hr assessment", () => {
  const assessment = assess("oracle-hr");

  it("scores readiness 77/100 (review) with the two blockers", () => {
    expect(assessment.readiness.score).toBe(77);
    expect(assessment.readiness.level).toBe("review");
    expect(assessment.readiness.blockers).toEqual([
      "4 procedural objects need manual conversion.",
      "2 columns use types with no automatic mapping.",
    ]);
  });

  it("counts 19 automatic, 2 partial and 2 manual columns", () => {
    expect(assessment.totals).toMatchObject({
      files: 2,
      schemas: 1,
      tables: 4,
      columns: 23,
      views: 2,
      indexes: 2,
      sequences: 1,
      procedural: 4,
      automaticColumns: 19,
      partialColumns: 2,
      manualColumns: 2,
    });
  });

  it("has an SDO_GEOMETRY manual row in the type coverage", () => {
    const row = assessment.typeCoverage.find((entry) => entry.sourceType === "SDO_GEOMETRY");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      targetType: "text",
      count: 1,
      status: "manual",
      caveat: "Requires PostGIS; enable the extension and convert the column to geometry.",
    });
  });

  it("classifies the views as partial and manual", () => {
    const partial = assessment.attention.find(
      (item) => item.kind === "view" && item.name === "HR.EMP_DETAILS_V",
    );
    expect(partial).toMatchObject({
      status: "partial",
      reason: "Rewritten with rules: NVL, SYSDATE; review the SQL.",
    });
    const manual = assessment.attention.find(
      (item) => item.kind === "view" && item.name === "HR.DEPT_SUMMARY_V",
    );
    expect(manual).toMatchObject({
      status: "manual",
      reason: "Manual: DECODE, Oracle outer join (+).",
    });
  });

  it("flags HR.JOB_HISTORY as missing a primary key", () => {
    const risk = assessment.risks.find((entry) => entry.code === "no_primary_key");
    expect(risk?.severity).toBe("warning");
    expect(risk?.message).toContain("HR.JOB_HISTORY");
  });

  it("sorts attention manual before partial, then by kind and name", () => {
    const statuses = assessment.attention.map((item) => item.status);
    const firstPartial = statuses.indexOf("partial");
    expect(statuses.slice(0, firstPartial)).not.toContain("partial");
  });
});

describe("teradata-sales assessment", () => {
  const assessment = assess("teradata-sales");

  it("scores readiness 85/100 (review) with three blockers", () => {
    expect(assessment.readiness.score).toBe(85);
    expect(assessment.readiness.level).toBe("review");
    expect(assessment.readiness.blockers).toHaveLength(3);
  });

  it("counts 11 automatic, 4 partial and 1 manual column", () => {
    expect(assessment.totals).toMatchObject({
      automaticColumns: 11,
      partialColumns: 4,
      manualColumns: 1,
    });
  });

  it("moves customers manually and the other tables with COPY", () => {
    const movements = Object.fromEntries(
      assessment.tables.map((row) => [`${row.schema}.${row.name}`, row.movement]),
    );
    expect(movements).toEqual({
      "sales.orders": "copy",
      "sales.customers": "manual",
      "sales.order_lines": "copy",
    });
  });

  it("explains why customers cannot be exported", () => {
    const risk = assessment.risks.find((entry) => entry.code === "movement_manual");
    expect(risk?.message).toBe(
      "Table sales.customers: Columns of type PERIOD, CLOB cannot be exported by the generated script; export this table manually.",
    );
  });
});

describe("hive-lake assessment", () => {
  const assessment = assess("hive-lake");

  it("scores readiness 94/100 (review) with one blocker", () => {
    expect(assessment.readiness.score).toBe(94);
    expect(assessment.readiness.level).toBe("review");
    expect(assessment.readiness.blockers).toEqual(["1 table cannot be moved automatically."]);
  });

  it("assigns the documented movement per table", () => {
    const movements = Object.fromEntries(
      assessment.tables.map((row) => [`${row.schema}.${row.name}`, row.movement]),
    );
    expect(movements).toEqual({
      "sales.orders": "datasync",
      "sales.customers": "datasync",
      "sales.order_events": "manual",
      "sales.clicks": "s3",
    });
  });

  it("normalizes the S3 location of clicks", () => {
    const clicks = assessment.tables.find((row) => row.name === "clicks");
    expect(clicks?.location).toBe("s3://legacy-clickstream/clicks/");
  });

  it("marks the ACID table manual in the movement summary", () => {
    expect(assessment.movement).toMatchObject({
      method: "datasync-athena",
      tables: 3,
      manualTables: 1,
    });
    expect(assessment.movement.summary).toContain("1 tables already on S3 are read in place.");
  });
});

describe("truncateDatabaseAssessment", () => {
  it("keeps the full assessment unchanged when lists are short", () => {
    const assessment = assess("oracle-hr");
    const truncated = truncateDatabaseAssessment(assessment);
    expect(truncated.tables).toHaveLength(assessment.tables.length);
    expect(truncated.procedural).toHaveLength(assessment.procedural.length);
    expect(truncated.attention).toHaveLength(assessment.attention.length);
    expect(truncated.truncated).toEqual({ tables: false, procedural: false, attention: false });
  });
});
