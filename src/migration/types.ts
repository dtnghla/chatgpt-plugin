import type { ConversionStatus } from "../convert/step-mapping.js";

export type Severity = "info" | "warning" | "error";
export type ReadinessLevel = "ready" | "review" | "blocked";

export interface Risk {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
  step?: string;
}

export interface InventoryFile {
  path: string;
  kind: "transformation" | "job" | "repository" | "properties" | "shared" | "other";
  bytes: number;
  sha256: string;
  name?: string;
}

export interface StepCoverage {
  type: string;
  count: number;
  status: ConversionStatus;
  /** True for automatic and partial mappings. */
  supported: boolean;
  conversion: string;
  caveat?: string;
}

export interface UnsupportedStep {
  file: string;
  transformation: string;
  step: string;
  type: string;
  status: ConversionStatus;
}

export interface JobEntryCoverage {
  type: string;
  count: number;
  status: ConversionStatus;
  mapped: boolean;
  conversion: string;
}

export interface ConnectionSummary {
  name: string;
  type: string;
  host?: string;
  database?: string;
  port?: string;
  username?: string;
  hasPassword: boolean;
  jdbcUrl: string;
  driver: string;
  secretName: string;
  files: string[];
  warnings: string[];
}

export interface ScheduleSummary {
  job: string;
  file: string;
  entry: string;
  pdiSchedulerType: number;
  mapped: boolean;
  expression?: string;
  description: string;
  note?: string;
}

export interface ParameterSummary {
  name: string;
  defaultValue?: string;
  description?: string;
  files: string[];
}

export interface Dependency {
  fromFile: string;
  entry: string;
  kind: "transformation" | "job";
  target: string;
  resolved: boolean;
}

export interface FlowNode {
  name: string;
  type: string;
  x: number;
  y: number;
  status: ConversionStatus;
}

export interface FlowEdge {
  from: string;
  to: string;
  enabled: boolean;
  failure: boolean;
}

export interface FlowGraph {
  kind: "transformation" | "job";
  name: string;
  file: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface ProjectAssessment {
  projectName: string;
  totals: {
    files: number;
    transformations: number;
    jobs: number;
    steps: number;
    jobEntries: number;
    connections: number;
    schedules: number;
    warnings: number;
    supportedStepTypes: number;
    partialStepTypes: number;
    unsupportedStepTypes: number;
  };
  files: InventoryFile[];
  stepCoverage: StepCoverage[];
  unsupportedSteps: UnsupportedStep[];
  partialSteps: UnsupportedStep[];
  jobEntryCoverage: JobEntryCoverage[];
  connections: ConnectionSummary[];
  schedules: ScheduleSummary[];
  parameters: ParameterSummary[];
  variables: string[];
  dependencies: Dependency[];
  risks: Risk[];
  questions: string[];
  readiness: {
    score: number;
    level: ReadinessLevel;
    summary: string;
    blockers: string[];
  };
}

export interface GlueJobArtifact {
  transformation: string;
  sourceFile: string;
  glueJobName: string;
  scriptPath: string;
  kind: "transformation" | "sql";
  automaticSteps: string[];
  partialSteps: string[];
  manualSteps: string[];
  connections: string[];
  needsExcel: boolean;
  overriddenSteps: string[];
  warnings: string[];
}

export interface StateMachineArtifact {
  job: string;
  sourceFile: string;
  stateMachineName: string;
  definitionPath: string;
  scheduleCount: number;
  entryTypes: string[];
  nested: { placeholder: string; targetJob: string; targetFile: string }[];
  usesSns: boolean;
  usesS3: boolean;
  usesSql: boolean;
  warnings: string[];
}

export interface SqlRunnerArtifact {
  name: string;
  scriptPath: string;
  entries: { job: string; entry: string; connection?: string }[];
  connections: string[];
  warnings: string[];
}

export interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
  kind: "python" | "asl" | "cloudformation" | "markdown" | "json" | "text";
}

export interface MigrationBundle {
  id: string;
  projectName: string;
  zip: Uint8Array;
  files: BundleFile[];
  /** UTF-8 text of every file in the bundle, keyed by path. */
  contents: Record<string, string>;
  assessment: ProjectAssessment;
  jobs: GlueJobArtifact[];
  stateMachines: StateMachineArtifact[];
  sqlRunner?: SqlRunnerArtifact;
  connections: ConnectionSummary[];
  schedules: ScheduleSummary[];
  flows: FlowGraph[];
  warnings: string[];
  nextSteps: string[];
  createdAt: number;
}

export interface BundleSummary {
  bundle_id: string;
  project_name: string;
  download_url?: string;
  download_expires_at?: string;
  generated_with: string;
  totals: ProjectAssessment["totals"];
  readiness: ProjectAssessment["readiness"];
  files: { path: string; bytes: number; sha256: string; kind: BundleFile["kind"] }[];
  jobs: {
    transformation: string;
    source_file: string;
    glue_job_name: string;
    script_path: string;
    kind: GlueJobArtifact["kind"];
    automatic_steps: string[];
    partial_steps: string[];
    manual_steps: string[];
    warnings: string[];
  }[];
  state_machines: {
    job: string;
    source_file: string;
    state_machine_name: string;
    definition_path: string;
    schedule_count: number;
    warnings: string[];
  }[];
  sql_runner?: {
    name: string;
    script_path: string;
    entries: number;
    warnings: string[];
  };
  connections: {
    name: string;
    type: string;
    jdbc_url: string;
    driver: string;
    secret_name: string;
    has_password: boolean;
  }[];
  schedules: {
    job: string;
    entry: string;
    expression?: string;
    description: string;
    mapped: boolean;
    note?: string;
  }[];
  warnings: string[];
  next_steps: string[];
  assessment: ProjectAssessment;
  flows: FlowGraph[];
}

export interface MigrationFileResult {
  bundle_id: string;
  path: string;
  kind: BundleFile["kind"];
  bytes: number;
  sha256: string;
  content: string;
  truncated: boolean;
}

export interface GeneratedBundleOptions {
  projectName: string;
  glueVersion: string;
  workerType: string;
  numberOfWorkers: number;
  scriptPrefix: string;
  pathMappings: { from: string; to: string }[];
  stepOverrides: Record<string, string>;
  scheduleOverrides: Record<string, string>;
  generatedWith: string;
}
