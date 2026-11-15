import type { ArtifactBundle } from "../artifacts/store.js";
import type { DownloadLink } from "../migration/bundle.js";
import { packageFiles, sha256 } from "../migration/package.js";
import type { BundleFile } from "../migration/types.js";
import {
  assessDatabaseProject,
  decideTableMovement,
  truncateDatabaseAssessment,
} from "./assessment.js";
import { generateDatabaseCloudFormation } from "./cloudformation.js";
import { generateTargetDdl } from "./ddl.js";
import {
  buildDmsReplicationSettings,
  buildDmsTableMappings,
  buildLakeApplyPlan,
  buildWarehouseApplyPlan,
  generateNetezzaExport,
  generateTeradataExport,
} from "./movement.js";
import { buildDatabaseReadme, buildDatabaseReport, databaseNextSteps } from "./report.js";
import { sqlApplyScript } from "./runner.js";
import { lakeStateMachineDefinition, warehouseStateMachineDefinition } from "./state-machine.js";
import type {
  DatabaseAssessment,
  DatabaseProject,
  SourceEngine,
  TargetEngine,
  WorkloadClass,
} from "./types.js";

export interface DatabaseBundleOptions {
  projectName: string;
  replicationType: "full-load" | "full-load-and-cdc";
  dmsMaxCapacityUnits: number;
  generatedWith: string;
}

export interface BundleArtifact {
  kind: "target-ddl" | "dms" | "export" | "load" | "runner" | "state-machine" | "cloudformation";
  path: string;
  description: string;
}

export interface DatabaseBundle extends ArtifactBundle {
  generatedWith: string;
  assessment: DatabaseAssessment;
  artifacts: BundleArtifact[];
  secrets: { name: string; purpose: string }[];
  stateMachines: { name: string; definitionPath: string; purpose: string }[];
  warnings: string[];
  nextSteps: string[];
  createdAt: number;
}

export interface DatabaseBundleSummary {
  workload: "database";
  bundle_id: string;
  project_name: string;
  download_url?: string;
  download_expires_at?: string;
  generated_with: string;
  source_engine: SourceEngine;
  target_engine: TargetEngine;
  workload_class: WorkloadClass;
  readiness: DatabaseAssessment["readiness"];
  totals: DatabaseAssessment["totals"];
  files: { path: string; bytes: number; sha256: string; kind: BundleFile["kind"] }[];
  artifacts: BundleArtifact[];
  secrets: { name: string; purpose: string }[];
  state_machines: { name: string; definition_path: string; purpose: string }[];
  warnings: string[];
  next_steps: string[];
  assessment: DatabaseAssessment;
}

function artifactKind(path: string): BundleArtifact["kind"] {
  if (path.startsWith("sql/target/")) return "target-ddl";
  if (path.startsWith("dms/")) return "dms";
  if (path.startsWith("export/")) return "export";
  if (path.startsWith("sql/load/")) return "load";
  if (path.startsWith("glue/scripts/")) return "runner";
  if (path.startsWith("stepfunctions/")) return "state-machine";
  return "cloudformation";
}

const ARTIFACT_DESCRIPTIONS: { match: RegExp; description: string }[] = [
  { match: /^sql\/target\/01-schemas\.sql$/, description: "Target schemas" },
  { match: /^sql\/target\/02-tables\.sql$/, description: "Tables and sequences" },
  { match: /^sql\/target\/03-views\.sql$/, description: "Rewritten views" },
  {
    match: /^sql\/target\/04-constraints-indexes\.sql$/,
    description: "Foreign keys, indexes and identity resets",
  },
  { match: /^sql\/target\/01-databases\.sql$/, description: "Target databases" },
  { match: /^sql\/target\/02-raw-tables\.sql$/, description: "Raw tables over the copied files" },
  { match: /^sql\/target\/03-iceberg-tables\.sql$/, description: "Apache Iceberg tables" },
  { match: /^sql\/target\/04-views-/, description: "Rewritten views" },
  {
    match: /^dms\/table-mappings\.json$/,
    description: "DMS table selection and transformation rules",
  },
  { match: /^dms\/replication-settings\.json$/, description: "DMS replication settings" },
  { match: /^sql\/load\/copy\.sql$/, description: "Redshift COPY statements" },
  { match: /^sql\/load\/load\.sql$/, description: "Partition repair and Iceberg inserts" },
  { match: /^export\/teradata-export\.tpt$/, description: "Teradata TPT export job template" },
  { match: /^export\/export-teradata\.sh$/, description: "Teradata TPT export shell script" },
  { match: /^export\/export-netezza\.sql$/, description: "Netezza external table export" },
  { match: /^export\/export-netezza\.sh$/, description: "Netezza export shell script" },
  { match: /^sql\/apply-plan\.json$/, description: "SQL phases applied by the Glue job" },
  {
    match: /^glue\/scripts\//,
    description: "Glue Python shell job that applies the SQL phases",
  },
  {
    match: /^stepfunctions\//,
    description: "Step Functions definition that orchestrates the load",
  },
  {
    match: /^cloudformation\//,
    description: "CloudFormation template for the migration resources",
  },
];

