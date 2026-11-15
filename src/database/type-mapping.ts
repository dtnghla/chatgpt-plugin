import type { ConversionStatus } from "../convert/step-mapping.js";
import type { ColumnDef, SourceEngine } from "./types.js";

export interface TypeMapping {
  targetType: string;
  status: ConversionStatus;
  conversion: string;
  caveat?: string;
}

const STATUS_ORDER: Record<ConversionStatus, number> = { automatic: 0, partial: 1, manual: 2 };

/** Returns the more severe of two conversion statuses. */
export function worstStatus(a: ConversionStatus, b: ConversionStatus): ConversionStatus {
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}

const SUFFIX_PATTERNS = [
  { suffix: "WITH LOCAL TIME ZONE", regex: /\s*WITH\s+LOCAL\s+TIME\s+ZONE(?:\s*\([^)]*\))?$/i },
  { suffix: "WITH TIME ZONE", regex: /\s*WITH\s+TIME\s+ZONE(?:\s*\([^)]*\))?$/i },
  { suffix: "TO MONTH", regex: /\s*TO\s+MONTH(?:\s*\([^)]*\))?$/i },
  { suffix: "TO SECOND", regex: /\s*TO\s+SECOND(?:\s*\([^)]*\))?$/i },
];

export interface SourceTypeParts {
  /** Leading words before "(" or "<", such as "DOUBLE PRECISION". */
  base: string;
  /** Comma list inside the first parentheses. */
  params: string[];
  /** Trailing suffix such as "WITH LOCAL TIME ZONE" or "TO SECOND". */
  suffix: string;
}

export function parseSourceType(sourceType: string): SourceTypeParts {
  let text = sourceType.trim();
  let suffix = "";
  for (const candidate of SUFFIX_PATTERNS) {
    const match = candidate.regex.exec(text);
    if (match) {
      suffix = candidate.suffix;
      text = text.slice(0, match.index).trim();
      break;
    }
  }
  const paramsMatch = /\(([^)]*)\)/.exec(text);
  const rawParams = paramsMatch?.[1];
  const params = rawParams
    ? rawParams
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
    : [];
  const baseMatch = /^[A-Za-z0-9_ ]+/.exec(text);
  return { base: (baseMatch?.[0] ?? text).trim(), params, suffix };
}

function numericParam(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Target base without parameters, for "<source base> → <target base>" conversion labels. */
function baseOf(targetType: string): string {
  return targetType.replace(/\s*(\([^)]*\)|<.*>)$/, "").trim();
}

function mapping(
  base: string,
  targetType: string,
  status: ConversionStatus,
  caveat?: string,
): TypeMapping {
  return caveat === undefined
    ? { targetType, status, conversion: `${base} → ${baseOf(targetType)}` }
    : { targetType, status, conversion: `${base} → ${baseOf(targetType)}`, caveat };
}

function unrecognized(base: string, targetType: string): TypeMapping {
  return mapping(
    base,
    targetType,
    "manual",
    "Unrecognized source type; generated as text for review.",
  );
}

const PG_CORE_TYPES = new Set([
  "smallint",
  "integer",
  "int",
  "int2",
  "int4",
  "int8",
  "bigint",
  "serial",
  "bigserial",
  "smallserial",
  "numeric",
  "decimal",
  "real",
  "float4",
  "float8",
  "double precision",
  "money",
  "char",
  "character",
  "varchar",
  "character varying",
  "text",
  "bytea",
  "boolean",
  "bool",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "json",
  "jsonb",
  "xml",
  "inet",
  "cidr",
  "macaddr",
  "macaddr8",
  "bit",
  "varbit",
  "tsvector",
  "tsquery",
  "point",
  "line",
  "lseg",
  "box",
  "path",
  "polygon",
  "circle",
  "int4range",
  "int8range",
  "numrange",
  "tsrange",
  "tstzrange",
  "daterange",
  "oid",
  "name",
]);

function oracleWholeNumber(base: string, p: number | null): TypeMapping {
  if (p === null) return mapping(base, "numeric(38)", "automatic");
  if (p <= 4) return mapping(base, "smallint", "automatic");
  if (p <= 9) return mapping(base, "integer", "automatic");
  if (p <= 18) return mapping(base, "bigint", "automatic");
  return mapping(base, `numeric(${p})`, "automatic");
}

