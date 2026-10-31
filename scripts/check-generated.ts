import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { InputFile } from "../src/ingest/types.js";
import { buildMigrationBundle } from "../src/migration/bundle.js";
import { parsePentahoProject } from "../src/pentaho/parse.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "test", "fixtures", "retail");
const STRICT = process.env.REQUIRE_GENERATED_CHECKS === "1";

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

function main(): number {
  const files = collectFiles(FIXTURE_ROOT);
  const project = parsePentahoProject(files);
  const bundle = buildMigrationBundle(project, {
    projectName: "retail",
    glueVersion: "6.0",
    workerType: "G.1X",
    numberOfWorkers: 2,
    scriptPrefix: "glue/scripts",
    pathMappings: [],
    stepOverrides: {},
    scheduleOverrides: {},
    generatedWith: "pentaho-to-aws 1.0.0",
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pentaho-generated-"));
  const problems: string[] = [];
  const skipped: string[] = [];
  try {
    for (const [name, content] of Object.entries(bundle.contents)) {
      const target = path.join(tempDir, ...name.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

    const pythonFiles = bundle.files
      .filter((file) => file.kind === "python")
      .map((file) => path.join(tempDir, ...file.path.split("/")));
    const python = findCommand(
      process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"],
      ["--version"],
    );
    if (python && pythonFiles.length > 0) {
      const compile = spawnSync(python, ["-m", "py_compile", ...pythonFiles], {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      if (compile.status !== 0) {
        problems.push(
          `py_compile failed for the generated Glue scripts:\n${compile.stderr || compile.stdout || "unknown error"}`,
        );
      } else {
        console.log(`py_compile: ${pythonFiles.length} generated Python file(s) compiled.`);
      }
    } else {
      skipped.push("py_compile (Python interpreter not found)");
    }

    const template = bundle.files.find((file) => file.kind === "cloudformation");
    if (!template) {
      problems.push("The bundle did not contain a CloudFormation template.");
    } else {
      const templatePath = path.join(tempDir, ...template.path.split("/"));
      problems.push(...checkCloudFormation(templatePath));
      const cfnLint = findCommand(
        process.platform === "win32" ? ["cfn-lint.cmd", "cfn-lint"] : ["cfn-lint"],
        ["--version"],
      );
      if (cfnLint) {
        const lint = spawnSync(cfnLint, [templatePath], {
          encoding: "utf8",
          timeout: 120_000,
          windowsHide: true,
        });
        if (lint.status !== 0) {
          problems.push(`cfn-lint failed:\n${lint.stdout || lint.stderr || "unknown error"}`);
        } else {
          console.log("cfn-lint: CloudFormation template passed.");
        }
      } else {
        skipped.push("cfn-lint (command not found)");
      }
    }

    const manifest = bundle.contents["manifest.json"];
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest) as { files?: unknown[] };
        if (!Array.isArray(parsed.files) || parsed.files.length !== bundle.files.length - 1) {
          problems.push("manifest.json does not list every generated file.");
        }
      } catch {
        problems.push("manifest.json is not valid JSON.");
      }
    } else {
      problems.push("The bundle did not contain manifest.json.");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  for (const skip of skipped) console.warn(`SKIP ${skip}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`ERROR ${problem}`);
    return 1;
  }
  if (skipped.length > 0 && STRICT) {
    console.error("REQUIRE_GENERATED_CHECKS=1 but required generated-file tools are missing.");
    return 1;
  }
  console.log(`Generated bundle ${bundle.id} passed the available checks.`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
