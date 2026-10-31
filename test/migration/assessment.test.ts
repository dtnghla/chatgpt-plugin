import { describe, expect, it } from "vitest";
import type { InputFile } from "../../src/ingest/types.js";
import { assessProject, deriveProjectName, slugify } from "../../src/migration/assessment.js";
import { buildFlows } from "../../src/migration/flow.js";
import { parsePentahoProject } from "../../src/pentaho/parse.js";
import { fixtureFiles, RETAIL_OPTIONS } from "../helpers.js";

const FILES = fixtureFiles();
const PROJECT = parsePentahoProject(FILES);

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function file(path: string, content: string): InputFile {
  return { path, data: encode(content) };
}

function projectWith(...files: InputFile[]) {
  return parsePentahoProject(files);
}

describe("assessProject", () => {
  const noMappings = assessProject(PROJECT);
  const mapped = assessProject(PROJECT, {
    projectName: "retail",
    pathMappings: [...RETAIL_OPTIONS.pathMappings],
  });

  it("counts the project inventory", () => {
    expect(noMappings.projectName).toBe("repo-dim");
    expect(mapped.projectName).toBe("retail");
    expect(mapped.totals).toEqual({
      files: 7,
      transformations: 4,
      jobs: 3,
      steps: 18,
      jobEntries: 20,
      connections: 2,
      schedules: 1,
      warnings: 2,
      supportedStepTypes: 16,
      partialStepTypes: 3,
      unsupportedStepTypes: 0,
    });
    expect(mapped.files).toHaveLength(7);
  });

  it("summarizes step and job-entry coverage", () => {
    const byType = new Map(mapped.stepCoverage.map((coverage) => [coverage.type, coverage]));
    expect(byType.get("CsvInput")).toMatchObject({
      count: 1,
      status: "automatic",
      supported: true,
    });
    expect(byType.get("GetVariable")).toMatchObject({
      count: 1,
      status: "partial",
      supported: true,
    });
    expect(byType.get("ExcelInput")).toMatchObject({ count: 1, status: "partial" });
    expect(byType.get("TableOutput")).toMatchObject({ count: 1, status: "automatic" });
    expect(byType.get("CsvInput")?.caveat).toBeUndefined();
    expect(byType.get("GetVariable")?.caveat).toBeTruthy();
    expect(mapped.unsupportedSteps).toEqual([]);
    expect(mapped.partialSteps.map((step) => `${step.file}:${step.step}`)).toEqual([
      "transforms/customers.ktr:Get run date",
      "transforms/exports.ktr:Read workbook",
      "transforms/exports.ktr:Write workbook",
    ]);

    const entries = new Map(mapped.jobEntryCoverage.map((coverage) => [coverage.type, coverage]));
    expect(entries.get("SPECIAL")).toMatchObject({ count: 8, status: "automatic", mapped: true });
    expect(entries.get("TRANS")).toMatchObject({ count: 4, status: "automatic" });
    expect(entries.get("SQL")).toMatchObject({ count: 1, status: "partial", mapped: true });
    expect(entries.get("FILE_EXISTS")).toMatchObject({ count: 1, status: "partial" });
    expect(mapped.jobEntryCoverage.map((coverage) => coverage.type)).toEqual([
      "SPECIAL",
      "TRANS",
      "EVAL",
      "FILE_EXISTS",
      "JOB",
      "MAIL",
      "SET_VARIABLES",
      "SQL",
      "WAIT",
      "WRITE_TO_LOG",
    ]);
  });

  it("resolves job dependencies on uploaded transformations and jobs", () => {
    expect(mapped.dependencies).toHaveLength(5);
    expect(mapped.dependencies.every((dependency) => dependency.resolved)).toBe(true);
    expect(
      mapped.dependencies.map((dependency) => `${dependency.fromFile}:${dependency.entry}`),
    ).toEqual([
      "jobs/nightly.kjb:Load customers",
      "jobs/nightly.kjb:Load orders",
      "jobs/nightly.kjb:Publish export",
      "jobs/nightly.kjb:Run child job",
      "repository-export.xml:Build dimension",
    ]);
    expect(
      mapped.dependencies.filter((dependency) => dependency.kind === "transformation"),
    ).toHaveLength(4);
    expect(
      mapped.dependencies.find((dependency) => dependency.entry === "Run child job"),
    ).toMatchObject({ kind: "job", target: "child", resolved: true });
  });

  it("summarizes connections without leaking passwords", () => {
    expect(mapped.connections.map((connection) => connection.name)).toEqual([
      "landing",
      "warehouse",
    ]);
    const warehouse = mapped.connections.find((connection) => connection.name === "warehouse");
    expect(warehouse).toMatchObject({
      type: "POSTGRESQL",
      host: "${DB_HOST}",
      jdbcUrl: "jdbc:postgresql://REPLACE_ME:5432/retail",
      driver: "org.postgresql.Driver",
      secretName: "WAREHOUSE_JDBC",
      hasPassword: true,
    });
    expect(warehouse?.warnings).toEqual([
      "The source password was removed. Put the real credentials in the generated Secrets Manager secret.",
    ]);
    expect(warehouse?.files).toEqual([
      "jobs/nightly.kjb",
      "transforms/customers.ktr",
      "transforms/orders.ktr",
    ]);
    const landing = mapped.connections.find((connection) => connection.name === "landing");
    expect(landing?.jdbcUrl).toBe("jdbc:generic://s3.amazonaws.com/retail-landing");
    expect(landing?.hasPassword).toBe(false);
    expect(JSON.stringify(mapped)).not.toContain("Encrypted 2be98");
  });

  it("maps schedules to UTC cron expressions", () => {
    expect(mapped.schedules).toHaveLength(1);
    expect(mapped.schedules[0]).toMatchObject({
      job: "nightly_load",
      entry: "Start",
      pdiSchedulerType: 2,
      mapped: true,
      expression: "cron(15 2 * * ? *)",
      description: "Daily at 02:15",
    });
    expect(mapped.schedules[0]?.note).toMatch(/UTC/);
    expect(mapped.risks.some((risk) => risk.code === "schedule_timezone")).toBe(true);
  });

  it("collects parameters and variables across files", () => {
    expect(mapped.parameters.map((parameter) => parameter.name)).toEqual([
      "REPORT_DATE",
      "RUN_DATE",
    ]);
    expect(mapped.parameters[0]?.files).toEqual(["transforms/exports.ktr"]);
    expect(mapped.parameters[1]?.files).toEqual(["jobs/nightly.kjb", "transforms/customers.ktr"]);
    expect(mapped.variables).toContain("DB_HOST");
    expect(mapped.variables).toContain("Internal.Job.Filename.Directory");
    expect(mapped.variables).toContain("RUN_DATE");
  });

  it("flags placeholder endpoints and unmapped paths", () => {
    const codes = new Set(noMappings.risks.map((risk) => risk.code));
    expect(codes).toContain("local_paths");
    expect(codes).toContain("partial_step");
    expect(codes).toContain("project_warning");
    expect(codes).toContain("schedule_timezone");
    const localPaths = noMappings.risks.find((risk) => risk.code === "local_paths");
    expect(localPaths?.message).toContain("/opt/retail/data/orders_summary.csv");
    expect(localPaths?.message).toContain("s3://<DataBucket>/unmapped/");

    expect(noMappings.readiness).toMatchObject({ score: 82, level: "review" });
    expect(noMappings.readiness.blockers).toEqual([
      "1 connection still contains a placeholder endpoint.",
    ]);
    expect(mapped.readiness).toMatchObject({ score: 84, level: "review" });
    expect(new Set(mapped.risks.map((risk) => risk.code))).not.toContain("local_paths");
  });

  it("asks focused follow-up questions", () => {
    expect(noMappings.questions).toHaveLength(4);
    expect(noMappings.questions.join("\n")).toMatch(
      /host and database for the placeholder connection warehouse/,
    );
    expect(noMappings.questions.join("\n")).toMatch(/Which S3 prefixes/);
    expect(noMappings.questions.join("\n")).toMatch(/UTC/);
    expect(noMappings.questions.join("\n")).toMatch(/DB_HOST/);
    expect(mapped.questions).toHaveLength(3);
    expect(mapped.questions.join("\n")).not.toMatch(/Which S3 prefixes/);
  });

  it("marks projects ready when every step is automatic", () => {
    const clean = projectWith(
      file(
        "clean.ktr",
        `<?xml version="1.0"?><transformation><info><name>clean</name></info><step><name>Start</name><type>Dummy</type></step></transformation>`,
      ),
    );
    const assessment = assessProject(clean);
    expect(assessment.totals.unsupportedStepTypes).toBe(0);
    expect(assessment.risks).toEqual([]);
    expect(assessment.readiness).toMatchObject({ score: 100, level: "ready", blockers: [] });
  });

  it("reports manual steps as blockers", () => {
    const manual = projectWith(
      file(
        "script.ktr",
        `<?xml version="1.0"?>
<transformation>
  <info><name>script</name></info>
  <step><name>Start</name><type>Dummy</type></step>
  <step><name>Custom logic</name><type>JavaScript</type></step>
  <order><hop><from>Start</from><to>Custom logic</to><enabled>Y</enabled></hop></order>
</transformation>`,
      ),
    );
    const assessment = assessProject(manual);
    expect(assessment.unsupportedSteps).toEqual([
      {
        file: "script.ktr",
        transformation: "script",
        step: "Custom logic",
        type: "JavaScript",
        status: "manual",
      },
    ]);
    expect(assessment.readiness.blockers).toEqual(["1 step needs a manual rewrite."]);
    expect(assessment.readiness.level).toBe("review");
    expect(assessment.risks.some((risk) => risk.code === "manual_step")).toBe(true);
    expect(assessment.questions.join("\n")).toMatch(/manual step \(JavaScript\)/);
  });
});

