import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachedWidgetLoader, readWidgetHtml } from "../../src/widget.js";

const DIST = path.resolve(import.meta.dirname, "../../dist/web/workbench.html");
const BUILT = fs.existsSync(DIST);

describe("workbench widget", () => {
  it("caches the loaded HTML", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return "<html>widget</html>";
    };
    const loader = cachedWidgetLoader(load);
    expect(await loader()).toBe("<html>widget</html>");
    expect(await loader()).toBe("<html>widget</html>");
    expect(calls).toBe(1);
  });

  it("retries after a failed load", async () => {
    let calls = 0;
    const loader = cachedWidgetLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error("not built yet");
      return "<html>retry</html>";
    });
    await expect(loader()).rejects.toThrow("not built yet");
    await expect(loader()).resolves.toBe("<html>retry</html>");
    expect(calls).toBe(2);
  });

  it.skipIf(!BUILT)("serves the built single-file widget", async () => {
    const html = await readWidgetHtml();
    expect(html).toBe(fs.readFileSync(DIST, "utf8"));
    expect(html).toContain("<title>Pentaho migration workbench</title>");
    expect(html.length).toBeGreaterThan(100_000);
    expect(html.match(/<\/html>/gi)).toHaveLength(1);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref=["']https?:/i);
    expect(html).not.toMatch(/\bfetch\(\s*["']https?:/i);
    expect(html).not.toMatch(/\bimport\(\s*["']https?:/i);
    expect(html).toMatch(/<script type="module"/i);
  });
});
