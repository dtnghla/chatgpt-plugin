import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio, validatePlugin } from "../../scripts/validate-plugin.js";

type Json = Record<string, unknown>;

const SOURCE = fileURLToPath(new URL("../../plugins/time-zone-planner", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tzp-plugin-"));
  tempDirs.push(dir);
  return dir;
}

async function makePlugin(): Promise<string> {
  const root = await tempRoot();
  const dir = path.join(root, "time-zone-planner");
  await cp(SOURCE, dir, { recursive: true });
  return dir;
}

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, "utf8")) as Json;
}

async function editJson(file: string, edit: (json: Json) => void): Promise<void> {
  const json = await readJson(file);
  edit(json);
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
}

function iface(manifest: Json): Json {
  return (
    (manifest.extensions as Record<string, { interface: Json }>)["com.openai"]?.interface ?? {}
  );
}

async function editInterface(dir: string, edit: (value: Json) => void): Promise<void> {
  await editJson(path.join(dir, "plugin.json"), (manifest) => edit(iface(manifest)));
}

async function editFile(file: string, edit: (text: string) => string): Promise<void> {
  await writeFile(file, edit(await readFile(file, "utf8")));
}

async function errorCodes(dir: string, release = false): Promise<string[]> {
  const result = await validatePlugin(dir, { release });
  return result.errors.map((issue) => issue.code);
}

function svg(size: string): string {
  return `<svg ${SVG_NS} width="${size.split(" ")[0]}" height="${size.split(" ")[1]}" viewBox="0 0 ${size}"><rect width="10" height="10"/></svg>\n`;
}

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("committed plugin", () => {
  it("passes in package mode with a release_not_ready warning", async () => {
    const result = await validatePlugin(SOURCE, { release: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["release_not_ready"]);
  });

  it("fails in release mode because URLs are missing and the server is on localhost", async () => {
    const codes = await errorCodes(SOURCE, true);
    expect(codes).toEqual(
      expect.arrayContaining([
        "release_website_url_missing",
        "release_privacy_policy_url_missing",
        "release_terms_of_service_url_missing",
        "release_support_url_missing",
        "release_mcp_url_not_public",
      ]),
    );
  });

  it("matches the package.json version", async () => {
    const result = await validatePlugin(SOURCE, { release: false, repoRoot: REPO_ROOT });
    expect(result.errors.map((issue) => issue.code)).not.toContain("version_mismatch");
  });
});

describe("release mode", () => {
  it("passes with listing URLs and a public https server", async () => {
    const dir = await makePlugin();
    const url = "https://planner.timezones.dev/mcp";
    await editInterface(dir, (value) => {
      value.websiteURL = "https://timezones.dev";
      value.privacyPolicyURL = "https://timezones.dev/privacy";
      value.termsOfServiceURL = "https://timezones.dev/terms";
      value.supportURL = "https://timezones.dev/support";
    });
    await editJson(path.join(dir, "mcp.json"), (mcp) => {
      (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
        type: "streamable-http",
        url,
      };
    });
    await editFile(path.join(dir, "skills/plan-meeting/agents/openai.yaml"), (text) =>
      text.replace("http://localhost:3000/mcp", url),
    );
    const result = await validatePlugin(dir, { release: true });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects placeholder hosts and non-https listing URLs", async () => {
    const dir = await makePlugin();
    await editInterface(dir, (value) => {
      value.websiteURL = "http://timezones.dev";
    });
    await editJson(path.join(dir, "mcp.json"), (mcp) => {
      (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
        type: "streamable-http",
        url: "https://plan.example.org/mcp",
      };
    });
    const codes = await errorCodes(dir, true);
    expect(codes).toContain("plugin_website_url_format");
    expect(codes).toContain("release_mcp_url_not_public");
  });
});

describe("plugin.json", () => {
  it("rejects a bad name", async () => {
    const dir = await makePlugin();
    await editJson(path.join(dir, "plugin.json"), (manifest) => {
      manifest.name = "Bad.Name";
    });
    expect(await errorCodes(dir)).toContain("plugin_name_format");
  });

  it("rejects an unknown top-level key as a schema error", async () => {
    const dir = await makePlugin();
    await editJson(path.join(dir, "plugin.json"), (manifest) => {
      manifest.skills = "./skills";
    });
    const result = await validatePlugin(dir, { release: false });
    const schemaErrors = result.errors.filter((issue) => issue.code === "plugin_schema_invalid");
    expect(schemaErrors.some((issue) => issue.message.includes("skills"))).toBe(true);
  });

  it("reports a missing manifest", async () => {
    const dir = await makePlugin();
    await rm(path.join(dir, "plugin.json"));
    expect(await errorCodes(dir)).toContain("plugin_manifest_missing");
  });

  it("reports malformed JSON", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "plugin.json"), "{ nope");
    expect(await errorCodes(dir)).toContain("plugin_manifest_json_malformed");
  });

  it("rejects a developer name that differs from the author", async () => {
    const dir = await makePlugin();
    await editInterface(dir, (value) => {
      value.developerName = "someone else";
    });
    expect(await errorCodes(dir)).toContain("developer_name_mismatch");
  });

  it("rejects a non-semver version", async () => {
    const dir = await makePlugin();
    await editJson(path.join(dir, "plugin.json"), (manifest) => {
      manifest.version = "1.0";
    });
    expect(await errorCodes(dir)).toContain("plugin_version_not_semver");
  });

  it("rejects a version that differs from package.json", async () => {
    const root = await tempRoot();
    const dir = path.join(root, "plugins", "time-zone-planner");
    await cp(SOURCE, dir, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const result = await validatePlugin(dir, { release: false, repoRoot: root });
    expect(result.errors.map((issue) => issue.code)).toContain("version_mismatch");
  });
});

