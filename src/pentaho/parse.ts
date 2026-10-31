import { createHash } from "node:crypto";
import path from "node:path";
import type { InputFile } from "../ingest/types.js";
import { IngestError } from "../ingest/types.js";
import {
  boolAt,
  child,
  children,
  node,
  numberAt,
  parseXml,
  stringAt,
  type XmlNode,
  xmlToJson,
} from "../ingest/xml.js";
import type {
  Hop,
  Job,
  JobEntry,
  PentahoConnection,
  PentahoFile,
  PentahoParameter,
  PentahoProject,
  Schedule,
  Transformation,
  TransformationStep,
} from "./types.js";
import { collectVariables } from "./variables.js";

const SECRET_PROPERTY = /(?:password|passwd|secret|token|credential|api[-_.]?key)/i;

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isAllowedFile(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  if (base === "kettle.properties" || base === "shared.xml") return true;
  const ext = path.posix.extname(base);
  return ext === ".ktr" || ext === ".kjb" || ext === ".xml";
}

function documentRoot(value: XmlNode): XmlNode {
  const keys = Object.keys(value).filter((key) => !key.startsWith("@_") && key !== "#text");
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only) {
    const raw = value[only];
    const candidate = Array.isArray(raw) ? node(raw[0]) : node(raw);
    if (candidate) return candidate;
  }
  return value;
}

function parseParameters(value: unknown): PentahoParameter[] {
  const container = child(value, "parameters") ?? node(value);
  return children(container, "parameter").flatMap((parameter) => {
    const name = stringAt(parameter, "name");
    if (!name) return [];
    return [
      {
        name,
        defaultValue: stringAt(parameter, "default_value") || undefined,
        description: stringAt(parameter, "description") || undefined,
      },
    ];
  });
}

function parseHop(value: unknown): Hop | undefined {
  const from = stringAt(value, "from");
  const to = stringAt(value, "to");
  if (!from || !to) return undefined;
  return {
    from,
    to,
    enabled: boolAt(value, "enabled") ?? true,
    unconditional: boolAt(value, "unconditional") ?? false,
    evaluation: stringAt(value, "evaluation"),
  };
}

function parseHops(root: XmlNode): Hop[] {
  const orders = children(root, "order");
  const containers = [...orders, ...children(root, "hops")];
  const hops = containers.flatMap((container) => children(container, "hop"));
  return hops.flatMap((hop) => {
    const parsed = parseHop(hop);
    return parsed ? [parsed] : [];
  });
}

function parseConnections(
  root: XmlNode,
  sourceFile: string,
  warnings: string[],
): PentahoConnection[] {
  const direct = children(root, "connections").flatMap((container) =>
    children(container, "connection"),
  );
  const loose = children(root, "connection");
  return [...direct, ...loose].flatMap((connection) => {
    const name = stringAt(connection, "name");
    if (!name) return [];
    const password = stringAt(connection, "password") ?? stringAt(connection, "pass");
    const parsed: PentahoConnection = {
      name,
      type:
        stringAt(connection, "type") ??
        stringAt(connection, "database_type") ??
        stringAt(connection, "dialect") ??
        "GENERIC",
      host:
        stringAt(connection, "server") ??
        stringAt(connection, "hostname") ??
        stringAt(connection, "host") ??
        undefined,
      database:
        stringAt(connection, "database") ??
        stringAt(connection, "db") ??
        stringAt(connection, "databaseName") ??
        undefined,
      port: stringAt(connection, "port") ?? undefined,
      username: stringAt(connection, "username") ?? stringAt(connection, "user") ?? undefined,
      hasPassword: (password ?? "").length > 0,
      url: stringAt(connection, "url") ?? stringAt(connection, "jdbc_url") ?? undefined,
      driver: stringAt(connection, "driver") ?? undefined,
      sourceFile,
    };
    if (!parsed.host && !parsed.url) {
      warnings.push(`Connection "${name}" in ${sourceFile} has no host or JDBC URL; review it.`);
    }
    return [parsed];
  });
}

function parseStep(value: unknown): TransformationStep | undefined {
  const name = stringAt(value, "name");
  const type = stringAt(value, "type");
  if (!name || !type) return undefined;
  return {
    name,
    type,
    description: stringAt(value, "description") || undefined,
    connection: stringAt(value, "connection") || undefined,
    x: numberAt(value, "xloc"),
    y: numberAt(value, "yloc"),
    raw: node(xmlToJson(value)) ?? {},
  };
}

