import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type {
  BundleSummary,
  FlowGraph,
  MigrationFileResult,
  ProjectAssessment,
  Risk,
} from "../../src/migration/types.js";
import {
  assessmentOf,
  bundlePrompt,
  edgePath,
  fileKindLabel,
  filePrompt,
  flowCounts,
  flowLabel,
  flowPrompt,
  formatBytes,
  generatePrompt,
  layoutFlow,
  modelContextText,
  parseMigrationFile,
  parseWorkbenchData,
  projectName,
  readiness,
  readinessLabel,
  recommendationText,
  relativeTime,
  riskLabel,
  safeDownloadUrl,
  sortedRisks,
  statusLabel,
  type WorkbenchData,
} from "./model.js";
import "./styles.css";

const TOOL_NAME = "get_migration_file";

type TabId = "overview" | "flows" | "bundle";
type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unknown error";
}

function resultMessage(result: ToolResult): string | null {
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) return block.text;
  }
  return null;
}

function truncated(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const app = new App({ name: "pentaho-to-aws", version: "1.0.0" });

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app element");

let locale = document.documentElement.lang || navigator.language || "en";
let data: WorkbenchData | null = null;
let activeTab: TabId = "overview";
let selectedFlowIndex = 0;
let selectedNode: string | null = null;
let openedFile: MigrationFileResult | null = null;
let fileError: string | null = null;
let loadingFile: string | null = null;
let loading = false;
let modelContext = "";

const header = el("header", "top");
const title = el("h1", "title", "Pentaho migration workbench");
const subtitle = el("p", "subtitle", "Upload .ktr and .kjb files to assess an AWS migration.");
const readinessPill = el("span", "pill");
const titleRow = el("div", "title-row");
titleRow.append(title, readinessPill);
const heading = el("div", "heading");
heading.append(titleRow, subtitle);

const tabBar = el("nav", "tabs");
tabBar.setAttribute("aria-label", "Workbench sections");
const tabButtons: Record<TabId, HTMLButtonElement> = {
  overview: el("button", "tab", "Overview"),
  flows: el("button", "tab", "Flows"),
  bundle: el("button", "tab", "Bundle"),
};
for (const [id, button] of Object.entries(tabButtons) as [TabId, HTMLButtonElement][]) {
  button.type = "button";
  button.id = `tab-${id}`;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-controls", "workbench-panel");
  button.addEventListener("click", () => selectTab(id));
  tabBar.append(button);
}

const status = el("p", "status");
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");
status.hidden = true;

const panel = el("section", "panel");
panel.id = "workbench-panel";
panel.setAttribute("role", "tabpanel");
panel.setAttribute("aria-labelledby", "tab-overview");

header.append(heading, tabBar);
root.append(header, status, panel);
readinessPill.hidden = true;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
  status.hidden = message === "";
}

function setLoading(value: boolean): void {
  loading = value;
  root?.toggleAttribute("aria-busy", value);
}

function syncContext(text: string): void {
  if (text === modelContext) return;
  modelContext = text;
  app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {
    modelContext = "";
  });
}

function showLoading(): void {
  if (data) return;
  header.hidden = true;
  readinessPill.hidden = true;
  panel.replaceChildren(el("p", "placeholder", "Reading the Pentaho project…"));
  setStatus("");
}

function showInvalid(detail: string): void {
  data = null;
  openedFile = null;
  header.hidden = true;
  readinessPill.hidden = true;
  const box = el("div", "placeholder error");
  box.append(
    el("p", undefined, "The migration workbench could not display this result."),
    el("p", "detail", detail),
  );
  panel.replaceChildren(box);
  setStatus("");
  setLoading(false);
}

function selectTab(id: TabId): void {
  if (id === "bundle" && data?.kind !== "bundle") return;
  activeTab = id;
  updateTabs();
  renderPanel();
}

function updateTabs(): void {
  const bundleReady = data?.kind === "bundle";
  for (const [id, button] of Object.entries(tabButtons) as [TabId, HTMLButtonElement][]) {
    const selected = id === activeTab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.disabled = id === "bundle" && !bundleReady;
  }
  panel.setAttribute("aria-labelledby", `tab-${activeTab}`);
}

