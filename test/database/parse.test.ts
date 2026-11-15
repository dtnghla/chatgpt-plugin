import { describe, expect, it } from "vitest";
import { parseDatabaseProject, redactSecrets } from "../../src/database/parse.js";
import type { DatabaseProject } from "../../src/database/types.js";
import type { InputFile } from "../../src/ingest/types.js";
import { fixtureFiles } from "../helpers.js";

function textFiles(name: string): InputFile[] {
  return fixtureFiles(name);
}

function text(name: string, content: string): InputFile {
  return { path: name, data: new TextEncoder().encode(content) };
}

const ORACLE = parseDatabaseProject(textFiles("oracle-hr"));
const TERADATA = parseDatabaseProject(textFiles("teradata-sales"));
const HIVE = parseDatabaseProject(textFiles("hive-lake"));

function qualifiedName(project: DatabaseProject, name: string): string {
  const table = project.tables.find((entry) => entry.name === name);
  expect(table, `${name} should exist`).toBeTruthy();
  return `${table?.schema}.${table?.name}`;
}

describe("parseDatabaseProject oracle-hr", () => {
  it("detects oracle from two files", () => {
    expect(ORACLE.engine).toBe("oracle");
    expect(ORACLE.engineDetection).toBe("detected");
    expect(ORACLE.files.length).toBe(2);
    expect(ORACLE.files.every((file) => file.detectedEngine === "oracle")).toBe(true);
    expect(ORACLE.files.map((file) => file.statements)).toEqual([4, 10]);
    expect(ORACLE.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(ORACLE.schemas).toEqual(["HR"]);
    expect(ORACLE.warnings).toEqual([]);
    expect(ORACLE.schemaFallbackUsed).toBe(false);
    expect(ORACLE.otherStatements).toBe(1);
  });

  it("finds 4 tables with 23 columns", () => {
    expect(ORACLE.tables.length).toBe(4);
    expect(ORACLE.tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "HR.DEPARTMENTS",
      "HR.EMPLOYEES",
      "HR.JOB_HISTORY",
      "HR.LOCATIONS",
    ]);
    expect(ORACLE.tables.reduce((sum, table) => sum + table.columns.length, 0)).toBe(23);
  });

  it("finds 2 views, 2 indexes (one bitmap) and 1 sequence", () => {
    expect(ORACLE.views.map((view) => `${view.schema}.${view.name}`)).toEqual([
      "HR.EMP_DETAILS_V",
      "HR.DEPT_SUMMARY_V",
    ]);
    expect(ORACLE.views.every((view) => !view.materialized)).toBe(true);
    expect(ORACLE.indexes.length).toBe(2);
    expect(ORACLE.indexes.filter((index) => index.bitmap).length).toBe(1);
    expect(ORACLE.indexes.map((index) => `${index.schema}.${index.name}`)).toEqual([
      "HR.EMP_NAME_IX",
      "HR.EMP_DEPT_BIX",
    ]);
    expect(ORACLE.indexes[0]?.columns).toEqual(["LAST_NAME", "FIRST_NAME"]);
    expect(ORACLE.indexes[0]?.table).toBe("HR.EMPLOYEES");
    expect(ORACLE.indexes[0]?.unique).toBe(false);
    expect(ORACLE.indexes[0]?.expression).toBe(false);
    expect(ORACLE.sequences.length).toBe(1);
    expect(ORACLE.sequences[0]?.schema).toBe("HR");
    expect(ORACLE.sequences[0]?.name).toBe("EMPLOYEES_SEQ");
    expect(ORACLE.sequences[0]?.start).toBe("1000");
    expect(ORACLE.sequences[0]?.increment).toBe("1");
  });

  it("inventories 4 procedural objects with the expected complexity", () => {
    expect(ORACLE.procedural.length).toBe(4);
    expect(
      ORACLE.procedural.map((object) => `${object.kind} ${object.name} ${object.complexity}`),
    ).toEqual([
      "package EMP_PKG low",
      "package_body EMP_PKG high",
      "trigger EMP_BI low",
      "function GET_SALARY low",
    ]);
    const body = ORACLE.procedural.find((object) => object.kind === "package_body");
    expect(body?.features).toEqual([
      "dynamic SQL",
      "exception handling",
      "transaction control",
      "bulk operations",
    ]);
  });

  it("parses table details", () => {
    const employees = ORACLE.tables.find((table) => table.name === "EMPLOYEES");
    expect(employees?.primaryKey).toEqual(["EMPLOYEE_ID"]);
    expect(employees?.uniqueKeys).toEqual([["EMAIL"]]);
    expect(employees?.foreignKeys).toEqual([
      {
        columns: ["DEPARTMENT_ID"],
        referencedSchema: "HR",
        referencedTable: "DEPARTMENTS",
        referencedColumns: ["DEPARTMENT_ID"],
      },
    ]);
    const hireDate = employees?.columns.find((column) => column.name === "HIRE_DATE");
    expect(hireDate?.sourceType).toBe("DATE");
    expect(hireDate?.defaultExpression).toBe("SYSDATE");
    expect(hireDate?.nullable).toBe(false);
    const locations = ORACLE.tables.find((table) => table.name === "LOCATIONS");
    expect(locations?.primaryKey).toEqual(["LOCATION_ID"]);
    expect(locations?.columns.every((column) => column.caseInsensitive === false)).toBe(true);
    const jobHistory = ORACLE.tables.find((table) => table.name === "JOB_HISTORY");
    expect(jobHistory?.primaryKey).toEqual([]);
    expect(jobHistory?.partitioning).toBe("RANGE (start_date)");
    const updatedAt = jobHistory?.columns.find((column) => column.name === "UPDATED_AT");
    expect(updatedAt?.sourceType).toBe("TIMESTAMP(6) WITH LOCAL TIME ZONE");
    const departments = ORACLE.tables.find((table) => table.name === "DEPARTMENTS");
    expect(
      departments?.columns.find((column) => column.name === "DEPARTMENT_NAME")?.sourceType,
    ).toBe("VARCHAR2(30 CHAR)");
  });

  it("extracts view bodies", () => {
    const details = ORACLE.views.find((view) => view.name === "EMP_DETAILS_V");
    expect(details?.body).toBe(
      "SELECT e.employee_id, NVL(e.commission_pct, 0) AS commission_pct, SYSDATE AS as_of FROM hr.employees e",
    );
    const summary = ORACLE.views.find((view) => view.name === "DEPT_SUMMARY_V");
    expect(summary?.body).toContain("DECODE(COUNT(e.employee_id), 0, 'empty', 'staffed')");
    expect(summary?.body).toContain("e.department_id(+)");
    expect(summary?.body).toContain("GROUP BY d.department_name");
  });

  it("never stores the redacted secret", () => {
    expect(JSON.stringify(ORACLE)).not.toContain("S3cretPw!");
    expect(ORACLE.otherStatements).toBe(1);
    expect(ORACLE.unparsed).toEqual([]);
    expect(ORACLE.temporaryTables).toEqual([]);
    expect(ORACLE.synonyms).toBe(0);
    expect(ORACLE.grants).toBe(0);
  });
});

