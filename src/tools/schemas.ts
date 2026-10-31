import * as z from "zod/v4";
import type { BundleSummary, MigrationFileResult, ProjectAssessment } from "../migration/types.js";

export const fileReferenceSchema = z.object({
  download_url: z
    .string()
    .url()
    .max(4096)
    .describe("HTTPS URL supplied by the host for the uploaded file."),
  file_id: z.string().min(1).max(256).describe("Host-assigned file identifier."),
  mime_type: z.string().max(200).optional(),
  file_name: z.string().max(255).optional().describe("Original file name, e.g. orders.ktr."),
});

export const inlineFileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .describe("Relative file name such as transformations/orders.ktr or kettle.properties."),
  content: z.string().max(2_000_000).optional().describe("UTF-8 file content."),
  content_base64: z
    .string()
    .max(3_000_000)
    .optional()
    .describe("Base64-encoded file content. Use for binary files such as a ZIP archive."),
});

const filesField = z
  .array(fileReferenceSchema)
  .max(50)
  .optional()
  .describe(
    "Pentaho files uploaded through the host's file picker. Provide .ktr, .kjb, kettle.properties, shared.xml, a repository export, or one ZIP archive.",
  );

const inlineFilesField = z
  .array(inlineFileSchema)
  .max(50)
  .optional()
  .describe(
    "Pentaho files pasted inline. Use this when the host cannot upload files. Do not include real passwords.",
  );

export const analyzeInputSchema = z.object({
  files: filesField,
  inline_files: inlineFilesField,
  project_name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("Name for the migration project. Derived from the file paths when omitted."),
});

const pathMappingSchema = z.object({
  from: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .describe('Source prefix such as "C:/pentaho/data" or "/opt/pentaho/data".'),
  to: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(
      /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?:\/[^\s]*)?$/i,
      "Destination must be an s3://bucket/prefix URI.",
    )
    .describe('Target S3 prefix such as "s3://my-data/pentaho".'),
});

export const generateInputSchema = z.object({
  files: filesField,
  inline_files: inlineFilesField,
  project_name: z.string().trim().min(1).max(80).optional(),
  glue_version: z
    .enum(["5.1", "6.0"])
    .default("6.0")
    .describe(
      "AWS Glue version for the generated PySpark jobs. Default 6.0; 5.1 is available for older accounts.",
    ),
  worker_type: z
    .enum(["G.025X", "G.1X", "G.2X", "G.4X", "G.8X"])
    .default("G.1X")
    .describe("Glue worker type. G.1X is a good default for migrated PDI transformations."),
  number_of_workers: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(2)
    .describe("Number of Glue workers (1-100) for each generated job."),
  path_mappings: z
    .array(pathMappingSchema)
    .max(50)
    .default([])
    .describe(
      "Map local PDI file paths to S3 prefixes. Unmapped paths are written under s3://<DataBucket>/unmapped/.",
    ),
  step_overrides: z
    .record(z.string(), z.string().max(20_000))
    .default({})
    .describe(
      'Optional PySpark replacements for steps that need manual work. Key by "file#step", "transformation#step" or a unique "step" name; the snippet must assign a DataFrame variable for that step.',
    ),
  schedule_overrides: z
    .record(z.string(), z.string().max(256))
    .default({})
    .describe(
      'Optional EventBridge Scheduler expressions keyed by "job:entry" or entry name, for example "nightly:START" -> "cron(0 2 * * ? *)".',
    ),
});

export const getFileInputSchema = z.object({
  bundle_id: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .describe("The bundle_id returned by generate_aws_migration."),
  path: z
    .string()
    .min(1)
    .max(400)
    .describe("A path from the bundle's file list, for example migration-report.md."),
});

