import { describe, expect, it } from "vitest";
import { mapColumnType, worstStatus } from "../../src/database/type-mapping.js";
import type { ColumnDef } from "../../src/database/types.js";

function column(sourceType: string, extra: Partial<ColumnDef> = {}): ColumnDef {
  return {
    name: "c",
    sourceType,
    nullable: true,
    identity: false,
    caseInsensitive: false,
    ...extra,
  };
}

function map(
  engine: Parameters<typeof mapColumnType>[0],
  sourceType: string,
  extra: Partial<ColumnDef> = {},
) {
  return mapColumnType(engine, column(sourceType, extra));
}

describe("worstStatus", () => {
  it("orders automatic < partial < manual", () => {
    expect(worstStatus("automatic", "automatic")).toBe("automatic");
    expect(worstStatus("automatic", "partial")).toBe("partial");
    expect(worstStatus("partial", "automatic")).toBe("partial");
    expect(worstStatus("partial", "manual")).toBe("manual");
    expect(worstStatus("manual", "partial")).toBe("manual");
  });
});

describe("oracle to Aurora PostgreSQL", () => {
  it("maps the documented rows", () => {
    expect(map("oracle", "VARCHAR2(30 CHAR)")).toEqual({
      targetType: "varchar(30)",
      status: "automatic",
      conversion: "VARCHAR2 → varchar",
    });
    expect(map("oracle", "NVARCHAR2(10)").targetType).toBe("varchar(10)");
    expect(map("oracle", "VARCHAR(5)").targetType).toBe("varchar(5)");
    expect(map("oracle", "CHAR(10)").targetType).toBe("char(10)");
    expect(map("oracle", "NUMBER(4)").targetType).toBe("smallint");
    expect(map("oracle", "NUMBER(6)").targetType).toBe("integer");
    expect(map("oracle", "NUMBER(18)").targetType).toBe("bigint");
    expect(map("oracle", "NUMBER(19)").targetType).toBe("numeric(19)");
    expect(map("oracle", "NUMBER(8,2)")).toMatchObject({
      targetType: "numeric(8,2)",
      status: "automatic",
    });
    expect(map("oracle", "NUMBER(*,5)").targetType).toBe("numeric(38,5)");
    expect(map("oracle", "NUMBER")).toEqual({
      targetType: "numeric",
      status: "partial",
      conversion: "NUMBER → numeric",
      caveat:
        "Unconstrained NUMBER becomes numeric; pick a narrower type after profiling the data.",
    });
    expect(map("oracle", "INTEGER").targetType).toBe("numeric(38)");
    expect(map("oracle", "INT").targetType).toBe("numeric(38)");
    expect(map("oracle", "SMALLINT").targetType).toBe("numeric(38)");
    expect(map("oracle", "FLOAT").targetType).toBe("double precision");
    expect(map("oracle", "FLOAT(126)").targetType).toBe("double precision");
    expect(map("oracle", "BINARY_DOUBLE").targetType).toBe("double precision");
    expect(map("oracle", "DOUBLE PRECISION").targetType).toBe("double precision");
    expect(map("oracle", "BINARY_FLOAT").targetType).toBe("real");
    expect(map("oracle", "REAL").targetType).toBe("real");
    expect(map("oracle", "DATE").targetType).toBe("timestamp(0)");
    expect(map("oracle", "TIMESTAMP").targetType).toBe("timestamp(6)");
    expect(map("oracle", "TIMESTAMP(3)").targetType).toBe("timestamp(3)");
    expect(map("oracle", "TIMESTAMP WITH TIME ZONE").targetType).toBe("timestamptz");
    expect(map("oracle", "TIMESTAMP(3) WITH TIME ZONE").targetType).toBe("timestamptz(3)");
    expect(map("oracle", "TIMESTAMP(6) WITH LOCAL TIME ZONE")).toEqual({
      targetType: "timestamptz(6)",
      status: "partial",
      conversion: "TIMESTAMP → timestamptz",
      caveat: "Session time zone conversion differs; values are stored as UTC instants.",
    });
    expect(map("oracle", "INTERVAL YEAR TO MONTH").targetType).toBe("interval");
    expect(map("oracle", "INTERVAL DAY TO SECOND").targetType).toBe("interval");
    expect(map("oracle", "CLOB").targetType).toBe("text");
    expect(map("oracle", "NCLOB").targetType).toBe("text");
    expect(map("oracle", "LONG").targetType).toBe("text");
    expect(map("oracle", "BLOB").targetType).toBe("bytea");
    expect(map("oracle", "RAW(2000)").targetType).toBe("bytea");
    expect(map("oracle", "LONG RAW").targetType).toBe("bytea");
    expect(map("oracle", "ROWID")).toMatchObject({
      targetType: "text",
      status: "partial",
      caveat: "Physical row addresses do not carry over; values are copied as text.",
    });
    expect(map("oracle", "XMLTYPE").targetType).toBe("xml");
    expect(map("oracle", "JSON").targetType).toBe("jsonb");
    expect(map("oracle", "BOOLEAN").targetType).toBe("boolean");
    expect(map("oracle", "BFILE")).toMatchObject({
      targetType: "text",
      status: "manual",
      caveat:
        "External file pointers have no PostgreSQL equivalent; store the files in S3 and keep the object key.",
    });
    expect(map("oracle", "SDO_GEOMETRY")).toMatchObject({
      targetType: "text",
      status: "manual",
      caveat: "Requires PostGIS; enable the extension and convert the column to geometry.",
    });
    expect(map("oracle", "WAT")).toMatchObject({
      targetType: "text",
      status: "manual",
      caveat: "Unrecognized source type; generated as text for review.",
    });
  });
});