describe("parseDatabaseProject teradata-sales", () => {
  it("detects teradata with 3 tables, 1 temporary table and 1 view", () => {
    expect(TERADATA.engine).toBe("teradata");
    expect(TERADATA.engineDetection).toBe("detected");
    expect(TERADATA.tables.length).toBe(3);
    expect(TERADATA.tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "sales.orders",
      "sales.customers",
      "sales.order_lines",
    ]);
    expect(TERADATA.temporaryTables).toEqual(["sales.vt_stage"]);
    expect(TERADATA.views.length).toBe(1);
    expect(TERADATA.views[0]?.schema).toBe("sales");
    expect(TERADATA.views[0]?.name).toBe("order_totals_v");
    expect(TERADATA.views[0]?.body).toContain("LOCKING ROW FOR ACCESS");
    expect(TERADATA.views[0]?.body).toContain("ZEROIFNULL(o.total)");
    expect(TERADATA.schemas).toEqual(["sales"]);
  });

  it("parses teradata distribution, partitioning and charset attributes", () => {
    const orders = TERADATA.tables.find((table) => table.name === "orders");
    expect(orders?.distribution).toEqual({ kind: "key", columns: ["order_id"] });
    expect(orders?.sortColumns).toEqual(["order_date"]);
    expect(orders?.partitioning).toBe(
      "RANGE_N(order_date BETWEEN DATE '2020-01-01' AND DATE '2030-12-31' EACH INTERVAL '1' MONTH)",
    );
    expect(orders?.setTable).toBe(false);
    const status = orders?.columns.find((column) => column.name === "status");
    expect(status?.sourceType).toBe("CHAR(1)");
    expect(status?.charset).toBe("LATIN");
    expect(status?.caseInsensitive).toBe(true);
    expect(status?.nullable).toBe(true);
    const note = orders?.columns.find((column) => column.name === "note");
    expect(note?.charset).toBe("UNICODE");
    expect(note?.caseInsensitive).toBe(false);
    const orderDate = orders?.columns.find((column) => column.name === "order_date");
    expect(orderDate?.defaultExpression).toBeUndefined();
    expect(orderDate?.nullable).toBe(false);
    const customers = TERADATA.tables.find((table) => table.name === "customers");
    expect(customers?.setTable).toBe(true);
    expect(customers?.distribution).toEqual({ kind: "key", columns: ["customer_id"] });
    const orderLines = TERADATA.tables.find((table) => table.name === "order_lines");
    expect(orderLines?.distribution).toEqual({ kind: "key", columns: ["order_id", "line_no"] });
    expect(customers?.columns.find((column) => column.name === "valid_period")?.sourceType).toBe(
      "PERIOD(DATE)",
    );
  });

  it("inventories the macro and the BTEQ script", () => {
    expect(TERADATA.procedural.length).toBe(2);
    const macro = TERADATA.procedural.find((object) => object.kind === "macro");
    expect(macro?.name).toBe("refresh_totals");
    expect(macro?.schema).toBe("sales");
    expect(macro?.complexity).toBe("low");
    expect(macro?.features).toEqual([]);
    const script = TERADATA.procedural.find((object) => object.kind === "bteq_script");
    expect(script?.name).toBe("nightly");
    expect(script?.schema).toBe("sales");
    expect(script?.line).toBe(1);
    expect(script?.lines).toBe(9);
    expect(script?.complexity).toBe("medium");
    expect(script?.features).toEqual(["BTEQ file export/import", "BTEQ control flow"]);
  });

  it("never stores the .LOGON password", () => {
    expect(JSON.stringify(TERADATA)).not.toContain("T3raPass!");
    expect(TERADATA.files.map((file) => file.statements)).toEqual([9, 7]);
    expect(TERADATA.otherStatements).toBe(10);
    expect(TERADATA.unparsed).toEqual([]);
  });
});

