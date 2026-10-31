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
import { IngestError, readProjectInput } from "./ingest/index.js";
import { assessProject, deriveProjectName } from "./migration/assessment.js";
import { buildMigrationBundle, summarizeBundle } from "./migration/bundle.js";
import type { MigrationFileResult } from "./migration/types.js";
import { parsePentahoProject } from "./pentaho/parse.js";
import { formatAssessment, formatBundleSummary, formatMigrationFile } from "./tools/format.js";
import {
  analyzeInputSchema,
  assessmentOutputSchema,
  bundleSummarySchema,
  generateInputSchema,
  getFileInputSchema,
  migrationFileSchema,
} from "./tools/schemas.js";

export const SERVER_NAME = "pentaho-to-aws";
export const SERVER_VERSION = "1.0.0";
export const WORKBENCH_UI_URI = "ui://pentaho-to-aws/workbench-v1.html";
export const GENERATOR_VERSION = "pentaho-to-aws 1.0.0";

const MAX_FILE_CHARS = 120_000;

const INSTRUCTIONS = [
  "This server analyzes Pentaho Data Integration files and generates an AWS migration bundle. Every tool is read-only: it never calls AWS, never asks for AWS credentials, and never stores or prints database passwords.",
  "Start with analyze_pentaho_project when the user uploads .ktr/.kjb files, a repository export or a project ZIP. Summarize the readiness score, manual steps, placeholder connections and open questions honestly; do not claim the project will run unchanged.",
  "Call generate_aws_migration only after the analysis. It produces Glue scripts, Step Functions definitions, EventBridge schedules and one CloudFormation template. The user deploys the bundle with the AWS CLI; this server cannot deploy it.",
  "Never ask for a password, access key, secret key or session token. If a connection needs credentials, tell the user to replace the generated Secrets Manager placeholders themselves after deployment.",
  "Download URLs supplied by the host are fetched only over HTTPS from an allowlisted host. Do not invent file contents; if a file cannot be read, report the error.",
  "Use get_migration_file to quote or inspect generated text files. The returned bundle expires; regenerate it if the download or file lookup has expired.",
].join(" ");

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
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof IngestError) return failure(error.message);
  throw error;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
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
        const input = await readProjectInput(args.files ?? [], args.inline_files ?? [], {
          allowlist: deps.fileHostAllowlist,
        });
        const project = parsePentahoProject(input.files);
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
    "generate_aws_migration",
    {
      title: "Generate AWS migration bundle",
      description:
        "Use this after analyze_pentaho_project when the user wants deployable AWS artifacts. It generates Glue 6.0 PySpark scripts, Step Functions state machines with JSONata, EventBridge Scheduler schedules, Glue JDBC connections with placeholder Secrets Manager secrets, a migration report and one CloudFormation template, and packages them as a deterministic ZIP. The user deploys the bundle with the AWS CLI; this tool never deploys anything.",
      inputSchema: generateInputSchema,
      outputSchema: bundleSummarySchema,
      annotations: READ_ONLY,
      _meta: {
        ui: { resourceUri: WORKBENCH_UI_URI },
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Generating AWS migration bundle",
        "openai/toolInvocation/invoked": "Bundle ready",
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const input = await readProjectInput(args.files ?? [], args.inline_files ?? [], {
          allowlist: deps.fileHostAllowlist,
        });
        const project = parsePentahoProject(input.files);
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
        return {
          content: [{ type: "text", text: formatBundleSummary(summary) }],
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
        "Use this to read a text file from a generated migration bundle, for example migration-report.md, README.md, a Glue PySpark script, a Step Functions JSON definition or the CloudFormation template. Pass the bundle_id from generate_aws_migration and an exact path from its file list. Large files are truncated, and the bundle expires.",
      inputSchema: getFileInputSchema,
      outputSchema: migrationFileSchema,
      annotations: READ_ONLY,
    },
    async (args): Promise<CallToolResult> => {
      const bundle = await deps.artifacts.load(args.bundle_id);
      if (!bundle) {
        return failure(
          `Bundle ${args.bundle_id} was not found or has expired. Run generate_aws_migration again.`,
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
    "Pentaho migration workbench",
    WORKBENCH_UI_URI,
    {
      description:
        "Readiness dashboard, step-mapping coverage, flow graphs and generated bundle file list for a Pentaho migration.",
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