describe("sqlserver to Aurora PostgreSQL", () => {
  it("maps the documented rows", () => {
    expect(map("sqlserver", "BIT").targetType).toBe("boolean");
    expect(map("sqlserver", "TINYINT").targetType).toBe("smallint");
    expect(map("sqlserver", "SMALLINT").targetType).toBe("smallint");
    expect(map("sqlserver", "INT").targetType).toBe("integer");
    expect(map("sqlserver", "BIGINT").targetType).toBe("bigint");
    expect(map("sqlserver", "DECIMAL(10,2)").targetType).toBe("numeric(10,2)");
    expect(map("sqlserver", "MONEY").targetType).toBe("numeric(19,4)");
    expect(map("sqlserver", "SMALLMONEY").targetType).toBe("numeric(10,4)");
    expect(map("sqlserver", "REAL").targetType).toBe("real");
    expect(map("sqlserver", "FLOAT(24)").targetType).toBe("real");
    expect(map("sqlserver", "FLOAT(25)").targetType).toBe("double precision");
    expect(map("sqlserver", "FLOAT").targetType).toBe("double precision");
    expect(map("sqlserver", "DATE").targetType).toBe("date");
    expect(map("sqlserver", "TIME(4)").targetType).toBe("time(4)");
    expect(map("sqlserver", "TIME")).toEqual({
      targetType: "time(6)",
      status: "partial",
      conversion: "TIME → time",
      caveat: "Fractional seconds beyond microseconds are dropped.",
    });
    expect(map("sqlserver", "TIME(7)").status).toBe("partial");
    expect(map("sqlserver", "DATETIME").targetType).toBe("timestamp(3)");
    expect(map("sqlserver", "SMALLDATETIME").targetType).toBe("timestamp(0)");
    expect(map("sqlserver", "DATETIME2(3)").targetType).toBe("timestamp(3)");
    expect(map("sqlserver", "DATETIME2")).toMatchObject({
      targetType: "timestamp(6)",
      status: "partial",
      caveat: "PostgreSQL keeps microseconds; the seventh fractional digit is dropped.",
    });
    expect(map("sqlserver", "DATETIMEOFFSET")).toMatchObject({
      targetType: "timestamptz",
      status: "partial",
      caveat: "The original offset is not stored; values become UTC instants.",
    });
    expect(map("sqlserver", "CHAR(10)").targetType).toBe("char(10)");
    expect(map("sqlserver", "NCHAR(5)").targetType).toBe("char(5)");
    expect(map("sqlserver", "VARCHAR(50)").targetType).toBe("varchar(50)");
    expect(map("sqlserver", "NVARCHAR(50)").targetType).toBe("varchar(50)");
    expect(map("sqlserver", "VARCHAR(MAX)").targetType).toBe("text");
    expect(map("sqlserver", "NVARCHAR(MAX)").targetType).toBe("text");
    expect(map("sqlserver", "TEXT").targetType).toBe("text");
    expect(map("sqlserver", "NTEXT").targetType).toBe("text");
    expect(map("sqlserver", "BINARY(16)").targetType).toBe("bytea");
    expect(map("sqlserver", "VARBINARY(MAX)").targetType).toBe("bytea");
    expect(map("sqlserver", "IMAGE").targetType).toBe("bytea");
    expect(map("sqlserver", "UNIQUEIDENTIFIER").targetType).toBe("uuid");
    expect(map("sqlserver", "XML").targetType).toBe("xml");
    expect(map("sqlserver", "SYSNAME").targetType).toBe("varchar(128)");
    expect(map("sqlserver", "ROWVERSION")).toMatchObject({
      targetType: "bytea",
      status: "partial",
      caveat:
        "Automatic row versioning is not reproduced; add a trigger if the application depends on it.",
    });
    expect(map("sqlserver", "TIMESTAMP")).toMatchObject({ targetType: "bytea", status: "partial" });
    expect(map("sqlserver", "SQL_VARIANT")).toMatchObject({
      targetType: "text",
      status: "manual",
      caveat: "No PostgreSQL equivalent; choose a concrete type per column.",
    });
    expect(map("sqlserver", "HIERARCHYID")).toMatchObject({
      targetType: "text",
      status: "manual",
      caveat: "Use the ltree extension or a path column.",
    });
    expect(map("sqlserver", "GEOGRAPHY")).toMatchObject({ targetType: "text", status: "manual" });
    expect(map("sqlserver", "GEOMETRY")).toMatchObject({ targetType: "text", status: "manual" });
    expect(map("sqlserver", "COMPUTED")).toEqual({
      targetType: "not emitted",
      status: "manual",
      conversion: "COMPUTED → not emitted",
      caveat: "Recreate as GENERATED ALWAYS AS (...) STORED after translating the expression.",
    });
  });
});