describe("parseDatabaseProject hive-lake", () => {
  it("detects hive with 4 tables, 17 columns and 1 view", () => {
    expect(HIVE.engine).toBe("hive");
    expect(HIVE.engineDetection).toBe("detected");
    expect(HIVE.tables.length).toBe(4);
    const columnCount = HIVE.tables.reduce(
      (sum, table) => sum + table.columns.length + table.partitionColumns.length,
      0,
    );
    expect(columnCount).toBe(17);
    expect(HIVE.views.length).toBe(1);
    expect(HIVE.views[0]?.schema).toBe("sales");
    expect(HIVE.views[0]?.name).toBe("order_summary_v");
    expect(HIVE.schemas).toEqual(["sales"]);
    expect(HIVE.otherStatements).toBe(1);
  });

  it("parses hive storage clauses", () => {
    const orders = HIVE.tables.find((table) => table.name === "orders");
    expect(orders?.external).toBe(true);
    expect(qualifiedName(HIVE, "orders")).toBe("sales.orders");
    expect(orders?.partitionColumns[0]?.name).toBe("order_date");
    expect(orders?.partitionColumns[0]?.sourceType).toBe("STRING");
    expect(orders?.location).toBe("hdfs://namenode:8020/data/sales/orders");
    expect(orders?.hive?.storedAs).toBe("STORED AS PARQUET");
    expect(orders?.hive?.format).toBe("PARQUET");
    expect(orders?.hive?.rowFormat).toBeUndefined();
    expect(orders?.columns.find((column) => column.name === "tags")?.sourceType).toBe(
      "ARRAY<STRING>",
    );
    expect(orders?.columns.find((column) => column.name === "attrs")?.sourceType).toBe(
      "MAP<STRING,STRING>",
    );
    const customers = HIVE.tables.find((table) => table.name === "customers");
    expect(customers?.buckets).toEqual({ columns: ["customer_id"], count: 8 });
    expect(customers?.external).toBe(false);
    expect(customers?.hive?.format).toBe("ORC");
    const orderEvents = HIVE.tables.find((table) => table.name === "order_events");
    expect(orderEvents?.hive?.tblProperties.transactional).toBe("true");
    const clicks = HIVE.tables.find((table) => table.name === "clicks");
    expect(clicks?.location).toBe("s3a://legacy-clickstream/clicks/");
    expect(clicks?.hive?.rowFormat).toBe("ROW FORMAT DELIMITED FIELDS TERMINATED BY '\\t'");
    expect(clicks?.hive?.format).toBe("TEXTFILE");
    expect(clicks?.hive?.tblProperties["skip.header.line.count"]).toBe("1");
    expect(clicks?.external).toBe(true);
  });
});