describe("interface", () => {
  const cases: [string, (value: Json) => void, string][] = [
    [
      "display name over 30 characters",
      (v) => void (v.displayName = "x".repeat(31)),
      "plugin_display_name_too_long",
    ],
    [
      "short description over 30 characters",
      (v) => void (v.shortDescription = "y".repeat(31)),
      "plugin_short_description_too_long",
    ],
    [
      "multi-line short description",
      (v) => void (v.shortDescription = "a\nb"),
      "plugin_short_description_character_unsupported",
    ],
    [
      "four default prompts",
      (v) => void (v.defaultPrompt = ["one", "two", "three", "four"]),
      "plugin_default_prompt_too_many",
    ],
    [
      "prompt with an @ mention",
      (v) => void (v.defaultPrompt = ["Ask @planner for help"]),
      "plugin_default_prompt_mention",
    ],
    [
      "duplicate prompts after normalisation",
      (v) => void (v.defaultPrompt = ["Find a slot", "Find   a  slot "]),
      "plugin_default_prompt_duplicate",
    ],
    [
      "prompt over 128 characters",
      (v) => void (v.defaultPrompt = ["p".repeat(129)]),
      "plugin_default_prompt_too_long",
    ],
    ["unknown category", (v) => void (v.category = "Gaming"), "plugin_category_unknown"],
    [
      "low-contrast brand color",
      (v) => void (v.brandColor = "#FFFF00"),
      "plugin_brand_color_contrast",
    ],
    [
      "low-contrast dark brand color",
      (v) => void (v.brandColorDark = "#222222"),
      "plugin_brand_color_dark_contrast",
    ],
    ["non-hex brand color", (v) => void (v.brandColor = "blue"), "plugin_brand_color_format"],
    [
      "too many capabilities",
      (v) => void (v.capabilities = Array.from({ length: 21 }, (_, i) => `c${i}`)),
      "plugin_capabilities_too_many",
    ],
    [
      "empty long description",
      (v) => void (v.longDescription = "  "),
      "plugin_long_description_empty",
    ],
    [
      "control character in long description",
      (v) => void (v.longDescription = "bad\u0007text"),
      "plugin_long_description_character_unsupported",
    ],
    [
      "line separator in capability",
      (v) => void (v.capabilities = ["a\u2028b"]),
      "plugin_capability_character_unsupported",
    ],
    [
      "non-https website URL",
      (v) => void (v.websiteURL = "http://timezones.dev"),
      "plugin_website_url_format",
    ],
  ];

  it.each(cases)("rejects %s", async (_label, mutate, code) => {
    const dir = await makePlugin();
    await editInterface(dir, mutate);
    expect(await errorCodes(dir)).toContain(code);
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#2563EB", "#FFFFFF")).toBeGreaterThan(2);
  });
});

