import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import type { InputFile } from "../src/ingest/types.js";
import { buildMigrationBundle } from "../src/migration/bundle.js";
import type { GeneratedBundleOptions, MigrationBundle } from "../src/migration/types.js";
import { parsePentahoProject } from "../src/pentaho/parse.js";

export const FIXTURE_ROOT = path.resolve(import.meta.dirname, "fixtures", "retail");

export function fixtureFiles(): InputFile[] {
  const files: InputFile[] = [];
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(FIXTURE_ROOT, full).replaceAll("\\", "/"),
          data: fs.readFileSync(full),
        });
      }
    }
  };
  visit(FIXTURE_ROOT);
  return files;
}

export function fixtureText(relativePath: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8");
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
  generatedWith: "pentaho-to-aws 1.0.0",
};

export function retailBundle(): MigrationBundle {
  return buildMigrationBundle(parsePentahoProject(fixtureFiles()), { ...RETAIL_OPTIONS });
}

export function b64(data: Uint8Array | string): string {
  return Buffer.from(data).toString("base64");
}

export function inlineFixtureFiles(): { name: string; content: string }[] {
  return fixtureFiles().map((file) => ({
    name: file.path,
    content: new TextDecoder("utf-8", { fatal: true }).decode(file.data),
  }));
}

export function fixtureZipBase64(): string {
  const entries: Record<string, Uint8Array> = {};
  for (const file of fixtureFiles()) entries[file.path] = file.data;
  return b64(zipSync(entries, { level: 6, mtime: Date.UTC(2000, 0, 1, 12, 0, 0) }));
}