function parseTransformation(root: XmlNode, file: string): Transformation {
  const info = child(root, "info");
  const name =
    stringAt(info, "name") ??
    stringAt(root, "name") ??
    path.posix.basename(file).replace(/\.ktr$/i, "");
  const steps = children(root, "step").flatMap((step) => {
    const parsed = parseStep(step);
    return parsed ? [parsed] : [];
  });
  const variables = collectVariables(root);
  return {
    name,
    description: stringAt(info, "description") || stringAt(root, "description") || undefined,
    file,
    steps,
    hops: parseHops(root),
    parameters: parseParameters(info ?? root),
    connections: [...new Set(steps.flatMap((step) => (step.connection ? [step.connection] : [])))],
    variables: [...variables].sort(),
  };
}

function parseJobEntry(value: unknown): JobEntry | undefined {
  const name = stringAt(value, "name");
  const type = stringAt(value, "type");
  if (!name || !type) return undefined;
  const start = boolAt(value, "start") ?? false;
  const schedulerType = numberAt(value, "schedulerType") ?? 0;
  return {
    name,
    type: type.toUpperCase(),
    description: stringAt(value, "description") || undefined,
    start,
    success: boolAt(value, "success") ?? false,
    failure: boolAt(value, "failure") ?? false,
    dummy: boolAt(value, "dummy") ?? false,
    repeat: boolAt(value, "repeat") ?? false,
    parallel: boolAt(value, "parallel") ?? false,
    schedulerType,
    intervalSeconds: numberAt(value, "intervalSeconds") ?? 0,
    intervalMinutes: numberAt(value, "intervalMinutes") ?? 0,
    hour: numberAt(value, "hour") ?? 12,
    minutes: numberAt(value, "minutes") ?? 0,
    weekDay: numberAt(value, "weekDay") ?? 1,
    dayOfMonth: numberAt(value, "dayOfMonth") ?? numberAt(value, "DayOfMonth") ?? 1,
    x: numberAt(value, "xloc"),
    y: numberAt(value, "yloc"),
    raw: node(xmlToJson(value)) ?? {},
  };
}

function parseJob(root: XmlNode, file: string, warnings: string[]): Job {
  const name = stringAt(root, "name") ?? path.posix.basename(file).replace(/\.kjb$/i, "");
  const entries = children(root, "entries").flatMap((container) => children(container, "entry"));
  const parsedEntries = entries.flatMap((entry) => {
    const parsed = parseJobEntry(entry);
    return parsed ? [parsed] : [];
  });
  const schedules: Schedule[] = [];
  for (const entry of parsedEntries) {
    if (!entry.start || entry.schedulerType === 0) continue;
    schedules.push({
      job: name,
      file,
      entry: entry.name,
      schedulerType: entry.schedulerType,
      repeat: boolAt(entry.raw, "repeat") ?? false,
      intervalSeconds: entry.intervalSeconds,
      intervalMinutes: entry.intervalMinutes,
      hour: entry.hour,
      minutes: entry.minutes,
      weekDay: entry.weekDay,
      dayOfMonth: entry.dayOfMonth,
    });
  }
  if (parsedEntries.filter((entry) => entry.start).length > 1) {
    warnings.push(`Job "${name}" has more than one START entry; only the first is used.`);
  }
  if (parsedEntries.length === 0) warnings.push(`Job "${name}" has no job entries.`);
  const variables = collectVariables(root);
  return {
    name,
    description: stringAt(root, "description") || undefined,
    file,
    entries: parsedEntries,
    hops: parseHops(root),
    parameters: parseParameters(root),
    connections: [
      ...new Set(
        parsedEntries.flatMap((entry) => {
          const connection = stringAt(entry.raw, "connection");
          return connection ? [connection] : [];
        }),
      ),
    ],
    variables: [...variables].sort(),
    schedules,
  };
}