describe("assets", () => {
  it("rejects a non-square svg", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "assets/logo.svg"), svg("128 64"));
    expect(await errorCodes(dir)).toContain("svg_dimensions_not_square");
  });

  it("rejects an svg smaller than 48px", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "assets/logo.svg"), svg("32 32"));
    expect(await errorCodes(dir)).toContain("svg_dimensions_too_small");
  });

  it("rejects an svg with units in its dimensions", async () => {
    const dir = await makePlugin();
    await writeFile(
      path.join(dir, "assets/logo.svg"),
      `<svg ${SVG_NS} width="64px" height="64px"/>`,
    );
    expect(await errorCodes(dir)).toContain("svg_dimensions_not_numeric");
  });

  it("rejects malformed and unsafe svgs", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "assets/logo.svg"), '<svg width="64" height="64"><g></svg>');
    await writeFile(
      path.join(dir, "assets/composer-icon.svg"),
      `<svg ${SVG_NS} width="64" height="64"><script>alert(1)</script></svg>`,
    );
    const codes = await errorCodes(dir);
    expect(codes).toContain("svg_xml_malformed");
    expect(codes).toContain("svg_unsafe_content");
  });

  it("rejects a non-svg root element", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "assets/logo.svg"), "<html></html>");
    expect(await errorCodes(dir)).toContain("svg_root_element_invalid");
  });

  it("requires a logo declaration", async () => {
    const dir = await makePlugin();
    await editInterface(dir, (value) => {
      delete value.logo;
    });
    expect(await errorCodes(dir)).toContain("plugin_logo_path_missing");
  });

  it("requires the logo file to exist", async () => {
    const dir = await makePlugin();
    await rm(path.join(dir, "assets/logo.svg"));
    expect(await errorCodes(dir)).toContain("declared_asset_file_missing");
  });

  it("rejects a path containing ..", async () => {
    const dir = await makePlugin();
    await editInterface(dir, (value) => {
      value.logo = "./../outside.svg";
    });
    expect(await errorCodes(dir)).toContain("declared_asset_path_unsafe");
  });

  it("rejects a path without the ./ prefix", async () => {
    const dir = await makePlugin();
    await editInterface(dir, (value) => {
      value.composerIcon = "assets/composer-icon.svg";
    });
    expect(await errorCodes(dir)).toContain("branding_asset_path_missing_root_prefix");
  });

  it("rejects unsupported image extensions", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "assets/logo.gif"), "GIF89a");
    await editInterface(dir, (value) => {
      value.logo = "./assets/logo.gif";
    });
    expect(await errorCodes(dir)).toContain("image_file_format_unsupported");
  });

  it("accepts a square PNG and rejects a non-square or mislabeled one", async () => {
    const dir = await makePlugin();
    await writeFile(path.join(dir, "assets/logo.png"), pngHeader(128, 128));
    await editInterface(dir, (value) => {
      value.logo = "./assets/logo.png";
    });
    expect(await errorCodes(dir)).toEqual([]);

    await writeFile(path.join(dir, "assets/logo.png"), pngHeader(128, 64));
    expect(await errorCodes(dir)).toContain("raster_image_not_square");

    await writeFile(path.join(dir, "assets/logo.png"), pngHeader(5000, 5000));
    expect(await errorCodes(dir)).toContain("raster_image_dimensions_too_large");

    await writeFile(path.join(dir, "assets/logo.jpg"), pngHeader(128, 128));
    await editInterface(dir, (value) => {
      value.logo = "./assets/logo.jpg";
    });
    expect(await errorCodes(dir)).toContain("raster_image_extension_content_mismatch");

    await writeFile(path.join(dir, "assets/logo.jpg"), "not an image");
    expect(await errorCodes(dir)).toContain("raster_image_decode_failed");
  });

  it("warns about screenshots without failing", async () => {
    const dir = await makePlugin();
    await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "assets/shot.png"), pngHeader(706, 500));
    await editInterface(dir, (value) => {
      value.screenshots = ["./assets/shot.png"];
    });
    const result = await validatePlugin(dir, { release: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toContain("screenshots_custom_ui_only");
  });
});

