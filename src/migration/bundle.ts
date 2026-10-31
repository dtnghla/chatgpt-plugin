import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { generateCloudFormation } from "../convert/cloudformation.js";
import { generateGlueScript } from "../convert/glue.js";
import {
  buildBundleReadme,
  buildMigrationReport,
  bundleNextSteps,
  type ReportContext,
  type ReportFile,
} from "../convert/report.js";
import { generateSqlRunner, sqlEntries } from "../convert/sql-runner.js";
import { buildStateMachine } from "../convert/state-machine.js";
import type { Job, PentahoProject, Transformation } from "../pentaho/types.js";
import { assessProject, slugify } from "./assessment.js";
import { buildFlows } from "./flow.js";
import type {
  BundleFile,
  BundleSummary,
  GeneratedBundleOptions,
  GlueJobArtifact,
  MigrationBundle,
  ScheduleSummary,
  SqlRunnerArtifact,
  StateMachineArtifact,
} from "./types.js";

const DATA_BUCKET = "${DataBucket}";
const FIXED_MTIME = Date.UTC(2000, 0, 1, 12, 0, 0);

function sha256(data: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

function uniqueName(project: string, value: string, used: Set<string>, max: number): string {
  const base = `${project}-${slugify(value, "item")}`.slice(0, max).replace(/-+$/g, "");
  let candidate = base || project;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, max - suffix.length)}${suffix}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeMapping(value: string): string {
  return normalizeSlashes(value.trim()).replace(/\/+$/g, "");
}

function unmappedKey(path: string): string {
  const withoutDrive = normalizeSlashes(path).replace(/^[A-Za-z]:/, "");
  const cleaned = withoutDrive
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .map((segment) =>
      segment
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 120),
    )
    .filter((segment) => segment !== "");
  return cleaned.length > 0 ? `unmapped/${cleaned.join("/")}` : "unmapped/file";
}

