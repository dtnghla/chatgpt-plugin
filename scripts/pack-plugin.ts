import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync } from "fflate";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "pentaho-to-aws");
const OUTPUT = path.join(REPO_ROOT, "dist", "pentaho-to-aws-plugin.zip");

/** Deterministic timestamp (2000-01-01) so rebuilds produce identical ZIPs. */
const ZIP_MTIME = Date.UTC(2000, 0, 1, 12, 0, 0);

export async function collectFiles(dir: string, prefix = ""): Promise<Record<string, Uint8Array>> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(full, key));
    } else if (entry.isFile()) {
      files[key] = new Uint8Array(await readFile(full));
    }
  }
  return files;
}

export async function packPlugin(
  pluginDir: string = PLUGIN_DIR,
  output: string = OUTPUT,
): Promise<{ output: string; count: number; bytes: number }> {
  const files = await collectFiles(pluginDir);
  if (!files["plugin.json"]) {
    throw new Error(`${pluginDir} does not contain plugin.json; nothing to pack.`);
  }
  const zipped = zipSync(files, { level: 9, mtime: ZIP_MTIME });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, zipped);
  return { output, count: Object.keys(files).length, bytes: zipped.byteLength };
}

async function main(): Promise<number> {
  try {
    const { output, count, bytes } = await packPlugin();
    console.log(`Packed ${count} files (${(bytes / 1024).toFixed(1)} KiB) -> ${output}`);
    console.log(
      "Upload this ZIP at https://platform.openai.com/plugins (Plugins directory submission).",
    );
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
