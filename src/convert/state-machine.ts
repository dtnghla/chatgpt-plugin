import path from "node:path";
import { boolAt, children, stringAt } from "../ingest/xml.js";
import { slugify } from "../migration/assessment.js";
import type { Hop, Job, JobEntry, Transformation } from "../pentaho/types.js";

export interface NestedStateMachineReference {
  /** Name used in the definition, resolved by CloudFormation Fn::Sub. */
  placeholder: string;
  targetJob: string;
  targetFile: string;
}

export interface StateMachinePlan {
  job: Job;
  stateMachineName: string;
  definition: Record<string, unknown>;
  json: string;
  nested: NestedStateMachineReference[];
  entryTypes: string[];
  warnings: string[];
  usesGlue: boolean;
  usesNested: boolean;
  usesSns: boolean;
  usesS3: boolean;
  usesSql: boolean;
  scheduleCount: number;
}

export interface StateMachineOptions {
  projectName: string;
  /** Returns the Glue job name for a transformation, or undefined when it is not in the bundle. */
  glueJobName: (transformation: Transformation) => string | undefined;
  /** Returns the state machine name for a nested job, or undefined when it is not in the bundle. */
  nestedStateMachineName: (job: Job) => string | undefined;
  /** Name of the generated SQL-runner Glue job, or undefined when the job has no SQL entries. */
  sqlJobName: (job: Job) => string | undefined;
  /** Maps a PDI file path to an s3:// URI (bucket placeholders allowed). */
  s3Uri: (pdiPath: string) => string;
  /** Number of EventBridge schedules that target this state machine. */
  scheduleCount?: number;
}

const GLUE_SYNC = "arn:aws:states:::glue:startJobRun.sync";
const NESTED_SYNC = "arn:aws:states:::states:startExecution.sync:2";
const SNS_PUBLISH = "arn:aws:states:::sns:publish";
const S3_HEAD = "arn:aws:states:::aws-sdk:s3:headObject";
const S3_DELETE = "arn:aws:states:::aws-sdk:s3:deleteObject";
const S3_COPY = "arn:aws:states:::aws-sdk:s3:copyObject";

const MAIL_TOPIC_PLACEHOLDER = "MailTopicArn";
const DATA_BUCKET_PLACEHOLDER = "DataBucket";

function normalizedFile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.posix
    .basename(value.replaceAll("\\", "/"))
    .replace(/\.(ktr|kjb)$/i, "")
    .toLowerCase();
}

function entryCandidates(entry: JobEntry): string[] {
  const raw = entry.raw;
  const values = [
    entry.name,
    typeof raw.transname === "string" ? raw.transname : undefined,
    typeof raw.jobname === "string" ? raw.jobname : undefined,
    typeof raw.filename === "string" ? raw.filename : undefined,
  ];
  const result: string[] = [];
  for (const value of values) {
    if (!value?.trim()) continue;
    result.push(value.trim().toLowerCase());
    const file = normalizedFile(value);
    if (file) result.push(file);
  }
  return [...new Set(result)];
}

function matchesEntry(entry: JobEntry, candidate: { name: string; file: string }): boolean {
  const candidates = entryCandidates(entry);
  const names = [candidate.name.toLowerCase(), normalizedFile(candidate.file) ?? ""];
  return names.some((name) => name !== "" && candidates.includes(name));
}

function findTransformation(
  entry: JobEntry,
  transformations: Transformation[],
): Transformation | undefined {
  return transformations.find((transformation) =>
    matchesEntry(entry, { name: transformation.name, file: transformation.file }),
  );
}

function findJob(entry: JobEntry, jobs: Job[]): Job | undefined {
  return jobs.find((job) => matchesEntry(entry, { name: job.name, file: job.file }));
}

