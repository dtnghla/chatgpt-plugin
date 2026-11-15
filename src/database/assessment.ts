import type { ConversionStatus } from "../convert/step-mapping.js";
import { commonProjectDirectory, slugify } from "../migration/assessment.js";
import type { Risk } from "../migration/types.js";
import { ENGINE_LABELS, TARGET_LABELS } from "./labels.js";
import { rewriteViewSql, translateDefault } from "./sql-rewrite.js";
import { mapColumnType, parseSourceType, worstStatus } from "./type-mapping.js";
import type {
  ColumnDef,
  DatabaseAssessment,
  DatabaseProject,
  ObjectKind,
  ProceduralKind,
  SourceEngine,
  TableDef,
  TableMovement,
  WorkloadClass,
} from "./types.js";
import { CLASS_FOR, TARGET_FOR } from "./types.js";

const FALLBACK_SCHEMAS: Record<SourceEngine, string> = {
  oracle: "public",
  sqlserver: "dbo",
  mysql: "public",
  postgresql: "public",
  teradata: "public",
  netezza: "public",
  hive: "default",
};

const PROCEDURAL_LABELS: Record<ProceduralKind, string> = {
  procedure: "Procedure",
  function: "Function",
  trigger: "Trigger",
  package: "Package",
  package_body: "Package body",
  macro: "Macro",
  type: "Type",
  bteq_script: "BTEQ script",
};

const PROCEDURAL_KIND_ORDER: ProceduralKind[] = [
  "procedure",
  "function",
  "trigger",
  "package",
  "package_body",
  "macro",
  "type",
  "bteq_script",
];

const OBJECT_KIND_ORDER: ObjectKind[] = [
  "table",
  "view",
  "index",
  "sequence",
  ...PROCEDURAL_KIND_ORDER,
];

const TABLE_CONVERSIONS: Record<WorkloadClass, string> = {
  database: "CREATE TABLE with mapped column types",
  warehouse: "CREATE TABLE with distribution and sort keys",
  lake: "Raw Hive table plus Apache Iceberg table",
};

const SEQUENCE_CONVERSION = "No sequences in the target; use IDENTITY or AUTO_INCREMENT columns.";
const INDEX_NOT_CREATED_CONVERSION =
  "Not created; Redshift and Iceberg rely on sort, distribution and partition layout.";
const INDEX_NOT_CREATED_MESSAGE =
  "Index <i> is not created; the target relies on sort, distribution and partition layout.";

const ORACLE_LOB_BASES = new Set(["CLOB", "NCLOB", "LONG", "BLOB", "LONG RAW"]);
const SQLSERVER_LOB_BASES = new Set([
  "VARCHAR",
  "NVARCHAR",
  "VARBINARY",
  "TEXT",
  "NTEXT",
  "IMAGE",
  "XML",
]);

const TERADATA_EXPORT_BLOCKED = new Set([
  "CLOB",
  "BLOB",
  "BYTE",
  "VARBYTE",
  "PERIOD",
  "JSON",
  "XML",
  "ST_GEOMETRY",
]);
const NETEZZA_EXPORT_BLOCKED = new Set(["VARBINARY", "BINARY VARYING", "ST_GEOMETRY"]);

const S3_SCHEMES = new Set(["s3", "s3a", "s3n"]);

export interface TableMovementDecision {
  movement: TableMovement;
  reason?: string;
  /** Effective location: normalized s3 URI, source HDFS URI or derived warehouse path. */
  location?: string;
  /** HDFS path without scheme and host, for datasync tables. */
  hdfsPath?: string;
}

function hdfsPathFromUri(uri: string): string {
  // hdfs://host[:port]/x -> /x
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(\/.*)$/.exec(uri);
  const path = match?.[1] ?? uri;
  return path.replace(/\/+$/g, "") || "/";
}

function schemeOf(location: string): string | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(location);
  return match?.[1]?.toLowerCase();
}

function columnsOf(table: TableDef): ColumnDef[] {
  return [...table.columns, ...table.partitionColumns];
}