describe("project naming", () => {
  it("slugifies requested names and falls back safely", () => {
    expect(slugify("  Retail Ops!  ")).toBe("retail-ops");
    expect(slugify("***")).toBe("pentaho-migration");
    expect(slugify("x".repeat(80))).toHaveLength(48);
    expect(deriveProjectName(PROJECT, "My Migration")).toBe("my-migration");
  });

  it("uses a shared top-level directory or the first object name", () => {
    const nested = projectWith(
      file(
        "retail/retail.ktr",
        `<?xml version="1.0"?><transformation><info><name>inside</name></info><step><name>Start</name><type>Dummy</type></step></transformation>`,
      ),
      file("retail/kettle.properties", "A=1\n"),
    );
    expect(deriveProjectName(nested)).toBe("retail");
  });
});

describe("buildFlows", () => {
  const flows = buildFlows(PROJECT);

  it("creates transformation and job graphs with conversion statuses", () => {
    expect(flows.map((flow) => `${flow.kind}:${flow.name}`)).toEqual([
      "job:child",
      "job:nightly_load",
      "transformation:repo_dim",
      "job:repo_job",
      "transformation:customers",
      "transformation:exports",
      "transformation:orders",
    ]);
    const customers = flows.find((flow) => flow.name === "customers");
    expect(customers?.nodes).toHaveLength(8);
    expect(customers?.edges).toHaveLength(7);
    expect(customers?.nodes.every((node) => node.x >= 0 && node.y >= 0)).toBe(true);
    const get = customers?.nodes.find((node) => node.name === "Get run date");
    expect(get?.status).toBe("partial");
    expect(customers?.nodes.find((node) => node.name === "Read customers")?.status).toBe(
      "automatic",
    );
  });

  it("marks failed hops so the workbench can draw them separately", () => {
    const nightly = flows.find((flow) => flow.name === "nightly_load");
    expect(nightly?.edges).toHaveLength(15);
    expect(nightly?.edges.filter((edge) => edge.failure)).toHaveLength(7);
    const failed = nightly?.edges.find((edge) => edge.to === "Failure");
    expect(failed).toMatchObject({ enabled: true, failure: true });
  });
});