function parseProperties(raw: string, warnings: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const match = /^((?:\\.|[^=:\s])+)\s*[=:]\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").replace(/\\(.)/g, "$1");
    let value = match[2] ?? "";
    value = value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\(.)/g, "$1");
    if (SECRET_PROPERTY.test(key)) {
      result[key] = "***REDACTED***";
      warnings.push(`Redacted secret-like property "${key}" from kettle.properties.`);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function collectRepositoryNodes(root: XmlNode): { transformations: XmlNode[]; jobs: XmlNode[] } {
  const transformations: XmlNode[] = [];
  const jobs: XmlNode[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    const current = node(value);
    if (!current) return;
    for (const [key, childValue] of Object.entries(current)) {
      const items = Array.isArray(childValue) ? childValue : [childValue];
      for (const item of items) {
        const candidate = node(item);
        if (!candidate) continue;
        if (
          key === "transformation" &&
          (candidate.info !== undefined || candidate.step !== undefined)
        ) {
          transformations.push(candidate);
        } else if (
          key === "job" &&
          (candidate.entries !== undefined || candidate.name !== undefined)
        ) {
          jobs.push(candidate);
        } else {
          visit(candidate, depth + 1);
        }
      }
    }
  };
  visit(root, 0);
  return { transformations, jobs };
}

export function parsePentahoProject(files: InputFile[]): PentahoProject {
  const parsedFiles: PentahoFile[] = [];
  const transformations: Transformation[] = [];
  const jobs: Job[] = [];
  const connections: PentahoConnection[] = [];
  const properties: Record<string, string> = {};
  const schedules: Schedule[] = [];
  const warnings: string[] = [];
  const seenConnection = new Map<string, PentahoConnection>();

  const addConnections = (found: PentahoConnection[], sourceFile: string) => {
    for (const connection of found) {
      const existing = seenConnection.get(connection.name);
      if (!existing) {
        seenConnection.set(connection.name, connection);
        connections.push(connection);
        continue;
      }
      if (
        existing.host !== connection.host ||
        existing.database !== connection.database ||
        existing.type !== connection.type
      ) {
        warnings.push(
          `Connection name "${connection.name}" is defined differently in ${existing.sourceFile} and ${sourceFile}; the first definition is used.`,
        );
      }
    }
  };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isAllowedFile(file.path)) {
      warnings.push(
        `Skipped ${file.path}: only .ktr, .kjb, repository-export .xml, kettle.properties and shared.xml are accepted.`,
      );
      continue;
    }
    const ext = path.posix.extname(file.path).toLowerCase();
    const base = path.posix.basename(file.path).toLowerCase();
    const fileRecord: PentahoFile = {
      path: file.path,
      kind: "other",
      bytes: file.data.byteLength,
      sha256: sha256(file.data),
    };
    try {
      if (base === "kettle.properties") {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
        Object.assign(properties, parseProperties(raw, warnings));
        fileRecord.kind = "properties";
        parsedFiles.push(fileRecord);
        continue;
      }
      if (ext === ".ktr" || ext === ".kjb" || ext === ".xml") {
        const root = documentRoot(parseXml(file.data, file.path));
        if (ext === ".ktr") {
          const foundConnections = parseConnections(root, file.path, warnings);
          addConnections(foundConnections, file.path);
          transformations.push(parseTransformation(root, file.path));
          fileRecord.kind = "transformation";
        } else if (ext === ".kjb") {
          const foundConnections = parseConnections(root, file.path, warnings);
          addConnections(foundConnections, file.path);
          const job = parseJob(root, file.path, warnings);
          jobs.push(job);
          schedules.push(...job.schedules);
          fileRecord.kind = "job";
        } else if (base === "shared.xml") {
          const foundConnections = parseConnections(root, file.path, warnings);
          addConnections(foundConnections, file.path);
          fileRecord.kind = "shared";
        } else {
          const found = collectRepositoryNodes(root);
          if (found.transformations.length === 0 && found.jobs.length === 0) {
            warnings.push(
              `Skipped ${file.path}: XML file is not a transformation, job or repository export.`,
            );
            continue;
          }
          for (const transformation of found.transformations) {
            const foundConnections = parseConnections(transformation, file.path, warnings);
            addConnections(foundConnections, file.path);
            transformations.push(parseTransformation(transformation, file.path));
          }
          for (const job of found.jobs) {
            const foundConnections = parseConnections(job, file.path, warnings);
            addConnections(foundConnections, file.path);
            const parsedJob = parseJob(job, file.path, warnings);
            jobs.push(parsedJob);
            schedules.push(...parsedJob.schedules);
          }
          fileRecord.kind = "repository";
        }
        parsedFiles.push(fileRecord);
      } else {
        warnings.push(`Skipped unsupported file ${file.path}.`);
      }
    } catch (error) {
      if (error instanceof IngestError) {
        warnings.push(error.message);
        continue;
      }
      throw error;
    }
  }

  if (transformations.length === 0 && jobs.length === 0) {
    throw new IngestError(
      "No Pentaho transformations or jobs were found. Upload .ktr/.kjb files, a repository export, or a ZIP of the project.",
    );
  }
  return {
    files: parsedFiles,
    transformations: transformations.sort(
      (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
    ),
    jobs: jobs.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
    connections,
    properties,
    schedules: schedules.sort(
      (a, b) => a.file.localeCompare(b.file) || a.entry.localeCompare(b.entry),
    ),
    warnings,
  };
}