export const fileResultSchema = z.object({
  bundle_id: z.string(),
  path: z.string(),
  kind: z.enum(["python", "asl", "cloudformation", "markdown", "json", "text"]),
  bytes: z.number().int(),
  sha256: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

const riskSchema: z.ZodType<ProjectAssessment["risks"][number]> = z.object({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  file: z.string().optional(),
  step: z.string().optional(),
});

const inventoryFileSchema: z.ZodType<ProjectAssessment["files"][number]> = z.object({
  path: z.string(),
  kind: z.enum(["transformation", "job", "repository", "properties", "shared", "other"]),
  bytes: z.number().int(),
  sha256: z.string(),
});

const stepCoverageSchema: z.ZodType<ProjectAssessment["stepCoverage"][number]> = z.object({
  type: z.string(),
  count: z.number().int(),
  status: z.enum(["automatic", "partial", "manual"]),
  supported: z.boolean(),
  conversion: z.string(),
  caveat: z.string().optional(),
});

const unsupportedStepSchema: z.ZodType<ProjectAssessment["unsupportedSteps"][number]> = z.object({
  file: z.string(),
  transformation: z.string(),
  step: z.string(),
  type: z.string(),
  status: z.enum(["automatic", "partial", "manual"]),
});

const jobEntryCoverageSchema: z.ZodType<ProjectAssessment["jobEntryCoverage"][number]> = z.object({
  type: z.string(),
  count: z.number().int(),
  status: z.enum(["automatic", "partial", "manual"]),
  mapped: z.boolean(),
  conversion: z.string(),
});

const connectionSchema: z.ZodType<ProjectAssessment["connections"][number]> = z.object({
  name: z.string(),
  type: z.string(),
  host: z.string().optional(),
  database: z.string().optional(),
  port: z.string().optional(),
  username: z.string().optional(),
  hasPassword: z.boolean(),
  jdbcUrl: z.string(),
  driver: z.string(),
  secretName: z.string(),
  files: z.array(z.string()),
  warnings: z.array(z.string()),
});

const scheduleSchema: z.ZodType<ProjectAssessment["schedules"][number]> = z.object({
  job: z.string(),
  file: z.string(),
  entry: z.string(),
  pdiSchedulerType: z.number().int(),
  mapped: z.boolean(),
  expression: z.string().optional(),
  description: z.string(),
  note: z.string().optional(),
});

const parameterSchema: z.ZodType<ProjectAssessment["parameters"][number]> = z.object({
  name: z.string(),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
  files: z.array(z.string()),
});

const dependencySchema: z.ZodType<ProjectAssessment["dependencies"][number]> = z.object({
  fromFile: z.string(),
  entry: z.string(),
  kind: z.enum(["transformation", "job"]),
  target: z.string(),
  resolved: z.boolean(),
});

export const assessmentOutputSchema: z.ZodType<ProjectAssessment> = z.object({
  projectName: z.string(),
  totals: z.object({
    files: z.number().int(),
    transformations: z.number().int(),
    jobs: z.number().int(),
    steps: z.number().int(),
    jobEntries: z.number().int(),
    connections: z.number().int(),
    schedules: z.number().int(),
    warnings: z.number().int(),
    supportedStepTypes: z.number().int(),
    partialStepTypes: z.number().int(),
    unsupportedStepTypes: z.number().int(),
  }),
  files: z.array(inventoryFileSchema),
  stepCoverage: z.array(stepCoverageSchema),
  unsupportedSteps: z.array(unsupportedStepSchema),
  partialSteps: z.array(unsupportedStepSchema),
  jobEntryCoverage: z.array(jobEntryCoverageSchema),
  connections: z.array(connectionSchema),
  schedules: z.array(scheduleSchema),
  parameters: z.array(parameterSchema),
  variables: z.array(z.string()),
  dependencies: z.array(dependencySchema),
  risks: z.array(riskSchema),
  questions: z.array(z.string()),
  readiness: z.object({
    score: z.number().int(),
    level: z.enum(["ready", "review", "blocked"]),
    summary: z.string(),
    blockers: z.array(z.string()),
  }),
});

const totalsSchema = z.object({
  files: z.number().int(),
  transformations: z.number().int(),
  jobs: z.number().int(),
  steps: z.number().int(),
  jobEntries: z.number().int(),
  connections: z.number().int(),
  schedules: z.number().int(),
  warnings: z.number().int(),
  supportedStepTypes: z.number().int(),
  partialStepTypes: z.number().int(),
  unsupportedStepTypes: z.number().int(),
});

const readinessSchema = z.object({
  score: z.number().int(),
  level: z.enum(["ready", "review", "blocked"]),
  summary: z.string(),
  blockers: z.array(z.string()),
});

const bundleFileSchema: z.ZodType<BundleSummary["files"][number]> = z.object({
  path: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  kind: z.enum(["python", "asl", "cloudformation", "markdown", "json", "text"]),
});

const flowSchema: z.ZodType<BundleSummary["flows"][number]> = z.object({
  kind: z.enum(["transformation", "job"]),
  name: z.string(),
  file: z.string(),
  nodes: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      x: z.number(),
      y: z.number(),
      status: z.enum(["automatic", "partial", "manual"]),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      enabled: z.boolean(),
      failure: z.boolean(),
    }),
  ),
});

export const bundleSummarySchema: z.ZodType<BundleSummary> = z.object({
  bundle_id: z.string(),
  project_name: z.string(),
  download_url: z.string().optional(),
  download_expires_at: z.string().optional(),
  generated_with: z.string(),
  totals: totalsSchema,
  readiness: readinessSchema,
  files: z.array(bundleFileSchema),
  jobs: z.array(
    z.object({
      transformation: z.string(),
      source_file: z.string(),
      glue_job_name: z.string(),
      script_path: z.string(),
      kind: z.enum(["transformation", "sql"]),
      automatic_steps: z.array(z.string()),
      partial_steps: z.array(z.string()),
      manual_steps: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
  ),
  state_machines: z.array(
    z.object({
      job: z.string(),
      source_file: z.string(),
      state_machine_name: z.string(),
      definition_path: z.string(),
      schedule_count: z.number().int(),
      warnings: z.array(z.string()),
    }),
  ),
  sql_runner: z
    .object({
      name: z.string(),
      script_path: z.string(),
      entries: z.number().int(),
      warnings: z.array(z.string()),
    })
    .optional(),
  connections: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      jdbc_url: z.string(),
      driver: z.string(),
      secret_name: z.string(),
      has_password: z.boolean(),
    }),
  ),
  schedules: z.array(
    z.object({
      job: z.string(),
      entry: z.string(),
      expression: z.string().optional(),
      description: z.string(),
      mapped: z.boolean(),
      note: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
  next_steps: z.array(z.string()),
  assessment: assessmentOutputSchema,
  flows: z.array(flowSchema),
});

export const migrationFileSchema: z.ZodType<MigrationFileResult> = z.object({
  bundle_id: z.string(),
  path: z.string(),
  kind: z.enum(["python", "asl", "cloudformation", "markdown", "json", "text"]),
  bytes: z.number().int(),
  sha256: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});