describe("parseDatabaseProject failures and arguments", () => {
  it("throws when the engine cannot be detected", () => {
    expect(() =>
      parseDatabaseProject([text("t.sql", "CREATE TABLE t (id INTEGER);")]),
    ).toThrowError(
      "Could not detect the source database engine from the uploaded files. Pass source_engine as one of oracle, sqlserver, mysql, postgresql, teradata, netezza or hive.",
    );
  });

  it("uses the engine argument when given", () => {
    const project = parseDatabaseProject([text("t.sql", "CREATE TABLE t (id INTEGER);")], {
      engine: "postgresql",
    });
    expect(project.engine).toBe("postgresql");
    expect(project.engineDetection).toBe("argument");
    expect(project.tables.length).toBe(1);
    expect(project.tables[0]?.schema).toBe("public");
    expect(project.schemaFallbackUsed).toBe(true);
    expect(project.files[0]?.detectedEngine).toBeUndefined();
  });

  it("throws the empty-result error when no accepted file remains", () => {
    expect(() => parseDatabaseProject([text("notes.md", "# x")])).toThrowError(
      "No tables, views or procedural objects were found. Upload DDL exports such as .sql, .ddl, .hql or BTEQ scripts, or a ZIP of them.",
    );
  });

  it("warns about skipped files and non-UTF-8 content", () => {
    const project = parseDatabaseProject(
      [
        text("a.sql", "CREATE TABLE t (id INTEGER);"),
        text("notes.txt", "hello"),
        { path: "broken.sql", data: new Uint8Array([0xff, 0xfe, 0x41]) },
      ],
      { engine: "postgresql" },
    );
    expect(project.warnings).toEqual([
      "broken.sql is not valid UTF-8; skipped.",
      "Skipped notes.txt: only .sql, .ddl, .hql, .btq, .bteq, .pks, .pkb and .pls files are accepted.",
    ]);
    expect(project.tables.length).toBe(1);
  });

  it("warns when a file disagrees with the detected engine", () => {
    const project = parseDatabaseProject([
      text("a.sql", "CREATE TABLE t (id NUMBER(4));"),
      text("b.hql", "CREATE TABLE u (id BIGINT) STORED AS PARQUET LOCATION 'hdfs://nn/data/u';"),
    ]);
    expect(project.engine).toBe("hive");
    expect(project.warnings).toContain(
      "a.sql looks like Oracle DDL, but the project was analyzed as Hive.",
    );
  });
});

