import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLANNER_UI_URI } from "../../src/server.js";
import { connectClient, type Era, type RunningServer, startServer } from "./harness.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const firstText = (result: ToolResult): string =>
  result.content.find((c) => c.type === "text")?.text ?? "";

const nyLondonBerlin = [
  { name: "Ana", time_zone: "America/New_York" },
  { name: "Ben", time_zone: "Europe/London" },
  { name: "Caro", time_zone: "Europe/Berlin" },
];

let running: RunningServer;

beforeAll(async () => {
  running = await startServer();
});

afterAll(async () => {
  await running.close();
});

describe.each<Era>(["legacy", "modern"])("MCP server (%s protocol era)", (era) => {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient(running.mcpUrl, era);
  });

  afterAll(async () => {
    await client.close();
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  it("identifies itself", () => {
    expect(client.getServerVersion()?.name).toBe("time-zone-planner");
  });

  it("lists exactly the three tools with accurate read-only annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "convert_time",
      "find_meeting_times",
      "render_meeting_planner",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      });
      expect(tool.title).toBeTruthy();
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
    }
  });

  it("attaches a UI resource only to render_meeting_planner", async () => {
    const { tools } = await client.listTools();
    const withUi = tools.filter((tool) => {
      const ui = (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
      return ui?.resourceUri !== undefined;
    });
    expect(withUi.map((tool) => tool.name)).toEqual(["render_meeting_planner"]);
    const ui = (withUi[0]?._meta as { ui: { resourceUri: string } }).ui;
    expect(ui.resourceUri).toBe(PLANNER_UI_URI);
  });

  it("serves the planner widget as an MCP App resource without network access", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain(PLANNER_UI_URI);

    const read = await client.readResource({ uri: PLANNER_UI_URI });
    const [content] = read.contents;
    expect(content?.mimeType).toBe("text/html;profile=mcp-app");
    expect(content && "text" in content ? content.text : "").toContain("<html");
    const meta = (
      content?._meta as { ui?: { csp?: Record<string, unknown>; prefersBorder?: boolean } }
    )?.ui;
    expect(meta?.prefersBorder).toBe(true);
    expect(meta?.csp).toEqual({ connectDomains: [], resourceDomains: [] });
  });

  it("converts a skipped local time and reports the DST gap", async () => {
    const result = await call("convert_time", {
      date_time: "2026-03-08T02:30",
      from_time_zone: "America/New_York",
      to_time_zones: ["Europe/London", "Asia/Kolkata"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dst_adjustment: "gap",
      utc: "2026-03-08T07:30:00Z",
      source: { local_date_time: "2026-03-08T03:30", utc_offset: "-04:00" },
    });
    const targets = result.structuredContent?.targets as Array<{ local_date_time: string }>;
    expect(targets.map((target) => target.local_date_time)).toEqual([
      "2026-03-08T07:30",
      "2026-03-08T13:00",
    ]);
    expect(firstText(result)).toContain("does not exist");
  });

  it("finds the narrow overlap between New York, London and Berlin", async () => {
    const result = await call("find_meeting_times", {
      participants: nyLondonBerlin,
      start_date: "2026-01-12",
      days: 1,
      duration_minutes: 60,
    });
    expect(result.isError).toBeFalsy();
    const found = result.structuredContent as {
      has_full_overlap: boolean;
      slots: Array<{ start_utc: string; all_available: boolean }>;
    };
    expect(found.has_full_overlap).toBe(true);
    expect(found.slots.length).toBeGreaterThan(0);
    for (const slot of found.slots) {
      expect(slot.all_available).toBe(true);
      expect(slot.start_utc >= "2026-01-12T14:00:00Z").toBe(true);
      expect(slot.start_utc <= "2026-01-12T15:00:00Z").toBe(true);
    }
  });

  it("falls back to partial overlap when nobody shares working hours", async () => {
    const result = await call("find_meeting_times", {
      participants: [
        { name: "Ana", time_zone: "America/New_York" },
        { name: "Taka", time_zone: "Asia/Tokyo" },
      ],
      start_date: "2026-01-12",
      days: 2,
    });
    const found = result.structuredContent as {
      has_full_overlap: boolean;
      slots: unknown[];
      summary: string;
    };
    expect(found.has_full_overlap).toBe(false);
    expect(found.summary.length).toBeGreaterThan(10);
  });

  it("renders the planner grid with the overlap columns", async () => {
    const result = await call("render_meeting_planner", {
      participants: [
        { name: "Ana", time_zone: "America/New_York" },
        { name: "Ben", time_zone: "Europe/London" },
      ],
      date: "2026-01-12",
    });
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as {
      rows: Array<{ cells: unknown[] }>;
      overlap_columns: number[];
      participants: Array<{ work_start: string; work_days: number[] }>;
    };
    expect(output.rows).toHaveLength(2);
    expect(output.rows[0]?.cells).toHaveLength(24);
    expect(output.overlap_columns).toEqual([9, 10, 11]);
    expect(output.participants[0]).toMatchObject({
      work_start: "09:00",
      work_days: [1, 2, 3, 4, 5],
    });
    expect(firstText(result)).toContain("09:00-12:00");
  });

  it("returns a recoverable tool error for an ambiguous abbreviation", async () => {
    const result = await call("convert_time", {
      date_time: "2026-03-09T09:00",
      from_time_zone: "IST",
      to_time_zones: ["Europe/London"],
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/IST/);
    expect(firstText(result)).toMatch(/IANA|America\/Chicago/);
  });

  it("rejects schema-invalid arguments as a tool error", async () => {
    const result = await call("find_meeting_times", {
      participants: nyLondonBerlin,
      start_date: "2026-01-12",
      days: 99,
    });
    expect(result.isError).toBe(true);
  });

  it("rejects duplicate participant names as a tool error", async () => {
    const result = await call("render_meeting_planner", {
      participants: [
        { name: "Ana", time_zone: "America/New_York" },
        { name: "ana", time_zone: "Europe/London" },
      ],
      date: "2026-01-12",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result).toLowerCase()).toContain("must be unique");
  });
});