describe("mysql to Aurora MySQL", () => {
  it("keeps types unchanged and automatic", () => {
    expect(map("mysql", "INT")).toEqual({
      targetType: "int",
      status: "automatic",
      conversion: "unchanged",
    });
    expect(map("mysql", "VARCHAR(50)")).toEqual({
      targetType: "varchar(50)",
      status: "automatic",
      conversion: "unchanged",
    });
    expect(map("mysql", "TINYINT UNSIGNED ZEROFILL").targetType).toBe("tinyint unsigned zerofill");
    expect(map("mysql", "DECIMAL(12,2)").targetType).toBe("decimal(12,2)");
  });
});

describe("postgresql to Aurora PostgreSQL", () => {
  it("maps core types automatically", () => {
    expect(map("postgresql", "INTEGER")).toMatchObject({
      targetType: "integer",
      status: "automatic",
    });
    expect(map("postgresql", "TEXT[]")).toMatchObject({
      targetType: "text[]",
      status: "automatic",
    });
    expect(map("postgresql", "DOUBLE PRECISION").targetType).toBe("double precision");
    expect(map("postgresql", "NUMERIC(10,2)").targetType).toBe("numeric(10,2)");
    expect(map("postgresql", "TIMESTAMPTZ").targetType).toBe("timestamptz");
    expect(map("postgresql", "BOOLEAN").targetType).toBe("boolean");
  });

  it("marks extension types partial", () => {
    expect(map("postgresql", "HSTORE")).toEqual({
      targetType: "hstore",
      status: "partial",
      conversion: "HSTORE → hstore",
      caveat: "Confirm the extension that provides this type is enabled in Aurora PostgreSQL.",
    });
    expect(map("postgresql", "CITEXT[]").status).toBe("partial");
  });
});

