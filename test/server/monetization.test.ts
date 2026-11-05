import type { CallToolResult } from "@modelcontextprotocol/client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateLicenseKey } from "../../src/licensing/license.js";
import { assessmentOutputSchema } from "../../src/tools/schemas.js";
import { inlineFixtureFiles } from "../helpers.js";
import { connectClient, type RunningServer, startServer } from "./harness.js";

const SECRET = "monetization-mcp-test-secret";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function connectWithLicenseHeader(url: URL, key: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "x-pentaho-license-key": key } },
    }),
  );
  return client;
}

describe("enforced licensing", () => {
  let server: RunningServer;
  let client: Client;
  const proKey = generateLicenseKey({ subject: "buyer@example.com" }, SECRET);
  const expiredKey = generateLicenseKey(
    { days: 1, issuedAt: Math.floor(Date.now() / 1000) - 2 * 86_400 },
    SECRET,
  );
  const singleTransform = inlineFixtureFiles().filter(
    (file) => file.name === "transforms/customers.ktr",
  );

  beforeAll(async () => {
    server = await startServer({
      licenseMode: "enforced",
      licenseSigningSecret: SECRET,
      upgradeUrl: "https://buy.example.com/pro",
      freeMaxFiles: 2,
      freeMaxSteps: 10,
      freeDailyBundles: 2,
    });
    client = await connectClient(server.mcpUrl, "modern");
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("tells the user about the free tier limits and the upgrade URL", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: { inline_files: inlineFixtureFiles() },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("free tier limit: 2");
    expect(text).toContain("workflow steps");
    expect(text).toContain("license_key");
    expect(text).toContain("https://buy.example.com/pro");
  });

  it("mentions the license_key argument in the server instructions", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("free-tier limits");
    expect(instructions).toContain("license_key");
  });

  it("unlocks the tools for a valid license key argument", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: { inline_files: inlineFixtureFiles(), license_key: proKey },
    });
    expect(result.isError).toBeFalsy();
    const assessment = assessmentOutputSchema.parse(result.structuredContent);
    expect(assessment.totals.files).toBe(7);
  });

  it("rejects an invalid license key with a clear message", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: {
        inline_files: inlineFixtureFiles(),
        license_key: "PTA1.BOGUS.BOGUS",
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a valid license");
  });

  it("rejects an expired license key", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: { inline_files: singleTransform, license_key: expiredKey },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a valid license");
  });

  it("stops free bundle generation after the daily quota", async () => {
    const arguments_ = { inline_files: singleTransform };
    for (let index = 0; index < 2; index += 1) {
      const result = await client.callTool({
        name: "generate_aws_migration",
        arguments: arguments_,
      });
      expect(result.isError, `generation ${index + 1}`).toBeFalsy();
    }
    const exhausted = await client.callTool({
      name: "generate_aws_migration",
      arguments: arguments_,
    });
    expect(exhausted.isError).toBe(true);
    expect(textOf(exhausted)).toContain("limited to 2 per rolling 24 hours (2 used)");
    expect(textOf(exhausted)).toContain("https://buy.example.com/pro");

    const withKey = await client.callTool({
      name: "generate_aws_migration",
      arguments: { ...arguments_, license_key: proKey },
    });
    expect(withKey.isError).toBeFalsy();
  });

  it("unlocks the tools through the license header", async () => {
    const headerClient = await connectWithLicenseHeader(server.mcpUrl, proKey);
    try {
      const result = await headerClient.callTool({
        name: "analyze_pentaho_project",
        arguments: { inline_files: inlineFixtureFiles() },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await headerClient.close();
    }
  });
});

describe("licensing disabled (default)", () => {
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    server = await startServer({ licenseMode: "off" });
    client = await connectClient(server.mcpUrl, "modern");
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("analyzes the whole fixture without a license key", async () => {
    const result = await client.callTool({
      name: "analyze_pentaho_project",
      arguments: { inline_files: inlineFixtureFiles() },
    });
    expect(result.isError).toBeFalsy();
    const assessment = assessmentOutputSchema.parse(result.structuredContent);
    expect(assessment.totals.files).toBe(7);
  });

  it("never enforces a bundle quota", async () => {
    const singleTransform = inlineFixtureFiles().filter(
      (file) => file.name === "transforms/customers.ktr",
    );
    for (let index = 0; index < 5; index += 1) {
      const result = await client.callTool({
        name: "generate_aws_migration",
        arguments: { inline_files: singleTransform },
      });
      expect(result.isError, `generation ${index + 1}`).toBeFalsy();
    }
  });

  it("keeps the base instructions without license wording", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).not.toContain("free-tier limits");
  });
});
