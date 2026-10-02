import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import {
  type CallToolResult,
  McpServer,
  type ReadResourceResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  buildPlannerGrid,
  convertTime,
  findMeetingTimes,
  normalizeParticipants,
  TimeInputError,
} from "./time/index.js";
import type { RenderOutput } from "./time/types.js";
import { formatConvertResult, formatFindResult, formatRenderOutput } from "./tools/format.js";
import {
  convertInputSchema,
  convertOutputSchema,
  findInputSchema,
  findOutputSchema,
  renderInputSchema,
  renderOutputSchema,
} from "./tools/schemas.js";

export const SERVER_NAME = "time-zone-planner";
export const SERVER_VERSION = "1.0.0";
export const PLANNER_UI_URI = "ui://time-zone-planner/planner-v1.html";

const INSTRUCTIONS = [
  "Never calculate time zone offsets or daylight-saving changes yourself; call convert_time or find_meeting_times.",
  'Use IANA time zone names such as "Europe/Berlin". If the user gives an ambiguous abbreviation (IST, CST, BST) or a country with several zones, ask which zone they mean.',
  "Call find_meeting_times to find slots; call render_meeting_planner afterwards only to show the visual grid for one date.",
  "This server has no calendar access and cannot send invitations.",
].join(" ");

const READ_ONLY_COMPUTATION: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface ServerDeps {
  loadWidgetHtml: () => Promise<string>;
}

function inputError(error: unknown): CallToolResult {
  if (error instanceof TimeInputError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  throw error;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "convert_time",
    {
      title: "Convert time between time zones",
      description:
        "Use this when the user wants to know what a specific local date and time is in other time zones. Handles daylight saving correctly, reports each zone's UTC offset, weekday and day change, and flags local times that do not exist or happen twice around clock changes.",
      inputSchema: convertInputSchema,
      outputSchema: convertOutputSchema,
      annotations: READ_ONLY_COMPUTATION,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = convertTime(args);
        return {
          content: [{ type: "text", text: formatConvertResult(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return inputError(error);
      }
    },
  );

  server.registerTool(
    "find_meeting_times",
    {
      title: "Find meeting times",
      description:
        "Use this when the user wants to schedule a meeting across time zones. Given participants with time zones and optional working hours and days, returns ranked slots that fit everyone's working hours, or the best partial overlap when nobody overlaps. It does not read calendars, so it knows working hours only, not existing commitments.",
      inputSchema: findInputSchema,
      outputSchema: findOutputSchema,
      annotations: READ_ONLY_COMPUTATION,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const participants = normalizeParticipants(args.participants);
        const result = findMeetingTimes({ ...args, participants });
        return {
          content: [{ type: "text", text: formatFindResult(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return inputError(error);
      }
    },
  );

  registerAppTool(
    server,
    "render_meeting_planner",
    {
      title: "Show meeting planner",
      description:
        "Use this after the participants are known to show a visual hour-by-hour grid of who is within working hours on one date, so the user can compare and pick a time. It presents data; do not use it to calculate answers. Call find_meeting_times or convert_time for those.",
      inputSchema: renderInputSchema,
      outputSchema: renderOutputSchema,
      annotations: READ_ONLY_COMPUTATION,
      _meta: {
        ui: { resourceUri: PLANNER_UI_URI },
        "openai/toolInvocation/invoking": "Building the planner",
        "openai/toolInvocation/invoked": "Planner ready",
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const participants = normalizeParticipants(args.participants);
        const grid = buildPlannerGrid({ participants, date: args.date });
        const output: RenderOutput = { ...grid, participants };
        return {
          content: [{ type: "text", text: formatRenderOutput(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return inputError(error);
      }
    },
  );

  registerAppResource(
    server,
    "Time zone planner",
    PLANNER_UI_URI,
    {
      description: "Hour-by-hour working-hours overlap grid for a group of time zones.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: PLANNER_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await deps.loadWidgetHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  return server;
}
