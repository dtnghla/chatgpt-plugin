import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { InputFile } from "../../src/ingest/types.js";
import {
  buildMigrationBundle,
  createPathMapper,
  summarizeBundle,
} from "../../src/migration/bundle.js";
import type { GeneratedBundleOptions, MigrationBundle } from "../../src/migration/types.js";
import { parsePentahoProject } from "../../src/pentaho/parse.js";
import { fixtureFiles, RETAIL_OPTIONS } from "../helpers.js";

const PROJECT = parsePentahoProject(fixtureFiles());

function build(overrides: Partial<GeneratedBundleOptions> = {}): MigrationBundle {
  return buildMigrationBundle(PROJECT, { ...RETAIL_OPTIONS, ...overrides });
}

const BUNDLE = build();

function parseJson<T = Record<string, unknown>>(value: string | undefined, name: string): T {
  expect(value, `${name} should exist`).toBeTruthy();
  return JSON.parse(value ?? "{}") as T;
}

interface CfnTemplate {
  Parameters: Record<string, unknown>;
  Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  Outputs: Record<string, unknown>;
}

describe("buildMigrationBundle", () => {
  it("produces the expected deterministic bundle layout", () => {
    expect(BUNDLE.projectName).toBe("retail");
    expect(BUNDLE.id).toMatch(/^[a-f0-9]{16}$/);
    expect(BUNDLE.files.map((file) => file.path)).toEqual([
      "README.md",
      "cloudformation/pentaho-migration.yaml",
      "glue/scripts/retail-customers.py",
      "glue/scripts/retail-exports.py",
      "glue/scripts/retail-orders.py",
      "glue/scripts/retail-repo-dim.py",
      "glue/scripts/retail-sql-runner.py",
      "manifest.json",
      "migration-report.md",
      "stepfunctions/retail-child.json",
      "stepfunctions/retail-nightly-load.json",
      "stepfunctions/retail-repo-job.json",
    ]);
    expect(BUNDLE.files.map((file) => file.kind)).toEqual([
      "markdown",
      "cloudformation",
      "python",
      "python",
      "python",
      "python",
      "python",
      "json",
      "markdown",
      "asl",
      "asl",
      "asl",
    ]);
    for (const file of BUNDLE.files) {
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(BUNDLE.contents[file.path]?.endsWith("\n")).toBe(true);
    }
    expect(Object.keys(BUNDLE.contents).sort()).toEqual(BUNDLE.files.map((file) => file.path));
    expect(BUNDLE.files.map((file) => file.path)).toMatchSnapshot("bundle-files");
  });

  it("is byte-identical for identical inputs and options", () => {
    const first = build();
    const second = build();
    expect(second.id).toBe(first.id);
    expect(second.zip).toEqual(first.zip);
    expect(second.files).toEqual(first.files);
    expect(second.contents).toEqual(first.contents);
    const changed = build({ numberOfWorkers: 10 });
    expect(changed.id).not.toBe(first.id);
    const remapped = build({
      pathMappings: [{ from: "/opt/retail/data", to: "s3://${DataBucket}/different" }],
    });
    expect(remapped.id).not.toBe(first.id);
  });

  it("creates a safe zip whose entries match the recorded contents", () => {
    const unpacked = unzipSync(BUNDLE.zip);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(Object.keys(unpacked).sort()).toEqual(BUNDLE.files.map((file) => file.path));
    for (const file of BUNDLE.files) {
      const data = unpacked[file.path];
      expect(data, file.path).toBeDefined();
      expect(decoder.decode(data)).toBe(BUNDLE.contents[file.path]);
      expect(file.path.startsWith("/")).toBe(false);
      expect(file.path.split("/")).not.toContain("..");
      expect(file.path).not.toContain("\\");
    }
  });

  it("writes a manifest that matches every bundled file", () => {
    const manifest = parseJson<{
      bundle_format: number;
      generator: string;
      project: string;
      glue_version: string;
      worker_type: string;
      number_of_workers: number;
      source_files: { path: string; kind: string; bytes: number; sha256: string }[];
      files: { path: string; bytes: number; sha256: string }[];
      warnings: string[];
    }>(BUNDLE.contents["manifest.json"], "manifest.json");
    expect(manifest.bundle_format).toBe(1);
    expect(manifest.generator).toBe("pentaho-to-aws 1.0.0");
    expect(manifest.project).toBe("retail");
    expect(manifest.glue_version).toBe("6.0");
    expect(manifest.worker_type).toBe("G.1X");
    expect(manifest.number_of_workers).toBe(2);
    expect(manifest.source_files).toHaveLength(7);
    expect(manifest.source_files).toEqual(BUNDLE.assessment.files);
    expect(manifest.files).toHaveLength(BUNDLE.files.length - 1);
    const byPath = new Map(BUNDLE.files.map((file) => [file.path, file]));
    for (const entry of manifest.files) {
      expect(byPath.get(entry.path)).toMatchObject({
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    }
    expect(manifest.warnings).toEqual(BUNDLE.warnings);
  });

  it("never embeds source secrets in any generated file", () => {
    const everything = Object.values(BUNDLE.contents).join("\n");
    expect(everything).not.toContain("SuperSecret!23");
    expect(everything).not.toContain("abc123token");
    expect(everything).not.toContain("Encrypted 2be98");
    expect(everything).not.toMatch(/aws_access_key_id|aws_secret_access_key/i);
    expect(everything).not.toMatch(/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
  });

  it("generates Glue scripts with the expected conversions", () => {
    const customers = BUNDLE.contents["glue/scripts/retail-customers.py"] ?? "";
    expect(customers).toContain("from awsglue.job import Job");
    expect(customers).toContain("job.init(JOB_NAME, ARGS)");
    expect(customers).toContain("job.commit()");
    expect(customers).toContain("secretsmanager");
    expect(customers).toContain("customers.csv");
    expect(customers).toContain('F.col("country") != "XX"');
    expect(customers).toContain(
      'withColumn("loyalty_score", F.col("lifetime_value") * F.lit(0.1))',
    );
    expect(customers).toContain('dropDuplicates(["customer_id"])');
    expect(customers).toContain(
      'write_jdbc(df_Deduplicate_esw2oa, "dim_customers", "WAREHOUSE", True)',
    );
    expect(customers).toContain(
      'PATH_MAPPINGS = [["/opt/retail/data","s3://${DataBucket}/retail"]]',
    );

    const orders = BUNDLE.contents["glue/scripts/retail-orders.py"] ?? "";
    expect(orders).toContain("read_jdbc(");
    expect(orders).toContain("WHERE order_date >= '${RUN_DATE}'");
    expect(orders).toContain('groupBy(F.col("country"))');
    expect(orders).toContain('pdi_path("/opt/retail/data/orders_summary.csv", "OUTPUT_BASE_PATH")');

    const exports = BUNDLE.contents["glue/scripts/retail-exports.py"] ?? "";
    expect(exports).toContain("read_excel(");
    expect(exports).toContain("write_excel(");
    expect(exports).toContain("/opt/retail/reports/sales_${REPORT_DATE}_published.xlsx");

    const repo = BUNDLE.contents["glue/scripts/retail-repo-dim.py"] ?? "";
    expect(repo).toContain("spark.range(10)");
    expect(repo).toContain('"source_system"');

    const runner = BUNDLE.contents["glue/scripts/retail-sql-runner.py"] ?? "";
    expect(runner).toContain("def raw_args()");
    expect(runner).toContain('"nightly_load"');
    expect(runner).toContain("CALL refresh_order_summary('${RUN_DATE}')");
    expect(runner).toContain("--entry");
    expect(runner).toContain("CONNECTION_");
    expect(runner).toContain("_SECRET_ARN");
    expect(runner).not.toContain("LANDING");
  });

  it("records Glue job and SQL-runner artifacts", () => {
    expect(BUNDLE.jobs.map((job) => job.glueJobName)).toEqual([
      "retail-repo-dim",
      "retail-customers",
      "retail-exports",
      "retail-orders",
    ]);
    const customers = BUNDLE.jobs.find((job) => job.transformation === "customers");
    expect(customers).toMatchObject({
      sourceFile: "transforms/customers.ktr",
      scriptPath: "glue/scripts/retail-customers.py",
      kind: "transformation",
      connections: ["warehouse"],
      needsExcel: false,
      overriddenSteps: [],
    });
    expect(customers?.automaticSteps).toHaveLength(7);
    expect(customers?.partialSteps).toEqual(["GetVariable"]);
    expect(customers?.manualSteps).toEqual([]);
    const exports = BUNDLE.jobs.find((job) => job.transformation === "exports");
    expect(exports?.needsExcel).toBe(true);
    expect(exports?.partialSteps).toEqual(["ExcelInput", "ExcelOutput"]);
    expect(BUNDLE.sqlRunner).toMatchObject({
      name: "retail-sql-runner",
      scriptPath: "glue/scripts/retail-sql-runner.py",
      entries: [{ job: "nightly_load", entry: "Refresh summary", connection: "warehouse" }],
      connections: ["warehouse"],
    });
  });

  it("generates JSONata state machines with resolvable transitions", () => {
    expect(BUNDLE.stateMachines.map((machine) => machine.stateMachineName)).toEqual([
      "retail-child",
      "retail-nightly-load",
      "retail-repo-job",
    ]);
    for (const machine of BUNDLE.stateMachines) {
      const definition = parseJson<{
        QueryLanguage: string;
        StartAt: string;
        States: Record<string, Record<string, unknown>>;
      }>(BUNDLE.contents[machine.definitionPath], machine.definitionPath);
      expect(definition.QueryLanguage).toBe("JSONata");
      expect(definition.States[definition.StartAt]).toBeDefined();
      for (const [name, state] of Object.entries(definition.States)) {
        for (const target of [
          state.Next,
          state.Default,
          ...((state.Choices as { Next?: string }[] | undefined) ?? []).map(
            (choice) => choice.Next,
          ),
          ...((state.Catch as { Next?: string }[] | undefined) ?? []).map((item) => item.Next),
        ]) {
          if (typeof target === "string") {
            expect(definition.States[target], `${name} -> ${target}`).toBeDefined();
          }
        }
        expect(["Task", "Pass", "Wait", "Choice", "Succeed", "Fail"]).toContain(state.Type);
      }
      expect(Object.values(definition.States).some((state) => state.Type === "Succeed")).toBe(true);
    }

    const nightly = parseJson<{
      States: Record<string, Record<string, unknown>>;
    }>(BUNDLE.contents["stepfunctions/retail-nightly-load.json"], "nightly");
    const runChild = nightly.States.Run_child_job;
    expect(runChild?.Resource).toBe("arn:aws:states:::states:startExecution.sync:2");
    expect(runChild?.Arguments).toMatchObject({ StateMachineArn: "${NestedStateMachineArn0}" });
    expect(JSON.parse(String((runChild?.Arguments as { Input?: string }).Input))).toEqual({
      RUN_DATE: "2026-01-01",
    });
    const notify = nightly.States.Notify_team;
    expect(notify?.Arguments).toMatchObject({
      TopicArn: "${MailTopicArn}",
      Subject: "Retail nightly load finished",
      Message: "The nightly retail load for 2026-01-01 completed.",
    });
    const check = nightly.States.Check_extract;
    expect(check?.Arguments).toEqual({ Bucket: "${DataBucket}", Key: "retail/orders_summary.csv" });
    expect(BUNDLE.contents["stepfunctions/retail-nightly-load.json"]).not.toContain("${RUN_DATE}");

    const child = parseJson<{ States: Record<string, Record<string, unknown>> }>(
      BUNDLE.contents["stepfunctions/retail-child.json"],
      "child",
    );
    expect(child.States.Set_audit_variables?.Assign).toEqual({
      AUDIT_SOURCE: "nightly_load",
      LOAD_OK: "Y",
    });
    expect(child.States.Check_load_flag?.Choices).toEqual([
      { Condition: '{% $lookup($states.input, "LOAD_OK") = "Y" %}', Next: "Success" },
    ]);
    expect(BUNDLE.warnings).toContain(
      'child: Wait entry "Wait for writers" has a failure hop; Wait states cannot catch errors, so it is ignored.',
    );
  });

  it("filters CloudFormation resources to the used connections", () => {
    const template = parse(
      BUNDLE.contents["cloudformation/pentaho-migration.yaml"] ?? "",
    ) as CfnTemplate;
    expect(template.Parameters).toEqual(
      expect.objectContaining({
        DataBucket: expect.objectContaining({ Type: "String" }),
        ScriptsBucket: expect.objectContaining({ Type: "String" }),
      }),
    );
    const resources = Object.entries(template.Resources);
    const byType = (type: string) =>
      resources.filter(([, resource]) => resource.Type === type).map(([name]) => name);
    expect(byType("AWS::Glue::Job")).toHaveLength(5);
    expect(byType("AWS::Glue::Connection")).toEqual(["GlueConnectionWAREHOUSEJDBC"]);
    expect(byType("AWS::SecretsManager::Secret")).toEqual(["JdbcSecretWAREHOUSEJDBC"]);
    expect(byType("AWS::StepFunctions::StateMachine")).toHaveLength(3);
    expect(byType("AWS::Scheduler::Schedule")).toHaveLength(1);
    expect(byType("AWS::SNS::Topic")).toEqual(["MailTopic"]);

    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain("LANDING_JDBC");
    expect(serialized).not.toContain("Encrypted 2be98");
    expect(serialized).not.toContain("SuperSecret");

    const glueJobs = resources
      .filter(([, resource]) => resource.Type === "AWS::Glue::Job")
      .map(([, resource]) => resource.Properties ?? {});
    for (const job of glueJobs) {
      expect(job).toMatchObject({ GlueVersion: "6.0", WorkerType: "G.1X", NumberOfWorkers: 2 });
      expect(job.Command).toMatchObject({ Name: "glueetl", PythonVersion: "3" });
      expect(job.Role).toEqual({ "Fn::GetAtt": ["GlueRole", "Arn"] });
    }
    const customersJob = glueJobs.find((job) => job.Name === "retail-customers");
    expect(customersJob?.DefaultArguments).toMatchObject({
      "--CONNECTION_WAREHOUSE_URL": "jdbc:postgresql://REPLACE_ME:5432/retail",
      "--CONNECTION_WAREHOUSE_DRIVER": "org.postgresql.Driver",
    });
    expect(customersJob?.Connections).toEqual({
      Connections: [{ Ref: "GlueConnectionWAREHOUSEJDBC" }],
    });

    const schedule = template.Resources.Scheduleretailnightlyloadstart;
    expect(schedule?.Properties).toMatchObject({
      ScheduleExpression: "cron(15 2 * * ? *)",
      State: "ENABLED",
      Target: {
        Arn: { "Fn::GetAtt": ["StateMachineretailnightlyload", "Arn"] },
        Input: "{}",
      },
    });
    for (const name of [
      "StateMachineretailchild",
      "StateMachineretailnightlyload",
      "StateMachineretailrepojob",
    ]) {
      expect(template.Outputs).toHaveProperty(name);
    }
  });

  it("does not leave dangling references in CloudFormation", () => {
    const template = parse(
      BUNDLE.contents["cloudformation/pentaho-migration.yaml"] ?? "",
    ) as CfnTemplate;
    const resourceNames = new Set(Object.keys(template.Resources));
    const parameterNames = new Set(Object.keys(template.Parameters));
    const pseudo = (name: string) => name.startsWith("AWS::");
    const known = (name: string) =>
      resourceNames.has(name) || parameterNames.has(name) || pseudo(name);
    const problems: string[] = [];

    const checkSub = (value: string, allowed: Set<string>): void => {
      for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
        const name = match[1] ?? "";
        if (name.startsWith("!")) continue;
        const root = name.split(".")[0] ?? name;
        if (!allowed.has(name) && !allowed.has(root) && !pseudo(root)) {
          problems.push(`unresolved Fn::Sub placeholder \${${name}}`);
        }
      }
    };

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "Ref" && typeof child === "string") {
          if (!known(child)) problems.push(`dangling Ref ${child}`);
        } else if (key === "Fn::GetAtt" && Array.isArray(child)) {
          const target = child[0];
          if (typeof target !== "string" || !resourceNames.has(target)) {
            problems.push(`dangling GetAtt ${String(target)}`);
          }
        } else if (key === "Fn::Sub") {
          if (typeof child === "string") {
            checkSub(child, new Set([...resourceNames, ...parameterNames]));
          } else if (Array.isArray(child)) {
            const [body, variables] = child as [unknown, unknown];
            const map = variables && typeof variables === "object" ? variables : {};
            if (typeof body === "string") {
              checkSub(body, new Set([...Object.keys(map as object), ...resourceNames]));
            }
            visit(map);
          }
        } else {
          visit(child);
        }
      }
    };

    visit(template);
    expect(problems).toEqual([]);
  });

  it("applies step and schedule overrides", () => {
    const overridden = build({
      stepOverrides: {
        "customers#Write customers": "override_frame = spark.range(0)",
      },
      scheduleOverrides: { "nightly_load:Start": "cron(0 6 * * ? *)" },
    });
    const customers = overridden.jobs.find((job) => job.transformation === "customers");
    expect(customers?.overriddenSteps).toEqual(["Write customers"]);
    expect(overridden.contents["glue/scripts/retail-customers.py"]).toContain(
      'Model-written override for step "Write customers" (TableOutput); review required.',
    );
    expect(overridden.contents["glue/scripts/retail-customers.py"]).toContain(
      "override_frame = spark.range(0)",
    );
    expect(overridden.schedules[0]?.expression).toBe("cron(0 6 * * ? *)");
    expect(overridden.schedules[0]?.note).toMatch(/schedule_overrides/);
    expect(overridden.contents["cloudformation/pentaho-migration.yaml"]).toContain(
      "cron(0 6 * * ? *)",
    );
  });

  it("summarizes the bundle without shipping the zip", () => {
    const summary = summarizeBundle(BUNDLE, {
      url: "https://example.com/bundle.zip",
      expiresAt: "2026-10-31T18:00:00.000Z",
    });
    expect(summary).toMatchObject({
      bundle_id: BUNDLE.id,
      project_name: "retail",
      download_url: "https://example.com/bundle.zip",
      download_expires_at: "2026-10-31T18:00:00.000Z",
      generated_with: "pentaho-to-aws 1.0.0",
      readiness: BUNDLE.assessment.readiness,
    });
    expect(summary.files).toHaveLength(BUNDLE.files.length);
    expect(summary.jobs).toHaveLength(4);
    expect(summary.state_machines).toHaveLength(3);
    expect(summary.sql_runner).toMatchObject({ entries: 1 });
    expect(summary.connections.map((connection) => connection.name)).toEqual([
      "landing",
      "warehouse",
    ]);
    expect(summary.flows).toHaveLength(7);
    expect("zip" in summary).toBe(false);
    expect("contents" in summary).toBe(false);
  });

  it("keeps the report and README deployable without AWS credentials", () => {
    const report = BUNDLE.contents["migration-report.md"] ?? "";
    expect(report).toContain("**Readiness:** 84/100 (review)");
    expect(report).toContain("**Blockers:**");
    expect(report).toContain("1 connection still contains a placeholder endpoint.");
    expect(report).toContain("| retail-customers |");
    expect(report).toContain("cron(15 2 * * ? *)");
    expect(report).toMatch(/did not contact AWS/);

    const readme = BUNDLE.contents["README.md"] ?? "";
    expect(readme).toContain("aws cloudformation deploy");
    expect(readme).toContain("capabilities CAPABILITY_IAM");
    expect(readme).toContain("Never commit real credentials to this bundle.");
    expect(readme).toContain("REPLACE_ME");
    expect(BUNDLE.nextSteps.join("\n")).toMatch(/placeholder endpoint for warehouse/);
    expect(BUNDLE.nextSteps.join("\n")).toMatch(
      /EventBridge Scheduler expressions should run in UTC/,
    );
  });

  it("warns when a generated state machine has no entries", () => {
    const jobOnly = parsePentahoProject([
      {
        path: "empty.kjb",
        data: new TextEncoder().encode(
          `<?xml version="1.0"?><job><name>empty</name><entries></entries></job>`,
        ),
      } satisfies InputFile,
    ]);
    const bundle = buildMigrationBundle(jobOnly, {
      ...RETAIL_OPTIONS,
      projectName: "empty",
    });
    expect(bundle.stateMachines).toHaveLength(1);
    expect(bundle.stateMachines[0]?.warnings.join("\n")).toMatch(/has no entries/);
    const definition = JSON.parse(bundle.contents["stepfunctions/empty-empty.json"] ?? "{}") as {
      States: Record<string, { Type: string }>;
    };
    expect(definition.States.Start).toMatchObject({ Type: "Pass" });
    expect(definition.States.Succeed).toMatchObject({ Type: "Succeed" });
  });
});

