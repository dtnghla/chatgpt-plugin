import type { ConversionStatus } from "../convert/step-mapping.js";
import type { ProjectAssessment, Risk } from "../migration/types.js";

export type SourceEngine =
  | "oracle"
  | "sqlserver"
  | "mysql"
  | "postgresql"
  | "teradata"
  | "netezza"
  | "hive";
export type TargetEngine =
  | "aurora-postgresql"
  | "aurora-mysql"
  | "redshift-serverless"
  | "athena-iceberg";
export type WorkloadClass = "database" | "warehouse" | "lake";

export const SOURCE_ENGINES: readonly SourceEngine[] = [
  "oracle",
  "sqlserver",
  "mysql",
  "postgresql",
  "teradata",
  "netezza",
  "hive",
];

export const TARGET_FOR: Record<SourceEngine, TargetEngine> = {
  oracle: "aurora-postgresql",
  sqlserver: "aurora-postgresql",
  mysql: "aurora-mysql",
  postgresql: "aurora-postgresql",
  teradata: "redshift-serverless",
  netezza: "redshift-serverless",
  hive: "athena-iceberg",
};

export const CLASS_FOR: Record<SourceEngine, WorkloadClass> = {
  oracle: "database",
  sqlserver: "database",
  mysql: "database",
  postgresql: "database",
  teradata: "warehouse",
  netezza: "warehouse",
  hive: "lake",
};

export interface SqlStatement {
  file: string;
  line: number;
  /** Original statement slice, trimmed. */
  text: string;
  /** Comments stripped, trimmed, terminator removed. */
  sql: string;
}

export interface ColumnDef {
  name: string;
  sourceType: string;
  nullable: boolean;
  defaultExpression?: string;
  identity: boolean;
  charset?: string;
  caseInsensitive: boolean;
  computed?: string;
}

export interface ForeignKey {
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface TableDef {
  schema: string;
  name: string;
  file: string;
  line: number;
  sql: string;
  columns: ColumnDef[];
  partitionColumns: ColumnDef[];
  primaryKey: string[];
  uniqueKeys: string[][];
  foreignKeys: ForeignKey[];
  checks: number;
  partitioning?: string;
  distribution?: { kind: "key" | "random"; columns: string[] };
  sortColumns: string[];
  buckets?: { columns: string[]; count: number };
  hive?: {
    rowFormat?: string;
    storedAs: string;
    format: string;
    tblProperties: Record<string, string>;
  };
  location?: string;
  external: boolean;
  setTable: boolean;
  mysqlEngine?: string;
  createdFromQuery: boolean;
}

export interface ViewDef {
  schema: string;
  name: string;
  file: string;
  line: number;
  sql: string;
  body: string;
  materialized: boolean;
}

export interface IndexDef {
  schema: string;
  name: string;
  /** Qualified source table reference ("SCHEMA.TABLE"). */
  table: string;
  columns: string[];
  unique: boolean;
  bitmap: boolean;
  expression: boolean;
  file: string;
  line: number;
  sql: string;
}

export interface SequenceDef {
  schema: string;
  name: string;
  file: string;
  line: number;
  sql: string;
  start?: string;
  increment?: string;
}

export type ProceduralKind =
  | "procedure"
  | "function"
  | "trigger"
  | "package"
  | "package_body"
  | "macro"
  | "type"
  | "bteq_script";

export interface ProceduralObject {
  schema: string;
  name: string;
  kind: ProceduralKind;
  file: string;
  line: number;
  lines: number;
  features: string[];
  complexity: "low" | "medium" | "high";
}

export interface DatabaseFile {
  path: string;
  bytes: number;
  sha256: string;
  statements: number;
  detectedEngine?: SourceEngine;
}

export type ObjectKind = "table" | "view" | "index" | "sequence" | ProceduralKind;
export type TableMovement = "dms" | "copy" | "datasync" | "s3" | "manual";

export interface DatabaseAssessment {
  workload: "database";
  projectName: string;
  sourceEngine: SourceEngine;
  engineDetection: "argument" | "detected";
  targetEngine: TargetEngine;
  workloadClass: WorkloadClass;
  totals: {
    files: number;
    schemas: number;
    tables: number;
    columns: number;
    views: number;
    indexes: number;
    sequences: number;
    procedural: number;
    temporaryTables: number;
    unparsed: number;
    warnings: number;
    automaticColumns: number;
    partialColumns: number;
    manualColumns: number;
  };
  files: { path: string; bytes: number; sha256: string; statements: number }[];
  typeCoverage: {
    sourceType: string;
    targetType: string;
    count: number;
    status: ConversionStatus;
    caveat?: string;
  }[];
  objectCoverage: {
    kind: ObjectKind;
    count: number;
    automatic: number;
    partial: number;
    manual: number;
    conversion: string;
  }[];
  attention: {
    kind: ObjectKind | "column";
    name: string;
    file: string;
    line: number;
    status: "partial" | "manual";
    reason: string;
  }[];
  procedural: {
    schema: string;
    name: string;
    kind: ProceduralKind;
    file: string;
    line: number;
    lines: number;
    complexity: "low" | "medium" | "high";
    features: string[];
  }[];
  tables: {
    schema: string;
    name: string;
    columns: number;
    primaryKey: boolean;
    partitioned: boolean;
    movement: TableMovement;
    status: ConversionStatus;
    location?: string;
  }[];
  movement: {
    method: "dms-serverless" | "s3-copy" | "datasync-athena";
    summary: string;
    tables: number;
    manualTables: number;
  };
  risks: Risk[];
  questions: string[];
  readiness: ProjectAssessment["readiness"];
  truncated: { tables: boolean; procedural: boolean; attention: boolean };
}

export interface DatabaseProject {
  engine: SourceEngine;
  engineDetection: "argument" | "detected";
  files: DatabaseFile[];
  schemas: string[];
  tables: TableDef[];
  views: ViewDef[];
  indexes: IndexDef[];
  sequences: SequenceDef[];
  procedural: ProceduralObject[];
  /** ALTER TABLE … ADD CONSTRAINT statements, in source order. */
  constraintStatements: SqlStatement[];
  temporaryTables: string[];
  schemaFallbackUsed: boolean;
  extensions: string[];
  synonyms: number;
  grants: number;
  otherStatements: number;
  unparsed: { file: string; line: number; snippet: string }[];
  warnings: string[];
}
