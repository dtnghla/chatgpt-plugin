import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import {
  type CallToolResult,
  McpServer,
  type ReadResourceResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { ArtifactService } from "./artifacts/store.js";
import {
  assessDatabaseProject,
  deriveDatabaseProjectName,
  truncateDatabaseAssessment,
} from "./database/assessment.js";
import {
  buildDatabaseBundle,
  type DatabaseBundle,
  summarizeDatabaseBundle,
} from "./database/bundle.js";
import { parseDatabaseProject } from "./database/parse.js";
import type { DatabaseProject } from "./database/types.js";
import { IngestError, readProjectInput } from "./ingest/index.js";
import {
  type LicensingContext,
  projectLimitMessage,
  quotaMessage,
  type ResolvedEntitlement,
  resolveEntitlement,
} from "./licensing/entitlements.js";
import type { VerifiedLicense } from "./licensing/license.js";
import { assessProject, deriveProjectName } from "./migration/assessment.js";
import { buildMigrationBundle, summarizeBundle } from "./migration/bundle.js";
import type { MigrationFileResult } from "./migration/types.js";
import { parsePentahoProject } from "./pentaho/parse.js";
import type { PentahoProject } from "./pentaho/types.js";
import {
  formatAssessment,
  formatBundleSummary,
  formatDatabaseAssessment,
  formatDatabaseBundleSummary,
  formatMigrationFile,
} from "./tools/format.js";
import {
  analyzeInputSchema,
  assessmentOutputSchema,
  bundleSummarySchema,
  databaseAnalyzeInputSchema,
  databaseAssessmentSchema,
  databaseBundleSummarySchema,
  databaseGenerateInputSchema,
  generateInputSchema,
  getFileInputSchema,
  migrationFileSchema,
} from "./tools/schemas.js";

export const SERVER_NAME = "aws-data-modernizer";
export const SERVER_VERSION = "1.0.0";
export const WORKBENCH_UI_URI = "ui://aws-data-modernizer/workbench-v1.html";
export const GENERATOR_VERSION = "aws-data-modernizer 1.0.0";

const MAX_FILE_CHARS = 120_000;

const INSTRUCTIONS = [
  "This server assesses data platform modernization projects and generates AWS migration bundles: Pentaho Data Integration ETL projects, relational databases (Oracle, SQL Server, MySQL/MariaDB, PostgreSQL), data warehouses (Teradata, Netezza) and Hive data lakes. Every tool is read-only: it never calls AWS, never asks for AWS credentials, and never connects to, stores or prints database passwords.",
  "For Pentaho .ktr/.kjb files, repository exports or project ZIPs, start with analyze_pentaho_project and call generate_pentaho_migration only after the analysis. For database, warehouse or Hive DDL exports (.sql, .ddl, .hql or BTEQ scripts), start with analyze_database_schema and call generate_database_migration only after the analysis.",
  "Summarize readiness, manual work, placeholder connections and open questions honestly; do not claim the migration will run unchanged. The user deploys the bundle with the AWS CLI; this server cannot deploy it.",
  "Never ask for a password, access key, secret key or session token. If a connection needs credentials, tell the user to fill the generated Secrets Manager placeholders themselves after deployment.",
  "Download URLs supplied by the host are fetched only over HTTPS from an allowlisted host. Do not invent file contents; if a file cannot be read, report the error.",
  "Use get_migration_file to quote or inspect generated text files from either bundle type. Bundles expire; regenerate them if the download or file lookup has expired.",
].join(" ");

const LICENSE_INSTRUCTIONS =
  "This deployment enforces free-tier limits. If a tool result says the free tier limit was exceeded or a license key is invalid, relay that message to the user. A purchased Pro license key can be passed through the license_key argument of the analyze and generate tools.";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface ServerDeps {
  loadWidgetHtml: () => Promise<string>;
  artifacts: ArtifactService;
  fileHostAllowlist: string[];
  widgetDomain?: string;
  /** Present when LICENSE_MODE=enforced; enables free-tier gates and bundle quotas. */
  licensing?: LicensingContext;
  /** License verified from the connection's x-modernizer-license-key header, if any. */
  headerLicense?: VerifiedLicense;
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof IngestError) return failure(error.message);
  throw error;
}

