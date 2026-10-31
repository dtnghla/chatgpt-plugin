import type { XmlNode } from "../ingest/xml.js";

export interface PentahoFile {
  path: string;
  kind: "transformation" | "job" | "repository" | "properties" | "shared" | "other";
  bytes: number;
  sha256: string;
}

export interface PentahoConnection {
  name: string;
  type: string;
  host?: string;
  database?: string;
  port?: string;
  username?: string;
  hasPassword: boolean;
  url?: string;
  driver?: string;
  sourceFile: string;
}

export interface PentahoParameter {
  name: string;
  defaultValue?: string;
  description?: string;
}

export interface TransformationStep {
  name: string;
  type: string;
  description?: string;
  connection?: string;
  x?: number;
  y?: number;
  raw: XmlNode;
}

export interface Hop {
  from: string;
  to: string;
  enabled: boolean;
  unconditional: boolean;
  evaluation?: string;
}

export interface Transformation {
  name: string;
  description?: string;
  file: string;
  steps: TransformationStep[];
  hops: Hop[];
  parameters: PentahoParameter[];
  connections: string[];
  variables: string[];
}

export interface JobEntry {
  name: string;
  type: string;
  description?: string;
  start: boolean;
  success: boolean;
  failure: boolean;
  dummy: boolean;
  repeat: boolean;
  parallel: boolean;
  schedulerType: number;
  intervalSeconds: number;
  intervalMinutes: number;
  hour: number;
  minutes: number;
  weekDay: number;
  dayOfMonth: number;
  x?: number;
  y?: number;
  raw: XmlNode;
}

export interface Schedule {
  job: string;
  file: string;
  entry: string;
  schedulerType: number;
  repeat: boolean;
  intervalSeconds: number;
  intervalMinutes: number;
  hour: number;
  minutes: number;
  weekDay: number;
  dayOfMonth: number;
}

export interface Job {
  name: string;
  description?: string;
  file: string;
  entries: JobEntry[];
  hops: Hop[];
  parameters: PentahoParameter[];
  connections: string[];
  variables: string[];
  schedules: Schedule[];
}

export interface PentahoProject {
  files: PentahoFile[];
  transformations: Transformation[];
  jobs: Job[];
  connections: PentahoConnection[];
  properties: Record<string, string>;
  schedules: Schedule[];
  warnings: string[];
}
