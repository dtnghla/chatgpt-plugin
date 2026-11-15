import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ArtifactBundle } from "../src/artifacts/store.js";
import { buildDatabaseBundle } from "../src/database/bundle.js";
import { parseDatabaseProject } from "../src/database/parse.js";
import type { InputFile } from "../src/ingest/types.js";
import { buildMigrationBundle } from "../src/migration/bundle.js";
import { parsePentahoProject } from "../src/pentaho/parse.js";
import { GENERATOR_VERSION } from "../src/server.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STRICT = process.env.REQUIRE_GENERATED_CHECKS === "1";

const DATABASE_FIXTURES = ["oracle-hr", "teradata-sales", "hive-lake"] as const;
type DatabaseFixtureName = (typeof DATABASE_FIXTURES)[number];

function collectFiles(root: string): InputFile[] {
  const files: InputFile[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        path: path.relative(root, full).replaceAll("\\", "/"),
        data: fs.readFileSync(full),
      });
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function fixtureFiles(name: string): InputFile[] {
  return collectFiles(path.join(REPO_ROOT, "test", "fixtures", name));
}

function retailBundle(): ArtifactBundle {
  return buildMigrationBundle(parsePentahoProject(fixtureFiles("retail")), {
    projectName: "retail",
    glueVersion: "6.0",
    workerType: "G.1X",
    numberOfWorkers: 2,
    scriptPrefix: "glue/scripts",
    pathMappings: [],
    stepOverrides: {},
    scheduleOverrides: {},
    generatedWith: GENERATOR_VERSION,
  });
}

function databaseBundle(name: DatabaseFixtureName): ArtifactBundle {
  return buildDatabaseBundle(parseDatabaseProject(fixtureFiles(name)), {
    projectName: name,
    replicationType: "full-load-and-cdc",
    dmsMaxCapacityUnits: 16,
    generatedWith: GENERATOR_VERSION,
  });
}

function findCommand(candidates: string[], args: string[]): string | undefined {
  for (const command of candidates) {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.status === 0 && !result.error) return command;
  }
  return undefined;
}