function oracleNumber(base: string, params: string[]): TypeMapping | null {
  const p = numericParam(params[0]);
  const s = numericParam(params[1]);
  if (params.length === 0) {
    if (base !== "NUMBER") return null;
    return mapping(
      base,
      "numeric",
      "partial",
      "Unconstrained NUMBER becomes numeric; pick a narrower type after profiling the data.",
    );
  }
  if (params.length === 1) return base === "NUMBER" ? oracleWholeNumber(base, p) : null;
  if (s === null) return null;
  if (s > 0)
    return mapping(base, p === null ? `numeric(38,${s})` : `numeric(${p},${s})`, "automatic");
  if (s === 0) return base === "NUMBER" ? oracleWholeNumber(base, p) : null;
  return null;
}

function mapOracle(parts: SourceTypeParts): TypeMapping {
  const { base, params, suffix } = parts;
  const p = numericParam(params[0]);
  if (base === "NUMBER" || base === "DECIMAL" || base === "NUMERIC") {
    return oracleNumber(base, params) ?? unrecognized(base, "text");
  }
  if (base === "VARCHAR2" || base === "NVARCHAR2" || base === "VARCHAR") {
    return mapping(base, p === null ? "varchar" : `varchar(${p})`, "automatic");
  }
  if (base === "CHAR" || base === "NCHAR") {
    return mapping(base, p === null ? "char" : `char(${p})`, "automatic");
  }
  if (base === "INTEGER" || base === "INT" || base === "SMALLINT") {
    return mapping(base, "numeric(38)", "automatic");
  }
  if (base === "FLOAT" || base === "BINARY_DOUBLE" || base === "DOUBLE PRECISION") {
    return mapping(base, "double precision", "automatic");
  }
  if (base === "BINARY_FLOAT" || base === "REAL") {
    return mapping(base, "real", "automatic");
  }
  if (base === "DATE") {
    return mapping(base, "timestamp(0)", "automatic");
  }
  if (base === "TIMESTAMP") {
    if (suffix === "WITH LOCAL TIME ZONE") {
      return mapping(
        base,
        p === null ? "timestamptz" : `timestamptz(${p})`,
        "partial",
        "Session time zone conversion differs; values are stored as UTC instants.",
      );
    }
    if (suffix === "WITH TIME ZONE") {
      return mapping(base, p === null ? "timestamptz" : `timestamptz(${p})`, "automatic");
    }
    return mapping(base, `timestamp(${p ?? 6})`, "automatic");
  }
  if (base.startsWith("INTERVAL") || suffix === "TO MONTH" || suffix === "TO SECOND") {
    return mapping(base, "interval", "automatic");
  }
  if (base === "CLOB" || base === "NCLOB" || base === "LONG") {
    return mapping(base, "text", "automatic");
  }
  if (base === "BLOB" || base === "RAW" || base === "LONG RAW") {
    return mapping(base, "bytea", "automatic");
  }
  if (base === "ROWID" || base === "UROWID") {
    return mapping(
      base,
      "text",
      "partial",
      "Physical row addresses do not carry over; values are copied as text.",
    );
  }
  if (base === "XMLTYPE") {
    return mapping(base, "xml", "automatic");
  }
  if (base === "JSON") {
    return mapping(base, "jsonb", "automatic");
  }
  if (base === "BOOLEAN") {
    return mapping(base, "boolean", "automatic");
  }
  if (base === "BFILE") {
    return mapping(
      base,
      "text",
      "manual",
      "External file pointers have no PostgreSQL equivalent; store the files in S3 and keep the object key.",
    );
  }
  if (base === "SDO_GEOMETRY") {
    return mapping(
      base,
      "text",
      "manual",
      "Requires PostGIS; enable the extension and convert the column to geometry.",
    );
  }
  return unrecognized(base, "text");
}

const COMPUTED_CAVEAT =
  "Recreate as GENERATED ALWAYS AS (...) STORED after translating the expression.";
const FRACTION_CAVEAT = "Fractional seconds beyond microseconds are dropped.";
const MICROSECONDS_CAVEAT =
  "PostgreSQL keeps microseconds; the seventh fractional digit is dropped.";
const OFFSET_CAVEAT = "The original offset is not stored; values become UTC instants.";
const ROWVERSION_CAVEAT =
  "Automatic row versioning is not reproduced; add a trigger if the application depends on it.";

