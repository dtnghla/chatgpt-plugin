import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import type { DatabaseBundle } from "../src/database/bundle.js";
import { buildDatabaseBundle } from "../src/database/bundle.js";
import { parseDatabaseProject } from "../src/database/parse.js";
import type { InputFile } from "../src/ingest/types.js";
import { buildMigrationBundle } from "../src/migration/bundle.js";
import type { GeneratedBundleOptions, MigrationBundle } from "../src/migration/types.js";
import { parsePentahoProject } from "../src/pentaho/parse.js";
import { GENERATOR_VERSION } from "../src/server.js";

export function fixtureRoot(name = "retail"): string {
  return path.resolve(import.meta.dirname, "fixtures", name);
}

export function fixtureFiles(name = "retail"): InputFile[] {
  const files: InputFile[] = [];
  const root = fixtureRoot(name);
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(root, full).replaceAll("\\", "/"),
          data: fs.readFileSync(full),
        });
      }
    }
  };
  visit(root);
  return files;
}

export const RETAIL_OPTIONS: GeneratedBundleOptions = {
  projectName: "retail",
  glueVersion: "6.0",
  workerType: "G.1X",
  numberOfWorkers: 2,
  scriptPrefix: "glue/scripts",
  pathMappings: [{ from: "/opt/retail/data", to: "s3://${DataBucket}/retail" }],
  stepOverrides: {},
  scheduleOverrides: {},
  generatedWith: GENERATOR_VERSION,
};

export function retailBundle(): MigrationBundle {
  return buildMigrationBundle(parsePentahoProject(fixtureFiles()), { ...RETAIL_OPTIONS });
}

export type DatabaseFixtureName = "oracle-hr" | "teradata-sales" | "hive-lake";

export function databaseBundle(name: DatabaseFixtureName): DatabaseBundle {
  return buildDatabaseBundle(parseDatabaseProject(fixtureFiles(name)), {
    projectName: name,
    replicationType: "full-load-and-cdc",
    dmsMaxCapacityUnits: 16,
    generatedWith: GENERATOR_VERSION,
  });
}

export function b64(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64");
}

export function inlineFixtureFiles(name = "retail"): { name: string; content: string }[] {
  return fixtureFiles(name).map((file) => ({
    name: file.path,
    content: new TextDecoder("utf-8", { fatal: true }).decode(file.data),
  }));
}

export function fixtureZipBase64(name = "retail"): string {
  const entries: Record<string, Uint8Array> = {};
  for (const file of fixtureFiles(name)) entries[file.path] = file.data;
  return b64(zipSync(entries, { level: 6, mtime: Date.UTC(2000, 0, 1, 12, 0, 0) }));
}