describe("teradata to Redshift Serverless", () => {
  it("maps the documented rows", () => {
    expect(map("teradata", "BYTEINT").targetType).toBe("smallint");
    expect(map("teradata", "SMALLINT").targetType).toBe("smallint");
    expect(map("teradata", "INTEGER").targetType).toBe("integer");
    expect(map("teradata", "INT").targetType).toBe("integer");
    expect(map("teradata", "BIGINT").targetType).toBe("bigint");
    expect(map("teradata", "DECIMAL(12,2)").targetType).toBe("decimal(12,2)");
    expect(map("teradata", "NUMERIC(10,3)").targetType).toBe("decimal(10,3)");
    expect(map("teradata", "NUMBER(8,2)").targetType).toBe("decimal(8,2)");
    expect(map("teradata", "NUMBER")).toEqual({
      targetType: "decimal(38,10)",
      status: "partial",
      conversion: "NUMBER → decimal",
      caveat: "Unconstrained NUMBER becomes DECIMAL(38,10); pick a narrower type after profiling.",
    });
    expect(map("teradata", "FLOAT").targetType).toBe("double precision");
    expect(map("teradata", "REAL").targetType).toBe("double precision");
    expect(map("teradata", "DOUBLE PRECISION").targetType).toBe("double precision");
    expect(map("teradata", "CHAR(10)").targetType).toBe("char(10)");
    expect(map("teradata", "CHAR(10)", { charset: "LATIN" }).targetType).toBe("char(10)");
    expect(map("teradata", "CHAR(10)", { charset: "UNICODE" })).toMatchObject({
      targetType: "varchar(40)",
      status: "partial",
      caveat: "Redshift CHAR is single-byte; Unicode values are stored as VARCHAR sized in bytes.",
    });
    expect(map("teradata", "VARCHAR(200)").targetType).toBe("varchar(200)");
    expect(map("teradata", "VARCHAR(200)", { charset: "UNICODE" })).toMatchObject({
      targetType: "varchar(800)",
      status: "partial",
      caveat: "Redshift VARCHAR length is in bytes; sized at 4 bytes per character.",
    });
    expect(map("teradata", "LONG VARCHAR")).toMatchObject({
      targetType: "varchar(65535)",
      status: "partial",
      caveat: "Values longer than 65,535 bytes do not fit.",
    });
    expect(map("teradata", "CLOB").targetType).toBe("varchar(65535)");
    expect(map("teradata", "BYTE(100)").targetType).toBe("varbyte(100)");
    expect(map("teradata", "VARBYTE(2000)").targetType).toBe("varbyte(2000)");
    expect(map("teradata", "BLOB")).toMatchObject({
      targetType: "varbyte(1024000)",
      status: "partial",
      caveat: "Redshift VARBYTE holds at most 1,024,000 bytes.",
    });
    expect(map("teradata", "DATE").targetType).toBe("date");
    expect(map("teradata", "TIME(6)").targetType).toBe("time");
    expect(map("teradata", "TIMESTAMP(6)").targetType).toBe("timestamp");
    expect(map("teradata", "TIME WITH TIME ZONE").targetType).toBe("timetz");
    expect(map("teradata", "TIMESTAMP WITH TIME ZONE").targetType).toBe("timestamptz");
    expect(map("teradata", "INTERVAL DAY TO SECOND")).toMatchObject({
      targetType: "varchar(32)",
      status: "partial",
      caveat: "Intervals are loaded as text; convert them after the load.",
    });
    expect(map("teradata", "PERIOD(DATE)")).toMatchObject({
      targetType: "varchar(64)",
      status: "manual",
      caveat: "PERIOD has no Redshift equivalent; split it into begin and end columns.",
    });
    expect(map("teradata", "JSON").targetType).toBe("super");
    expect(map("teradata", "XML")).toMatchObject({
      targetType: "varchar(65535)",
      status: "partial",
      caveat: "XML is loaded as text.",
    });
    expect(map("teradata", "ST_GEOMETRY")).toMatchObject({
      targetType: "geometry",
      status: "partial",
      caveat: "Convert values with ST_GeomFromText during the load.",
    });
    expect(map("teradata", "WAT")).toMatchObject({
      targetType: "varchar(65535)",
      status: "manual",
      caveat: "Unrecognized source type; generated as text for review.",
    });
  });

  it("appends the case-insensitive COLLATE override", () => {
    expect(map("teradata", "CHAR(1)", { caseInsensitive: true })).toEqual({
      targetType: "char(1) COLLATE case_insensitive",
      status: "partial",
      conversion: "CHAR → char",
      caveat:
        "Teradata compares this column case-insensitively; the column is declared COLLATE case_insensitive.",
    });
    expect(
      map("teradata", "VARCHAR(100)", { charset: "UNICODE", caseInsensitive: true }).targetType,
    ).toBe("varchar(400) COLLATE case_insensitive");
    expect(map("teradata", "INTEGER", { caseInsensitive: true }).targetType).toBe("integer");
  });
});

