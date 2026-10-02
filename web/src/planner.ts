import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { RenderOutput } from "../../src/time/types.js";
import {
  cellDescription,
  dayMarker,
  headerText,
  hourLabel,
  modelContextText,
  noOverlapMessage,
  offsetLabel,
  parseRenderOutput,
  type SlotSummary,
  scheduleMessageText,
  shiftDate,
  summarizeSelection,
} from "./model.js";
import "./styles.css";

const TOOL_NAME = "render_meeting_planner";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unknown error";
}

function resultMessage(result: ToolResult): string | null {
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) {
      return block.text;
    }
  }
  return null;
}

const app = new App({ name: "time-zone-planner", version: "1.0.0" });

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app element");
}

let locale = document.documentElement.lang || navigator.language || "en";
let grid: RenderOutput | null = null;
let selected: number | null = null;
let loading = false;
let requestSeq = 0;
let modelContextDirty = false;

const header = el("header", "top");
const title = el("h1", "title", "Meeting planner");
const nav = el("div", "nav");
const prevButton = el("button", "btn", "Previous day");
const nextButton = el("button", "btn", "Next day");
prevButton.type = "button";
nextButton.type = "button";
nav.append(prevButton, nextButton);
header.append(title, nav);

const status = el("p", "status");
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");

const content = el("div", "content");
const summaryPanel = el("section", "summary");
summaryPanel.setAttribute("aria-live", "polite");

root.append(header, status, content, summaryPanel);

let columnHeaders: HTMLElement[] = [];
let columnCells: HTMLElement[][] = [];
let columnButtons: (HTMLButtonElement | null)[] = [];

function setStatus(message: string): void {
  status.textContent = message;
  status.hidden = message === "";
}

function setLoading(value: boolean): void {
  loading = value;
  prevButton.disabled = value || grid === null;
  nextButton.disabled = value || grid === null;
  root?.toggleAttribute("aria-busy", value);
}

function showLoadingState(): void {
  content.replaceChildren(el("p", "placeholder", "Loading planner..."));
  summaryPanel.replaceChildren();
  header.hidden = true;
  setStatus("");
}

function showInvalidState(detail: string): void {
  grid = null;
  selected = null;
  columnHeaders = [];
  columnCells = [];
  columnButtons = [];
  header.hidden = true;
  const box = el("div", "placeholder error");
  box.append(el("p", undefined, "The planner could not be displayed."));
  box.append(el("p", "detail", detail));
  content.replaceChildren(box);
  summaryPanel.replaceChildren();
  setStatus("");
  setLoading(false);
}

function buildLegend(): HTMLElement {
  const legend = el("ul", "legend");
  const items: [string, string][] = [
    ["swatch working", "Working hours"],
    ["swatch off", "Off hours"],
    ["swatch overlap", "Everyone works"],
  ];
  for (const [swatchClass, label] of items) {
    const item = el("li");
    const swatch = el("span", swatchClass);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, el("span", undefined, label));
    legend.append(item);
  }
  return legend;
}

