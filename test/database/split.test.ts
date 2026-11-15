import { describe, expect, it } from "vitest";
import { splitStatements, stripComments } from "../../src/database/split.js";
import { fixtureFiles } from "../helpers.js";

function fixtureText(name: string, relativePath: string): string {
  const file = fixtureFiles(name).find((entry) => entry.path === relativePath);
  expect(file, `${relativePath} should exist`).toBeTruthy();
  return new TextDecoder("utf-8", { fatal: true }).decode(file?.data ?? new Uint8Array());
}

describe("stripComments", () => {
  it("removes -- and /* */ comments while preserving line numbers", () => {
    const text = "SELECT 1 -- trailing\n/* block\ncomment */ FROM dual; -- end\nSELECT 2;";
    const stripped = stripComments(text);
    expect(stripped.length).toBe(text.length);
    expect(stripped.split("\n").length).toBe(text.split("\n").length);
    expect(stripped).not.toContain("trailing");
    expect(stripped).not.toContain("block");
    expect(stripped).not.toContain("end");
    expect(stripped).toContain("SELECT 1");
    expect(stripped).toContain("FROM dual;");
    expect(stripped).toContain("SELECT 2;");
  });

  it("keeps string literals intact", () => {
    const text = "SELECT 'a -- b', \"c /* d */\", `e -- f` FROM t;";
    expect(stripComments(text)).toBe(text);
  });

  it("strips # line comments only for mysql", () => {
    expect(stripComments("SELECT 1 # note\nFROM t;", "mysql")).not.toContain("note");
    expect(stripComments("SELECT 1 # note\nFROM t;", "oracle")).toContain("note");
    expect(stripComments("SELECT 1 # note\nFROM t;")).toContain("note");
  });

  it("respects postgresql dollar quotes", () => {
    const text = "SELECT $$ -- not a comment $$ FROM t;";
    expect(stripComments(text, "postgresql")).toBe(text);
  });

  it("respects sqlserver brackets", () => {
    const text = "SELECT [col -- name] FROM t;";
    expect(stripComments(text, "sqlserver")).toBe(text);
  });
});