/** Worst column status of a table; computed columns count as manual. */
export function tableColumnStatus(engine: SourceEngine, table: TableDef): ConversionStatus {
  let status: ConversionStatus = "automatic";
  for (const column of columnsOf(table)) {
    status = worstStatus(status, mapColumnType(engine, column).status);
  }
  return status;
}

/** Decides how a table's data moves to AWS and, for Hive, where it lives. */
export function decideTableMovement(
  project: DatabaseProject,
  table: TableDef,
): TableMovementDecision {
  if (table.createdFromQuery) {
    return {
      movement: "manual",
      reason: "Columns are unknown because the table is created from a query.",
    };
  }
  const workloadClass = CLASS_FOR[project.engine];
  if (workloadClass === "database") {
    if (table.external) {
      return {
        movement: "manual",
        reason: "Oracle external tables are not migrated by DMS; load their files to S3 instead.",
      };
    }
    return { movement: "dms" };
  }
  if (workloadClass === "warehouse") {
    const blocked =
      project.engine === "teradata" ? TERADATA_EXPORT_BLOCKED : NETEZZA_EXPORT_BLOCKED;
    const types: string[] = [];
    for (const column of table.columns) {
      const base = parseSourceType(column.sourceType).base;
      if (blocked.has(base) && !types.includes(base)) types.push(base);
    }
    if (types.length > 0) {
      return {
        movement: "manual",
        reason: `Columns of type ${types.join(", ")} cannot be exported by the generated script; export this table manually.`,
      };
    }
    return { movement: "copy" };
  }
  const transactional = table.hive?.tblProperties.transactional;
  if (transactional !== undefined && transactional.toLowerCase() === "true") {
    return {
      movement: "manual",
      reason:
        "Hive ACID table: major-compact and export it manually; Athena cannot read Hive ACID delta files.",
      location: table.location ?? warehousePathOf(table),
    };
  }
  if (table.location) {
    const scheme = schemeOf(table.location);
    if (scheme !== undefined && S3_SCHEMES.has(scheme)) {
      const normalized = `s3://${table.location.slice(table.location.indexOf("://") + 3)}`;
      return { movement: "s3", location: normalized };
    }
    if (scheme === undefined || scheme === "hdfs") {
      const raw = scheme === undefined ? table.location : hdfsPathFromUri(table.location);
      const clean = raw.replace(/\/+$/g, "") || "/";
      return { movement: "datasync", location: table.location, hdfsPath: clean };
    }
    return {
      movement: "manual",
      reason: `Unsupported location scheme ${scheme}.`,
      location: table.location,
    };
  }
  const derived = warehousePathOf(table);
  return { movement: "datasync", location: derived, hdfsPath: derived };
}

function warehousePathOf(table: TableDef): string {
  const db = table.schema.toLowerCase();
  const name = table.name.toLowerCase();
  return db === "default"
    ? `/user/hive/warehouse/${name}`
    : `/user/hive/warehouse/${db}.db/${name}`;
}

function sourceTypeLabel(sourceType: string): string {
  const parts = parseSourceType(sourceType);
  return parts.suffix ? `${parts.base} ${parts.suffix}` : parts.base;
}

function targetWithoutParams(targetType: string): string {
  let text = targetType.trim();
  for (;;) {
    if (text.endsWith(")")) {
      const open = text.lastIndexOf("(");
      if (open > 0) {
        text = text.slice(0, open).trim();
        continue;
      }
    }
    if (text.endsWith(">")) {
      let depth = 0;
      for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] === ">") depth++;
        else if (text[i] === "<") {
          depth--;
          if (depth === 0) {
            text = text.slice(0, i).trim();
            break;
          }
        }
      }
      continue;
    }
    return text;
  }
}