function artifactDescription(path: string): string {
  for (const entry of ARTIFACT_DESCRIPTIONS) {
    if (entry.match.test(path)) return entry.description;
  }
  return "Generated artifact";
}

export function buildDatabaseBundle(
  project: DatabaseProject,
  options: DatabaseBundleOptions,
): DatabaseBundle {
  const assessment = assessDatabaseProject(project, { projectName: options.projectName });
  const projectName = assessment.projectName;
  const workloadClass = assessment.workloadClass;
  const warnings: string[] = [...project.warnings];
  const fileText = new Map<string, string>();
  const addFile = (path: string, content: string) => {
    fileText.set(path, content.endsWith("\n") ? content : `${content}\n`);
  };

  // 1. Target DDL and load SQL.
  const ddl = generateTargetDdl(project);
  for (const [path, content] of ddl.files) addFile(path, content);
  warnings.push(...ddl.warnings);

  // 2. Workload-class specific artifacts.
  const stateMachines: DatabaseBundle["stateMachines"] = [];
  let tableMappings: Record<string, unknown> | undefined;
  let replicationSettings: Record<string, unknown> | undefined;
  if (workloadClass === "database") {
    tableMappings = buildDmsTableMappings(project);
    replicationSettings = buildDmsReplicationSettings();
    addFile("dms/table-mappings.json", `${JSON.stringify(tableMappings, null, 2)}\n`);
    addFile("dms/replication-settings.json", `${JSON.stringify(replicationSettings, null, 2)}\n`);
  } else if (workloadClass === "warehouse") {
    const exportFiles =
      project.engine === "teradata"
        ? generateTeradataExport(project)
        : generateNetezzaExport(project);
    for (const [path, content] of exportFiles) addFile(path, content);
    addFile("sql/apply-plan.json", `${JSON.stringify(buildWarehouseApplyPlan(), null, 2)}\n`);
    addFile(`glue/scripts/${projectName}-sql-apply.py`, sqlApplyScript());
    const definition = warehouseStateMachineDefinition(projectName);
    const definitionPath = `stepfunctions/${projectName}-warehouse-load.json`;
    addFile(definitionPath, definition);
    stateMachines.push({
      name: `${projectName}-warehouse-load`,
      definitionPath,
      purpose: "Applies the schema and loads Redshift",
    });
  } else {
    const viewFiles = [...ddl.files.keys()]
      .filter((path) => /^sql\/target\/04-views-/.test(path))
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({
        path,
        database: path.slice("sql/target/04-views-".length, -".sql".length),
      }));
    addFile("sql/apply-plan.json", `${JSON.stringify(buildLakeApplyPlan(viewFiles), null, 2)}\n`);
    addFile(`glue/scripts/${projectName}-sql-apply.py`, sqlApplyScript());
    const hasDataSync = assessment.tables.some((row) => row.movement === "datasync");
    const definition = lakeStateMachineDefinition(projectName, hasDataSync);
    const definitionPath = `stepfunctions/${projectName}-lake-load.json`;
    addFile(definitionPath, definition);
    stateMachines.push({
      name: `${projectName}-lake-load`,
      definitionPath,
      purpose: "Copies HDFS data and loads Apache Iceberg tables",
    });
  }

  // 3. CloudFormation template.
  const datasyncTables = project.tables.filter(
    (table) => decideTableMovement(project, table).movement === "datasync",
  );
  addFile(
    "cloudformation/data-modernization.yaml",
    generateDatabaseCloudFormation({
      projectName,
      engine: project.engine,
      targetEngine: assessment.targetEngine,
      workloadClass,
      replicationType: options.replicationType,
      dmsMaxCapacityUnits: options.dmsMaxCapacityUnits,
      tableMappings,
      replicationSettings,
      ...(datasyncTables.length > 0
        ? {
            datasyncRoot: ddl.datasync?.root ?? "/",
            datasyncIncludeFilter: ddl.datasync?.includeFilter,
          }
        : {}),
      ...(workloadClass === "warehouse"
        ? {
            warehouseDefinition:
              fileText.get(`stepfunctions/${projectName}-warehouse-load.json`) ?? "{}",
          }
        : {}),
      ...(workloadClass === "lake"
        ? { lakeDefinition: fileText.get(`stepfunctions/${projectName}-lake-load.json`) ?? "{}" }
        : {}),
      externalS3Buckets: ddl.externalS3Buckets,
    }),
  );

  // 4. Artifacts list.
  const artifacts: BundleArtifact[] = [...fileText.keys()]
    .filter(
      (path) => path !== "README.md" && path !== "migration-report.md" && path !== "manifest.json",
    )
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      kind: artifactKind(path),
      path,
      description: artifactDescription(path),
    }));

  const secrets: DatabaseBundle["secrets"] =
    workloadClass === "database"
      ? [
          {
            name: `${projectName}/source-database`,
            purpose: "DMS source endpoint credentials (username, password, host, port)",
          },
          {
            name: `${projectName}/target-database`,
            purpose: "DMS target credentials for a database user you create in Aurora",
          },
        ]
      : [];

  const nextSteps = databaseNextSteps(assessment);

  // 5. Report, README and manifest last.
  const encoder = new TextEncoder();
  const reportFiles = [...fileText.keys()].map((path) => ({
    path,
    kind: artifactKind(path),
    bytes: encoder.encode(fileText.get(path) ?? "").byteLength,
  }));
  const reportContext = {
    projectName,
    generatedWith: options.generatedWith,
    assessment,
    artifacts,
    files: [
      ...reportFiles,
      { path: "migration-report.md", kind: "markdown" },
      { path: "README.md", kind: "markdown" },
      { path: "manifest.json", kind: "json" },
    ],
    warnings: [...new Set(warnings)].sort(),
    nextSteps,
  };
  addFile("migration-report.md", buildDatabaseReport(reportContext));
  addFile("README.md", buildDatabaseReadme(reportContext));
  const sortedWarnings = [...new Set(warnings)].sort();
  const manifestFiles = [...fileText.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({
      path,
      bytes: encoder.encode(content).byteLength,
      sha256: sha256(content),
    }));
  const manifest = {
    bundle_format: 1,
    generator: options.generatedWith,
    project: projectName,
    workload: "database",
    source_engine: project.engine,
    target_engine: assessment.targetEngine,
    source_files: project.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    files: manifestFiles,
    warnings: sortedWarnings,
  };
  addFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const { id, zip, files, contents } = packageFiles(fileText);

  return {
    id,
    projectName,
    zip,
    files,
    contents,
    generatedWith: options.generatedWith,
    assessment,
    artifacts,
    secrets,
    stateMachines,
    warnings: sortedWarnings,
    nextSteps,
    createdAt: Date.now(),
  };
}

export function summarizeDatabaseBundle(
  bundle: DatabaseBundle,
  download?: DownloadLink,
): DatabaseBundleSummary {
  return {
    workload: "database",
    bundle_id: bundle.id,
    project_name: bundle.projectName,
    ...(download ? { download_url: download.url, download_expires_at: download.expiresAt } : {}),
    generated_with: bundle.generatedWith,
    source_engine: bundle.assessment.sourceEngine,
    target_engine: bundle.assessment.targetEngine,
    workload_class: bundle.assessment.workloadClass,
    readiness: bundle.assessment.readiness,
    totals: bundle.assessment.totals,
    files: bundle.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.kind,
    })),
    artifacts: bundle.artifacts,
    secrets: bundle.secrets,
    state_machines: bundle.stateMachines.map((machine) => ({
      name: machine.name,
      definition_path: machine.definitionPath,
      purpose: machine.purpose,
    })),
    warnings: bundle.warnings,
    next_steps: bundle.nextSteps,
    assessment: truncateDatabaseAssessment(bundle.assessment),
  };
}