function projectUsage(project: PentahoProject): { files: number; units: number } {
  return {
    files: project.files.length,
    units:
      project.transformations.reduce(
        (sum, transformation) => sum + transformation.steps.length,
        0,
      ) + project.jobs.reduce((sum, job) => sum + job.entries.length, 0),
  };
}

function databaseUsage(project: DatabaseProject): { files: number; units: number } {
  return {
    files: project.files.length,
    units: project.tables.length + project.views.length + project.procedural.length,
  };
}

/** Reject a free-tier call before the expensive work when the project is too large. */
function freeTierGate(
  deps: ServerDeps,
  entitlement: ResolvedEntitlement,
  usage: { files: number; units: number; unitLabel: string },
): CallToolResult | undefined {
  if (entitlement.tier !== "free" || !deps.licensing) return undefined;
  const { files, units, unitLabel } = usage;
  const { maxFiles, maxSteps } = deps.licensing.settings.free;
  if (files <= maxFiles && units <= maxSteps) return undefined;
  return failure(projectLimitMessage(deps.licensing.settings, files, units, unitLabel));
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: deps.licensing?.settings.enforced
        ? `${INSTRUCTIONS} ${LICENSE_INSTRUCTIONS}`
        : INSTRUCTIONS,
    },
  );

  registerAppTool(
    server,
    "analyze_pentaho_project",
    {
      title: "Analyze Pentaho project",
      description:
        "Use this when the user uploads Pentaho Data Integration jobs (.kjb), transformations (.ktr), a repository export or a project ZIP. It parses the files, maps every step to an AWS Glue or manual equivalent, checks connection, path, schedule and dependency risks, scores migration readiness and lists open questions. It never contacts Pentaho, a database or AWS.",
      inputSchema: analyzeInputSchema,
      outputSchema: assessmentOutputSchema,
      annotations: READ_ONLY,
      _meta: {
        ui: { resourceUri: WORKBENCH_UI_URI },
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Analyzing Pentaho project",
        "openai/toolInvocation/invoked": "Analysis ready",
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const entitlement = resolveEntitlement(
          deps.licensing,
          args.license_key,
          deps.headerLicense,
        );
        if (entitlement.error) return failure(entitlement.error);
        const input = await readProjectInput(args.files ?? [], args.inline_files ?? [], {
          allowlist: deps.fileHostAllowlist,
        });
        const project = parsePentahoProject(input.files);
        const gate = freeTierGate(deps, entitlement, {
          ...projectUsage(project),
          unitLabel: "workflow steps",
        });
        if (gate) return gate;
        const assessment = assessProject(project, { projectName: args.project_name });
        return {
          content: [{ type: "text", text: formatAssessment(assessment) }],
          structuredContent: assessment,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "analyze_database_schema",
    {
      title: "Analyze database schema",
      description:
        "Use this when the user uploads database, data warehouse or data lake DDL exports: Oracle, SQL Server, MySQL/MariaDB or PostgreSQL schema scripts, Teradata DDL or BTEQ scripts, Netezza DDL, or Hive/Impala DDL (.sql, .ddl, .hql, .btq, .bteq, .pks, .pkb, .pls or a ZIP). It detects the source engine, inventories tables, views, indexes, sequences, procedural code and Hive table locations, maps every column type to the AWS target (Aurora PostgreSQL, Aurora MySQL, Redshift Serverless, or Athena with Apache Iceberg), scores modernization readiness and lists open questions. It never connects to a database or AWS.",
      inputSchema: databaseAnalyzeInputSchema,
      outputSchema: databaseAssessmentSchema,
      annotations: READ_ONLY,
      _meta: {
        ui: { resourceUri: WORKBENCH_UI_URI },
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Analyzing database schema",
        "openai/toolInvocation/invoked": "Analysis ready",
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const entitlement = resolveEntitlement(
          deps.licensing,
          args.license_key,
          deps.headerLicense,
        );
        if (entitlement.error) return failure(entitlement.error);
        const input = await readProjectInput(args.files ?? [], args.inline_files ?? [], {
          allowlist: deps.fileHostAllowlist,
        });
        const project = parseDatabaseProject(input.files, {
          engine: args.source_engine,
          defaultSchema: args.default_schema,
        });
        const gate = freeTierGate(deps, entitlement, {
          ...databaseUsage(project),
          unitLabel: "schema objects",
        });
        if (gate) return gate;
        const assessment = truncateDatabaseAssessment(
          assessDatabaseProject(project, { projectName: args.project_name }),
        );
        return {
          content: [{ type: "text", text: formatDatabaseAssessment(assessment) }],
          structuredContent: assessment,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "generate_pentaho_migration",
    {
      title: "Generate Pentaho migration bundle",
      description:
        "Use this after analyze_pentaho_project when the user wants deployable AWS artifacts. It generates Glue 6.0 PySpark scripts, Step Functions state machines with JSONata, EventBridge Scheduler schedules, Glue JDBC connections with placeholder Secrets Manager secrets, a migration report and one CloudFormation template, and packages them as a deterministic ZIP. The user deploys the bundle with the AWS CLI; this tool never deploys anything.",
      inputSchema: generateInputSchema,
      outputSchema: bundleSummarySchema,
      annotations: READ_ONLY,
      _meta: {
        ui: { resourceUri: WORKBENCH_UI_URI },
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Generating Pentaho migration bundle",
        "openai/toolInvocation/invoked": "Bundle ready",
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const entitlement = resolveEntitlement(
          deps.licensing,
          args.license_key,
          deps.headerLicense,
        );
        if (entitlement.error) return failure(entitlement.error);
        const input = await readProjectInput(args.files ?? [], args.inline_files ?? [], {
          allowlist: deps.fileHostAllowlist,
        });
        const project = parsePentahoProject(input.files);
        const gate = freeTierGate(deps, entitlement, {
          ...projectUsage(project),
          unitLabel: "workflow steps",
        });
        if (gate) return gate;
        if (entitlement.tier === "free" && deps.licensing) {
          const used = deps.licensing.quota.used();
          if (used >= deps.licensing.settings.free.dailyBundles) {
            return failure(quotaMessage(deps.licensing.settings, used));
          }
        }
        const projectName = args.project_name ?? deriveProjectName(project);
        const bundle = buildMigrationBundle(project, {
          projectName,
          glueVersion: args.glue_version,
          workerType: args.worker_type,
          numberOfWorkers: args.number_of_workers,
          scriptPrefix: "glue/scripts",
          pathMappings: args.path_mappings,
          stepOverrides: args.step_overrides,
          scheduleOverrides: args.schedule_overrides,
          generatedWith: GENERATOR_VERSION,
        });
        let download: { url: string; expiresAt: string } | undefined;
        try {
          const saved = await deps.artifacts.save(bundle);
          if (saved.url) {
            download = { url: saved.url, expiresAt: new Date(saved.expiresAt).toISOString() };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return failure(
            `The bundle was generated but could not be stored for download or file lookup: ${message}. Configure ARTIFACT_STORE and its credentials, or use analyze_pentaho_project only.`,
          );
        }
        const summary = summarizeBundle(bundle, download);
        if (entitlement.tier === "free" && deps.licensing) deps.licensing.quota.record();
        return {
          content: [{ type: "text", text: formatBundleSummary(summary) }],
          structuredContent: summary,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "generate_database_migration",
    {
      title: "Generate database migration bundle",
      description:
        "Use this after analyze_database_schema when the user wants deployable AWS artifacts. It writes target DDL for Aurora PostgreSQL, Aurora MySQL, Redshift Serverless or Athena with Apache Iceberg, data movement artifacts (AWS DMS Serverless table mappings, Teradata or Netezza export scripts with Redshift COPY, or DataSync with Athena load SQL), Step Functions orchestration where needed, a migration report and one CloudFormation template, packaged as a deterministic ZIP. The user deploys the bundle with the AWS CLI; this tool never connects to a database or deploys anything.",
      inputSchema: databaseGenerateInputSchema,
      outputSchema: databaseBundleSummarySchema,
      annotations: READ_ONLY,
      _meta: {
        ui: { resourceUri: WORKBENCH_UI_URI },
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Generating database migration bundle",
        "openai/toolInvocation/invoked": "Bundle ready",
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const entitlement = resolveEntitlement(
          deps.licensing,
          args.license_key,
          deps.headerLicense,
        );
        if (entitlement.error) return failure(entitlement.error);
        const input = await readProjectInput(args.files ?? [], args.inline_files ?? [], {
          allowlist: deps.fileHostAllowlist,
        });
        const project = parseDatabaseProject(input.files, {
          engine: args.source_engine,
          defaultSchema: args.default_schema,
        });
        const gate = freeTierGate(deps, entitlement, {
          ...databaseUsage(project),
          unitLabel: "schema objects",
        });
        if (gate) return gate;
        if (entitlement.tier === "free" && deps.licensing) {
          const used = deps.licensing.quota.used();
          if (used >= deps.licensing.settings.free.dailyBundles) {
            return failure(quotaMessage(deps.licensing.settings, used));
          }
        }
        const projectName = args.project_name ?? deriveDatabaseProjectName(project);
        const bundle: DatabaseBundle = buildDatabaseBundle(project, {
          projectName,
          replicationType: args.replication_type,
          dmsMaxCapacityUnits: args.dms_max_capacity_units,
          generatedWith: GENERATOR_VERSION,
        });
        let download: { url: string; expiresAt: string } | undefined;
        try {
          const saved = await deps.artifacts.save(bundle);
          if (saved.url) {
            download = { url: saved.url, expiresAt: new Date(saved.expiresAt).toISOString() };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return failure(
            `The bundle was generated but could not be stored for download or file lookup: ${message}. Configure ARTIFACT_STORE and its credentials, or use analyze_database_schema only.`,
          );
        }
        const summary = summarizeDatabaseBundle(bundle, download);
        if (entitlement.tier === "free" && deps.licensing) deps.licensing.quota.record();
        return {
          content: [{ type: "text", text: formatDatabaseBundleSummary(summary) }],
          structuredContent: summary,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_migration_file",
    {
      title: "Read generated migration file",
      description:
        "Use this to read a text file from a generated migration bundle, for example migration-report.md, README.md, a Glue PySpark script, a Step Functions JSON definition, SQL scripts and DMS mappings, or the CloudFormation template. Pass the bundle_id from generate_pentaho_migration or generate_database_migration and an exact path from its file list. Large files are truncated, and the bundle expires.",
      inputSchema: getFileInputSchema,
      outputSchema: migrationFileSchema,
      annotations: READ_ONLY,
    },
    async (args): Promise<CallToolResult> => {
      const bundle = await deps.artifacts.load(args.bundle_id);
      if (!bundle) {
        return failure(
          `Bundle ${args.bundle_id} was not found or has expired. Run generate_pentaho_migration again.`,
        );
      }
      const path = args.path.replaceAll("\\", "/").replace(/^\/+/, "");
      const content = bundle.contents[path];
      const file = bundle.files.find((candidate) => candidate.path === path);
      if (content === undefined || !file) {
        const available = bundle.files.map((candidate) => candidate.path).join(", ");
        return failure(
          `"${args.path}" is not a file in bundle ${args.bundle_id}. Available files: ${available}.`,
        );
      }
      const truncated = content.length > MAX_FILE_CHARS;
      const body = truncated ? content.slice(0, MAX_FILE_CHARS) : content;
      const result: MigrationFileResult = {
        bundle_id: bundle.id,
        path,
        kind: file.kind,
        bytes: file.bytes,
        sha256: file.sha256,
        content: body,
        truncated,
      };
      return {
        content: [
          {
            type: "text",
            text: formatMigrationFile(result, Buffer.byteLength(body, "utf8")),
          },
        ],
        structuredContent: result,
      };
    },
  );

  registerAppResource(
    server,
    "Data Modernizer workbench",
    WORKBENCH_UI_URI,
    {
      description:
        "Readiness dashboard, mapping coverage, flow graphs and generated bundle files for Pentaho, database, data warehouse and data lake modernization.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: WORKBENCH_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await deps.loadWidgetHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              ...(deps.widgetDomain ? { domain: deps.widgetDomain } : {}),
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  return server;
}
