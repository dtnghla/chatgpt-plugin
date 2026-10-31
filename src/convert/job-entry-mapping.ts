import type { ConversionStatus } from "./step-mapping.js";

export interface JobEntryMapping {
  status: ConversionStatus;
  conversion: string;
}

const MAPPINGS: Record<string, JobEntryMapping> = {
  SPECIAL: {
    status: "automatic",
    conversion: "START becomes a Pass state; SUCCESS and FAILURE become Succeed and Fail states",
  },
  TRANS: {
    status: "automatic",
    conversion: "Glue startJobRun.sync task for the matching transformation",
  },
  JOB: { status: "automatic", conversion: "Nested Step Functions startExecution.sync task" },
  DUMMY: { status: "automatic", conversion: "Pass state" },
  WRITE_TO_LOG: {
    status: "automatic",
    conversion: "Pass state with the log message in the report",
  },
  SET_VARIABLES: { status: "automatic", conversion: "Pass state with JSONata Assign" },
  WAIT: { status: "automatic", conversion: "Wait state" },
  SUCCESS: { status: "automatic", conversion: "Succeed state" },
  FAILURE: { status: "automatic", conversion: "Fail state" },
  ABORT: { status: "automatic", conversion: "Fail state" },
  MAIL: { status: "automatic", conversion: "SNS publish task" },
  SQL: {
    status: "partial",
    conversion: "One SQL-runner Glue job per job, selected by --entry",
  },
  FILE_EXISTS: { status: "partial", conversion: "S3 headObject task" },
  WAIT_FOR_FILE: { status: "partial", conversion: "S3 headObject task with retries" },
  DELETE_FILES: { status: "partial", conversion: "S3 deleteObject task" },
  COPY_FILES: { status: "partial", conversion: "S3 copyObject task" },
  MOVE_FILES: { status: "partial", conversion: "S3 copyObject and deleteObject tasks" },
  EVAL: { status: "partial", conversion: "Choice state for simple comparisons" },
  SHELL: {
    status: "manual",
    conversion: "Not executed; replace with a container, Lambda or Glue task",
  },
  FTP: { status: "manual", conversion: "Not executed; use AWS Transfer Family or S3" },
  SFTP: { status: "manual", conversion: "Not executed; use AWS Transfer Family or S3" },
  HTTP: { status: "manual", conversion: "Not executed; use a Lambda task" },
  JAVASCRIPT: {
    status: "manual",
    conversion: "Not executed; replace with a Lambda or Glue task",
  },
  ZIP: { status: "manual", conversion: "Not executed; use Lambda or Glue" },
};

const UNKNOWN: JobEntryMapping = {
  status: "manual",
  conversion: "Not executed; needs a manual state machine task",
};

export function jobEntryMapping(type: string): JobEntryMapping {
  return MAPPINGS[type.toUpperCase()] ?? UNKNOWN;
}
