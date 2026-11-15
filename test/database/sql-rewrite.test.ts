import { describe, expect, it } from "vitest";
import { ENGINE_LABELS, TARGET_LABELS } from "../../src/database/labels.js";
import { qualified, quoteIdent } from "../../src/database/names.js";
import { rewriteCall, rewriteViewSql, translateDefault } from "../../src/database/sql-rewrite.js";

describe("labels", () => {
  it("labels engines and targets", () => {
    expect(ENGINE_LABELS.oracle).toBe("Oracle");
    expect(ENGINE_LABELS.sqlserver).toBe("SQL Server");
    expect(ENGINE_LABELS.mysql).toBe("MySQL");
    expect(ENGINE_LABELS.postgresql).toBe("PostgreSQL");
    expect(ENGINE_LABELS.teradata).toBe("Teradata");
    expect(ENGINE_LABELS.netezza).toBe("Netezza");
    expect(ENGINE_LABELS.hive).toBe("Hive");
    expect(TARGET_LABELS["aurora-postgresql"]).toBe("Aurora PostgreSQL");
    expect(TARGET_LABELS["aurora-mysql"]).toBe("Aurora MySQL");
    expect(TARGET_LABELS["redshift-serverless"]).toBe("Redshift Serverless");
    expect(TARGET_LABELS["athena-iceberg"]).toBe("Athena (Apache Iceberg)");
  });
});

describe("quoteIdent", () => {
  it("lower-cases bare identifiers and quotes reserved or irregular names", () => {
    expect(quoteIdent("HR", "double")).toBe("hr");
    expect(quoteIdent("EMPLOYEES_SEQ", "double")).toBe("employees_seq");
    expect(quoteIdent("Order", "double")).toBe('"order"');
    expect(quoteIdent("Table Name", "double")).toBe('"table name"');
    expect(quoteIdent("1st", "double")).toBe('"1st"');
    expect(quoteIdent("weird`name", "backtick")).toBe("`weird``name`");
    expect(quoteIdent('say "hi"', "double")).toBe('"say ""hi"""');
    expect(quoteIdent("field", "backtick")).toBe("field");
    expect(qualified("HR", "EMPLOYEES", "double")).toBe("hr.employees");
    expect(qualified("My Db", "T", "backtick")).toBe("`my db`.t");
  });
});