function severityRank(severity: Risk["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

export function sortRisks(risks: Risk[]): Risk[] {
  return risks.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

function pluralize(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function attentionRank(kind: string): number {
  switch (kind) {
    case "column":
      return 0;
    case "table":
      return 1;
    case "view":
      return 2;
    case "index":
      return 3;
    case "sequence":
      return 4;
    default:
      return 5;
  }
}

function compareAttention(
  a: DatabaseAssessment["attention"][number],
  b: DatabaseAssessment["attention"][number],
): number {
  const statusRank = (status: "partial" | "manual"): number => (status === "manual" ? 0 : 1);
  return (
    statusRank(a.status) - statusRank(b.status) ||
    attentionRank(a.kind) - attentionRank(b.kind) ||
    a.name.localeCompare(b.name)
  );
}

function sourceOrder(a: { file: string; line: number }, b: { file: string; line: number }): number {
  return a.file.localeCompare(b.file) || a.line - b.line;
}

export function deriveDatabaseProjectName(project: DatabaseProject, requested?: string): string {
  if (requested?.trim()) return slugify(requested, "data-modernization");
  const directory = commonProjectDirectory(project.files.map((file) => file.path));
  if (directory) return slugify(directory, "data-modernization");
  const firstSchema = project.schemas[0];
  if (firstSchema) return slugify(firstSchema, "data-modernization");
  return "data-modernization";
}

export function assessDatabaseProject(
  project: DatabaseProject,
  options: { projectName?: string } = {},
): DatabaseAssessment {
  const projectName = deriveDatabaseProjectName(project, options.projectName);
  const engine = project.engine;
  const targetEngine = TARGET_FOR[engine];
  const workloadClass = CLASS_FOR[engine];
  const generatesDdl =
    workloadClass !== "database" || (engine !== "mysql" && engine !== "postgresql");
  const homogeneous = engine === "mysql" || engine === "postgresql";

  // --- Columns -----------------------------------------------------------------
  const automaticColumns: { table: TableDef; column: ColumnDef }[] = [];
  const partialColumns: { table: TableDef; column: ColumnDef }[] = [];
  const manualColumns: { table: TableDef; column: ColumnDef }[] = [];
  let columnCount = 0;
  const coverage = new Map<
    string,
    {
      sourceType: string;
      targetType: string;
      count: number;
      status: ConversionStatus;
      caveat?: string;
    }
  >();
  const untranslatedDefaults: { table: TableDef; column: ColumnDef }[] = [];
  for (const table of project.tables) {
    for (const column of columnsOf(table)) {
      columnCount++;
      const mapped = mapColumnType(engine, column);
      const entry = { table, column };
      if (mapped.status === "automatic") automaticColumns.push(entry);
      else if (mapped.status === "partial") partialColumns.push(entry);
      else manualColumns.push(entry);
      const key = [
        sourceTypeLabel(column.sourceType),
        targetWithoutParams(mapped.targetType),
        mapped.status,
        mapped.caveat ?? "",
      ].join("\u0000");
      const existing = coverage.get(key);
      if (existing) existing.count += 1;
      else
        coverage.set(key, {
          sourceType: sourceTypeLabel(column.sourceType),
          targetType: targetWithoutParams(mapped.targetType),
          count: 1,
          status: mapped.status,
          caveat: mapped.caveat,
        });
      if (
        generatesDdl &&
        column.defaultExpression !== undefined &&
        translateDefault(engine, column.defaultExpression, mapped.targetType) === undefined
      ) {
        untranslatedDefaults.push({ table, column });
      }
    }
  }
  const typeCoverage = [...coverage.values()].sort(
    (a, b) => b.count - a.count || a.sourceType.localeCompare(b.sourceType),
  );

  // --- Table movement ------------------------------------------------------------
  const tableData = project.tables.map((table) => ({
    table,
    decision: decideTableMovement(project, table),
  }));
  const tableRows: DatabaseAssessment["tables"] = tableData.map(({ table, decision }) => ({
    schema: table.schema,
    name: table.name,
    columns: table.columns.length + table.partitionColumns.length,
    primaryKey: table.primaryKey.length > 0,
    partitioned: table.partitioning !== undefined,
    movement: decision.movement,
    status:
      decision.movement === "manual"
        ? ("manual" as ConversionStatus)
        : tableColumnStatus(engine, table),
    ...(decision.location !== undefined ? { location: decision.location } : {}),
  }));
  const manualMovementCount = tableData.filter((e) => e.decision.movement === "manual").length;
  const movedTableCount = project.tables.length - manualMovementCount;
  const s3TableCount = tableData.filter((e) => e.decision.movement === "s3").length;

  // --- View rewrites ---------------------------------------------------------------
  const viewData = project.views.map((view) => ({
    view,
    rewrite: rewriteViewSql(engine, view.body),
  }));

  // --- Attention --------------------------------------------------------------------
  const attention: DatabaseAssessment["attention"] = [];
  const columnQualify = (table: TableDef, column: ColumnDef): string =>
    `${table.schema}.${table.name}.${column.name}`;
  for (const { table, column } of manualColumns) {
    const mapped = mapColumnType(engine, column);
    attention.push({
      kind: "column",
      name: columnQualify(table, column),
      file: table.file,
      line: table.line,
      status: "manual",
      reason: mapped.caveat ?? "",
    });
  }
  for (const { table, column } of partialColumns) {
    const mapped = mapColumnType(engine, column);
    attention.push({
      kind: "column",
      name: columnQualify(table, column),
      file: table.file,
      line: table.line,
      status: "partial",
      reason: mapped.caveat ?? "",
    });
  }
  for (const { table, column } of untranslatedDefaults) {
    attention.push({
      kind: "column",
      name: columnQualify(table, column),
      file: table.file,
      line: table.line,
      status: "partial",
      reason: `Default expression ${column.defaultExpression} was not translated.`,
    });
  }
  for (const { table, decision } of tableData) {
    if (decision.movement === "manual") {
      attention.push({
        kind: "table",
        name: `${table.schema}.${table.name}`,
        file: table.file,
        line: table.line,
        status: "manual",
        reason: decision.reason ?? "",
      });
    }
  }
  for (const { view, rewrite } of viewData) {
    if (rewrite.status === "automatic") continue;
    attention.push({
      kind: "view",
      name: `${view.schema}.${view.name}`,
      file: view.file,
      line: view.line,
      status: rewrite.status,
      reason:
        rewrite.status === "manual"
          ? `Manual: ${rewrite.manualFeatures.join(", ")}.`
          : `Rewritten with rules: ${rewrite.applied.join(", ") || "no changes"}; review the SQL.`,
    });
  }
  for (const index of project.indexes) {
    if (workloadClass === "database") {
      if (!index.bitmap && !index.expression) continue;
      attention.push({
        kind: "index",
        name: `${index.schema}.${index.name}`,
        file: index.file,
        line: index.line,
        status: "partial",
        reason: index.bitmap
          ? "Bitmap index recreated as a B-tree index."
          : "Expression index copied from the source; check the functions.",
      });
    } else {
      attention.push({
        kind: "index",
        name: `${index.schema}.${index.name}`,
        file: index.file,
        line: index.line,
        status: "partial",
        reason: INDEX_NOT_CREATED_MESSAGE.replace("<i>", `${index.schema}.${index.name}`),
      });
    }
  }
  if (targetEngine !== "aurora-postgresql") {
    for (const sequence of project.sequences) {
      attention.push({
        kind: "sequence",
        name: `${sequence.schema}.${sequence.name}`,
        file: sequence.file,
        line: sequence.line,
        status: "manual",
        reason: SEQUENCE_CONVERSION,
      });
    }
  }
  for (const proc of project.procedural) {
    attention.push({
      kind: proc.kind,
      name: `${proc.schema}.${proc.name}`,
      file: proc.file,
      line: proc.line,
      status: "manual",
      reason: `${proc.complexity} complexity${proc.features.length > 0 ? `: ${proc.features.join(", ")}` : ""}`,
    });
  }
  attention.sort(compareAttention);

  // --- Object coverage -----------------------------------------------------------
  const objectCoverage: DatabaseAssessment["objectCoverage"] = [];
  const tablesAutomatic = tableRows.filter((row) => row.status === "automatic").length;
  const tablesPartial = tableRows.filter((row) => row.status === "partial").length;
  const tablesManual = tableRows.filter((row) => row.status === "manual").length;
  const presentKinds = OBJECT_KIND_ORDER.filter((kind) => {
    if (kind === "table") return project.tables.length > 0;
    if (kind === "view") return project.views.length > 0;
    if (kind === "index") return project.indexes.length > 0;
    if (kind === "sequence") return project.sequences.length > 0;
    return project.procedural.some((proc) => proc.kind === kind);
  });
  for (const kind of presentKinds) {
    let automatic = 0;
    let partial = 0;
    let manual = 0;
    let conversion: string;
    if (kind === "table") {
      automatic = tablesAutomatic;
      partial = tablesPartial;
      manual = tablesManual;
      conversion = TABLE_CONVERSIONS[workloadClass];
    } else if (kind === "view") {
      for (const { rewrite } of viewData) {
        if (rewrite.status === "automatic") automatic++;
        else if (rewrite.status === "partial") partial++;
        else manual++;
      }
      conversion = homogeneous ? "Copied unchanged" : "Rule-based SQL rewrite; review required";
    } else if (kind === "index") {
      if (workloadClass === "database") {
        for (const index of project.indexes) {
          if (index.bitmap || index.expression) partial++;
          else automatic++;
        }
        conversion = "CREATE INDEX after the full load";
      } else {
        partial = project.indexes.length;
        conversion = INDEX_NOT_CREATED_CONVERSION;
      }
    } else if (kind === "sequence") {
      automatic = targetEngine === "aurora-postgresql" ? project.sequences.length : 0;
      manual = targetEngine === "aurora-postgresql" ? 0 : project.sequences.length;
      conversion = targetEngine === "aurora-postgresql" ? "CREATE SEQUENCE" : SEQUENCE_CONVERSION;
    } else {
      manual = project.procedural.filter((proc) => proc.kind === kind).length;
      conversion = "Inventoried for manual conversion.";
    }
    objectCoverage.push({
      kind,
      count: automatic + partial + manual,
      automatic,
      partial,
      manual,
      conversion,
    });
  }

  // --- Movement summary ------------------------------------------------------------
  let method: DatabaseAssessment["movement"]["method"];
  let summary: string;
  if (workloadClass === "database") {
    method = "dms-serverless";
    summary = `AWS DMS Serverless full load and CDC of ${movedTableCount} tables from ${ENGINE_LABELS[engine]} to ${TARGET_LABELS[targetEngine]}.`;
  } else if (workloadClass === "warehouse") {
    method = "s3-copy";
    summary = `Export ${movedTableCount} tables to S3 with the generated ${engine === "teradata" ? "Teradata TPT" : "Netezza external table"} scripts, then load them into Redshift Serverless with COPY.`;
  } else {
    method = "datasync-athena";
    summary = `Copy ${movedTableCount} HDFS table locations to S3 with AWS DataSync, register raw tables in the Glue Data Catalog and load Apache Iceberg tables with Athena.`;
    if (s3TableCount > 0) {
      summary += ` ${s3TableCount} tables already on S3 are read in place.`;
    }
  }

  // --- Risks ---------------------------------------------------------------------------
  const risks: Risk[] = [];
  for (const warning of project.warnings) {
    risks.push({ severity: "warning", code: "project_warning", message: warning });
  }
  if (project.engineDetection === "detected") {
    risks.push({
      severity: "info",
      code: "engine_detected",
      message: `Source engine detected as ${ENGINE_LABELS[engine]}; pass source_engine to override.`,
    });
  }
  if (project.schemaFallbackUsed) {
    risks.push({
      severity: "warning",
      code: "schema_fallback",
      message: `Unqualified objects were assigned to schema ${FALLBACK_SCHEMAS[engine]}; pass default_schema if they belong to another schema.`,
    });
  }
  for (const entry of project.unparsed) {
    risks.push({
      severity: "warning",
      code: "unparsed_statement",
      message: `Statement at ${entry.file}:${entry.line} could not be parsed: ${entry.snippet}`,
    });
  }
  for (const { table, column } of manualColumns) {
    const mapped = mapColumnType(engine, column);
    risks.push({
      severity: "warning",
      code: "manual_type",
      message: `Column ${table.schema}.${table.name}.${column.name} (${column.sourceType}): ${mapped.caveat ?? ""}`,
    });
  }
  for (const { table, column } of partialColumns) {
    const mapped = mapColumnType(engine, column);
    risks.push({
      severity: "info",
      code: "partial_type",
      message: `Column ${table.schema}.${table.name}.${column.name} (${column.sourceType}): ${mapped.caveat ?? ""}`,
    });
  }
  for (const { table, column } of untranslatedDefaults) {
    risks.push({
      severity: "info",
      code: "untranslated_default",
      message: `Default expression ${column.defaultExpression} on ${table.schema}.${table.name}.${column.name} was not translated.`,
    });
  }
  for (const { view, rewrite } of viewData) {
    if (rewrite.status === "manual") {
      risks.push({
        severity: "warning",
        code: "manual_view",
        message: `View ${view.schema}.${view.name} uses ${rewrite.manualFeatures.join(", ")}; rewrite it manually.`,
      });
    } else if (rewrite.status === "partial") {
      risks.push({
        severity: "info",
        code: "partial_view",
        message: `View ${view.schema}.${view.name} was rewritten with rules (${rewrite.applied.join(", ") || "no changes"}); review the SQL.`,
      });
    }
  }
  for (const proc of project.procedural) {
    risks.push({
      severity: "warning",
      code: "procedural_object",
      message: `${PROCEDURAL_LABELS[proc.kind]} ${proc.schema}.${proc.name} (${proc.complexity} complexity${proc.features.length > 0 ? `: ${proc.features.join(", ")}` : ""}) needs manual conversion.`,
    });
  }
  if (workloadClass === "database") {
    for (const row of tableRows) {
      if (!row.primaryKey) {
        risks.push({
          severity: "warning",
          code: "no_primary_key",
          message: `Table ${row.schema}.${row.name} has no primary key; DMS CDC cannot apply updates and deletes to it.`,
        });
      }
    }
    let lobCount = 0;
    for (const table of project.tables) {
      for (const column of table.columns) {
        const parts = parseSourceType(column.sourceType);
        if (engine === "oracle") {
          if (ORACLE_LOB_BASES.has(parts.base)) lobCount++;
        } else if (
          engine === "sqlserver" &&
          SQLSERVER_LOB_BASES.has(parts.base) &&
          (parts.base === "VARCHAR" || parts.base === "NVARCHAR" || parts.base === "VARBINARY"
            ? parts.params[0]?.toUpperCase() === "MAX"
            : true)
        ) {
          lobCount++;
        }
      }
    }
    if (lobCount > 0) {
      risks.push({
        severity: "info",
        code: "lob_columns",
        message: `${lobCount} columns hold LOBs; DMS limited LOB mode truncates values over 32 KB. Raise LobMaxSize in dms/replication-settings.json or switch to full LOB mode.`,
      });
    }
    if (engine === "oracle" || engine === "sqlserver") {
      for (const table of project.tables) {
        if (table.partitioning !== undefined) {
          risks.push({
            severity: "info",
            code: "partitioned_table",
            message: `Table ${table.schema}.${table.name} is partitioned in the source (${table.partitioning}); recreate partitions with PostgreSQL declarative partitioning.`,
          });
        }
      }
    }
  }
  if (engine === "mysql") {
    for (const table of project.tables) {
      if (table.mysqlEngine !== undefined && table.mysqlEngine.toLowerCase() !== "innodb") {
        risks.push({
          severity: "info",
          code: "myisam_engine",
          message: `Table ${table.schema}.${table.name} uses ENGINE=${table.mysqlEngine}; the generated DDL switches it to InnoDB because Aurora MySQL stores persistent tables in InnoDB.`,
        });
      }
    }
  }
  if (targetEngine === "aurora-postgresql") {
    for (const extension of project.extensions) {
      risks.push({
        severity: "info",
        code: "extension_required",
        message: `Extension ${extension} must be available in Aurora PostgreSQL.`,
      });
    }
    if (project.sequences.length > 0) {
      risks.push({
        severity: "info",
        code: "sequence_reset",
        message:
          "Reset sequence values after the final sync; DMS does not migrate sequence positions.",
      });
    }
  }
  if (workloadClass === "warehouse") {
    for (const table of project.tables) {
      if (table.setTable) {
        risks.push({
          severity: "info",
          code: "set_table",
          message: `Table ${table.schema}.${table.name} is a SET table; Redshift does not reject duplicate rows.`,
        });
      }
      if (table.distribution?.kind === "key" && table.distribution.columns.length > 1) {
        risks.push({
          severity: "info",
          code: "distribution_review",
          message: `Table ${table.schema}.${table.name} distributes on (${table.distribution.columns.join(", ")}); the Redshift table uses DISTSTYLE AUTO.`,
        });
      }
    }
  }
  if (workloadClass === "warehouse" || workloadClass === "lake") {
    for (const index of project.indexes) {
      risks.push({
        severity: "info",
        code: "index_not_created",
        message: INDEX_NOT_CREATED_MESSAGE.replace("<i>", `${index.schema}.${index.name}`),
      });
    }
  }
  for (const { table, decision } of tableData) {
    if (decision.movement === "manual" && decision.reason) {
      risks.push({
        severity: "warning",
        code: "movement_manual",
        message: `Table ${table.schema}.${table.name}: ${decision.reason}`,
      });
    }
    if (decision.movement === "s3" && decision.location) {
      risks.push({
        severity: "info",
        code: "external_s3_location",
        message: `Table ${table.schema}.${table.name} stays at ${decision.location}; the SQL apply job role is granted read access to that bucket.`,
      });
    }
  }
  for (const name of project.temporaryTables) {
    risks.push({
      severity: "info",
      code: "temporary_table",
      message: `Temporary table ${name} is not migrated.`,
    });
  }
  if (engine === "hive") {
    for (const table of project.tables) {
      if (/\$\{[^}]+\}/.test(table.sql)) {
        risks.push({
          severity: "warning",
          code: "variable_substitution",
          message: `Table ${table.schema}.${table.name} uses Hive variable substitution; resolve \${…} values before running the generated SQL.`,
        });
      }
    }
  }
  sortRisks(risks);

  // --- Readiness -------------------------------------------------------------------------
  const proceduralPenalty = project.procedural.reduce(
    (sum, proc) => sum + (proc.complexity === "high" ? 6 : proc.complexity === "medium" ? 3 : 1),
    0,
  );
  const noPrimaryKeyCount =
    workloadClass === "database" ? tableRows.filter((row) => !row.primaryKey).length : 0;
  const errorRiskCount = risks.filter((risk) => risk.severity === "error").length;
  const penalty =
    Math.min(40, proceduralPenalty) +
    Math.min(30, manualColumns.length * 4) +
    Math.min(10, partialColumns.length * 0.5) +
    Math.min(15, viewData.filter((entry) => entry.rewrite.status === "manual").length * 3) +
    Math.min(10, viewData.filter((entry) => entry.rewrite.status === "partial").length) +
    Math.min(10, noPrimaryKeyCount) +
    Math.min(20, manualMovementCount * 4) +
    Math.min(10, project.unparsed.length * 2) +
    errorRiskCount * 15;
  const score = Math.max(0, Math.min(100, 100 - Math.round(penalty)));
  const blockers: string[] = [];
  if (project.procedural.length > 0) {
    blockers.push(
      project.procedural.length === 1
        ? "1 procedural object needs manual conversion."
        : `${project.procedural.length} procedural objects need manual conversion.`,
    );
  }
  if (manualColumns.length > 0) {
    blockers.push(
      manualColumns.length === 1
        ? "1 column uses a type with no automatic mapping."
        : `${manualColumns.length} columns use types with no automatic mapping.`,
    );
  }
  if (manualMovementCount > 0) {
    blockers.push(
      manualMovementCount === 1
        ? "1 table cannot be moved automatically."
        : `${manualMovementCount} tables cannot be moved automatically.`,
    );
  }
  const level =
    errorRiskCount > 0 || score < 45
      ? "blocked"
      : score >= 85 && blockers.length === 0
        ? "ready"
        : "review";
  const summaryText =
    level === "ready"
      ? "The schema maps cleanly. Review the generated DDL, endpoints and secrets, then deploy."
      : level === "review"
        ? "The bundle is deployable after reviewing the flagged types, views and objects."
        : "The migration needs manual conversion work before it can run in AWS.";

  // --- Questions ---------------------------------------------------------------------------
  const questions: string[] = [];
  if (project.engineDetection === "detected") {
    questions.push(
      `The files were detected as ${ENGINE_LABELS[engine]} DDL. Is that right? Pass source_engine if not.`,
    );
  }
  if (project.schemaFallbackUsed) {
    questions.push(
      `Which source schema owns the unqualified objects? They were assigned to "${FALLBACK_SCHEMAS[engine]}"; pass default_schema to change it.`,
    );
  }
  if (project.procedural.length > 0) {
    questions.push(
      `Who will convert the ${pluralize(project.procedural.length, "procedural object")}? AWS DMS Schema Conversion can produce a first draft.`,
    );
  }
  if (workloadClass === "database") {
    questions.push(
      "Which host, port and database name should the DMS source endpoint use? The generated secret holds placeholders.",
    );
    const noKey = tableRows.filter((row) => !row.primaryKey).length;
    if (noKey > 0) {
      questions.push(
        `Should the ${pluralize(noKey, "table")} without a primary key use full load only? DMS CDC needs a primary or unique key to apply updates and deletes.`,
      );
    }
  }
  if (workloadClass === "warehouse") {
    questions.push(
      `Which host will run the generated ${engine === "teradata" ? "Teradata TPT" : "Netezza"} export script, and can it upload to the S3 staging bucket?`,
    );
  }
  if (workloadClass === "lake") {
    questions.push(
      "Which DataSync agent can reach the HDFS NameNode, and what is the NameNode host?",
    );
    if (tableData.some((entry) => entry.decision.reason?.startsWith("Hive ACID table"))) {
      questions.push("Can the Hive ACID tables be major-compacted and exported before the move?");
    }
  }
  if (project.unparsed.length > 0) {
    questions.push(
      `Can you review the ${pluralize(project.unparsed.length, "statement")} that could not be parsed? They are listed under risks.`,
    );
  }
  questions.splice(8);

  const proceduralRows = project.procedural
    .map((proc) => ({
      schema: proc.schema,
      name: proc.name,
      kind: proc.kind,
      file: proc.file,
      line: proc.line,
      lines: proc.lines,
      complexity: proc.complexity,
      features: proc.features,
    }))
    .sort((a, b) => sourceOrder(a, b));

  return {
    workload: "database",
    projectName,
    sourceEngine: engine,
    engineDetection: project.engineDetection,
    targetEngine,
    workloadClass,
    totals: {
      files: project.files.length,
      schemas: project.schemas.length,
      tables: project.tables.length,
      columns: columnCount,
      views: project.views.length,
      indexes: project.indexes.length,
      sequences: project.sequences.length,
      procedural: project.procedural.length,
      temporaryTables: project.temporaryTables.length,
      unparsed: project.unparsed.length,
      warnings: project.warnings.length,
      automaticColumns: automaticColumns.length,
      partialColumns: partialColumns.length,
      manualColumns: manualColumns.length,
    },
    files: project.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      statements: file.statements,
    })),
    typeCoverage,
    objectCoverage,
    attention,
    procedural: proceduralRows,
    tables: tableRows,
    movement: { method, summary, tables: movedTableCount, manualTables: manualMovementCount },
    risks,
    questions,
    readiness: { score, level, summary: summaryText, blockers },
    truncated: { tables: false, procedural: false, attention: false },
  };
}

const MAX_TABLES = 300;
const MAX_PROCEDURAL = 200;
const MAX_ATTENTION = 200;

/** Trims the long lists for tool responses; report and bundle use the full lists. */
export function truncateDatabaseAssessment(a: DatabaseAssessment): DatabaseAssessment {
  const tables = a.tables.slice(0, MAX_TABLES);
  const procedural = a.procedural.slice(0, MAX_PROCEDURAL);
  const attention = [...a.attention].sort(compareAttention).slice(0, MAX_ATTENTION);
  return {
    ...a,
    tables,
    procedural,
    attention,
    truncated: {
      tables: a.tables.length > MAX_TABLES,
      procedural: a.procedural.length > MAX_PROCEDURAL,
      attention: a.attention.length > MAX_ATTENTION,
    },
  };
}