function mapSqlServer(parts: SourceTypeParts): TypeMapping {
  const { base, params } = parts;
  const p = numericParam(params[0]);
  const s = numericParam(params[1]);
  if (base === "COMPUTED") {
    return {
      targetType: "not emitted",
      status: "manual",
      conversion: "COMPUTED → not emitted",
      caveat: COMPUTED_CAVEAT,
    };
  }
  if (base === "BIT") {
    return mapping(base, "boolean", "automatic");
  }
  if (base === "TINYINT" || base === "SMALLINT") {
    return mapping(base, "smallint", "automatic");
  }
  if (base === "INT" || base === "INTEGER") {
    return mapping(base, "integer", "automatic");
  }
  if (base === "BIGINT") {
    return mapping(base, "bigint", "automatic");
  }
  if (base === "DECIMAL" || base === "NUMERIC") {
    if (p === null || s === null) return unrecognized(base, "text");
    return mapping(base, `numeric(${p},${s})`, "automatic");
  }
  if (base === "MONEY") {
    return mapping(base, "numeric(19,4)", "automatic");
  }
  if (base === "SMALLMONEY") {
    return mapping(base, "numeric(10,4)", "automatic");
  }
  if (base === "REAL") {
    return mapping(base, "real", "automatic");
  }
  if (base === "FLOAT") {
    return mapping(base, p !== null && p <= 24 ? "real" : "double precision", "automatic");
  }
  if (base === "DOUBLE PRECISION") {
    return mapping(base, "double precision", "automatic");
  }
  if (base === "DATE") {
    return mapping(base, "date", "automatic");
  }
  if (base === "TIME") {
    if (p !== null && p <= 6) return mapping(base, `time(${p})`, "automatic");
    return mapping(base, "time(6)", "partial", FRACTION_CAVEAT);
  }
  if (base === "DATETIME") {
    return mapping(base, "timestamp(3)", "automatic");
  }
  if (base === "SMALLDATETIME") {
    return mapping(base, "timestamp(0)", "automatic");
  }
  if (base === "DATETIME2") {
    if (p !== null && p <= 6) return mapping(base, `timestamp(${p})`, "automatic");
    return mapping(base, "timestamp(6)", "partial", MICROSECONDS_CAVEAT);
  }
  if (base === "DATETIMEOFFSET") {
    return mapping(base, "timestamptz", "partial", OFFSET_CAVEAT);
  }
  if (base === "CHAR" || base === "NCHAR") {
    return mapping(base, p === null ? "char" : `char(${p})`, "automatic");
  }
  if (base === "VARCHAR" || base === "NVARCHAR") {
    if (params[0]?.toUpperCase() === "MAX") return mapping(base, "text", "automatic");
    return mapping(base, p === null ? "varchar" : `varchar(${p})`, "automatic");
  }
  if (base === "TEXT" || base === "NTEXT") {
    return mapping(base, "text", "automatic");
  }
  if (base === "BINARY" || base === "VARBINARY" || base === "IMAGE") {
    return mapping(base, "bytea", "automatic");
  }
  if (base === "UNIQUEIDENTIFIER") {
    return mapping(base, "uuid", "automatic");
  }
  if (base === "XML") {
    return mapping(base, "xml", "automatic");
  }
  if (base === "SYSNAME") {
    return mapping(base, "varchar(128)", "automatic");
  }
  if (base === "ROWVERSION" || base === "TIMESTAMP") {
    return mapping(base, "bytea", "partial", ROWVERSION_CAVEAT);
  }
  if (base === "SQL_VARIANT") {
    return mapping(
      base,
      "text",
      "manual",
      "No PostgreSQL equivalent; choose a concrete type per column.",
    );
  }
  if (base === "HIERARCHYID") {
    return mapping(base, "text", "manual", "Use the ltree extension or a path column.");
  }
  if (base === "GEOGRAPHY" || base === "GEOMETRY") {
    return mapping(base, "text", "manual", "Requires PostGIS.");
  }
  return unrecognized(base, "text");
}

function mapMysql(column: ColumnDef): TypeMapping {
  return {
    targetType: column.sourceType.toLowerCase(),
    status: "automatic",
    conversion: "unchanged",
  };
}

function mapPostgreSql(parts: SourceTypeParts, column: ColumnDef): TypeMapping {
  const { base } = parts;
  const lowered = base.toLowerCase();
  const isCore =
    PG_CORE_TYPES.has(lowered) ||
    (lowered.endsWith("[]") && PG_CORE_TYPES.has(lowered.slice(0, -2)));
  const targetType = column.sourceType.toLowerCase();
  if (isCore) return mapping(base, targetType, "automatic");
  return mapping(
    base,
    targetType,
    "partial",
    "Confirm the extension that provides this type is enabled in Aurora PostgreSQL.",
  );
}