describe("rewriteViewSql", () => {
  it("copies mysql and postgresql views unchanged with automatic status", () => {
    for (const engine of ["mysql", "postgresql"] as const) {
      expect(rewriteViewSql(engine, "SELECT 1 FROM t WHERE SYSDATE IS NULL")).toEqual({
        sql: "SELECT 1 FROM t WHERE SYSDATE IS NULL",
        status: "automatic",
        applied: [],
        manualFeatures: [],
      });
    }
  });

  it("rewrites the oracle emp_details_v body", () => {
    expect(
      rewriteViewSql(
        "oracle",
        "SELECT e.employee_id, NVL(e.commission_pct, 0) AS commission_pct, SYSDATE AS as_of FROM hr.employees e",
      ),
    ).toEqual({
      sql: "SELECT e.employee_id, COALESCE(e.commission_pct, 0) AS commission_pct, LOCALTIMESTAMP(0) AS as_of FROM hr.employees e",
      status: "partial",
      applied: ["NVL", "SYSDATE"],
      manualFeatures: [],
    });
  });

  it("flags the oracle dept_summary_v body as manual", () => {
    const result = rewriteViewSql(
      "oracle",
      "SELECT d.department_name, DECODE(COUNT(e.employee_id), 0, 'empty', 'staffed') AS status FROM hr.departments d, hr.employees e WHERE d.department_id = e.department_id(+) GROUP BY d.department_name",
    );
    expect(result.status).toBe("manual");
    expect(result.applied).toEqual([]);
    expect(result.manualFeatures).toEqual(["DECODE", "Oracle outer join (+)"]);
    expect(result.sql).toContain("DECODE(COUNT(e.employee_id)");
  });

  it("applies the remaining oracle rules and flags", () => {
    const result = rewriteViewSql(
      "oracle",
      "SELECT a FROM t WHERE b MINUS SELECT SYSTIMESTAMP FROM DUAL WHERE NVL2(x, 1, 2) IS NOT NULL",
    );
    expect(result.applied).toEqual(["SYSTIMESTAMP", "DUAL", "MINUS"]);
    expect(result.sql).toContain("CURRENT_TIMESTAMP");
    expect(result.sql).not.toContain("FROM DUAL");
    expect(result.sql).toContain("EXCEPT");
    expect(result.manualFeatures).toEqual(["NVL2"]);
  });

  it("flags ROWNUM, CONNECT BY and sequence pseudo-columns", () => {
    const result = rewriteViewSql(
      "oracle",
      "SELECT ROWNUM, e.id FROM hr.employees e CONNECT BY x = emp_seq.NEXTVAL",
    );
    expect(result.manualFeatures).toEqual(["ROWNUM", "CONNECT BY", "sequence pseudo-columns"]);
    expect(result.sql).toContain("emp_seq.NEXTVAL");
  });

  it("rewrites sqlserver views", () => {
    const result = rewriteViewSql(
      "sqlserver",
      "SELECT [dbo].[t].[c], ISNULL([c], 0) AS c2, GETDATE() AS d FROM [dbo].[t] WITH (NOLOCK)",
    );
    expect(result.status).toBe("partial");
    expect(result.applied).toEqual(["ISNULL", "GETDATE", "brackets", "NOLOCK"]);
    expect(result.sql).toBe(
      'SELECT "dbo"."t"."c", COALESCE("c", 0) AS c2, LOCALTIMESTAMP AS d FROM "dbo"."t"',
    );
  });

  it("flags sqlserver TOP, CONVERT and APPLY as manual", () => {
    const result = rewriteViewSql(
      "sqlserver",
      "SELECT TOP (10) CONVERT(int, c) FROM t CROSS APPLY u WHERE GETUTCDATE() IS NOT NULL",
    );
    expect(result.status).toBe("manual");
    expect(result.manualFeatures).toEqual(["TOP", "CONVERT", "APPLY"]);
    expect(result.applied).toEqual(["GETUTCDATE"]);
    expect(result.sql).toContain("(now() AT TIME ZONE 'utc')");
  });

  it("rewrites the teradata order_totals_v body", () => {
    expect(
      rewriteViewSql(
        "teradata",
        "LOCKING ROW FOR ACCESS\nSEL o.order_id, ZEROIFNULL(o.total) AS total FROM sales.orders o",
      ),
    ).toEqual({
      sql: "SELECT o.order_id, COALESCE(o.total, 0) AS total FROM sales.orders o",
      status: "partial",
      applied: ["LOCKING", "SEL", "ZEROIFNULL"],
      manualFeatures: [],
    });
  });

  it("applies teradata NULLIFZERO and CHARACTERS rules", () => {
    const result = rewriteViewSql(
      "teradata",
      "SELECT NULLIFZERO(qty), CHARACTERS(name) FROM t WHERE x > 0",
    );
    expect(result.applied).toEqual(["NULLIFZERO", "CHARACTERS"]);
    expect(result.sql).toBe("SELECT NULLIF(qty, 0), LENGTH(name) FROM t WHERE x > 0");
    const flagged = rewriteViewSql(
      "teradata",
      "SELECT c FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY FORMAT 'x') = 1",
    );
    expect(flagged.manualFeatures).toEqual(["QUALIFY", "FORMAT phrase"]);
  });

  it("rewrites netezza views", () => {
    expect(rewriteViewSql("netezza", "SELECT NOW(), ISNULL(a, b) FROM t")).toEqual({
      sql: "SELECT GETDATE(), NVL(a, b) FROM t",
      status: "partial",
      applied: ["NOW", "ISNULL"],
      manualFeatures: [],
    });
    expect(rewriteViewSql("netezza", "SELECT AGE(x) FROM t").manualFeatures).toEqual(["AGE"]);
  });

  it("rewrites hive views", () => {
    const result = rewriteViewSql("hive", "SELECT `a`, NVL(b, 0), SIZE(c) FROM t LATERAL VIEW u");
    expect(result.status).toBe("manual");
    expect(result.applied).toEqual(["backticks", "NVL", "SIZE"]);
    expect(result.sql).toBe('SELECT "a", COALESCE(b, 0), CARDINALITY(c) FROM t LATERAL VIEW u');
    expect(result.manualFeatures).toEqual(["LATERAL VIEW"]);
    const rlike = rewriteViewSql(
      "hive",
      "SELECT c FROM t WHERE x RLIKE 'a' AND COLLECT_SET(y) IS NOT NULL",
    );
    expect(rlike.manualFeatures).toEqual(["collect_set/collect_list", "RLIKE"]);
  });

  it("keeps replacements out of single-quoted literals", () => {
    const result = rewriteViewSql("oracle", "SELECT 'SYSDATE NVL(' FROM dual");
    expect(result.applied).toEqual(["DUAL"]);
    expect(result.sql).toBe("SELECT 'SYSDATE NVL('");
  });
});