function stateName(value: string, used: Set<string>, fallback: string): string {
  const base = value
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
  let candidate = base || fallback;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base || fallback}_${index}`.slice(0, 80);
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function outgoing(job: Job, name: string): Hop[] {
  return job.hops.filter((hop) => hop.enabled && hop.from === name);
}

function isFailureHop(hop: Hop): boolean {
  const evaluation = hop.evaluation?.trim().toUpperCase();
  return evaluation === "N" || evaluation === "FALSE";
}

function pickHop(
  hops: Hop[],
  failure: boolean,
  warnings: string[],
  entry: JobEntry,
): Hop | undefined {
  const candidates = hops.filter((hop) => (failure ? isFailureHop(hop) : !isFailureHop(hop)));
  if (candidates.length === 0) return undefined;
  const preferred = failure
    ? candidates[0]
    : (candidates.find((hop) => hop.unconditional) ?? candidates[0]);
  if (candidates.length > 1) {
    warnings.push(
      `Job entry "${entry.name}" has ${candidates.length} ${failure ? "failure" : "success"} hops; only "${preferred?.to}" is used because the generated state machine is sequential.`,
    );
  }
  return preferred;
}

function terminalState(entry: JobEntry): "Succeed" | "Fail" | undefined {
  if (entry.failure) return "Fail";
  if (entry.success) return "Succeed";
  return undefined;
}

function cleanComment(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, " ").slice(0, 200);
}

function s3Target(pdiPath: string, options: StateMachineOptions): { Bucket: string; Key: string } {
  const uri = options.s3Uri(pdiPath.trim());
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!match) {
    return { Bucket: `\${${DATA_BUCKET_PLACEHOLDER}}`, Key: `unmapped/${slugify(pdiPath)}` };
  }
  const [, bucket = "", key = ""] = match;
  const safeBucket = bucket.replace(/\$\{([^}]+)\}/g, "\${$1}") || `\${${DATA_BUCKET_PLACEHOLDER}}`;
  return { Bucket: safeBucket, Key: key || "unmapped/file" };
}

function entryFile(entry: JobEntry, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringAt(entry.raw, key);
    if (value) return value;
  }
  return undefined;
}

function variablesFromEntry(entry: JobEntry): Record<string, string> {
  const result: Record<string, string> = {};
  const variables = [
    ...children(entry.raw, "variables").flatMap((container) => children(container, "variable")),
    ...children(entry.raw, "fields").flatMap((container) => children(container, "field")),
  ];
  for (const variable of variables) {
    const rawName =
      stringAt(variable, "variable_name") ??
      stringAt(variable, "variablename") ??
      stringAt(variable, "name");
    const value =
      stringAt(variable, "variable_value") ??
      stringAt(variable, "variablevalue") ??
      stringAt(variable, "value") ??
      "";
    if (!rawName) continue;
    const name = rawName
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/^(\d)/, "_$1")
      .slice(0, 60);
    if (name) result[name] = value;
  }
  return result;
}

function waitSeconds(entry: JobEntry): number {
  const seconds =
    Number(stringAt(entry.raw, "maximumTimeout")) ||
    Number(stringAt(entry.raw, "intervalSeconds")) ||
    entry.intervalSeconds ||
    Number(stringAt(entry.raw, "seconds")) ||
    0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.min(86_400, Math.round(seconds));
}

function evalCondition(entry: JobEntry): { condition: string; valueLabel: string } | undefined {
  const field =
    stringAt(entry.raw, "fieldname") ??
    stringAt(entry.raw, "variable") ??
    stringAt(entry.raw, "field");
  if (!field) return undefined;
  const safeField = field.replace(/["\\]/g, "");
  const type = (stringAt(entry.raw, "valuetype") ?? stringAt(entry.raw, "type") ?? "String")
    .trim()
    .toLowerCase();
  if (type.startsWith("num")) {
    const value = Number(
      stringAt(entry.raw, "successnumber") ?? stringAt(entry.raw, "successvalue") ?? "0",
    );
    return {
      condition: `{% $lookup($states.input, "${safeField}") = ${Number.isFinite(value) ? value : 0} %}`,
      valueLabel: String(value),
    };
  }
  if (type.startsWith("bool")) {
    const value = boolAt(entry.raw, "successboolean") ?? false;
    return {
      condition: `{% $lookup($states.input, "${safeField}") = ${value} %}`,
      valueLabel: String(value),
    };
  }
  const raw =
    stringAt(entry.raw, "successvalue") ??
    stringAt(entry.raw, "successcondition") ??
    stringAt(entry.raw, "value") ??
    "";
  const value = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return {
    condition: `{% $lookup($states.input, "${safeField}") = "${value}" %}`,
    valueLabel: raw,
  };
}

function parameterDefaults(job: Job): Map<string, string> {
  const values = new Map<string, string>();
  for (const parameter of job.parameters) {
    if (parameter.defaultValue !== undefined && parameter.defaultValue !== "") {
      values.set(parameter.name, parameter.defaultValue);
    }
  }
  return values;
}

function substituteDefaults(value: string, defaults: Map<string, string>): string {
  return value.replace(
    /\$\{([^{}]+)\}|%%([^%]+)%%/g,
    (match, rawName: string | undefined, legacyName: string | undefined) => {
      const name = (rawName ?? legacyName ?? "").trim();
      return defaults.get(name) ?? match;
    },
  );
}

function mailFields(
  entry: JobEntry,
  job: Job,
  defaults: Map<string, string>,
): { subject: string; message: string } {
  const subject =
    stringAt(entry.raw, "subject") ??
    stringAt(entry.raw, "subjectText") ??
    `Pentaho migration notice: ${job.name}`;
  const message =
    stringAt(entry.raw, "message") ??
    stringAt(entry.raw, "comment") ??
    `Job entry "${entry.name}" reached in the migrated state machine for ${job.name}.`;
  return {
    subject: cleanComment(substituteDefaults(subject, defaults)),
    message: cleanComment(substituteDefaults(message, defaults)),
  };
}

function s3Arguments(
  entry: JobEntry,
  keys: string[],
  options: StateMachineOptions,
): { Bucket: string; Key: string } | undefined {
  const file = entryFile(entry, keys);
  return file ? s3Target(file, options) : undefined;
}

function parameterArguments(job: Job): Record<string, string> {
  const result: Record<string, string> = {};
  for (const parameter of job.parameters) {
    if (parameter.defaultValue === undefined || parameter.defaultValue === "") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name)) continue;
    result[`--${parameter.name}`] = parameter.defaultValue;
  }
  return result;
}

function parameterInput(job: Job): Record<string, string> {
  const result: Record<string, string> = {};
  for (const parameter of job.parameters) {
    if (parameter.defaultValue === undefined || parameter.defaultValue === "") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name)) continue;
    result[parameter.name] = parameter.defaultValue;
  }
  return result;
}

export function buildStateMachine(
  job: Job,
  transformations: Transformation[],
  jobs: Job[],
  options: StateMachineOptions,
): StateMachinePlan {
  const warnings: string[] = [];
  const usedNames = new Set<string>(["Succeed", "Fail"]);
  const stateNames = new Map<string, string>();
  const nested: NestedStateMachineReference[] = [];
  const entryTypes = [...new Set(job.entries.map((entry) => entry.type))].sort();
  const startEntry = job.entries.find((entry) => entry.start) ?? job.entries[0];
  let usesGlue = false;
  let usesNested = false;
  let usesSns = false;
  let usesS3 = false;
  let usesSql = false;

  for (const entry of job.entries) {
    stateNames.set(entry.name, stateName(entry.name, usedNames, `Entry_${stateNames.size + 1}`));
  }

  const nameOf = (entry: JobEntry | undefined, fallback: string): string =>
    entry ? (stateNames.get(entry.name) ?? fallback) : fallback;

  const states: Record<string, Record<string, unknown>> = {};
  if (!startEntry) {
    states.Start = { Type: "Pass", Next: "Succeed" };
    states.Succeed = { Type: "Succeed" };
    warnings.push(`Job "${job.name}" has no entries; the state machine only succeeds.`);
    const definition: Record<string, unknown> = {
      QueryLanguage: "JSONata",
      Comment: cleanComment(
        `Generated from ${job.file}. Review the migration report before deploying.`,
      ),
      StartAt: "Start",
      States: states,
    };
    return {
      job,
      stateMachineName: `${options.projectName}-${slugify(job.name)}`,
      definition,
      json: `${JSON.stringify(definition, null, 2)}\n`,
      nested,
      entryTypes,
      warnings,
      usesGlue,
      usesNested,
      usesSns,
      usesS3,
      usesSql,
      scheduleCount: options.scheduleCount ?? 0,
    };
  }

  const start = nameOf(startEntry, "Start");
  const glueArguments = parameterArguments(job);
  const nestedInput = parameterInput(job);
  const defaults = parameterDefaults(job);

  const getNext = (entry: JobEntry, failure: boolean): { next: string; viaHop: boolean } => {
    const hop = pickHop(outgoing(job, entry.name), failure, warnings, entry);
    if (!hop) return { next: failure ? "Fail" : "Succeed", viaHop: false };
    const target = job.entries.find((candidate) => candidate.name === hop.to);
    return { next: nameOf(target, "Succeed"), viaHop: target !== undefined };
  };

  const failureTarget = (entry: JobEntry): string | undefined => {
    const hop = pickHop(outgoing(job, entry.name), true, warnings, entry);
    return hop
      ? nameOf(
          job.entries.find((candidate) => candidate.name === hop.to),
          "Fail",
        )
      : undefined;
  };

  for (const entry of job.entries) {
    const name = nameOf(entry, entry.name);
    const success = getNext(entry, false);
    const successNext = success.next;
    const failureNext = failureTarget(entry);
    const terminal = terminalState(entry);
    const base = {
      ...(entry.description ? { Comment: cleanComment(entry.description) } : {}),
    };

    if (terminal === "Succeed") {
      states[name] = { Type: "Succeed" };
      continue;
    }
    if (terminal === "Fail") {
      const cause =
        stringAt(entry.raw, "message") ??
        stringAt(entry.raw, "cause") ??
        `PDI FAILURE entry "${entry.name}" in ${job.name}`;
      states[name] = {
        Type: "Fail",
        Error: "PentahoJobFailure",
        Cause: cleanComment(cause),
      };
      continue;
    }
    if (entry.type === "ABORT") {
      const cause =
        stringAt(entry.raw, "message") ?? `PDI ABORT entry "${entry.name}" in ${job.name}`;
      states[name] = {
        Type: "Fail",
        Error: "PentahoJobAborted",
        Cause: cleanComment(cause),
      };
      continue;
    }
    if (entry.start) {
      states[name] = {
        Type: "Pass",
        Comment: cleanComment(`PDI START entry "${entry.name}"`),
        Next: successNext,
      };
      if (failureNext) {
        warnings.push(
          `START entry "${entry.name}" has a failure hop; Pass states cannot catch errors, so it is ignored.`,
        );
      }
      continue;
    }

    if (entry.type === "TRANS") {
      const transformation = findTransformation(entry, transformations);
      const glueJobName = transformation ? options.glueJobName(transformation) : undefined;
      if (!transformation) {
        warnings.push(
          `Job entry "${entry.name}" references a transformation that was not uploaded; the state machine points at a placeholder Glue job.`,
        );
      }
      usesGlue = true;
      states[name] = {
        Type: "Task",
        Resource: GLUE_SYNC,
        Comment: cleanComment(
          transformation
            ? `Run Glue job for ${transformation.name}`
            : "Run the Glue job generated for this entry",
        ),
        Arguments: {
          JobName: glueJobName ?? `${options.projectName}-${slugify(entry.name)}`,
          ...(Object.keys(glueArguments).length > 0 ? { Arguments: glueArguments } : {}),
        },
        Next: successNext,
        ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
      };
      continue;
    }

    if (entry.type === "JOB") {
      const targetJob = findJob(entry, jobs);
      const targetName = targetJob ? options.nestedStateMachineName(targetJob) : undefined;
      if (!targetJob || !targetName) {
        warnings.push(
          `Job entry "${entry.name}" references a job that was not uploaded; the nested execution is replaced by a Pass state.`,
        );
        states[name] = {
          Type: "Pass",
          Comment: "Nested PDI job was not included in the upload",
          Next: successNext,
        };
        continue;
      }
      usesNested = true;
      const placeholder = `NestedStateMachineArn${nested.length}`;
      nested.push({ placeholder, targetJob: targetJob.name, targetFile: targetJob.file });
      states[name] = {
        Type: "Task",
        Resource: NESTED_SYNC,
        Comment: cleanComment(`Run nested job ${targetJob.name}`),
        Arguments: {
          StateMachineArn: `\${${placeholder}}`,
          Input: JSON.stringify(nestedInput),
        },
        Next: successNext,
        ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
      };
      continue;
    }

    if (entry.type === "DUMMY" || entry.type === "WRITE_TO_LOG") {
      const message = stringAt(entry.raw, "message") ?? stringAt(entry.raw, "log_message");
      states[name] = {
        Type: "Pass",
        ...(message ? { Comment: cleanComment(message) } : {}),
        Next: successNext,
      };
      if (failureNext) {
        warnings.push(
          `Job entry "${entry.name}" has a failure hop, but a Pass state cannot catch errors; it is ignored.`,
        );
      }
      continue;
    }

    if (entry.type === "SET_VARIABLES") {
      const variables = variablesFromEntry(entry);
      states[name] = {
        Type: "Pass",
        ...(Object.keys(variables).length > 0 ? { Assign: variables } : {}),
        Comment:
          Object.keys(variables).length > 0
            ? cleanComment(`Set ${Object.keys(variables).join(", ")}`)
            : "PDI Set variables entry",
        Next: successNext,
      };
      if (failureNext) {
        warnings.push(
          `Set variables entry "${entry.name}" has a failure hop; Pass states cannot catch errors, so it is ignored.`,
        );
      }
      continue;
    }

    if (entry.type === "WAIT") {
      states[name] = {
        Type: "Wait",
        Seconds: waitSeconds(entry),
        Next: successNext,
      };
      if (failureNext) {
        warnings.push(
          `Wait entry "${entry.name}" has a failure hop; Wait states cannot catch errors, so it is ignored.`,
        );
      }
      continue;
    }

    if (entry.type === "MAIL") {
      usesSns = true;
      const mail = mailFields(entry, job, defaults);
      states[name] = {
        Type: "Task",
        Resource: SNS_PUBLISH,
        Comment: cleanComment(`Email notification for ${entry.name}`),
        Arguments: {
          TopicArn: `\${${MAIL_TOPIC_PLACEHOLDER}}`,
          Subject: mail.subject,
          Message: mail.message,
        },
        Next: successNext,
        ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
      };
      continue;
    }

    if (entry.type === "SQL") {
      const sqlJobName = options.sqlJobName(job);
      if (!sqlJobName) {
        warnings.push(
          `SQL entry "${entry.name}" could not be migrated because the SQL runner was not generated.`,
        );
        states[name] = {
          Type: "Pass",
          Comment: "SQL entry was not migrated",
          Next: successNext,
        };
        continue;
      }
      usesGlue = true;
      usesSql = true;
      states[name] = {
        Type: "Task",
        Resource: GLUE_SYNC,
        Comment: cleanComment(`Run SQL entry "${entry.name}" through the SQL runner`),
        Arguments: {
          JobName: sqlJobName,
          Arguments: { "--job": job.name, "--entry": entry.name, ...glueArguments },
        },
        Next: successNext,
        ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
      };
      continue;
    }

    if (entry.type === "EVAL") {
      const condition = evalCondition(entry);
      if (!condition) {
        warnings.push(
          `Job entry "${entry.name}" (EVAL) has no field to evaluate; it becomes a Pass state.`,
        );
        states[name] = {
          Type: "Pass",
          Comment: "EVAL entry without a field",
          Next: successNext,
        };
        continue;
      }
      states[name] = {
        Type: "Choice",
        Comment: cleanComment(`PDI EVAL on "${condition.valueLabel}"`),
        Choices: [{ Condition: condition.condition, Next: successNext }],
        Default: failureNext ?? "Succeed",
      };
      if (!failureNext) {
        warnings.push(
          `EVAL entry "${entry.name}" has no failure hop; the false branch goes to Succeed.`,
        );
      }
      continue;
    }

    if (
      entry.type === "FILE_EXISTS" ||
      entry.type === "WAIT_FOR_FILE" ||
      entry.type === "DELETE_FILES" ||
      entry.type === "COPY_FILES" ||
      entry.type === "MOVE_FILES"
    ) {
      const sourceKeys =
        entry.type === "COPY_FILES" || entry.type === "MOVE_FILES"
          ? ["source_filefolder", "source_filefolder", "filename", "file"]
          : ["filename", "file", "files"];
      const target = s3Arguments(entry, [...new Set(sourceKeys)], options);
      if (!target) {
        warnings.push(
          `Job entry "${entry.name}" (${entry.type}) has no file path; it becomes a Pass state.`,
        );
        states[name] = {
          Type: "Pass",
          Comment: `${entry.type} entry without a file path`,
          Next: successNext,
        };
        continue;
      }
      usesS3 = true;
      if (entry.type === "FILE_EXISTS" || entry.type === "WAIT_FOR_FILE") {
        states[name] = {
          Type: "Task",
          Resource: S3_HEAD,
          Comment: cleanComment(`Check that ${target.Key} exists in S3`),
          Arguments: { Bucket: target.Bucket, Key: target.Key },
          Next: successNext,
          ...(entry.type === "WAIT_FOR_FILE"
            ? {
                Retry: [
                  {
                    ErrorEquals: ["S3.404"],
                    IntervalSeconds: 30,
                    MaxAttempts: 20,
                    BackoffRate: 1.5,
                  },
                ],
              }
            : {}),
          ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
        };
        continue;
      }
      if (entry.type === "DELETE_FILES") {
        states[name] = {
          Type: "Task",
          Resource: S3_DELETE,
          Comment: cleanComment(`Delete s3://.../${target.Key}`),
          Arguments: { Bucket: target.Bucket, Key: target.Key },
          Next: successNext,
          ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
        };
        continue;
      }
      const destination = s3Arguments(
        entry,
        ["destination_filefolder", "destination_file", "target"],
        options,
      );
      if (!destination) {
        warnings.push(
          `Job entry "${entry.name}" (${entry.type}) has no destination path; only the source is checked.`,
        );
        states[name] = {
          Type: "Task",
          Resource: S3_HEAD,
          Comment: cleanComment(`Check that ${target.Key} exists in S3`),
          Arguments: { Bucket: target.Bucket, Key: target.Key },
          Next: successNext,
          ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
        };
        continue;
      }
      const copyName = stateName(`${name}_copy`, usedNames, `${name}_copy`);
      states[name] = {
        Type: "Task",
        Resource: S3_COPY,
        Comment: cleanComment(`Copy ${target.Key} to ${destination.Key}`),
        Arguments: {
          Bucket: destination.Bucket,
          Key: destination.Key,
          CopySource: `${target.Bucket}/${target.Key}`,
        },
        Next: entry.type === "MOVE_FILES" ? copyName : successNext,
        ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
      };
      if (entry.type === "MOVE_FILES") {
        states[copyName] = {
          Type: "Task",
          Resource: S3_DELETE,
          Comment: cleanComment(`Remove the source ${target.Key} after the move`),
          Arguments: { Bucket: target.Bucket, Key: target.Key },
          Next: successNext,
          ...(failureNext ? { Catch: [{ ErrorEquals: ["States.ALL"], Next: failureNext }] } : {}),
        };
      }
      continue;
    }

    const mappingMessage =
      entry.type === "SHELL" ||
      entry.type === "FTP" ||
      entry.type === "SFTP" ||
      entry.type === "HTTP" ||
      entry.type === "JAVASCRIPT" ||
      entry.type === "ZIP"
        ? `uses ${entry.type}, which has no automatic state-machine mapping`
        : `uses ${entry.type}, which is not supported`;
    warnings.push(`Job entry "${entry.name}" ${mappingMessage}; it becomes a Pass state.`);
    states[name] = {
      Type: "Pass",
      ...base,
      Comment: cleanComment(`PDI ${entry.type} entry is not migrated`),
      Next: successNext,
    };
  }

  const reachable = new Set<string>();
  let cursor: string | undefined = start;
  let steps = 0;
  while (cursor && !reachable.has(cursor) && steps < 10_000) {
    reachable.add(cursor);
    const state: Record<string, unknown> | undefined = states[cursor];
    const next: unknown = state?.Next;
    cursor = typeof next === "string" ? next : undefined;
    steps += 1;
  }
  if (cursor && reachable.has(cursor)) {
    warnings.push(`Job "${job.name}" contains a hop cycle; the state machine may loop at runtime.`);
  }
  for (const state of Object.values(states)) {
    if (state.Type === "Task" || state.Type === "Pass" || state.Type === "Wait") {
      const next = state.Next;
      if (typeof next === "string" && !states[next] && next !== "Succeed" && next !== "Fail") {
        warnings.push(
          `A generated state points at the missing state "${next}"; it is sent to Succeed.`,
        );
        state.Next = "Succeed";
      }
    }
  }

  states.Succeed ??= { Type: "Succeed" };
  states.Fail ??= {
    Type: "Fail",
    Error: "PentahoJobFailure",
    Cause: cleanComment(`Job ${job.name} failed`),
  };

  const reachableFromStart = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachableFromStart.has(current)) continue;
    reachableFromStart.add(current);
    const state = states[current];
    if (!state) continue;
    if (typeof state.Next === "string") pending.push(state.Next);
    if (typeof state.Default === "string") pending.push(state.Default);
    for (const key of ["Choices", "Catch"] as const) {
      const list = state[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && typeof item === "object" && typeof item.Next === "string") {
          pending.push(item.Next);
        }
      }
    }
  }
  for (const fallback of ["Succeed", "Fail"] as const) {
    if (!reachableFromStart.has(fallback)) delete states[fallback];
  }

  const definition: Record<string, unknown> = {
    QueryLanguage: "JSONata",
    Comment: cleanComment(
      `Generated from ${job.file}. Review the migration report before deploying.`,
    ),
    StartAt: start,
    States: states,
  };
  return {
    job,
    stateMachineName: `${options.projectName}-${slugify(job.name)}`,
    definition,
    json: `${JSON.stringify(definition, null, 2)}\n`,
    nested,
    entryTypes,
    warnings,
    usesGlue,
    usesNested,
    usesSns,
    usesS3,
    usesSql,
    scheduleCount: options.scheduleCount ?? 0,
  };
}
