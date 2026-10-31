import path from "node:path";
import { connectionSlug, driverClass, jdbcSecretName, jdbcUrl } from "../convert/jdbc.js";
import { jobEntryMapping } from "../convert/job-entry-mapping.js";
import { toEventBridgeSchedule } from "../convert/schedule.js";
import { stepMapping } from "../convert/step-mapping.js";
import type { Job, JobEntry, PentahoConnection, PentahoProject } from "../pentaho/types.js";
import type {
  ConnectionSummary,
  Dependency,
  InventoryFile,
  JobEntryCoverage,
  ParameterSummary,
  ProjectAssessment,
  Risk,
  ScheduleSummary,
  StepCoverage,
  UnsupportedStep,
} from "./types.js";

export function slugify(value: string, fallback = "pentaho-migration"): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function commonProjectDirectory(project: PentahoProject): string | undefined {
  const paths = project.files.map((file) => file.path);
  if (paths.length === 0) return undefined;
  const firstSegments = paths.map((file) => file.split("/")[0] ?? "");
  if (firstSegments.some((segment) => segment === "" || segment.includes("."))) {
    return undefined;
  }
  const first = firstSegments[0];
  return first && firstSegments.every((segment) => segment === first) ? first : undefined;
}

export function deriveProjectName(project: PentahoProject, requested?: string): string {
  if (requested?.trim()) return slugify(requested);
  const directory = commonProjectDirectory(project);
  if (directory) return slugify(directory);
  const first = project.transformations[0]?.name ?? project.jobs[0]?.name;
  return slugify(first ?? "pentaho-migration");
}

function connectionFiles(project: PentahoProject): Map<string, Set<string>> {
  const files = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    const set = files.get(name) ?? new Set<string>();
    set.add(file);
    files.set(name, set);
  };
  for (const transformation of project.transformations) {
    for (const name of transformation.connections) add(name, transformation.file);
  }
  for (const job of project.jobs) {
    for (const name of job.connections) add(name, job.file);
  }
  return files;
}