describe("rewriteCall", () => {
  it("replaces a function call with the built expression", () => {
    expect(
      rewriteCall(
        "SELECT ZEROIFNULL(o.total) AS total FROM t",
        "ZEROIFNULL",
        (arg) => `COALESCE(${arg}, 0)`,
      ),
    ).toBe("SELECT COALESCE(o.total, 0) AS total FROM t");
  });

  it("handles nested parentheses and case-insensitive names", () => {
    expect(
      rewriteCall(
        "SELECT nullifzero(f(a, (b))) FROM t",
        "NULLIFZERO",
        (arg) => `NULLIF(${arg}, 0)`,
      ),
    ).toBe("SELECT NULLIF(f(a, (b)), 0) FROM t");
  });

  it("returns the input unchanged without a match", () => {
    expect(rewriteCall("SELECT a FROM t", "ZEROIFNULL", (arg) => arg)).toBe("SELECT a FROM t");
    expect(rewriteCall("SELECT ZEROIFNULL(a FROM t", "ZEROIFNULL", (arg) => arg)).toBe(
      "SELECT ZEROIFNULL(a FROM t",
    );
  });
});

describe("translateDefault", () => {
  it("passes through literals after unwrapping redundant parens", () => {
    expect(translateDefault("sqlserver", "((0))", "integer")).toBe("0");
    expect(translateDefault("oracle", "(0)", "integer")).toBe("0");
    expect(translateDefault("sqlserver", "((-1))", "integer")).toBe("-1");
    expect(translateDefault("sqlserver", "1.5", "numeric")).toBe("1.5");
    expect(translateDefault("sqlserver", "('x')", "text")).toBe("'x'");
    expect(translateDefault("teradata", "NULL", "integer")).toBe("NULL");
    expect(translateDefault("oracle", "(a) + (b)", "integer")).toBeUndefined();
  });

  it("translates oracle defaults", () => {
    expect(translateDefault("oracle", "SYSDATE", "timestamp(0)")).toBe("LOCALTIMESTAMP(0)");
    expect(translateDefault("oracle", "systimestamp", "timestamptz")).toBe("CURRENT_TIMESTAMP");
    expect(translateDefault("oracle", "CURRENT_DATE", "date")).toBeUndefined();
  });

  it("translates sqlserver defaults", () => {
    expect(translateDefault("sqlserver", "GETDATE()", "timestamp")).toBe("LOCALTIMESTAMP");
    expect(translateDefault("sqlserver", "SYSDATETIME()", "timestamp")).toBe("LOCALTIMESTAMP");
    expect(translateDefault("sqlserver", "CURRENT_TIMESTAMP", "timestamp")).toBe("LOCALTIMESTAMP");
    expect(translateDefault("sqlserver", "GETUTCDATE()", "timestamptz")).toBe(
      "(now() AT TIME ZONE 'utc')",
    );
    expect(translateDefault("sqlserver", "SYSUTCDATETIME()", "timestamptz")).toBe(
      "(now() AT TIME ZONE 'utc')",
    );
    expect(translateDefault("sqlserver", "NEWID()", "uuid")).toBe("gen_random_uuid()");
  });

  it("translates teradata and netezza defaults", () => {
    expect(translateDefault("teradata", "CURRENT_DATE", "date")).toBe("CURRENT_DATE");
    expect(translateDefault("teradata", "CURRENT_TIMESTAMP", "timestamp")).toBe("GETDATE()");
    expect(translateDefault("teradata", "NOW()", "timestamp")).toBe("GETDATE()");
    expect(translateDefault("netezza", "NOW()", "timestamp")).toBe("GETDATE()");
    expect(translateDefault("netezza", "CURRENT_TIMESTAMP", "timestamp")).toBe("GETDATE()");
  });

  it("returns undefined for untranslatable expressions and other engines", () => {
    expect(translateDefault("oracle", "nextval('seq')", "integer")).toBeUndefined();
    expect(translateDefault("mysql", "CURRENT_TIMESTAMP", "timestamp")).toBeUndefined();
    expect(translateDefault("postgresql", "now()", "timestamp")).toBeUndefined();
    expect(translateDefault("hive", "current_timestamp", "timestamp")).toBeUndefined();
  });
});
