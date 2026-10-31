import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  new URL("../dist/web/workbench.html", import.meta.url),
  new URL("../web/workbench.html", import.meta.url),
];

export class WidgetNotBuiltError extends Error {
  override readonly name = "WidgetNotBuiltError";
}

export async function readWidgetHtml(): Promise<string> {
  for (const candidate of CANDIDATES) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new WidgetNotBuiltError(
    `Widget bundle not found (looked in ${CANDIDATES.map((url) => fileURLToPath(url)).join(", ")}). Run "npm run build:web".`,
  );
}

export function cachedWidgetLoader(
  load: () => Promise<string> = readWidgetHtml,
): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}