function buildTable(data: RenderOutput): HTMLElement {
  const overlap = new Set(data.overlap_columns);
  const organizer = data.rows[0];
  columnHeaders = [];
  columnCells = Array.from({ length: 24 }, () => []);
  columnButtons = Array.from({ length: 24 }, () => null);

  const table = el("table", "grid");
  table.append(
    el(
      "caption",
      "sr-only",
      `Working hours on ${data.date} for each participant. Columns are hours in ${data.organizer_time_zone}.`,
    ),
  );

  const headRow = el("tr");
  const corner = el("th", "who");
  corner.scope = "col";
  corner.textContent = "Participant";
  headRow.append(corner);

  for (let column = 0; column < 24; column++) {
    const th = el("th", "hour");
    th.scope = "col";
    th.dataset.col = String(column);
    const label = hourLabel(organizer?.cells[column]?.local_time ?? `${column}:00`);
    if (overlap.has(column)) {
      th.classList.add("overlap");
      const button = el("button", "pick", label);
      button.type = "button";
      button.dataset.col = String(column);
      button.setAttribute("aria-pressed", "false");
      button.setAttribute(
        "aria-label",
        `${organizer?.cells[column]?.local_time ?? label} ${data.organizer_time_zone}, everyone works`,
      );
      th.append(button);
      columnButtons[column] = button;
    } else {
      th.textContent = label;
    }
    columnHeaders[column] = th;
    headRow.append(th);
  }
  const thead = el("thead");
  thead.append(headRow);

  const tbody = el("tbody");
  data.rows.forEach((row, rowIndex) => {
    const tr = el("tr");
    const th = el("th", "who");
    th.scope = "row";
    th.append(
      el("span", "name", row.name),
      el("span", "zone", `${row.time_zone} \u00b7 ${offsetLabel(row.utc_offset)}`),
    );
    tr.append(th);

    row.cells.forEach((cell, column) => {
      const td = el("td", `cell ${cell.state}`);
      td.dataset.col = String(column);
      td.title = cellDescription(row, column, data.date, locale);
      td.append(el("span", "h", hourLabel(cell.local_time)));
      const marker = dayMarker(row.cells, column, data.date);
      if (marker) {
        td.append(el("span", "day", marker));
      }
      td.append(el("span", "sr-only", cell.state === "working" ? ", working" : ", off"));
      if (overlap.has(column)) {
        td.classList.add("overlap");
        if (rowIndex === data.rows.length - 1) {
          td.classList.add("last");
        }
      }
      columnCells[column]?.push(td);
      tr.append(td);
    });
    tbody.append(tr);
  });

  table.append(thead, tbody);
  const scroll = el("div", "scroll");
  scroll.tabIndex = -1;
  scroll.append(table);
  return scroll;
}

function renderSummary(summary: SlotSummary | null): void {
  if (!grid) {
    summaryPanel.replaceChildren();
    return;
  }
  if (grid.overlap_columns.length === 0) {
    summaryPanel.replaceChildren(el("p", "empty", noOverlapMessage()));
    return;
  }
  if (!summary) {
    summaryPanel.replaceChildren(
      el("p", "hint", "Select a highlighted hour to see everyone's local time."),
    );
    return;
  }
  const heading = el("h2", "summary-title", `Selected: ${summary.organizer_readable}`);
  const list = el("ul", "slot-lines");
  for (const line of summary.lines) {
    list.append(el("li", undefined, line.text));
  }
  const use = el("button", "btn primary", "Use this time");
  use.type = "button";
  use.addEventListener("click", () => {
    void useThisTime(summary, use);
  });
  summaryPanel.replaceChildren(heading, list, use);
}

function applySelection(column: number | null): void {
  const previous = selected;
  selected = column;
  for (const index of [previous, column]) {
    if (index === null) {
      continue;
    }
    const on = index === column;
    columnHeaders[index]?.classList.toggle("selected", on);
    for (const cell of columnCells[index] ?? []) {
      cell.classList.toggle("selected", on);
    }
    columnButtons[index]?.setAttribute("aria-pressed", String(on));
  }
  const summary = grid && column !== null ? summarizeSelection(grid, column, locale) : null;
  renderSummary(summary);
  syncModelContext(summary);
}

function syncModelContext(summary: SlotSummary | null): void {
  if (!summary && !modelContextDirty) {
    return;
  }
  const text = summary
    ? modelContextText(summary)
    : "The user has not selected a meeting slot in the planner.";
  modelContextDirty = summary !== null;
  app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {
    modelContextDirty = false;
  });
}

function render(data: RenderOutput): void {
  grid = data;
  selected = null;
  header.hidden = false;
  title.textContent = headerText(data, locale);
  content.replaceChildren(buildTable(data), buildLegend());
  renderSummary(null);
  setLoading(false);
  syncModelContext(null);
}

function toggleColumn(column: number): void {
  if (!grid?.overlap_columns.includes(column)) {
    return;
  }
  applySelection(selected === column ? null : column);
}