function byteSized(n: number): number {
  return Math.min(n * 4, 65535);
}

const TERADATA_NUMBER_CAVEAT =
  "Unconstrained NUMBER becomes DECIMAL(38,10); pick a narrower type after profiling.";

function redshiftDecimal(base: string, params: string[]): TypeMapping | null {
  const p = numericParam(params[0]);
  const s = numericParam(params[1]);
  if (params.length >= 2 && s !== null) {
    return mapping(base, p === null ? `decimal(38,${s})` : `decimal(${p},${s})`, "automatic");
  }
  if (params.length === 1 && p !== null) return mapping(base, `decimal(${p},0)`, "automatic");
  return null;
}

function mapTeradata(parts: SourceTypeParts, column: ColumnDef): TypeMapping {
  const { base, params, suffix } = parts;
  const p = numericParam(params[0]);
  const unicode = column.charset?.toUpperCase() === "UNICODE";
  if (base === "BYTEINT" || base === "SMALLINT") {
    return mapping(base, "smallint", "automatic");
  }
  if (base === "INTEGER" || base === "INT") {
    return mapping(base, "integer", "automatic");
  }
  if (base === "BIGINT") {
    return mapping(base, "bigint", "automatic");
  }
  if (base === "DECIMAL" || base === "NUMERIC" || base === "NUMBER") {
    if (base === "NUMBER" && params.length === 0) {
      return mapping(base, "decimal(38,10)", "partial", TERADATA_NUMBER_CAVEAT);
    }
    return redshiftDecimal(base, params) ?? unrecognized(base, "varchar(65535)");
  }
  if (base === "FLOAT" || base === "REAL" || base === "DOUBLE PRECISION") {
    return mapping(base, "double precision", "automatic");
  }
  if (base === "CHAR") {
    if (unicode) {
      return mapping(
        base,
        p === null ? "varchar" : `varchar(${byteSized(p)})`,
        "partial",
        "Redshift CHAR is single-byte; Unicode values are stored as VARCHAR sized in bytes.",
      );
    }
    return mapping(base, p === null ? "char" : `char(${p})`, "automatic");
  }
  if (base === "VARCHAR") {
    if (unicode) {
      return mapping(
        base,
        p === null ? "varchar" : `varchar(${byteSized(p)})`,
        "partial",
        "Redshift VARCHAR length is in bytes; sized at 4 bytes per character.",
      );
    }
    return mapping(base, p === null ? "varchar" : `varchar(${p})`, "automatic");
  }
  if (base === "LONG" || base === "LONG VARCHAR" || base === "CLOB") {
    return mapping(
      base,
      "varchar(65535)",
      "partial",
      "Values longer than 65,535 bytes do not fit.",
    );
  }
  if (base === "BYTE" || base === "VARBYTE") {
    return mapping(base, p === null ? "varbyte" : `varbyte(${p})`, "automatic");
  }
  if (base === "BLOB") {
    return mapping(
      base,
      "varbyte(1024000)",
      "partial",
      "Redshift VARBYTE holds at most 1,024,000 bytes.",
    );
  }
  if (base === "DATE") {
    return mapping(base, "date", "automatic");
  }
  if (base === "TIME") {
    if (suffix === "WITH TIME ZONE") return mapping(base, "timetz", "automatic");
    return mapping(base, "time", "automatic");
  }
  if (base === "TIMESTAMP") {
    if (suffix === "WITH TIME ZONE") return mapping(base, "timestamptz", "automatic");
    return mapping(base, "timestamp", "automatic");
  }
  if (base.startsWith("INTERVAL") || suffix === "TO MONTH" || suffix === "TO SECOND") {
    return mapping(
      base,
      "varchar(32)",
      "partial",
      "Intervals are loaded as text; convert them after the load.",
    );
  }
  if (base === "PERIOD") {
    return mapping(
      base,
      "varchar(64)",
      "manual",
      "PERIOD has no Redshift equivalent; split it into begin and end columns.",
    );
  }
  if (base === "JSON") {
    return mapping(base, "super", "automatic");
  }
  if (base === "XML") {
    return mapping(base, "varchar(65535)", "partial", "XML is loaded as text.");
  }
  if (base === "ST_GEOMETRY") {
    return mapping(
      base,
      "geometry",
      "partial",
      "Convert values with ST_GeomFromText during the load.",
    );
  }
  return unrecognized(base, "varchar(65535)");
}