function summarizeConnections(project: PentahoProject, risks: Risk[]): ConnectionSummary[] {
  const files = connectionFiles(project);
  return project.connections
    .map((connection: PentahoConnection): ConnectionSummary => {
      const warnings: string[] = [];
      if (!connection.host && !connection.url) {
        warnings.push("No host or JDBC URL was found; replace the placeholder before deploying.");
        risks.push({
          severity: "warning",
          code: "connection_endpoint_missing",
          message: `Connection "${connection.name}" has no host or JDBC URL.`,
          file: connection.sourceFile,
        });
      }
      if (connection.hasPassword) {
        warnings.push(
          "The source password was removed. Put the real credentials in the generated Secrets Manager secret.",
        );
      }
      return {
        name: connection.name,
        type: connection.type,
        host: connection.host,
        database: connection.database,
        port: connection.port,
        username: connection.username,
        hasPassword: connection.hasPassword,
        jdbcUrl: jdbcUrl(connection),
        driver: driverClass(connection.type),
        secretName: jdbcSecretName(connection),
        files: [...(files.get(connection.name) ?? new Set<string>())].sort(),
        warnings,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeSchedules(project: PentahoProject, risks: Risk[]): ScheduleSummary[] {
  const result: ScheduleSummary[] = [];
  for (const schedule of project.schedules) {
    const mapped = toEventBridgeSchedule(schedule);
    if (!mapped) {
      risks.push({
        severity: "warning",
        code: "schedule_unmapped",
        message: `Schedule on "${schedule.job}" / "${schedule.entry}" uses unsupported PDI scheduler type ${schedule.schedulerType}.`,
        file: schedule.file,
      });
      result.push({
        job: schedule.job,
        file: schedule.file,
        entry: schedule.entry,
        pdiSchedulerType: schedule.schedulerType,
        mapped: false,
        description: `Unsupported PDI scheduler type ${schedule.schedulerType}`,
      });
      continue;
    }
    if (mapped.note) {
      risks.push({
        severity: "info",
        code: "schedule_timezone",
        message: `Schedule "${schedule.job}" / "${schedule.entry}": ${mapped.note}`,
        file: schedule.file,
      });
    }
    result.push({
      job: schedule.job,
      file: schedule.file,
      entry: schedule.entry,
      pdiSchedulerType: schedule.schedulerType,
      mapped: true,
      expression: mapped.expression,
      description: mapped.description,
      note: mapped.note,
    });
  }
  return result.sort((a, b) => a.file.localeCompare(b.file) || a.entry.localeCompare(b.entry));
}

function summarizeParameters(project: PentahoProject): ParameterSummary[] {
  const byName = new Map<string, ParameterSummary>();
  for (const item of [...project.transformations, ...project.jobs]) {
    for (const parameter of item.parameters) {
      const existing = byName.get(parameter.name);
      if (existing) {
        if (!existing.files.includes(item.file)) existing.files.push(item.file);
        existing.defaultValue ??= parameter.defaultValue;
        existing.description ??= parameter.description;
      } else {
        byName.set(parameter.name, {
          name: parameter.name,
          defaultValue: parameter.defaultValue,
          description: parameter.description,
          files: [item.file],
        });
      }
    }
  }
  return [...byName.values()]
    .map((parameter) => ({ ...parameter, files: [...parameter.files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizedName(value: string): string {
  return path.posix
    .basename(value.replaceAll("\\", "/"))
    .replace(/\.(ktr|kjb)$/i, "")
    .trim()
    .toLowerCase();
}

function entryTargets(entry: JobEntry): string[] {
  const raw = entry.raw;
  const values = [
    entry.name,
    typeof raw.transname === "string" ? raw.transname : undefined,
    typeof raw.jobname === "string" ? raw.jobname : undefined,
    typeof raw.filename === "string" ? raw.filename : undefined,
  ];
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    result.add(value.trim().toLowerCase());
    const normalized = normalizedName(value);
    if (normalized) result.add(normalized);
  }
  return [...result];
}

function findDependencies(project: PentahoProject): Dependency[] {
  const dependencies: Dependency[] = [];
  const transformationNames = new Set(
    project.transformations.flatMap((transformation) => [
      transformation.name.toLowerCase(),
      normalizedName(transformation.file),
    ]),
  );
  const jobNames = new Set(
    project.jobs.flatMap((job) => [job.name.toLowerCase(), normalizedName(job.file)]),
  );
  const add = (job: Job, entry: JobEntry, kind: "transformation" | "job") => {
    const candidates = entryTargets(entry).filter(
      (candidate) => candidate !== entry.name.toLowerCase(),
    );
    const known = kind === "transformation" ? transformationNames : jobNames;
    const resolved = candidates.some((candidate) => known.has(candidate));
    dependencies.push({
      fromFile: job.file,
      entry: entry.name,
      kind,
      target: candidates[0] ?? entry.name,
      resolved,
    });
  };
  for (const job of project.jobs) {
    for (const entry of job.entries) {
      if (entry.type === "TRANS") add(job, entry, "transformation");
      else if (entry.type === "JOB") add(job, entry, "job");
    }
  }
  return dependencies.sort(
    (a, b) => a.fromFile.localeCompare(b.fromFile) || a.entry.localeCompare(b.entry),
  );
}

const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)|file:)/;
const INTERNAL_PATH = /^\$\{Internal\./;

function localPathsIn(value: unknown, key: string, result: Set<string>): void {
  if (typeof value === "string") {
    if (
      (key === "filename" || key === "name" || key === "directory" || key === "file") &&
      LOCAL_PATH.test(value) &&
      !INTERNAL_PATH.test(value) &&
      !value.includes("${") &&
      !value.includes("%%")
    ) {
      result.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) localPathsIn(item, key, result);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      localPathsIn(childValue, childKey, result);
    }
  }
}

function normalizePathMapping(value: string): string {
  return value.replaceAll("\\", "/").trim().replace(/\/+$/g, "");
}

function isPathMapped(value: string, mappings: { from: string }[]): boolean {
  const path = normalizePathMapping(value).toLowerCase();
  return mappings.some((mapping) => {
    const from = normalizePathMapping(mapping.from).toLowerCase();
    return from !== "" && (path === from || path.startsWith(`${from}/`));
  });
}

function buildRisks(
  project: PentahoProject,
  manualSteps: UnsupportedStep[],
  partialSteps: UnsupportedStep[],
  dependencies: Dependency[],
  pathMappings: { from: string; to: string }[],
): Risk[] {
  const risks: Risk[] = [];
  for (const warning of project.warnings) {
    risks.push({
      severity: warning.startsWith("Redacted") ? "info" : "warning",
      code: "project_warning",
      message: warning,
    });
  }
  for (const step of manualSteps) {
    risks.push({
      severity: "warning",
      code: "manual_step",
      message: `Step "${step.step}" uses ${step.type}, which is passed through as a stub and needs a manual rewrite.`,
      file: step.file,
      step: step.step,
    });
  }
  for (const step of partialSteps) {
    const mapping = stepMapping(step.type);
    risks.push({
      severity: "info",
      code: "partial_step",
      message:
        `Step "${step.step}" uses ${step.type}: ${mapping.conversion}. ${mapping.caveat ?? ""}`.trim(),
      file: step.file,
      step: step.step,
    });
  }
  for (const job of project.jobs) {
    for (const entry of job.entries) {
      const known = jobEntryMapping(entry.type);
      if (known.status === "manual") {
        risks.push({
          severity: "warning",
          code: "unsupported_job_entry",
          message: `Job entry "${entry.name}" uses ${entry.type}, which is not executed by the generated state machine.`,
          file: job.file,
        });
      }
    }
  }
  for (const dependency of dependencies) {
    if (!dependency.resolved) {
      risks.push({
        severity: "warning",
        code: "dependency_missing",
        message: `Job entry "${dependency.entry}" in ${dependency.fromFile} references ${dependency.kind} "${dependency.target}", which was not uploaded.`,
        file: dependency.fromFile,
      });
    }
  }
  const localPaths = new Set<string>();
  for (const transformation of project.transformations) {
    for (const step of transformation.steps) {
      localPathsIn(step.raw, "raw", localPaths);
    }
  }
  for (const job of project.jobs) {
    for (const entry of job.entries) {
      localPathsIn(entry.raw, "raw", localPaths);
    }
  }
  if (localPaths.size > 0) {
    const unmappedPaths = [...localPaths]
      .filter((value) => !isPathMapped(value, pathMappings))
      .sort();
    if (unmappedPaths.length > 0) {
      const sample = unmappedPaths.slice(0, 3).join(", ");
      risks.push({
        severity: "warning",
        code: "local_paths",
        message: `${unmappedPaths.length} local file path${unmappedPaths.length === 1 ? " needs" : "s need"} an S3 mapping (for example ${sample}). Unmapped paths are written under s3://<DataBucket>/unmapped/.`,
      });
    }
  }
  return risks;
}

function scoreReadiness(
  risks: Risk[],
  manualSteps: UnsupportedStep[],
  partialSteps: UnsupportedStep[],
  schedules: ScheduleSummary[],
  connections: ConnectionSummary[],
): ProjectAssessment["readiness"] {
  const blockers: string[] = [];
  if (manualSteps.length > 0) {
    blockers.push(
      `${manualSteps.length} step${manualSteps.length === 1 ? "" : "s"} ${manualSteps.length === 1 ? "needs" : "need"} a manual rewrite.`,
    );
  }
  const missingEndpoints = connections.filter((connection) =>
    connection.jdbcUrl.includes("REPLACE_ME"),
  );
  if (missingEndpoints.length > 0) {
    blockers.push(
      missingEndpoints.length === 1
        ? "1 connection still contains a placeholder endpoint."
        : `${missingEndpoints.length} connections still contain placeholder endpoints.`,
    );
  }
  const unmapped = schedules.filter((schedule) => !schedule.mapped);
  if (unmapped.length > 0) {
    blockers.push(
      `${unmapped.length} PDI schedule${unmapped.length === 1 ? "" : "s"} could not be mapped.`,
    );
  }
  const errors = risks.filter((risk) => risk.severity === "error").length;
  const warnings = risks.filter((risk) => risk.severity === "warning").length;
  const penalty =
    manualSteps.length * 8 +
    partialSteps.length * 2 +
    missingEndpoints.length * 10 +
    unmapped.length * 6 +
    errors * 15 +
    Math.min(20, warnings * 2);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const level =
    errors > 0 || score < 45
      ? "blocked"
      : score >= 85 && blockers.length === 0
        ? "ready"
        : "review";
  const summary =
    level === "ready"
      ? "The project maps cleanly. Review the generated IAM, endpoints and secrets, then deploy."
      : level === "review"
        ? "The bundle is deployable after reviewing the flagged steps, connections and schedules."
        : "The bundle needs manual work before it can run in AWS.";
  return { score, level, summary, blockers };
}

function buildQuestions(
  project: PentahoProject,
  manualSteps: UnsupportedStep[],
  dependencies: Dependency[],
  connections: ConnectionSummary[],
  schedules: ScheduleSummary[],
  variables: string[],
  pathMappings: { from: string; to: string }[],
): string[] {
  const questions: string[] = [];
  const missingDependencies = dependencies.filter((dependency) => !dependency.resolved);
  if (missingDependencies.length > 0) {
    const sample = missingDependencies
      .slice(0, 3)
      .map((dependency) => `${dependency.entry} -> ${dependency.target}`)
      .join(", ");
    questions.push(
      `Upload the missing ${missingDependencies.length === 1 ? "file" : "files"} referenced by the job, or remove those entries before generating (${sample}).`,
    );
  }
  if (manualSteps.length > 0) {
    const types = [...new Set(manualSteps.map((step) => step.type))].slice(0, 4).join(", ");
    questions.push(
      `How should the ${manualSteps.length} manual step${manualSteps.length === 1 ? "" : "s"} (${types}) be implemented in AWS? You can provide PySpark through step_overrides.`,
    );
  }
  const localPathCount = project.transformations.reduce((count, transformation) => {
    const found = new Set<string>();
    for (const step of transformation.steps) localPathsIn(step.raw, "raw", found);
    return count + found.size;
  }, 0);
  if (localPathCount > 0) {
    const unmapped = new Set<string>();
    for (const transformation of project.transformations) {
      const found = new Set<string>();
      for (const step of transformation.steps) localPathsIn(step.raw, "raw", found);
      for (const value of found) {
        if (!isPathMapped(value, pathMappings)) unmapped.add(value);
      }
    }
    for (const job of project.jobs) {
      const found = new Set<string>();
      for (const entry of job.entries) localPathsIn(entry.raw, "raw", found);
      for (const value of found) {
        if (!isPathMapped(value, pathMappings)) unmapped.add(value);
      }
    }
    if (unmapped.size > 0) {
      questions.push(
        "Which S3 prefixes should the local file paths map to? Provide path_mappings as from/to pairs (for example C:/data to s3://my-bucket/data).",
      );
    }
  }
  const missingEndpoints = connections.filter((connection) =>
    connection.jdbcUrl.includes("REPLACE_ME"),
  );
  if (missingEndpoints.length > 0) {
    questions.push(
      `What are the host and database for the placeholder connection${missingEndpoints.length === 1 ? "" : "s"} ${missingEndpoints.map((connection) => connection.name).join(", ")}?`,
    );
  }
  if (schedules.length > 0) {
    questions.push(
      "PDI did not store a time zone for its schedules. Confirm that the generated EventBridge Scheduler expressions should run in UTC.",
    );
  }
  const variablesWithoutDefaults = variables.filter(
    (variable) =>
      !/^Internal\./.test(variable) &&
      ![...project.transformations, ...project.jobs]
        .flatMap((item) => item.parameters)
        .some((parameter) => parameter.name === variable),
  );
  if (variablesWithoutDefaults.length > 0) {
    questions.push(
      `Which values should these variables use in AWS: ${variablesWithoutDefaults.slice(0, 6).join(", ")}?`,
    );
  }
  const unresolvedJobEntries = project.jobs.flatMap((job) =>
    job.entries.filter((entry) => {
      return jobEntryMapping(entry.type).status === "manual";
    }),
  );
  if (unresolvedJobEntries.length > 0) {
    questions.push(
      "Several job entries have no automatic state-machine mapping. Confirm whether to replace them with Lambda, SNS or S3 tasks.",
    );
  }
  return questions.slice(0, 8);
}

export interface AssessOptions {
  projectName?: string;
  pathMappings?: { from: string; to: string }[];
}

export function assessProject(
  project: PentahoProject,
  options: AssessOptions = {},
): ProjectAssessment {
  const projectName = deriveProjectName(project, options.projectName);
  const files: InventoryFile[] = project.files
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      bytes: file.bytes,
      sha256: file.sha256,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const stepCounts = new Map<string, { type: string; count: number }>();
  const manualSteps: UnsupportedStep[] = [];
  const partialSteps: UnsupportedStep[] = [];
  for (const transformation of project.transformations) {
    for (const step of transformation.steps) {
      const key = step.type.toLowerCase();
      const current = stepCounts.get(key);
      if (current) current.count += 1;
      else stepCounts.set(key, { type: step.type, count: 1 });
      const mapping = stepMapping(step.type);
      if (mapping.status !== "automatic") {
        const parsed: UnsupportedStep = {
          file: transformation.file,
          transformation: transformation.name,
          step: step.name,
          type: step.type,
          status: mapping.status,
        };
        if (mapping.status === "manual") manualSteps.push(parsed);
        else partialSteps.push(parsed);
      }
    }
  }
  const stepCoverage: StepCoverage[] = [...stepCounts.values()]
    .map(({ type, count }) => {
      const mapping = stepMapping(type);
      return {
        type,
        count,
        status: mapping.status,
        supported: mapping.status !== "manual",
        conversion: mapping.conversion,
        caveat: mapping.caveat,
      };
    })
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const jobEntryCounts = new Map<string, { type: string; count: number }>();
  for (const job of project.jobs) {
    for (const entry of job.entries) {
      const key = entry.type.toUpperCase();
      const current = jobEntryCounts.get(key);
      if (current) current.count += 1;
      else jobEntryCounts.set(key, { type: key, count: 1 });
    }
  }
  const jobEntryCoverage: JobEntryCoverage[] = [...jobEntryCounts.values()]
    .map(({ type, count }) => {
      const mapping = jobEntryMapping(type);
      return {
        type,
        count,
        status: mapping.status,
        mapped: mapping.status !== "manual",
        conversion: mapping.conversion,
      };
    })
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const dependencies = findDependencies(project);
  const pathMappings = options.pathMappings ?? [];
  const risks = buildRisks(project, manualSteps, partialSteps, dependencies, pathMappings);
  const connections = summarizeConnections(project, risks);
  const schedules = summarizeSchedules(project, risks);
  const parameters = summarizeParameters(project);
  const variables = [
    ...new Set([...project.transformations, ...project.jobs].flatMap((item) => item.variables)),
  ].sort();
  const readiness = scoreReadiness(risks, manualSteps, partialSteps, schedules, connections);
  const questions = buildQuestions(
    project,
    manualSteps,
    dependencies,
    connections,
    schedules,
    variables,
    pathMappings,
  );
  const supportedStepTypes = new Set(
    stepCoverage
      .filter((coverage) => coverage.status !== "manual")
      .map((coverage) => coverage.type.toLowerCase()),
  ).size;
  const partialStepTypes = new Set(
    stepCoverage
      .filter((coverage) => coverage.status === "partial")
      .map((coverage) => coverage.type.toLowerCase()),
  ).size;

  const sortSteps = (steps: UnsupportedStep[]) =>
    steps.sort((a, b) => a.file.localeCompare(b.file) || a.step.localeCompare(b.step));

  return {
    projectName,
    totals: {
      files: files.length,
      transformations: project.transformations.length,
      jobs: project.jobs.length,
      steps: project.transformations.reduce((total, item) => total + item.steps.length, 0),
      jobEntries: project.jobs.reduce((total, item) => total + item.entries.length, 0),
      connections: connections.length,
      schedules: schedules.length,
      warnings: project.warnings.length,
      supportedStepTypes,
      partialStepTypes,
      unsupportedStepTypes: new Set(manualSteps.map((step) => step.type.toLowerCase())).size,
    },
    files,
    stepCoverage,
    unsupportedSteps: sortSteps(manualSteps),
    partialSteps: sortSteps(partialSteps),
    jobEntryCoverage,
    connections,
    schedules,
    parameters,
    variables,
    dependencies,
    risks: risks.sort(
      (a, b) =>
        (a.severity === "error" ? 0 : a.severity === "warning" ? 1 : 2) -
          (b.severity === "error" ? 0 : b.severity === "warning" ? 1 : 2) ||
        a.code.localeCompare(b.code) ||
        a.message.localeCompare(b.message),
    ),
    questions,
    readiness,
  };
}

export function connectionSlugFor(name: string): string {
  return connectionSlug(name);
}

export function fileBaseName(file: string): string {
  return path.posix.basename(file);
}