describe("createPathMapper", () => {
  const map = createPathMapper([
    { from: "/opt/retail/data", to: "s3://bucket/data" },
    { from: "C:\\exports\\", to: "s3://bucket/exports" },
    { from: "/opt/retail/data/raw", to: "s3://bucket/raw" },
    { from: "", to: "s3://ignored/empty" },
    { from: "/opt/retail/ignored", to: "gs://not-s3" },
  ]);

  it("maps exact paths and prefixes with the longest match", () => {
    expect(map("/opt/retail/data")).toBe("s3://bucket/data");
    expect(map("/opt/retail/data/orders.csv")).toBe("s3://bucket/data/orders.csv");
    expect(map("/opt/retail/data/raw/orders.csv")).toBe("s3://bucket/raw/orders.csv");
    expect(map("C:\\exports\\daily.csv")).toBe("s3://bucket/exports/daily.csv");
    expect(map("/opt/retail/datax/orders.csv")).toMatch(/^s3:\/\/\$\{DataBucket\}\/unmapped\//);
  });

  it("is case-insensitive on the prefix but preserves the remainder", () => {
    expect(map("/OPT/RETAIL/DATA/Orders.CSV")).toBe("s3://bucket/data/Orders.CSV");
  });

  it("passes s3 URIs through and sanitizes unmapped paths", () => {
    expect(map("s3://other-bucket/key")).toBe("s3://other-bucket/key");
    expect(map("/opt/retail/ignored/file.csv")).toBe(
      "s3://${DataBucket}/unmapped/opt/retail/ignored/file.csv",
    );
    expect(map("C:\\temp\\my file.csv")).toBe("s3://${DataBucket}/unmapped/temp/my_file.csv");
    expect(map("/")).toBe("s3://${DataBucket}/unmapped/file");
  });

  it("uses a custom bucket placeholder", () => {
    const custom = createPathMapper([], "MyBucket");
    expect(custom("/a/b.csv")).toBe("s3://MyBucket/unmapped/a/b.csv");
  });
});