function mapNetezza(parts: SourceTypeParts): TypeMapping {
  const { base, params, suffix } = parts;
  const p = numericParam(params[0]);
  if (base === "BYTEINT" || base === "INT1" || base === "SMALLINT" || base === "INT2") {
    return mapping(base, "smallint", "automatic");
  }
  if (base === "INTEGER" || base === "INT" || base === "INT4") {
    return mapping(base, "integer", "automatic");
  }
  if (base === "BIGINT" || base === "INT8") {
    return mapping(base, "bigint", "automatic");
  }
  if (base === "NUMERIC" || base === "DECIMAL") {
    return redshiftDecimal(base, params) ?? unrecognized(base, "varchar(65535)");
  }
  if (base === "REAL" || base === "FLOAT4") {
    return mapping(base, "real", "automatic");
  }
  if (base === "DOUBLE PRECISION" || base === "DOUBLE" || base === "FLOAT" || base === "FLOAT8") {
    return mapping(base, "double precision", "automatic");
  }
  if (base === "CHAR") {
    return mapping(base, p === null ? "char" : `char(${p})`, "automatic");
  }
  if (base === "VARCHAR") {
    return mapping(base, p === null ? "varchar" : `varchar(${p})`, "automatic");
  }
  if (base === "NCHAR" || base === "NVARCHAR") {
    return mapping(
      base,
      p === null ? "varchar" : `varchar(${byteSized(p)})`,
      "partial",
      "Redshift VARCHAR length is in bytes; sized at 4 bytes per character.",
    );
  }
  if (base === "BOOLEAN" || base === "BOOL") {
    return mapping(base, "boolean", "automatic");
  }
  if (base === "DATE") {
    return mapping(base, "date", "automatic");
  }
  if (base === "TIME") {
    if (suffix === "WITH TIME ZONE") return mapping(base, "timetz", "automatic");
    return mapping(base, "time", "automatic");
  }
  if (base === "TIMETZ") {
    return mapping(base, "timetz", "automatic");
  }
  if (base === "TIMESTAMP") {
    return mapping(base, "timestamp", "automatic");
  }
  if (base.startsWith("INTERVAL") || suffix === "TO MONTH" || suffix === "TO SECOND") {
    return mapping(
      base,
      "varchar(32)",
      "partial",
      "Intervals are loaded as text; convert them after the load.",
    );
  }
  if (base === "VARBINARY" || base === "BINARY VARYING") {
    return mapping(base, p === null ? "varbyte" : `varbyte(${p})`, "automatic");
  }
  if (base === "ST_GEOMETRY") {
    return mapping(
      base,
      "geometry",
      "partial",
      "Convert values with ST_GeomFromText during the load.",
    );
  }
  if (base === "JSON" || base === "JSONB") {
    return mapping(base, "super", "automatic");
  }
  return unrecognized(base, "varchar(65535)");
}

const HIVE_MANUAL_CAVEAT = "No Iceberg equivalent; generated as string for review.";
const HIVE_CHAR_CAVEAT = "CHAR padding is not preserved.";

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let angle = 0;
  let paren = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if (ch === "," && angle === 0 && paren === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function nestedTypes(sourceType: string): string[] | null {
  const open = sourceType.indexOf("<");
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < sourceType.length; i++) {
    if (sourceType[i] === "<") depth++;
    else if (sourceType[i] === ">") {
      depth--;
      if (depth === 0) {
        if (i !== sourceType.length - 1) return null;
        return splitTopLevelCommas(sourceType.slice(open + 1, i));
      }
    }
  }
  return null;
}

function mapHiveElement(element: string): TypeMapping {
  return mapColumnType("hive", {
    name: "",
    sourceType: element,
    nullable: true,
    identity: false,
    caseInsensitive: false,
  });
}