function checkCloudFormation(filePath: string): string[] {
  const problems: string[] = [];
  let document: unknown;
  try {
    document = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [
      `CloudFormation YAML is invalid: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return ["CloudFormation template is not a YAML mapping."];
  }
  const record = document as Record<string, unknown>;
  const resources = record.Resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
    return ["CloudFormation template has no Resources mapping."];
  }
  const parameters =
    typeof record.Parameters === "object" &&
    record.Parameters !== null &&
    !Array.isArray(record.Parameters)
      ? (record.Parameters as Record<string, unknown>)
      : {};
  const targets = new Set([...Object.keys(resources), ...Object.keys(parameters)]);
  const pseudo = new Set([
    "AWS::AccountId",
    "AWS::NotificationARNs",
    "AWS::NoValue",
    "AWS::Partition",
    "AWS::Region",
    "AWS::StackId",
    "AWS::StackName",
    "AWS::URLSuffix",
  ]);
  const visit = (value: unknown, location: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const mapping = value as Record<string, unknown>;
    if (typeof mapping.Ref === "string" && !targets.has(mapping.Ref) && !pseudo.has(mapping.Ref)) {
      problems.push(`${location}: Ref to unknown target ${mapping.Ref}`);
    }
    const getAtt = mapping["Fn::GetAtt"];
    if (getAtt !== undefined) {
      const target = Array.isArray(getAtt) ? getAtt[0] : String(getAtt).split(".")[0];
      if (typeof target !== "string" || !targets.has(target)) {
        problems.push(`${location}: Fn::GetAtt to unknown target ${String(target)}`);
      }
    }
    for (const [key, child] of Object.entries(mapping)) {
      visit(child, `${location}.${key}`);
    }
  };
  visit(resources, "Resources");
  visit(record.Outputs ?? {}, "Outputs");
  return problems;
}

function checkBundle(
  name: string,
  bundle: ArtifactBundle,
  python: string | undefined,
  cfnLint: string | undefined,
  skipped: string[],
): string[] {
  const problems: string[] = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `generated-${name}-`));
  try {
    for (const [fileName, content] of Object.entries(bundle.contents)) {
      const target = path.join(tempDir, ...fileName.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

    const pythonFiles = bundle.files
      .filter((file) => file.kind === "python")
      .map((file) => path.join(tempDir, ...file.path.split("/")));
    if (pythonFiles.length === 0) {
      // No Python artifacts in this bundle (for example the database class has no Glue runner).
    } else if (python) {
      const compile = spawnSync(python, ["-m", "py_compile", ...pythonFiles], {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      if (compile.status !== 0) {
        problems.push(
          `${name}: py_compile failed for the generated Python files:\n${
            compile.stderr || compile.stdout || "unknown error"
          }`,
        );
      } else {
        console.log(`${name}: py_compile compiled ${pythonFiles.length} Python file(s).`);
      }
    } else {
      skipped.push(`${name}: py_compile (Python interpreter not found)`);
    }

    for (const template of bundle.files.filter((file) => file.kind === "cloudformation")) {
      const templatePath = path.join(tempDir, ...template.path.split("/"));
      problems.push(...checkCloudFormation(templatePath).map((problem) => `${name}: ${problem}`));
      if (cfnLint) {
        const lint = spawnSync(cfnLint, [templatePath], {
          encoding: "utf8",
          timeout: 120_000,
          windowsHide: true,
        });
        // cfn-lint exit codes: 0 clean, 2 errors, 4 warnings, 6 both. Warnings
        // alone do not fail the check; the plan requires no errors.
        if (lint.status === null) {
          problems.push(
            `${name}: cfn-lint could not run on ${template.path}: ${
              lint.error?.message ?? "unknown error"
            }`,
          );
        } else if ((lint.status & ~4) !== 0) {
          problems.push(
            `${name}: cfn-lint failed on ${template.path}:\n${
              lint.stdout || lint.stderr || "unknown error"
            }`,
          );
        } else if (lint.status === 4) {
          console.warn(
            `${name}: cfn-lint reported warnings (no errors) on ${template.path}:\n${
              lint.stdout || lint.stderr || ""
            }`,
          );
        } else {
          console.log(`${name}: cfn-lint passed ${template.path}.`);
        }
      } else {
        skipped.push(`${name}: cfn-lint (command not found)`);
      }
    }

    for (const jsonFile of bundle.files.filter((file) => file.path.endsWith(".json"))) {
      const content = bundle.contents[jsonFile.path];
      if (content === undefined) {
        problems.push(`${name}: ${jsonFile.path} has no packaged content.`);
        continue;
      }
      try {
        JSON.parse(content);
      } catch (error) {
        problems.push(
          `${name}: ${jsonFile.path} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const manifest = bundle.contents["manifest.json"];
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest) as { files?: unknown[] };
        if (!Array.isArray(parsed.files) || parsed.files.length !== bundle.files.length - 1) {
          problems.push(`${name}: manifest.json does not list every generated file.`);
        }
      } catch {
        problems.push(`${name}: manifest.json is not valid JSON.`);
      }
    } else {
      problems.push(`${name}: the bundle did not contain manifest.json.`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return problems;
}

function main(): number {
  const targets: { name: string; bundle: ArtifactBundle }[] = [
    { name: "retail", bundle: retailBundle() },
    ...DATABASE_FIXTURES.map((name) => ({ name, bundle: databaseBundle(name) })),
  ];
  const python = findCommand(
    process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"],
    ["--version"],
  );
  const cfnLint = findCommand(
    process.platform === "win32" ? ["cfn-lint.cmd", "cfn-lint"] : ["cfn-lint"],
    ["--version"],
  );
  const skipped: string[] = [];
  let failed = false;
  for (const { name, bundle } of targets) {
    const problems = checkBundle(name, bundle, python, cfnLint, skipped);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`ERROR ${problem}`);
      failed = true;
      continue;
    }
    console.log(`Generated bundle ${name} (${bundle.id}) passed the available checks.`);
  }

  for (const skip of skipped) console.warn(`SKIP ${skip}`);
  if (failed) return 1;
  if (skipped.length > 0 && STRICT) {
    console.error("REQUIRE_GENERATED_CHECKS=1 but required generated-file tools are missing.");
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