describe("skills", () => {
  const skillFile = (dir: string) => path.join(dir, "skills/plan-meeting/SKILL.md");
  const agentFile = (dir: string) => path.join(dir, "skills/plan-meeting/agents/openai.yaml");

  it("rejects a skill name that differs from its directory", async () => {
    const dir = await makePlugin();
    await editFile(skillFile(dir), (text) =>
      text.replace("name: plan-meeting", "name: other-name"),
    );
    expect(await errorCodes(dir)).toContain("skill_name_dir_mismatch");
  });

  it("rejects a skill without front matter", async () => {
    const dir = await makePlugin();
    await writeFile(skillFile(dir), "# Just a heading\n\nNo front matter here.\n");
    expect(await errorCodes(dir)).toContain("skill_frontmatter_missing");
  });

  it("rejects unclosed and non-mapping front matter", async () => {
    const dir = await makePlugin();
    await writeFile(skillFile(dir), "---\nname: plan-meeting\n");
    expect(await errorCodes(dir)).toContain("skill_frontmatter_unclosed");
    await writeFile(skillFile(dir), "---\n- a\n- b\n---\nbody\n");
    expect(await errorCodes(dir)).toContain("skill_frontmatter_wrong_type");
  });

  it("rejects a missing description and an empty body", async () => {
    const dir = await makePlugin();
    await writeFile(skillFile(dir), "---\nname: plan-meeting\n---\n");
    const codes = await errorCodes(dir);
    expect(codes).toContain("skill_description_missing");
    expect(codes).toContain("skill_body_empty");
  });

  it("requires at least one skill", async () => {
    const dir = await makePlugin();
    await rm(path.join(dir, "skills"), { recursive: true });
    expect(await errorCodes(dir)).toContain("skills_directory_missing");
  });

  it("rejects a skill directory without SKILL.md", async () => {
    const dir = await makePlugin();
    await mkdir(path.join(dir, "skills/empty-skill"));
    expect(await errorCodes(dir)).toContain("skill_manifest_missing");
  });

  it("rejects an openai.yaml url that differs from mcp.json", async () => {
    const dir = await makePlugin();
    await editFile(agentFile(dir), (text) =>
      text.replace("http://localhost:3000/mcp", "http://localhost:4000/mcp"),
    );
    expect(await errorCodes(dir)).toContain("mcp_url_mismatch");
  });

  it("rejects an openai.yaml dependency on an unknown server", async () => {
    const dir = await makePlugin();
    await editFile(agentFile(dir), (text) =>
      text.replace('value: "time-zone-planner"', 'value: "other"'),
    );
    expect(await errorCodes(dir)).toContain("mcp_dependency_unknown_server");
  });

  it("rejects an openai.yaml without display_name or with extra dependencies", async () => {
    const dir = await makePlugin();
    await writeFile(
      agentFile(dir),
      'interface:\n  short_description: "x"\ndependencies:\n  skills: []\n',
    );
    const codes = await errorCodes(dir);
    expect(codes).toContain("skill_agent_display_name_missing");
    expect(codes).toContain("skill_agent_dependency_unsupported");
  });

  it("rejects an invalid policy", async () => {
    const dir = await makePlugin();
    await editFile(agentFile(dir), (text) => `${text}\npolicy:\n  products: [WEB]\n`);
    expect(await errorCodes(dir)).toContain("skill_agent_allow_implicit_invocation_wrong_type");
  });

  it("rejects malformed openai.yaml", async () => {
    const dir = await makePlugin();
    await writeFile(agentFile(dir), "interface: [unclosed\n");
    expect(await errorCodes(dir)).toContain("skill_agent_yaml_malformed");
  });
});

describe("mcp.json", () => {
  const mcpFile = (dir: string) => path.join(dir, "mcp.json");

  it("rejects http for a non-loopback host", async () => {
    const dir = await makePlugin();
    await editJson(mcpFile(dir), (mcp) => {
      (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
        type: "streamable-http",
        url: "http://plan.timezones.dev/mcp",
      };
    });
    expect(await errorCodes(dir)).toContain("mcp_url_insecure");
  });

  it("allows http for loopback hosts", async () => {
    const dir = await makePlugin();
    for (const host of ["127.0.0.1:3000", "[::1]:3000", "localhost:8080"]) {
      const url = `http://${host}/mcp`;
      await editJson(mcpFile(dir), (mcp) => {
        (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
          type: "streamable-http",
          url,
        };
      });
      await editFile(path.join(dir, "skills/plan-meeting/agents/openai.yaml"), (text) =>
        text.replace(/url: ".*"/, `url: "${url}"`),
      );
      expect(await errorCodes(dir)).toEqual([]);
    }
  });

  it("rejects credentials and fragments in the url", async () => {
    const dir = await makePlugin();
    await editJson(mcpFile(dir), (mcp) => {
      (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
        type: "streamable-http",
        url: "https://user:pw@plan.timezones.dev/mcp#frag",
      };
    });
    const codes = await errorCodes(dir);
    expect(codes).toContain("mcp_url_credentials");
    expect(codes).toContain("mcp_url_fragment");
  });

  it("rejects secret-looking headers", async () => {
    const dir = await makePlugin();
    await editJson(mcpFile(dir), (mcp) => {
      (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
        type: "streamable-http",
        url: "http://localhost:3000/mcp",
        headers: { Authorization: "Bearer abc" },
      };
    });
    expect(await errorCodes(dir)).toContain("mcp_secret_in_config");
  });

  it("rejects a $schema version that differs from plugin.json", async () => {
    const dir = await makePlugin();
    await editJson(mcpFile(dir), (mcp) => {
      mcp.$schema = "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json";
    });
    const codes = await errorCodes(dir);
    expect(codes).toContain("schema_version_mismatch");
    expect(codes).toContain("mcp_schema_invalid");
  });

  it("rejects unknown server fields via the schema", async () => {
    const dir = await makePlugin();
    await editJson(mcpFile(dir), (mcp) => {
      (mcp.mcpServers as Record<string, Json>)["time-zone-planner"] = {
        type: "streamable-http",
        url: "http://localhost:3000/mcp",
        auth: "none",
      };
    });
    expect(await errorCodes(dir)).toContain("mcp_schema_invalid");
  });
});