function mapHiveNested(base: string, sourceType: string): TypeMapping | null {
  const elements = nestedTypes(sourceType);
  if (!elements || elements.length === 0) return null;
  const kind = base.toLowerCase();
  if (kind === "array" && elements.length !== 1) return null;
  if (kind === "map" && elements.length !== 2) return null;
  const mapped = elements.map((element) => {
    if (kind !== "struct") {
      return { mapping: mapHiveElement(element), label: "" };
    }
    const colon = element.indexOf(":");
    const name = colon >= 0 ? element.slice(0, colon).trim() : "";
    const type = colon >= 0 ? element.slice(colon + 1).trim() : element;
    const inner = mapHiveElement(type);
    return { mapping: inner, label: name === "" ? "" : name };
  });
  let status: ConversionStatus = "automatic";
  let caveat: string | undefined;
  for (const entry of mapped) {
    if (STATUS_ORDER[entry.mapping.status] > STATUS_ORDER[status]) {
      status = entry.mapping.status;
      caveat = entry.mapping.caveat;
    }
  }
  const inner = mapped
    .map((entry) =>
      entry.label === "" ? entry.mapping.targetType : `${entry.label}:${entry.mapping.targetType}`,
    )
    .join(",");
  const targetType = `${kind}<${inner}>`;
  return caveat === undefined
    ? { targetType, status, conversion: `${base} → ${baseOf(targetType)}` }
    : { targetType, status, conversion: `${base} → ${baseOf(targetType)}`, caveat };
}

function mapHive(parts: SourceTypeParts, column: ColumnDef): TypeMapping {
  const { base, params, suffix } = parts;
  const p = numericParam(params[0]);
  const s = numericParam(params[1]);
  if (base === "ARRAY" || base === "MAP" || base === "STRUCT") {
    return (
      mapHiveNested(base, column.sourceType) ??
      mapping(base, "string", "manual", HIVE_MANUAL_CAVEAT)
    );
  }
  if (base === "UNIONTYPE") {
    return mapping(base, "string", "manual", HIVE_MANUAL_CAVEAT);
  }
  if (base === "TINYINT" || base === "SMALLINT") {
    return mapping(base, "int", "automatic");
  }
  if (base === "INT" || base === "INTEGER") {
    return mapping(base, "int", "automatic");
  }
  if (base === "BIGINT") {
    return mapping(base, "bigint", "automatic");
  }
  if (base === "FLOAT") {
    return mapping(base, "float", "automatic");
  }
  if (base === "DOUBLE" || base === "DOUBLE PRECISION") {
    return mapping(base, "double", "automatic");
  }
  if (base === "DECIMAL") {
    if (p !== null && s !== null) return mapping(base, `decimal(${p},${s})`, "automatic");
    if (p !== null) return mapping(base, `decimal(${p},0)`, "automatic");
    return mapping(base, "decimal(10,0)", "automatic");
  }
  if (base === "STRING" || base === "VARCHAR") {
    return mapping(base, "string", "automatic");
  }
  if (base === "CHAR") {
    return mapping(base, "string", "partial", HIVE_CHAR_CAVEAT);
  }
  if (base === "BOOLEAN" || base === "BINARY" || base === "DATE" || base === "TIMESTAMP") {
    return mapping(base, base.toLowerCase(), "automatic");
  }
  if (base.startsWith("INTERVAL") || suffix !== "") {
    return mapping(base, "string", "manual", HIVE_MANUAL_CAVEAT);
  }
  return unrecognized(base, "string");
}

const CHAR_BASES = new Set(["CHAR", "VARCHAR", "NCHAR", "NVARCHAR", "CHARACTER"]);
const COLLATE_CAVEAT =
  "Teradata compares this column case-insensitively; the column is declared COLLATE case_insensitive.";

function applyCollateOverride(mapped: TypeMapping, parts: SourceTypeParts): TypeMapping {
  if (!CHAR_BASES.has(parts.base)) return mapped;
  return {
    targetType: `${mapped.targetType} COLLATE case_insensitive`,
    status: worstStatus(mapped.status, "partial"),
    conversion: mapped.conversion,
    caveat: COLLATE_CAVEAT,
  };
}

/** Maps a source column type to the fixed AWS target for the engine. */
export function mapColumnType(engine: SourceEngine, column: ColumnDef): TypeMapping {
  const parts = parseSourceType(column.sourceType);
  switch (engine) {
    case "oracle":
      return mapOracle(parts);
    case "sqlserver":
      return mapSqlServer(parts);
    case "mysql":
      return mapMysql(column);
    case "postgresql":
      return mapPostgreSql(parts, column);
    case "teradata": {
      const mapped = mapTeradata(parts, column);
      return column.caseInsensitive ? applyCollateOverride(mapped, parts) : mapped;
    }
    case "netezza": {
      const mapped = mapNetezza(parts);
      return column.caseInsensitive ? applyCollateOverride(mapped, parts) : mapped;
    }
    case "hive":
      return mapHive(parts, column);
  }
}