describe("netezza to Redshift Serverless", () => {
  it("maps the documented rows", () => {
    expect(map("netezza", "BYTEINT").targetType).toBe("smallint");
    expect(map("netezza", "INT1").targetType).toBe("smallint");
    expect(map("netezza", "SMALLINT").targetType).toBe("smallint");
    expect(map("netezza", "INT2").targetType).toBe("smallint");
    expect(map("netezza", "INTEGER").targetType).toBe("integer");
    expect(map("netezza", "INT4").targetType).toBe("integer");
    expect(map("netezza", "BIGINT").targetType).toBe("bigint");
    expect(map("netezza", "INT8").targetType).toBe("bigint");
    expect(map("netezza", "NUMERIC(10,2)").targetType).toBe("decimal(10,2)");
    expect(map("netezza", "REAL").targetType).toBe("real");
    expect(map("netezza", "FLOAT4").targetType).toBe("real");
    expect(map("netezza", "DOUBLE PRECISION").targetType).toBe("double precision");
    expect(map("netezza", "DOUBLE").targetType).toBe("double precision");
    expect(map("netezza", "FLOAT").targetType).toBe("double precision");
    expect(map("netezza", "FLOAT8").targetType).toBe("double precision");
    expect(map("netezza", "CHAR(10)").targetType).toBe("char(10)");
    expect(map("netezza", "VARCHAR(50)").targetType).toBe("varchar(50)");
    expect(map("netezza", "NCHAR(10)")).toMatchObject({
      targetType: "varchar(40)",
      status: "partial",
      caveat: "Redshift VARCHAR length is in bytes; sized at 4 bytes per character.",
    });
    expect(map("netezza", "NVARCHAR(10)").status).toBe("partial");
    expect(map("netezza", "BOOLEAN").targetType).toBe("boolean");
    expect(map("netezza", "BOOL").targetType).toBe("boolean");
    expect(map("netezza", "DATE").targetType).toBe("date");
    expect(map("netezza", "TIME").targetType).toBe("time");
    expect(map("netezza", "TIMETZ").targetType).toBe("timetz");
    expect(map("netezza", "TIME WITH TIME ZONE").targetType).toBe("timetz");
    expect(map("netezza", "TIMESTAMP").targetType).toBe("timestamp");
    expect(map("netezza", "INTERVAL").status).toBe("partial");
    expect(map("netezza", "VARBINARY(100)").targetType).toBe("varbyte(100)");
    expect(map("netezza", "BINARY VARYING(100)").targetType).toBe("varbyte(100)");
    expect(map("netezza", "ST_GEOMETRY").targetType).toBe("geometry");
    expect(map("netezza", "JSON").targetType).toBe("super");
    expect(map("netezza", "JSONB").targetType).toBe("super");
    expect(map("netezza", "WAT")).toMatchObject({ targetType: "varchar(65535)", status: "manual" });
    expect(map("netezza", "CHAR(10)", { caseInsensitive: true }).targetType).toBe(
      "char(10) COLLATE case_insensitive",
    );
  });
});

describe("hive to Athena Iceberg", () => {
  it("maps the documented rows", () => {
    expect(map("hive", "TINYINT").targetType).toBe("int");
    expect(map("hive", "SMALLINT").targetType).toBe("int");
    expect(map("hive", "INT").targetType).toBe("int");
    expect(map("hive", "INTEGER").targetType).toBe("int");
    expect(map("hive", "BIGINT").targetType).toBe("bigint");
    expect(map("hive", "FLOAT").targetType).toBe("float");
    expect(map("hive", "DOUBLE").targetType).toBe("double");
    expect(map("hive", "DOUBLE PRECISION").targetType).toBe("double");
    expect(map("hive", "DECIMAL(12,2)").targetType).toBe("decimal(12,2)");
    expect(map("hive", "DECIMAL").targetType).toBe("decimal(10,0)");
    expect(map("hive", "STRING").targetType).toBe("string");
    expect(map("hive", "VARCHAR(100)").targetType).toBe("string");
    expect(map("hive", "CHAR(2)")).toMatchObject({
      targetType: "string",
      status: "partial",
      caveat: "CHAR padding is not preserved.",
    });
    expect(map("hive", "BOOLEAN").targetType).toBe("boolean");
    expect(map("hive", "BINARY").targetType).toBe("binary");
    expect(map("hive", "DATE").targetType).toBe("date");
    expect(map("hive", "TIMESTAMP").targetType).toBe("timestamp");
    expect(map("hive", "ARRAY<STRING>")).toEqual({
      targetType: "array<string>",
      status: "automatic",
      conversion: "ARRAY → array",
    });
    expect(map("hive", "MAP<STRING,STRING>").targetType).toBe("map<string,string>");
    expect(map("hive", "STRUCT<name:STRING,age:INT>").targetType).toBe(
      "struct<name:string,age:int>",
    );
    expect(map("hive", "ARRAY<VARCHAR(10)>").targetType).toBe("array<string>");
    expect(map("hive", "ARRAY<CHAR(2)>")).toMatchObject({
      targetType: "array<string>",
      status: "partial",
      caveat: "CHAR padding is not preserved.",
    });
    expect(map("hive", "UNIONTYPE<INT,STRING>")).toMatchObject({
      targetType: "string",
      status: "manual",
      caveat: "No Iceberg equivalent; generated as string for review.",
    });
    expect(map("hive", "INTERVAL")).toMatchObject({ targetType: "string", status: "manual" });
    expect(map("hive", "WAT")).toMatchObject({ targetType: "string", status: "manual" });
  });
});
