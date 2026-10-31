import { jobEntryMapping } from "../convert/job-entry-mapping.js";
import { stepMapping } from "../convert/step-mapping.js";
import type { Hop, PentahoProject } from "../pentaho/types.js";
import type { FlowEdge, FlowGraph, FlowNode } from "./types.js";

function isFailure(hop: Hop): boolean {
  const evaluation = hop.evaluation?.trim().toUpperCase();
  return evaluation === "N" || evaluation === "FALSE";
}

function place(
  items: { name: string; type: string; x?: number; y?: number }[],
  status: (type: string) => FlowNode["status"],
): FlowNode[] {
  const hasCoordinates = items.some(
    (item) =>
      typeof item.x === "number" && typeof item.y === "number" && (item.x !== 0 || item.y !== 0),
  );
  return items.map((item, index) => ({
    name: item.name,
    type: item.type,
    status: status(item.type),
    x: hasCoordinates ? Math.max(0, item.x ?? 0) : 40 + (index % 4) * 230,
    y: hasCoordinates ? Math.max(0, item.y ?? 0) : 40 + Math.floor(index / 4) * 130,
  }));
}

function edges(hops: Hop[]): FlowEdge[] {
  return hops.map((hop) => ({
    from: hop.from,
    to: hop.to,
    enabled: hop.enabled,
    failure: isFailure(hop),
  }));
}

export function buildFlows(project: PentahoProject): FlowGraph[] {
  const flows: FlowGraph[] = [];
  for (const transformation of project.transformations) {
    flows.push({
      kind: "transformation",
      name: transformation.name,
      file: transformation.file,
      nodes: place(transformation.steps, (type) => stepMapping(type).status),
      edges: edges(transformation.hops),
    });
  }
  for (const job of project.jobs) {
    flows.push({
      kind: "job",
      name: job.name,
      file: job.file,
      nodes: place(job.entries, (type) => jobEntryMapping(type).status),
      edges: edges(job.hops),
    });
  }
  return flows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}
