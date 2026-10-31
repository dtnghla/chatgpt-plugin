import type { CallToolResult, Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactService, MemoryArtifactBackend } from "../../src/artifacts/store.js";
import { SERVER_NAME, SERVER_VERSION, WORKBENCH_UI_URI } from "../../src/server.js";
import {
  assessmentOutputSchema,
  bundleSummarySchema,
  migrationFileSchema,
} from "../../src/tools/schemas.js";
import { fixtureZipBase64, inlineFixtureFiles } from "../helpers.js";
import { connectClient, type Era, type RunningServer, startServer } from "./harness.js";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function metaOf(tool: { _meta?: Record<string, unknown> }): Record<string, unknown> {
  return tool._meta ?? {};
}

describe.each<Era>(["legacy", "modern"])("%s protocol era", (era) => {
  let server: RunningServer;
  let client: Client;
  let artifacts: ArtifactService;

  beforeAll(async () => {
    artifacts = new ArtifactService(new MemoryArtifactBackend(), {
      publicBaseUrl: "https://migration.example.com",
      signingSecret: "mcp-test-signing-secret",
      ttlSeconds: 900,
    });
    server = await startServer({}, { artifacts });
    client = await connectClient(server.mcpUrl, era);
    await client.listTools();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("exposes the server identity and safety instructions", () => {
    expect(client.getServerVersion()).toMatchObject({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("read-only");
    expect(instructions).toContain("never asks for AWS credentials");
    expect(instructions).toContain("deploys the bundle with the AWS CLI");
    expect(instructions).toContain("Never ask for a password");
  });

  it("lists exactly the read-only migration tools with widget metadata", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "analyze_pentaho_project",
      "generate_aws_migration",
      "get_migration_file",
    ]);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
    const analyze = tools.find((tool) => tool.name === "analyze_pentaho_project");
    const generate = tools.find((tool) => tool.name === "generate_aws_migration");
    const read = tools.find((tool) => tool.name === "get_migration_file");
    for (const tool of [analyze, generate]) {
      expect(tool).toBeDefined();
      const meta = metaOf(tool ?? {});
      expect(meta.ui).toEqual({ resourceUri: WORKBENCH_UI_URI });
      expect(meta["openai/fileParams"]).toEqual(["files"]);
      expect(meta["openai/toolInvocation/invoking"]).toBeTypeOf("string");
    }
    expect(metaOf(read ?? {}).ui).toBeUndefined();
    expect(analyze?.inputSchema).toMatchObject({ type: "object" });
    expect(generate?.inputSchema).toMatchObject({ type: "object" });
    expect(read?.inputSchema).toMatchObject({ type: "object" });
  });

  it("serves the workbench resource with a locked-down CSP", async () => {
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain(WORKBENCH_UI_URI);
    const result = await client.readResource({ uri: WORKBENCH_UI_URI });
    const content = result.contents[0];
    expect(content?.uri).toBe(WORKBENCH_UI_URI);
    expect(content?.mimeType).toContain("text/html");
    expect(content && "text" in content ? content.text : "").toContain(
      "Pentaho migration workbench",
    );
    const meta = (content?._meta ?? {}) as Record<string, unknown>;
    expect(meta.ui).toMatchObject({
      prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [] },
    });
  });

  it("analyzes inline Pentaho files", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: { inline_files: inlineFixtureFiles() },
    });
    expect(result.isError).toBeFalsy();
    const assessment = assessmentOutputSchema.parse(result.structuredContent);
    expect(assessment.projectName).toBe("repo-dim");
    expect(assessment.totals).toMatchObject({
      files: 7,
      transformations: 4,
      jobs: 3,
      steps: 18,
      jobEntries: 20,
      connections: 2,
      schedules: 1,
    });
    expect(assessment.readiness.level).toBe("review");
    expect(assessment.connections.map((connection) => connection.name).sort()).toEqual([
      "landing",
      "warehouse",
    ]);
    const text = textOf(result);
    expect(text).toContain('Pentaho project "repo-dim"');
    expect(text).toContain("Call generate_aws_migration");
    expect(text).not.toContain("SuperSecret!23");
    expect(text).not.toContain("WAREHOUSE_JDBC");
  });

  it("analyzes a project ZIP and honours project_name", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: {
        inline_files: [{ name: "retail.zip", content_base64: fixtureZipBase64() }],
        project_name: "Retail Warehouse",
      },
    });
    expect(result.isError).toBeFalsy();
    const assessment = assessmentOutputSchema.parse(result.structuredContent);
    expect(assessment.projectName).toBe("retail-warehouse");
    expect(assessment.totals.files).toBe(7);
  });

  it("returns a tool error when no files are provided", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Provide at least one Pentaho file");
  });

  it("returns a tool error for unusable inline content", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: {
        inline_files: [{ name: "notes.md", content: "# not a Pentaho file" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No Pentaho transformations or jobs were found");
  });

  it("generates a bundle, exposes a signed download and reads files", async () => {
    const result = await client.callTool({
      name: "generate_aws_migration",
      arguments: {
        inline_files: inlineFixtureFiles(),
        project_name: "retail-mcp",
        glue_version: "5.1",
        worker_type: "G.2X",
        number_of_workers: 3,
        path_mappings: [{ from: "/opt/retail/data", to: "s3://migration-data/retail" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const summary = bundleSummarySchema.parse(result.structuredContent);
    expect(summary.bundle_id).toMatch(/^[a-f0-9]{16}$/);
    expect(summary.project_name).toBe("retail-mcp");
    expect(summary.readiness.level).toBe("review");
    expect(summary.files).toHaveLength(12);
    expect(summary.jobs).toHaveLength(4);
    expect(summary.state_machines).toHaveLength(3);
    expect(summary.download_url).toContain(
      `https://migration.example.com/artifacts/${summary.bundle_id}/download?expires=`,
    );
    expect(summary.download_url).toContain("signature=");
    expect(summary.download_expires_at).toBeTruthy();
    expect(textOf(result)).toContain(`Generated bundle ${summary.bundle_id}`);

    const manifestResult = await client.callTool({
      name: "get_migration_file",
      arguments: { bundle_id: summary.bundle_id, path: "manifest.json" },
    });
    expect(manifestResult.isError).toBeFalsy();
    const file = migrationFileSchema.parse(manifestResult.structuredContent);
    expect(file.kind).toBe("json");
    expect(file.truncated).toBe(false);
    const manifest = JSON.parse(file.content) as {
      glue_version: string;
      worker_type: string;
      number_of_workers: number;
      project: string;
      files: { path: string }[];
      warnings: string[];
    };
    expect(manifest.glue_version).toBe("5.1");
    expect(manifest.worker_type).toBe("G.2X");
    expect(manifest.number_of_workers).toBe(3);
    expect(manifest.project).toBe("retail-mcp");
    expect(manifest.files).toHaveLength(11);
    expect(manifest.files.some((entry) => entry.path === "glue/scripts/retail-mcp-orders.py")).toBe(
      true,
    );

    const readme = await client.callTool({
      name: "get_migration_file",
      arguments: { bundle_id: summary.bundle_id, path: "README.md" },
    });
    expect(readme.isError).toBeFalsy();
    const readmeFile = migrationFileSchema.parse(readme.structuredContent);
    expect(readmeFile.kind).toBe("markdown");
    expect(readmeFile.content).toContain("retail-mcp");
    expect(readmeFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(textOf(readme)).toContain(`README.md (markdown`);
  });

  it("normalizes path separators when reading a file", async () => {
    const generated = bundleSummarySchema.parse(
      (
        await client.callTool({
          name: "generate_aws_migration",
          arguments: { inline_files: inlineFixtureFiles(), project_name: "read-paths" },
        })
      ).structuredContent,
    );
    const result = await client.callTool({
      name: "get_migration_file",
      arguments: { bundle_id: generated.bundle_id, path: "\\README.md" },
    });
    expect(result.isError).toBeFalsy();
    expect(migrationFileSchema.parse(result.structuredContent).path).toBe("README.md");
  });

  it("returns tool errors for unknown bundles, files and traversal attempts", async () => {
    const unknown = await client.callTool({
      name: "get_migration_file",
      arguments: { bundle_id: "0000000000000000", path: "README.md" },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("was not found or has expired");

    const generated = bundleSummarySchema.parse(
      (
        await client.callTool({
          name: "generate_aws_migration",
          arguments: { inline_files: inlineFixtureFiles(), project_name: "errors" },
        })
      ).structuredContent,
    );
    const missing = await client.callTool({
      name: "get_migration_file",
      arguments: { bundle_id: generated.bundle_id, path: "does-not-exist.py" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Available files:");

    const traversal = await client.callTool({
      name: "get_migration_file",
      arguments: { bundle_id: generated.bundle_id, path: "../../etc/passwd" },
    });
    expect(traversal.isError).toBe(true);
    expect(textOf(traversal)).toContain("Available files:");
    expect(textOf(traversal)).not.toContain("root:");
  });
});