describe("parseDatabaseProject extras", () => {
  it("records CREATE SCHEMA / EXTENSION / ALTER TABLE constraints", () => {
    const project = parseDatabaseProject(
      [
        text(
          "a.sql",
          [
            "CREATE SCHEMA s;",
            "CREATE EXTENSION IF NOT EXISTS postgis;",
            "CREATE TABLE s.a (id integer, other integer);",
            "CREATE TABLE s.b (id integer);",
            "ALTER TABLE ONLY s.b ADD CONSTRAINT b_a_fk FOREIGN KEY (id) REFERENCES s.a (id);",
            "ALTER TABLE s.b ADD CONSTRAINT b_id_uk UNIQUE (id);",
            "ALTER TABLE s.b ADD CONSTRAINT b_id_pk PRIMARY KEY (id);",
            "ALTER TABLE s.missing ADD CONSTRAINT m_fk FOREIGN KEY (id) REFERENCES a (id);",
          ].join("\n"),
        ),
      ],
      { engine: "postgresql" },
    );
    expect(project.extensions).toEqual(["postgis"]);
    expect(project.schemas).toEqual(["s"]);
    const b = project.tables.find((table) => table.name === "b");
    expect(b?.primaryKey).toEqual(["id"]);
    expect(b?.uniqueKeys).toEqual([["id"]]);
    expect(b?.foreignKeys).toEqual([
      {
        columns: ["id"],
        referencedSchema: "s",
        referencedTable: "a",
        referencedColumns: ["id"],
      },
    ]);
    expect(project.warnings).toEqual([
      "ALTER TABLE in a.sql:8 targets s.missing, which was not found.",
    ]);
  });

  it("pushes unparseable CREATE statements to unparsed with redaction", () => {
    const project = parseDatabaseProject(
      [
        text(
          "a.sql",
          'CREATE TABLE t (id NUMBER(4));\nCREATE TRIGGERSET weird THING IDENTIFIED BY "pw";',
        ),
      ],
      { engine: "oracle" },
    );
    expect(project.tables.length).toBe(1);
    expect(project.unparsed.length).toBe(1);
    expect(project.unparsed[0]?.line).toBe(2);
    expect(project.unparsed[0]?.snippet).toBe(
      "CREATE TRIGGERSET weird THING IDENTIFIED BY ***REDACTED***",
    );
  });

  it("counts synonyms, grants and other statements", () => {
    const project = parseDatabaseProject(
      [
        text(
          "a.sql",
          [
            "CREATE TABLE t (id NUMBER(4));",
            "CREATE PUBLIC SYNONYM s FOR t;",
            "GRANT SELECT ON t TO u;",
            "REVOKE SELECT ON t FROM u;",
            "COMMENT ON TABLE t IS 'x';",
          ].join("\n"),
        ),
      ],
      { engine: "oracle" },
    );
    expect(project.synonyms).toBe(1);
    expect(project.grants).toBe(2);
    expect(project.otherStatements).toBe(1);
  });
});

describe("redactSecrets", () => {
  it("redacts IDENTIFIED BY and PASSWORD values", () => {
    expect(redactSecrets('CREATE USER u IDENTIFIED BY "S3cretPw!"')).toBe(
      "CREATE USER u IDENTIFIED BY ***REDACTED***",
    );
    expect(redactSecrets("identified by 'pw'")).toBe("identified by ***REDACTED***");
    expect(redactSecrets("PASSWORD='pw'")).toBe("PASSWORD= ***REDACTED***");
  });

  it("redacts .LOGON lines", () => {
    expect(redactSecrets(".LOGON tdprod/etl_user,T3raPass!;")).toBe(".LOGON ***REDACTED***");
    expect(redactSecrets("  .logon host/user,pass\nSELECT 1;")).toBe(
      ".LOGON ***REDACTED***\nSELECT 1;",
    );
  });
});