function badge(text: string, className: string): HTMLSpanElement {
  return el("span", `badge ${className}`, text);
}

function statusBadge(status: "automatic" | "partial" | "manual"): HTMLSpanElement {
  return badge(statusLabel(status), `status-${status}`);
}

function section(titleText: string, description?: string): HTMLElement {
  const node = el("section", "card");
  node.append(el("h2", "card-title", titleText));
  if (description) node.append(el("p", "card-copy", description));
  return node;
}

function metric(value: string | number, label: string, hint?: string): HTMLElement {
  const node = el("div", "metric");
  node.append(el("span", "metric-value", String(value)), el("span", "metric-label", label));
  if (hint) node.append(el("span", "metric-hint", hint));
  return node;
}

type Cell = string | Node;

function table(headers: string[], rows: Cell[][], className = ""): HTMLElement {
  const wrapper = el("div", "table-scroll");
  const element = el("table", className || "data");
  const headRow = el("tr");
  for (const headerText of headers) {
    const th = el("th", undefined, headerText);
    th.scope = "col";
    headRow.append(th);
  }
  const thead = el("thead");
  thead.append(headRow);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const cell of row) {
      const td = el("td");
      if (typeof cell === "string") td.textContent = cell;
      else td.append(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  element.append(thead, tbody);
  wrapper.append(element);
  return wrapper;
}

function bulletList(items: string[], className = "list"): HTMLUListElement {
  const list = el("ul", className);
  for (const item of items) list.append(el("li", undefined, item));
  return list;
}

function actionButton(label: string, prompt: string, primary = false): HTMLButtonElement {
  const button = el("button", primary ? "btn primary" : "btn", label);
  button.type = "button";
  button.addEventListener("click", () => {
    void sendPrompt(prompt, button);
  });
  return button;
}

async function sendPrompt(prompt: string, button?: HTMLButtonElement): Promise<void> {
  if (button) button.disabled = true;
  try {
    const result = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: prompt }],
    });
    setStatus(
      result.isError
        ? "The host did not accept the message. Ask in the conversation instead."
        : "Sent to the conversation.",
      Boolean(result.isError),
    );
  } catch (error) {
    setStatus(`Could not send the message (${errorText(error)}).`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function readinessCard(view: WorkbenchData): HTMLElement {
  const assessment = assessmentOf(view);
  const state = readiness(view);
  const card = section("Readiness", recommendationText(view));
  const head = el("div", "readiness-head");
  const score = el("div", "score");
  score.append(el("span", "score-value", String(state.score)), el("span", "score-max", "/100"));
  const copy = el("div", "readiness-copy");
  copy.append(
    badge(readinessLabel(state.level), `readiness-${state.level}`),
    el("p", "readiness-summary", state.summary),
  );
  head.append(score, copy);
  card.append(head);

  const meter = el("div", "meter");
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "100");
  meter.setAttribute("aria-valuenow", String(state.score));
  meter.setAttribute("aria-label", "Migration readiness score");
  const fill = el("span", "meter-fill");
  fill.style.width = `${Math.max(0, Math.min(100, state.score))}%`;
  meter.append(fill);
  card.append(meter);

  if (state.blockers.length > 0) {
    const blockers = el("div", "blockers");
    blockers.append(el("h3", "subheading", "Blockers"));
    blockers.append(bulletList(state.blockers, "list compact"));
    card.append(blockers);
  }

  const actions = el("div", "actions");
  if (view.kind === "assessment") {
    actions.append(actionButton("Generate AWS bundle", generatePrompt(), true));
  } else {
    const url = safeDownloadUrl(view.bundle.download_url);
    if (url) {
      const link = el("a", "btn primary", "Download ZIP");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      actions.append(link);
      if (view.bundle.download_expires_at) {
        const expiry = new Date(view.bundle.download_expires_at);
        if (Number.isFinite(expiry.getTime())) {
          actions.append(
            el(
              "span",
              "muted",
              `Link expires ${expiry.toLocaleString(locale)} (${relativeTime(view.bundle.download_expires_at, Date.now()) ?? "soon"}).`,
            ),
          );
        }
      }
    } else {
      actions.append(
        el(
          "span",
          "muted",
          `No download link is configured. Read files with bundle_id ${view.bundle.bundle_id}.`,
        ),
      );
    }
    actions.append(actionButton("Ask about this bundle", bundlePrompt()));
  }
  card.append(actions);
  card.append(
    el(
      "p",
      "muted small",
      assessment.connections.some((connection) => connection.hasPassword)
        ? "Passwords from the Pentaho project were removed. Fill the generated Secrets Manager placeholders after deployment."
        : "This workbench is read-only and never contacts AWS or your databases.",
    ),
  );
  return card;
}

function metricsCard(assessment: ProjectAssessment): HTMLElement {
  const card = section("Project inventory");
  const grid = el("div", "metrics");
  grid.append(
    metric(assessment.totals.files, "Files"),
    metric(assessment.totals.transformations, "Transformations"),
    metric(assessment.totals.jobs, "Jobs"),
    metric(assessment.totals.steps, "Steps"),
    metric(assessment.totals.jobEntries, "Job entries"),
    metric(assessment.totals.connections, "Connections"),
    metric(assessment.totals.schedules, "Schedules"),
    metric(
      `${assessment.totals.supportedStepTypes}/${assessment.totals.partialStepTypes}/${assessment.totals.unsupportedStepTypes}`,
      "Automatic / partial / manual",
      "Distinct step types",
    ),
  );
  card.append(grid);
  return card;
}

function coverageCard(assessment: ProjectAssessment): HTMLElement {
  const card = section(
    "Step mapping coverage",
    "Every distinct PDI step type and how it maps to AWS Glue.",
  );
  const rows = assessment.stepCoverage.map((entry) => [
    entry.type,
    String(entry.count),
    statusBadge(entry.status),
    entry.conversion + (entry.caveat ? ` — ${entry.caveat}` : ""),
  ]);
  card.append(table(["PDI step type", "Count", "Status", "AWS mapping"], rows));
  if (assessment.jobEntryCoverage.length > 0) {
    card.append(el("h3", "subheading", "Job entries"));
    const jobRows = assessment.jobEntryCoverage.map((entry) => [
      entry.type,
      String(entry.count),
      statusBadge(entry.status),
      entry.conversion,
    ]);
    card.append(table(["PDI job entry", "Count", "Status", "AWS mapping"], jobRows));
  }
  return card;
}

function attentionCard(assessment: ProjectAssessment): HTMLElement | null {
  const steps = [...assessment.partialSteps, ...assessment.unsupportedSteps];
  if (steps.length === 0) return null;
  const card = section(
    "Steps needing attention",
    "Partial steps generate code that must be reviewed; manual steps need a PySpark replacement.",
  );
  const list = el("ul", "attention-list");
  for (const step of steps) {
    const item = el("li", "attention");
    item.append(
      statusBadge(step.status),
      el("span", "attention-name", step.step),
      el("span", "attention-meta", `${step.type} · ${step.file}`),
    );
    list.append(item);
  }
  card.append(list);
  return card;
}

function connectionsCard(assessment: ProjectAssessment): HTMLElement | null {
  if (assessment.connections.length === 0) return null;
  const card = section(
    "JDBC connections",
    "Secrets are generated as placeholders; no password is read or stored.",
  );
  const rows = assessment.connections.map((connection) => [
    connection.name,
    connection.type,
    connection.jdbcUrl,
    connection.secretName,
    connection.warnings.length > 0 ? connection.warnings.join(" ") : "—",
  ]);
  card.append(table(["Name", "Type", "JDBC URL", "Secrets Manager", "Notes"], rows));
  return card;
}

function schedulesCard(assessment: ProjectAssessment): HTMLElement | null {
  if (assessment.schedules.length === 0) return null;
  const card = section(
    "Schedules",
    "EventBridge Scheduler expressions derived from PDI schedulers.",
  );
  const rows = assessment.schedules.map((schedule) => [
    `${schedule.job}/${schedule.entry}`,
    schedule.mapped ? (schedule.expression ?? "—") : "Not mapped",
    schedule.description,
    schedule.note ?? "—",
  ]);
  card.append(table(["Job / entry", "Expression", "Description", "Notes"], rows));
  return card;
}

function questionsCard(assessment: ProjectAssessment): HTMLElement | null {
  if (assessment.questions.length === 0) return null;
  const card = section("Open questions");
  card.append(bulletList(assessment.questions));
  return card;
}

function parametersCard(assessment: ProjectAssessment): HTMLElement | null {
  const hasParameters = assessment.parameters.length > 0;
  const hasVariables = assessment.variables.length > 0;
  if (!hasParameters && !hasVariables) return null;
  const card = section("Parameters and variables");
  if (hasParameters) {
    const rows = assessment.parameters.map((parameter) => [
      parameter.name,
      parameter.defaultValue ?? "—",
      parameter.files.join(", "),
      parameter.description ?? "—",
    ]);
    card.append(table(["Parameter", "Default", "Files", "Description"], rows));
  }
  if (hasVariables) {
    card.append(el("h3", "subheading", "Referenced variables"));
    card.append(bulletList(assessment.variables, "chips"));
  }
  return card;
}

function risksCard(assessment: ProjectAssessment): HTMLElement | null {
  if (assessment.risks.length === 0) return null;
  const card = section("Risks and warnings");
  const list = el("ul", "risk-list");
  for (const risk of sortedRisks(assessment.risks)) {
    list.append(riskItem(risk));
  }
  card.append(list);
  return card;
}

function riskItem(risk: Risk): HTMLElement {
  const item = el("li", `risk risk-${risk.severity}`);
  const headerNode = el("div", "risk-head");
  headerNode.append(
    badge(riskLabel(risk.severity), `severity-${risk.severity}`),
    el("span", "risk-message", risk.message),
  );
  item.append(headerNode);
  if (risk.file || risk.step) {
    item.append(el("span", "risk-meta", [risk.file, risk.step].filter(Boolean).join(" · ")));
  }
  return item;
}

function renderOverview(view: WorkbenchData): HTMLElement[] {
  const assessment = assessmentOf(view);
  const nodes: (HTMLElement | null)[] = [
    readinessCard(view),
    metricsCard(assessment),
    attentionCard(assessment),
    coverageCard(assessment),
    connectionsCard(assessment),
    schedulesCard(assessment),
    questionsCard(assessment),
    parametersCard(assessment),
    risksCard(assessment),
  ];
  return nodes.filter((node): node is HTMLElement => node !== null);
}

function renderFlowGraph(flow: FlowGraph, onSelect: (name: string) => void): HTMLElement {
  const layout = layoutFlow(flow);
  const wrapper = el("div", "diagram");
  if (layout.nodes.length === 0) {
    wrapper.append(el("p", "placeholder", "This flow has no steps."));
    return wrapper;
  }
  const svg = svgEl("svg", {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    width: String(layout.width),
    height: String(layout.height),
    role: "img",
    "aria-label": `Flow diagram for ${flow.name}`,
  });
  const defs = svgEl("defs", {});
  for (const [id, className] of [
    ["flow-arrow", "arrow"],
    ["flow-arrow-failure", "arrow failure"],
    ["flow-arrow-disabled", "arrow disabled"],
  ] as const) {
    const marker = svgEl("marker", {
      id,
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "7",
      markerHeight: "7",
      orient: "auto-start-reverse",
    });
    const path = svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", class: className });
    marker.append(path);
    defs.append(marker);
  }
  svg.append(defs);

  const edgeLayer = svgEl("g", { class: "edges" });
  for (const laid of layout.edges) {
    const path = svgEl("path", {
      d: edgePath(laid),
      class: `edge${laid.edge.failure ? " failure" : ""}${laid.edge.enabled ? "" : " disabled"}`,
      "marker-end": laid.edge.failure
        ? "url(#flow-arrow-failure)"
        : laid.edge.enabled
          ? "url(#flow-arrow)"
          : "url(#flow-arrow-disabled)",
    });
    const titleNode = svgEl("title", {});
    titleNode.textContent = `${laid.edge.from} → ${laid.edge.to}${laid.edge.failure ? " (failure)" : ""}${laid.edge.enabled ? "" : " (disabled)"}`;
    path.append(titleNode);
    edgeLayer.append(path);
  }
  svg.append(edgeLayer);

  const nodeLayer = svgEl("g", { class: "nodes" });
  for (const laid of layout.nodes) {
    const group = svgEl("g", {
      class: `node status-${laid.node.status}${selectedNode === laid.node.name ? " selected" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-label": `${laid.node.name}, ${laid.node.type}, ${statusLabel(laid.node.status)}`,
      transform: `translate(${laid.x} ${laid.y})`,
    });
    const rect = svgEl("rect", {
      width: String(laid.width),
      height: String(laid.height),
      rx: "10",
    });
    const name = svgEl("text", { x: "12", y: "22", class: "node-name" });
    name.textContent = truncated(laid.node.name, 26);
    const type = svgEl("text", { x: "12", y: "40", class: "node-type" });
    type.textContent = truncated(laid.node.type, 28);
    const titleNode = svgEl("title", {});
    titleNode.textContent = `${laid.node.name} (${laid.node.type}) — ${statusLabel(laid.node.status)}`;
    group.append(rect, name, type, titleNode);
    const choose = () => onSelect(laid.node.name);
    group.addEventListener("click", choose);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
      }
    });
    nodeLayer.append(group);
  }
  svg.append(nodeLayer);
  wrapper.append(svg);

  const legend = el("ul", "legend");
  for (const status of ["automatic", "partial", "manual"] as const) {
    const item = el("li");
    item.append(badge(statusLabel(status), `status-${status}`));
    legend.append(item);
  }
  wrapper.append(legend);
  return wrapper;
}

function nodeDetails(flow: FlowGraph): HTMLElement | null {
  if (!selectedNode) return null;
  const node = flow.nodes.find((candidate) => candidate.name === selectedNode);
  if (!node) return null;
  const incoming = flow.edges.filter((edge) => edge.to === node.name).map((edge) => edge.from);
  const outgoing = flow.edges.filter((edge) => edge.from === node.name).map((edge) => edge.to);
  const card = section("Selected step");
  const head = el("div", "node-head");
  head.append(el("span", "node-title", node.name), statusBadge(node.status));
  card.append(head, el("p", "muted", `Type: ${node.type}`));
  if (incoming.length > 0) {
    card.append(el("h3", "subheading", "Incoming hops"));
    card.append(bulletList(incoming, "chips"));
  }
  if (outgoing.length > 0) {
    card.append(el("h3", "subheading", "Outgoing hops"));
    card.append(bulletList(outgoing, "chips"));
  }
  return card;
}

function nodeTable(flow: FlowGraph, onSelect: (name: string) => void): HTMLElement {
  const rows = flow.nodes.map((node) => {
    const button = el("button", "link-button", node.name);
    button.type = "button";
    button.addEventListener("click", () => onSelect(node.name));
    return [button, node.type, statusBadge(node.status), String(node.x), String(node.y)];
  });
  return table(["Step", "Type", "Mapping", "X", "Y"], rows);
}

function renderFlows(view: WorkbenchData): HTMLElement[] {
  const flows = view.kind === "assessment" ? [] : view.bundle.flows;
  if (flows.length === 0) {
    return [
      section(
        "Flows",
        view.kind === "assessment"
          ? "Generate the AWS migration bundle to render flow diagrams, or read the step coverage in the overview."
          : "The bundle did not include flow diagrams.",
      ),
    ];
  }
  const index = Math.min(selectedFlowIndex, flows.length - 1);
  const flow = flows[index];
  if (!flow) return [];
  const counts = flowCounts(flow);
  const container = el("div", "flow-view");
  const toolbar = el("div", "flow-toolbar");
  const label = el("label", "select-label", "Flow");
  const select = el("select", "select");
  label.htmlFor = "flow-select";
  select.id = "flow-select";
  flows.forEach((candidate, flowIndex) => {
    const option = el("option", undefined, truncated(flowLabel(candidate), 60));
    option.value = String(flowIndex);
    option.selected = flowIndex === index;
    select.append(option);
  });
  select.addEventListener("change", () => {
    selectedFlowIndex = Number(select.value);
    selectedNode = null;
    renderPanel();
  });
  toolbar.append(label, select);
  const stats = el("div", "flow-stats");
  stats.append(
    badge(`${counts.automatic} automatic`, "status-automatic"),
    badge(`${counts.partial} partial`, "status-partial"),
    badge(`${counts.manual} manual`, "status-manual"),
  );
  toolbar.append(stats);
  toolbar.append(actionButton("Ask about this flow", flowPrompt(flow)));
  container.append(toolbar);
  container.append(renderFlowGraph(flow, selectNode));
  const details = nodeDetails(flow);
  if (details) container.append(details);
  const tableCard = section("Steps and hops", `${flow.file} · ${flow.kind}`);
  tableCard.append(nodeTable(flow, selectNode));
  container.append(tableCard);
  return [container];
}

function selectNode(name: string): void {
  selectedNode = selectedNode === name ? null : name;
  if (data) {
    const flows = data.kind === "bundle" ? data.bundle.flows : [];
    const flow = flows[Math.min(selectedFlowIndex, flows.length - 1)];
    syncContext(
      modelContextText(
        data,
        selectedNode && flow
          ? `Selected step "${selectedNode}" in flow "${flow.name}".`
          : undefined,
      ),
    );
  }
  renderPanel();
}

function scheduleRows(bundle: BundleSummary): Cell[][] {
  return bundle.schedules.map((schedule) => [
    `${schedule.job}/${schedule.entry}`,
    schedule.mapped ? (schedule.expression ?? "—") : "Not mapped",
    schedule.description,
    schedule.note ?? "—",
  ]);
}

function bundleDetails(bundle: BundleSummary): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const dl = section(
    "Bundle",
    `Generated with ${bundle.generated_with}. The archive is deterministic.`,
  );
  const facts = el("div", "facts");
  facts.append(
    el("span", "fact", `Bundle ${bundle.bundle_id}`),
    el("span", "fact", `${bundle.files.length} files`),
    el("span", "fact", `${bundle.jobs.length} Glue jobs`),
    el("span", "fact", `${bundle.state_machines.length} state machines`),
    el("span", "fact", `${bundle.schedules.length} schedules`),
  );
  dl.append(facts);
  const url = safeDownloadUrl(bundle.download_url);
  const actions = el("div", "actions");
  if (url) {
    const link = el("a", "btn primary", "Download ZIP");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  actions.append(actionButton("Ask about this bundle", bundlePrompt()));
  dl.append(actions);
  nodes.push(dl);

  if (bundle.jobs.length > 0) {
    const card = section("Glue jobs");
    const list = el("ul", "artifact-list");
    for (const job of bundle.jobs) {
      const item = el("li", "artifact");
      const head = el("div", "artifact-head");
      head.append(
        el("span", "artifact-name", job.glue_job_name),
        badge(job.kind === "sql" ? "SQL runner" : "Transformation", "kind"),
      );
      item.append(head);
      item.append(el("span", "artifact-meta", `${job.transformation} · ${job.source_file}`));
      item.append(el("code", "path", job.script_path));
      const counts = el("div", "inline-badges");
      counts.append(
        badge(`${job.automatic_steps.length} automatic`, "status-automatic"),
        badge(`${job.partial_steps.length} partial`, "status-partial"),
        badge(`${job.manual_steps.length} manual`, "status-manual"),
      );
      item.append(counts);
      if (job.warnings.length > 0) {
        item.append(bulletList(job.warnings, "list compact"));
      }
      list.append(item);
    }
    card.append(list);
    nodes.push(card);
  }

  if (bundle.state_machines.length > 0) {
    const card = section("Step Functions");
    const rows = bundle.state_machines.map((machine) => [
      machine.state_machine_name,
      machine.job,
      machine.definition_path,
      String(machine.schedule_count),
      machine.warnings.join(" ") || "—",
    ]);
    card.append(table(["State machine", "Job", "Definition", "Schedules", "Warnings"], rows));
    nodes.push(card);
  }

  if (bundle.sql_runner) {
    const card = section("SQL runner");
    card.append(
      el(
        "p",
        "card-copy",
        `${bundle.sql_runner.name} runs ${bundle.sql_runner.entries} SQL job ${bundle.sql_runner.entries === 1 ? "entry" : "entries"} from ${bundle.sql_runner.script_path}.`,
      ),
    );
    if (bundle.sql_runner.warnings.length > 0) {
      card.append(bulletList(bundle.sql_runner.warnings, "list compact"));
    }
    nodes.push(card);
  }

  if (bundle.schedules.length > 0) {
    const card = section("Schedules");
    card.append(table(["Job / entry", "Expression", "Description", "Notes"], scheduleRows(bundle)));
    nodes.push(card);
  }

  if (bundle.connections.length > 0) {
    const card = section(
      "Secrets to fill after deployment",
      "Passwords are not included. Populate each secret before running the jobs.",
    );
    const rows = bundle.connections.map((connection) => [
      connection.name,
      connection.type,
      connection.jdbc_url,
      connection.secret_name,
      connection.has_password ? "Password already present" : "Password placeholder",
    ]);
    card.append(table(["Connection", "Type", "JDBC URL", "Secret", "Status"], rows));
    nodes.push(card);
  }

  const filesCard = section(
    "Generated files",
    "Read any text file below; it stays on this server.",
  );
  if (loadingFile) {
    filesCard.append(el("p", "status", `Loading ${loadingFile}…`));
  }
  if (fileError) {
    filesCard.append(el("p", "status error", fileError));
  }
  if (openedFile) {
    filesCard.append(fileViewer(openedFile));
  }
  const rows: Cell[][] = bundle.files.map((file) => {
    const button = el("button", "link-button", file.path);
    button.type = "button";
    button.addEventListener("click", () => {
      void openFile(file.path);
    });
    return [button, fileKindLabel(file.kind), formatBytes(file.bytes), file.sha256.slice(0, 16)];
  });
  filesCard.append(table(["Path", "Kind", "Size", "SHA-256"], rows));
  nodes.push(filesCard);

  if (bundle.warnings.length > 0) {
    const card = section("Warnings");
    card.append(bulletList(bundle.warnings));
    nodes.push(card);
  }

  if (bundle.next_steps.length > 0) {
    const card = section("Next steps");
    const list = el("ol", "steps");
    for (const step of bundle.next_steps) list.append(el("li", undefined, step));
    card.append(list);
    nodes.push(card);
  }

  const assessment = bundle.assessment;
  const risks = risksCard(assessment);
  if (risks) nodes.push(risks);
  return nodes;
}

function fileViewer(file: MigrationFileResult): HTMLElement {
  const card = section(
    file.path,
    `${fileKindLabel(file.kind)} · ${formatBytes(file.bytes)} · sha256 ${file.sha256.slice(0, 16)}`,
  );
  const actions = el("div", "actions");
  const copy = el("button", "btn", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    void copyFile(file, copy);
  });
  actions.append(copy, actionButton("Ask about this file", filePrompt(file)));
  card.append(actions);
  if (file.truncated) {
    card.append(
      el(
        "p",
        "status",
        "This file is larger than the server's response limit; only the beginning is shown.",
      ),
    );
  }
  const pre = el("pre", "file-content", file.content);
  pre.tabIndex = 0;
  card.append(pre);
  return card;
}

async function copyFile(file: MigrationFileResult, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(file.content);
    setStatus(`Copied ${file.path} to the clipboard.`);
  } catch {
    setStatus("Could not copy to the clipboard. Select the text manually.", true);
  } finally {
    button.disabled = false;
  }
}

let renderSeq = 0;

async function openFile(path: string): Promise<void> {
  if (!data || data.kind !== "bundle") return;
  const seq = ++renderSeq;
  openedFile = null;
  fileError = null;
  loadingFile = path;
  renderPanel();
  try {
    const result = await app.callServerTool({
      name: TOOL_NAME,
      arguments: { bundle_id: data.bundle.bundle_id, path },
    });
    if (seq !== renderSeq) return;
    if (result.isError) {
      fileError = resultMessage(result) ?? `Could not read ${path}.`;
    } else {
      const parsed = parseMigrationFile(result.structuredContent);
      if (!parsed) {
        fileError = `The server returned an unexpected result for ${path}.`;
      } else {
        openedFile = parsed;
        syncContext(
          modelContextText(data, `The user opened generated file "${path}" from the bundle.`),
        );
      }
    }
  } catch (error) {
    if (seq !== renderSeq) return;
    fileError = `Could not read ${path} (${errorText(error)}).`;
  } finally {
    if (seq === renderSeq) {
      loadingFile = null;
      renderPanel();
    }
  }
}

function renderPanel(): void {
  if (!data) return;
  if (activeTab === "bundle" && data.kind !== "bundle") activeTab = "overview";
  let nodes: HTMLElement[];
  if (activeTab === "overview") {
    nodes = renderOverview(data);
  } else if (activeTab === "flows") {
    nodes = renderFlows(data);
  } else if (data.kind === "bundle") {
    nodes = bundleDetails(data.bundle);
  } else {
    nodes = renderOverview(data);
  }
  panel.replaceChildren(...nodes);
  root?.toggleAttribute("aria-busy", loading);
}

function render(next: WorkbenchData): void {
  data = next;
  header.hidden = false;
  readinessPill.hidden = false;
  const state = readiness(next);
  title.textContent = projectName(next);
  subtitle.textContent =
    next.kind === "assessment"
      ? `Pentaho migration assessment · ${next.assessment.totals.files} files · ${next.assessment.totals.steps} steps`
      : `AWS migration bundle ${next.bundle.bundle_id} · ${next.bundle.generated_with}`;
  readinessPill.textContent = `${state.score}/100 · ${readinessLabel(state.level)}`;
  readinessPill.className = `pill readiness-${state.level}`;
  activeTab = next.kind === "bundle" ? "bundle" : "overview";
  selectedFlowIndex = 0;
  selectedNode = null;
  openedFile = null;
  fileError = null;
  loadingFile = null;
  updateTabs();
  renderPanel();
  setLoading(false);
  setStatus("");
  syncContext(modelContextText(next));
}

function applyHostContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  const insets = context.safeAreaInsets;
  if (insets) {
    const style = document.documentElement.style;
    style.setProperty("--safe-top", `${insets.top}px`);
    style.setProperty("--safe-right", `${insets.right}px`);
    style.setProperty("--safe-bottom", `${insets.bottom}px`);
    style.setProperty("--safe-left", `${insets.left}px`);
  }
  if (context.locale) locale = context.locale;
}

app.ontoolinput = () => {
  if (!data) {
    showLoading();
    setLoading(true);
  }
};

app.ontoolresult = (result) => {
  renderSeq++;
  const next = result.isError ? null : parseWorkbenchData(result.structuredContent);
  if (next) {
    render(next);
    return;
  }
  showInvalid(
    result.isError
      ? (resultMessage(result) ?? "The tool reported an error.")
      : "The tool result did not match the workbench schema.",
  );
};

app.ontoolcancelled = () => {
  if (!data) showInvalid("The request was cancelled.");
};

app.onhostcontextchanged = (context) => {
  applyHostContext(app.getHostContext() ?? context);
};

app.onteardown = async () => {
  renderSeq++;
  return {};
};

app.onerror = (error) => {
  console.error("MCP app error", error);
};

showLoading();
setLoading(false);
updateTabs();

app
  .connect()
  .then(() => {
    applyHostContext(app.getHostContext());
  })
  .catch((error: unknown) => {
    showInvalid(`Could not connect to the host (${errorText(error)}).`);
  });