export function createPathMapper(
  mappings: { from: string; to: string }[],
  bucketPlaceholder = DATA_BUCKET,
): (pdiPath: string) => string {
  const normalized = mappings
    .map((mapping) => ({ from: normalizeMapping(mapping.from), to: normalizeMapping(mapping.to) }))
    .filter((mapping) => mapping.from !== "" && mapping.to.startsWith("s3://"))
    .sort((a, b) => b.from.length - a.from.length);
  return (pdiPath: string): string => {
    const path = normalizeSlashes(pdiPath.trim());
    if (/^s3:\/\//i.test(path)) return path;
    const lower = path.toLowerCase();
    for (const mapping of normalized) {
      const from = mapping.from;
      const fromLower = from.toLowerCase();
      if (lower === fromLower) return mapping.to;
      if (lower.startsWith(`${fromLower}/`)) {
        const rest = path.slice(from.length).replace(/^\/+/, "");
        return rest ? `${mapping.to}/${rest}` : mapping.to;
      }
    }
    return `s3://${bucketPlaceholder}/${unmappedKey(path)}`;
  };
}

function fileKey(file: string, name: string): string {
  return `${file}\u0000${name}`;
}

function kindForPath(path: string): BundleFile["kind"] {
  if (path.endsWith(".py")) return "python";
  if (path.startsWith("stepfunctions/")) return "asl";
  if (path.startsWith("cloudformation/") || path.endsWith(".yaml")) return "cloudformation";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  return "text";
}

function findTransformation(
  job: Job,
  project: PentahoProject,
  entryName: string,
): Transformation | undefined {
  const entry = job.entries.find((candidate) => candidate.name === entryName);
  if (!entry) return undefined;
  const candidates = new Set<string>([entry.name.toLowerCase()]);
  const rawName =
    typeof entry.raw.transname === "string"
      ? entry.raw.transname
      : typeof entry.raw.filename === "string"
        ? entry.raw.filename
        : undefined;
  if (rawName) {
    candidates.add(rawName.toLowerCase());
    const base = rawName.replaceAll("\\", "/").split("/").pop() ?? "";
    candidates.add(base.replace(/\.ktr$/i, "").toLowerCase());
  }
  return project.transformations.find(
    (transformation) =>
      candidates.has(transformation.name.toLowerCase()) ||
      candidates.has(
        (transformation.file.replaceAll("\\", "/").split("/").pop() ?? "")
          .replace(/\.ktr$/i, "")
          .toLowerCase(),
      ),
  );
}

function scheduleKey(job: string, entry: string): string[] {
  return [`${job}:${entry}`, `${job}/${entry}`, entry];
}

export function buildMigrationBundle(
  project: PentahoProject,
  options: GeneratedBundleOptions,
): MigrationBundle {
  const assessment = assessProject(project, {
    projectName: options.projectName,
    pathMappings: options.pathMappings,
  });
  const projectName = assessment.projectName;
  const scriptPrefix = options.scriptPrefix.trim().replace(/^\/+|\/+$/g, "") || "glue/scripts";
  const warnings: string[] = [...project.warnings];
  const fileText = new Map<string, string>();

  const addFile = (path: string, content: string) => {
    fileText.set(path, content.endsWith("\n") ? content : `${content}\n`);
  };

  const transformationNames = new Map<string, string>();
  const usedTransformationNames = new Set<string>();
  for (const transformation of project.transformations) {
    transformationNames.set(
      fileKey(transformation.file, transformation.name),
      uniqueName(projectName, transformation.name, usedTransformationNames, 80),
    );
  }

  const stateMachineNames = new Map<string, string>();
  const usedStateMachineNames = new Set<string>();
  for (const job of project.jobs) {
    stateMachineNames.set(
      fileKey(job.file, job.name),
      uniqueName(projectName, job.name, usedStateMachineNames, 80),
    );
  }

  const pathMapper = createPathMapper(options.pathMappings);
  const glueJobs: GlueJobArtifact[] = [];
  const glueTemplates = [];

  for (const transformation of project.transformations) {
    const glueJobName = transformationNames.get(fileKey(transformation.file, transformation.name));
    if (!glueJobName) continue;
    const script = generateGlueScript(transformation, {
      stepOverrides: options.stepOverrides,
      pathMappings: options.pathMappings,
    });
    const scriptPath = `${scriptPrefix}/${glueJobName}.py`;
    addFile(scriptPath, script.code);
    const artifactWarnings = script.warnings.map((warning) => `${transformation.name}: ${warning}`);
    warnings.push(...artifactWarnings);
    glueJobs.push({
      transformation: transformation.name,
      sourceFile: transformation.file,
      glueJobName,
      scriptPath,
      kind: "transformation",
      automaticSteps: script.automaticSteps,
      partialSteps: script.partialSteps,
      manualSteps: script.manualSteps,
      connections: script.connections,
      needsExcel: script.needsExcel,
      overriddenSteps: script.overriddenSteps,
      warnings: artifactWarnings,
    });
    glueTemplates.push({
      name: glueJobName,
      description: `Glue job generated from Pentaho transformation ${transformation.name} (${transformation.file}).`,
      scriptPath,
      connections: script.connections,
      needsExcel: script.needsExcel,
    });
  }

  const sqlJobs = project.jobs.filter((job) => sqlEntries(job).length > 0);
  let sqlRunner: SqlRunnerArtifact | undefined;
  let sqlJobName: string | undefined;
  let sqlScriptPath: string | undefined;
  if (sqlJobs.length > 0) {
    const sqlPlan = generateSqlRunner(sqlJobs, project.connections);
    sqlJobName = `${projectName}-sql-runner`.slice(0, 80);
    sqlScriptPath = `${scriptPrefix}/${sqlJobName}.py`;
    addFile(sqlScriptPath, sqlPlan.code);
    const sqlWarnings = sqlPlan.warnings.map((warning) => `SQL runner: ${warning}`);
    warnings.push(...sqlWarnings);
    sqlRunner = {
      name: sqlJobName,
      scriptPath: sqlScriptPath,
      entries: sqlPlan.entries.map((entry) => ({
        job: entry.job,
        entry: entry.entry,
        connection: entry.connection,
      })),
      connections: sqlPlan.connections,
      warnings: sqlWarnings,
    };
    glueTemplates.push({
      name: sqlJobName,
      description: "Executes the SQL job entries from the migrated Pentaho jobs.",
      scriptPath: sqlScriptPath,
      connections: sqlPlan.connections,
      needsExcel: false,
    });
  }
  const stateMachines: StateMachineArtifact[] = [];
  for (const job of project.jobs) {
    const stateMachineName = stateMachineNames.get(fileKey(job.file, job.name));
    if (!stateMachineName) continue;
    const scheduleCount = project.schedules.filter(
      (schedule) => schedule.job === job.name && schedule.file === job.file,
    ).length;
    const plan = buildStateMachine(job, project.transformations, project.jobs, {
      projectName,
      glueJobName: (transformation) =>
        transformationNames.get(fileKey(transformation.file, transformation.name)),
      nestedStateMachineName: (target) => stateMachineNames.get(fileKey(target.file, target.name)),
      sqlJobName: () => (sqlEntries(job).length > 0 ? sqlJobName : undefined),
      s3Uri: pathMapper,
      scheduleCount,
    });
    const definitionPath = `stepfunctions/${stateMachineName}.json`;
    addFile(definitionPath, plan.json);
    const machineWarnings = plan.warnings.map((warning) => `${job.name}: ${warning}`);
    warnings.push(...machineWarnings);
    stateMachines.push({
      job: job.name,
      sourceFile: job.file,
      stateMachineName,
      definitionPath,
      scheduleCount,
      entryTypes: plan.entryTypes,
      nested: plan.nested,
      usesSns: plan.usesSns,
      usesS3: plan.usesS3,
      usesSql: plan.usesSql,
      warnings: machineWarnings,
    });
  }

  const schedules: ScheduleSummary[] = assessment.schedules.map((schedule) => {
    for (const key of scheduleKey(schedule.job, schedule.entry)) {
      const override = options.scheduleOverrides[key]?.trim();
      if (override) {
        return {
          ...schedule,
          mapped: true,
          expression: override,
          note: "Schedule expression supplied by schedule_overrides; verify the time zone and rate limits.",
        };
      }
    }
    return schedule;
  });
  const cfnSchedulesSource = schedules;
  const machineNameForJob = (jobName: string, file: string): string | undefined =>
    stateMachineNames.get(fileKey(file, jobName));
  const cfnSchedules = cfnSchedulesSource.flatMap((schedule) => {
    if (!schedule.mapped || !schedule.expression) return [];
    const stateMachineName = machineNameForJob(schedule.job, schedule.file);
    if (!stateMachineName) return [];
    return [{ schedule, stateMachineName }];
  });
  const usedScheduleNames = new Set<string>();
  const scheduleTemplates = cfnSchedules.map(({ schedule, stateMachineName }) => {
    const base = `${stateMachineName}-${schedule.entry}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    let name = base || "schedule";
    let index = 2;
    while (usedScheduleNames.has(name)) {
      name = `${base || "schedule"}-${index}`.slice(0, 64);
      index += 1;
    }
    usedScheduleNames.add(name);
    return {
      name,
      expression: schedule.expression ?? "",
      stateMachineName,
    };
  });

  const usedConnectionNames = new Set([
    ...glueTemplates.flatMap((job) => job.connections),
    ...(sqlRunner?.connections ?? []),
  ]);
  const workflowConnections = assessment.connections.filter((connection) =>
    usedConnectionNames.has(connection.name),
  );
  addFile(
    "cloudformation/pentaho-migration.yaml",
    generateCloudFormation({
      projectName,
      region: "us-east-1",
      glueVersion: options.glueVersion,
      workerType: options.workerType,
      numberOfWorkers: options.numberOfWorkers,
      scriptPrefix,
      connections: workflowConnections,
      glueJobs: glueTemplates,
      stateMachines: stateMachines.map((machine) => ({
        name: machine.stateMachineName,
        definitionJson: fileText.get(machine.definitionPath) ?? "{}",
        nested: machine.nested.flatMap((reference) => {
          const target = stateMachineNames.get(fileKey(reference.targetFile, reference.targetJob));
          return target ? [{ placeholder: reference.placeholder, stateMachineName: target }] : [];
        }),
        usesGlue: machine.entryTypes.some((type) => ["TRANS", "SQL"].includes(type)),
        usesNested: machine.nested.length > 0 || machine.entryTypes.includes("JOB"),
        usesSns: machine.usesSns,
        usesS3: machine.usesS3,
        usesSql: machine.usesSql,
      })),
      schedules: scheduleTemplates,
    }),
  );

  const flows = buildFlows(project);
  const sortedWarnings = [...new Set(warnings)].sort();
  const reportFiles: ReportFile[] = [...fileText.keys()].map((path) => ({
    path,
    kind: kindForPath(path),
    bytes: new TextEncoder().encode(fileText.get(path) ?? "").byteLength,
  }));
  const reportContext: ReportContext = {
    projectName,
    generatedWith: options.generatedWith,
    assessment,
    jobs: glueJobs,
    stateMachines,
    connections: assessment.connections,
    schedules,
    files: [
      ...reportFiles,
      { path: "migration-report.md", kind: "markdown" },
      { path: "README.md", kind: "markdown" },
      { path: "manifest.json", kind: "json" },
    ],
    sqlRunner: sqlRunner
      ? {
          name: sqlRunner.name,
          scriptPath: sqlRunner.scriptPath,
          entries: sqlRunner.entries.length,
          warnings: sqlRunner.warnings,
        }
      : undefined,
    warnings: sortedWarnings,
  };
  const report = buildMigrationReport(reportContext);
  addFile("migration-report.md", report);
  const readme = buildBundleReadme(reportContext, scriptPrefix);
  addFile("README.md", readme);
  const nextSteps = bundleNextSteps(reportContext);

  const manifestFiles = [...fileText.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({
      path,
      bytes: new TextEncoder().encode(content).byteLength,
      sha256: sha256(content),
    }));
  const manifest = {
    bundle_format: 1,
    generator: options.generatedWith,
    project: projectName,
    glue_version: options.glueVersion,
    worker_type: options.workerType,
    number_of_workers: options.numberOfWorkers,
    source_files: assessment.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    files: manifestFiles,
    warnings: sortedWarnings,
  };
  addFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const paths = [...fileText.keys()].sort();
  const encoder = new TextEncoder();
  const zipEntries: Record<string, Uint8Array> = {};
  const files: BundleFile[] = paths.map((path) => {
    const content = fileText.get(path) ?? "";
    const bytes = encoder.encode(content);
    zipEntries[path] = bytes;
    return {
      path,
      bytes: bytes.byteLength,
      sha256: sha256(content),
      kind: kindForPath(path),
    };
  });
  const zip = zipSync(zipEntries, { level: 6, mtime: FIXED_MTIME });
  const id = sha256(zip).slice(0, 16);
  const contents: Record<string, string> = {};
  for (const path of paths) contents[path] = fileText.get(path) ?? "";

  return {
    id,
    projectName,
    zip,
    files,
    contents,
    assessment,
    jobs: glueJobs,
    stateMachines,
    sqlRunner,
    connections: assessment.connections,
    schedules,
    flows,
    warnings: sortedWarnings,
    nextSteps,
    createdAt: Date.now(),
  };
}

export interface DownloadLink {
  url: string;
  expiresAt: string;
}

export function summarizeBundle(bundle: MigrationBundle, download?: DownloadLink): BundleSummary {
  return {
    bundle_id: bundle.id,
    project_name: bundle.projectName,
    download_url: download?.url,
    download_expires_at: download?.expiresAt,
    generated_with: "pentaho-to-aws 1.0.0",
    totals: bundle.assessment.totals,
    readiness: bundle.assessment.readiness,
    files: bundle.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.kind,
    })),
    jobs: bundle.jobs.map((job) => ({
      transformation: job.transformation,
      source_file: job.sourceFile,
      glue_job_name: job.glueJobName,
      script_path: job.scriptPath,
      kind: job.kind,
      automatic_steps: job.automaticSteps,
      partial_steps: job.partialSteps,
      manual_steps: job.manualSteps,
      warnings: job.warnings,
    })),
    state_machines: bundle.stateMachines.map((machine) => ({
      job: machine.job,
      source_file: machine.sourceFile,
      state_machine_name: machine.stateMachineName,
      definition_path: machine.definitionPath,
      schedule_count: machine.scheduleCount,
      warnings: machine.warnings,
    })),
    sql_runner: bundle.sqlRunner
      ? {
          name: bundle.sqlRunner.name,
          script_path: bundle.sqlRunner.scriptPath,
          entries: bundle.sqlRunner.entries.length,
          warnings: bundle.sqlRunner.warnings,
        }
      : undefined,
    connections: bundle.connections.map((connection) => ({
      name: connection.name,
      type: connection.type,
      jdbc_url: connection.jdbcUrl,
      driver: connection.driver,
      secret_name: connection.secretName,
      has_password: connection.hasPassword,
    })),
    schedules: bundle.schedules.map((schedule) => ({
      job: schedule.job,
      entry: schedule.entry,
      expression: schedule.expression,
      description: schedule.description,
      mapped: schedule.mapped,
      note: schedule.note,
    })),
    warnings: bundle.warnings,
    next_steps: bundle.nextSteps,
    assessment: bundle.assessment,
    flows: bundle.flows,
  };
}

export function glueJobNameForTransformation(
  projectName: string,
  transformation: Transformation,
): string {
  return `${projectName}-${slugify(transformation.name)}`.slice(0, 80);
}

export { findTransformation };