describe("splitStatements", () => {
  it("splits on top-level semicolons by default", () => {
    const text = "CREATE TABLE a (x INT, y INT);\nINSERT INTO a VALUES (1, ';');\n";
    const statements = splitStatements(text, "a.sql", "postgresql");
    expect(statements.map((statement) => statement.sql)).toEqual([
      "CREATE TABLE a (x INT, y INT)",
      "INSERT INTO a VALUES (1, ';')",
    ]);
    expect(statements.map((statement) => statement.line)).toEqual([1, 2]);
  });

  it("drops empty statements", () => {
    const text = ";\n-- only a comment\n;\nSELECT 1;\n";
    const statements = splitStatements(text, "a.sql", "postgresql");
    expect(statements.map((statement) => statement.sql)).toEqual(["SELECT 1"]);
  });

  it("keeps the oracle package body as one statement despite inner semicolons", () => {
    const text = fixtureText("oracle-hr", "plsql/emp_pkg.sql");
    const statements = splitStatements(text, "plsql/emp_pkg.sql", "oracle");
    expect(statements.length).toBe(4);
    expect(statements[0]?.sql).toBe(
      "CREATE OR REPLACE PACKAGE hr.emp_pkg AS\n  PROCEDURE raise_salary(p_id NUMBER, p_pct NUMBER);\nEND emp_pkg;",
    );
    const body = statements[1]?.sql ?? "";
    expect(body.startsWith("CREATE OR REPLACE PACKAGE BODY hr.emp_pkg AS")).toBe(true);
    expect(body).toContain("BULK COLLECT");
    expect(body).toContain("EXCEPTION");
    expect(body).toContain("RAISE;");
    expect(body.endsWith("END emp_pkg;")).toBe(true);
    expect(statements[2]?.sql.startsWith("CREATE OR REPLACE TRIGGER hr.emp_bi")).toBe(true);
    expect(statements[3]?.sql.startsWith("CREATE OR REPLACE FUNCTION hr.get_salary")).toBe(true);
    expect(statements.map((statement) => statement.line)).toEqual([1, 5, 20, 26]);
  });

  it("ends oracle plain statements at ; or at a /-only line", () => {
    const text = "CREATE TABLE a (x INT);\n/\nSELECT 1\n/\n";
    const statements = splitStatements(text, "a.sql", "oracle");
    expect(statements.map((statement) => statement.sql)).toEqual([
      "CREATE TABLE a (x INT)",
      "SELECT 1",
    ]);
  });

  it("makes each sqlserver GO batch one statement", () => {
    const text = [
      "SET ANSI_NULLS ON;",
      "GO",
      "CREATE PROCEDURE dbo.p AS",
      "BEGIN",
      "  SELECT 1;",
      "  SELECT 2;",
      "END",
      "GO",
      "SELECT 3;",
      "GO",
      "",
    ].join("\n");
    const statements = splitStatements(text, "a.sql", "sqlserver");
    expect(statements.map((statement) => statement.sql)).toEqual([
      "SET ANSI_NULLS ON",
      "CREATE PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND",
      "SELECT 3",
    ]);
    expect(statements.map((statement) => statement.line)).toEqual([1, 3, 9]);
  });

  it("keeps a mysql procedure body whole across DELIMITER //", () => {
    const text = [
      "DELIMITER //",
      "CREATE PROCEDURE p()",
      "BEGIN",
      "  SELECT 1;",
      "  SELECT 2;",
      "END//",
      "DELIMITER ;",
      "SELECT 3;",
      "",
    ].join("\n");
    const statements = splitStatements(text, "a.sql", "mysql");
    expect(statements.length).toBe(2);
    expect(statements[0]?.sql).toBe("CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND");
    expect(statements[0]?.line).toBe(2);
    expect(statements[1]?.sql).toBe("SELECT 3");
  });

  it("treats teradata dot-command lines as single statements", () => {
    const text = fixtureText("teradata-sales", "bteq/nightly.btq");
    const statements = splitStatements(text, "bteq/nightly.btq", "teradata");
    expect(statements.length).toBe(9);
    expect(statements[0]?.sql).toBe(".LOGON tdprod/etl_user,T3raPass!;");
    expect(statements[1]?.sql).toBe("DATABASE sales");
    expect(statements[3]?.sql).toBe(".IF ERRORCODE <> 0 THEN .GOTO FAILED;");
    expect(statements[7]?.sql).toBe(".LABEL FAILED");
    expect(statements.map((statement) => statement.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps the teradata macro as one statement despite inner semicolons", () => {
    const text = fixtureText("teradata-sales", "ddl/sales.sql");
    const statements = splitStatements(text, "ddl/sales.sql", "teradata");
    expect(statements.length).toBe(7);
    const macro = statements[6]?.sql ?? "";
    expect(macro.startsWith("CREATE MACRO sales.refresh_totals AS (")).toBe(true);
    expect(macro).toContain("DELETE FROM sales.order_totals;");
    expect(macro).toContain("INSERT INTO sales.order_totals");
    expect(macro.endsWith(")")).toBe(true);
  });

  it("ends a teradata procedure at the first depth-0 ; after BEGIN", () => {
    const text = [
      "REPLACE PROCEDURE db.p(IN a INTEGER)",
      "BEGIN",
      "  INSERT INTO t VALUES (a);",
      "  UPDATE t SET x = 1;",
      "END;",
      "SELECT 2;",
      "",
    ].join("\n");
    const statements = splitStatements(text, "a.sql", "teradata");
    expect(statements.length).toBe(2);
    expect(statements[0]?.sql.endsWith("END")).toBe(true);
    expect(statements[0]?.sql).toContain("UPDATE t SET x = 1;");
    expect(statements[1]?.sql).toBe("SELECT 2");
  });

  it("ends a netezza procedure at the first ; after END_PROC", () => {
    const text = [
      "CREATE OR REPLACE PROCEDURE p() RETURNS INT AS",
      "BEGIN",
      "  RETURN 1;",
      "END_PROC;",
      "SELECT 2;",
      "",
    ].join("\n");
    const statements = splitStatements(text, "a.sql", "netezza");
    expect(statements.length).toBe(2);
    expect(statements[0]?.sql.endsWith("END_PROC")).toBe(true);
    expect(statements[0]?.sql).toContain("RETURN 1;");
    expect(statements[1]?.sql).toBe("SELECT 2");
  });

  it("records statement line numbers across files", () => {
    const statements = splitStatements(
      fixtureText("hive-lake", "hql/sales.hql"),
      "hql/sales.hql",
      "hive",
    );
    expect(statements.length).toBe(7);
    expect(statements[2]?.line).toBe(3);
    expect(statements[6]?.sql.startsWith("CREATE VIEW order_summary_v AS")).toBe(true);
  });
});