async function navigate(days: number): Promise<void> {
  if (!grid || loading) {
    return;
  }
  const current = grid;
  const seq = ++requestSeq;
  setLoading(true);
  setStatus("Loading...");
  try {
    const result = await app.callServerTool({
      name: TOOL_NAME,
      arguments: { participants: current.participants, date: shiftDate(current.date, days) },
    });
    if (seq !== requestSeq) {
      return;
    }
    const next = result.isError ? null : parseRenderOutput(result.structuredContent);
    if (!next) {
      const reason = result.isError ? resultMessage(result) : null;
      setStatus(`Could not load that day${reason ? `: ${reason}` : "."} Showing the previous day.`);
      setLoading(false);
      return;
    }
    setStatus("");
    render(next);
  } catch (error) {
    if (seq !== requestSeq) {
      return;
    }
    setStatus(`Could not load that day (${errorText(error)}). Showing the previous day.`);
    setLoading(false);
  }
}

async function useThisTime(summary: SlotSummary, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const result = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: scheduleMessageText(summary) }],
    });
    setStatus(
      result.isError
        ? "The host did not accept the message. You can ask for this time in the chat."
        : "Sent to the conversation.",
    );
  } catch (error) {
    setStatus(`Could not send the message (${errorText(error)}).`);
  } finally {
    button.disabled = false;
  }
}

prevButton.addEventListener("click", () => {
  void navigate(-1);
});
nextButton.addEventListener("click", () => {
  void navigate(1);
});

content.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const target = event.target.closest<HTMLElement>("[data-col]");
  if (!target || !content.contains(target)) {
    return;
  }
  if (target.tagName === "TH") {
    return;
  }
  toggleColumn(Number(target.dataset.col));
});

content.addEventListener("keydown", (event) => {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.classList.contains("pick")) {
    return;
  }
  const columns = columnButtons.flatMap((button, index) => (button ? [index] : []));
  const position = columns.indexOf(Number(event.target.dataset.col));
  let nextPosition = position;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      nextPosition = Math.min(columns.length - 1, position + 1);
      break;
    case "ArrowLeft":
    case "ArrowUp":
      nextPosition = Math.max(0, position - 1);
      break;
    case "Home":
      nextPosition = 0;
      break;
    case "End":
      nextPosition = columns.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const column = columns[nextPosition];
  if (column !== undefined) {
    columnButtons[column]?.focus();
  }
});

function applyHostContext(context: McpUiHostContext | undefined): void {
  if (!context) {
    return;
  }
  if (context.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts) {
    applyHostFonts(context.styles.css.fonts);
  }
  const insets = context.safeAreaInsets;
  if (insets) {
    const style = document.documentElement.style;
    style.setProperty("--safe-top", `${insets.top}px`);
    style.setProperty("--safe-right", `${insets.right}px`);
    style.setProperty("--safe-bottom", `${insets.bottom}px`);
    style.setProperty("--safe-left", `${insets.left}px`);
  }
  if (context.locale && context.locale !== locale) {
    locale = context.locale;
    if (grid) {
      const current = grid;
      const keep = selected;
      render(current);
      if (keep !== null) {
        applySelection(keep);
      }
    }
  }
}

app.ontoolinput = () => {
  if (!grid) {
    showLoadingState();
  }
};

app.ontoolresult = (result) => {
  requestSeq++;
  const next = result.isError ? null : parseRenderOutput(result.structuredContent);
  if (next) {
    render(next);
    return;
  }
  showInvalidState(
    result.isError
      ? (resultMessage(result) ?? "The tool reported an error.")
      : "The tool result did not have the expected format.",
  );
};

app.ontoolcancelled = () => {
  if (!grid) {
    showInvalidState("The request was cancelled.");
  }
};

app.onhostcontextchanged = (context) => {
  applyHostContext(app.getHostContext() ?? context);
};

app.onteardown = async () => {
  requestSeq++;
  return {};
};

app.onerror = (error) => {
  console.error("MCP app error", error);
};

showLoadingState();
setLoading(false);

app
  .connect()
  .then(() => {
    applyHostContext(app.getHostContext());
  })
  .catch((error: unknown) => {
    showInvalidState(`Could not connect to the host (${errorText(error)}).`);
  });
