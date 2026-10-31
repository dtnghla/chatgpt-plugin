import fs from "node:fs";
import path from "node:path";
import type { InputFile } from "../src/ingest/types.js";
import { deriveProjectName } from "../src/migration/assessment.js";
import { buildMigrationBundle } from "../src/migration/bundle.js";
import { parsePentahoProject } from "../src/pentaho/parse.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function collectFiles(root: string): InputFile[] {
  const files: InputFile[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (![".ktr", ".kjb", ".xml", ".properties", ".sql"].includes(extension)) continue;
      const size = fs.statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        throw new Error(`${full} is larger than the 25 MB smoke-test limit.`);
      }
      files.push({
        path: path.relative(root, full).replaceAll("\\", "/"),
        data: fs.readFileSync(full),
      });
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function main(): number {
  const directory = process.argv[2] ?? process.env.PDI_SAMPLES_DIR;
  if (!directory) {
    console.log(
      "SKIP pdi-samples smoke test: pass a directory or set PDI_SAMPLES_DIR to a folder of real Pentaho .ktr/.kjb files.",
    );
    return 0;
  }
  const root = path.resolve(directory);
  const stats = fs.statSync(root);
  if (!stats.isDirectory()) {
    throw new Error(`${root} is not a directory.`);
  }
  const files = collectFiles(root);
  if (files.length === 0) {
    throw new Error(`No .ktr, .kjb, .xml or .properties files were found under ${root}.`);
  }
  const project = parsePentahoProject(files);
  if (project.transformations.length === 0 && project.jobs.length === 0) {
    throw new Error("No Pentaho transformations or jobs could be parsed.");
  }
  const bundle = buildMigrationBundle(project, {
    projectName: deriveProjectName(project),
    glueVersion: "6.0",
    workerType: "G.1X",
    numberOfWorkers: 2,
    scriptPrefix: "glue/scripts",
    pathMappings: [],
    stepOverrides: {},
    scheduleOverrides: {},
    generatedWith: "pentaho-to-aws 1.0.0",
  });
  const manual = bundle.assessment.unsupportedSteps.length;
  const partial = bundle.assessment.partialSteps.length;
  console.log(
    `Parsed ${files.length} file(s): ${project.transformations.length} transformations, ${project.jobs.length} jobs.`,
  );
  console.log(
    `Bundle ${bundle.id}: ${bundle.files.length} files, readiness ${bundle.assessment.readiness.score}/100 (${bundle.assessment.readiness.level}), ${partial} partial and ${manual} manual step instance(s).`,
  );
  if (bundle.assessment.readiness.blockers.length > 0) {
    console.log(`Blockers: ${bundle.assessment.readiness.blockers.length}`);
    for (const blocker of bundle.assessment.readiness.blockers.slice(0, 10)) {
      console.log(`- ${blocker}`);
    }
  }
  if (bundle.warnings.length > 0) {
    console.log(`Warnings: ${bundle.warnings.length}`);
    for (const warning of bundle.warnings.slice(0, 10)) console.log(`- ${warning}`);
  }
  console.log("Smoke test passed. No AWS account or database was contacted.");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
