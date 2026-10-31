import type {
  ConnectionSummary,
  ScheduleSummary,
  StateMachineArtifact,
} from "../migration/types.js";
import { connectionSlug, driverClass } from "./jdbc.js";

export interface GlueJobTemplate {
  name: string;
  description: string;
  scriptPath: string;
  connections: string[];
  needsExcel: boolean;
}

export interface StateMachineTemplate {
  name: string;
  definitionJson: string;
  nested: { placeholder: string; stateMachineName: string }[];
  usesGlue: boolean;
  usesNested: boolean;
  usesSns: boolean;
  usesS3: boolean;
  usesSql: boolean;
}

export interface CloudFormationOptions {
  projectName: string;
  region: string;
  glueVersion: string;
  workerType: string;
  numberOfWorkers: number;
  scriptPrefix: string;
  dataBucketParameter?: string;
  scriptsBucketParameter?: string;
  connections: ConnectionSummary[];
  glueJobs: GlueJobTemplate[];
  stateMachines: StateMachineTemplate[];
  schedules: { name: string; expression: string; stateMachineName: string }[];
}

const MAIL_TOPIC = "MailTopic";

function safeLogical(value: string): string {
  const logical = value.replace(/[^A-Za-z0-9]/g, "").slice(0, 60);
  return logical && /^[A-Za-z]/.test(logical) ? logical : `Resource${logical}`;
}

function logicalId(base: string, used: Set<string>): string {
  let candidate = safeLogical(base);
  let index = 2;
  while (used.has(candidate)) {
    candidate = safeLogical(`${base}${index}`);
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function definitionsForSub(json: string, allowed: Set<string>): string {
  return json.replace(/\$\{([^{}]+)\}/g, (match, name: string) =>
    allowed.has(name) ? match : `\${!${name}}`,
  );
}

function secretString(url: string): Record<string, unknown> {
  const payload = JSON.stringify({
    username: "REPLACE_ME",
    password: "REPLACE_ME",
    url: "${JdbcUrl}",
  });
  return {
    "Fn::Sub": [payload, { JdbcUrl: url }],
  };
}

export function generateCloudFormation(options: CloudFormationOptions): string {
  const dataBucket = options.dataBucketParameter ?? "DataBucket";
  const scriptsBucket = options.scriptsBucketParameter ?? "ScriptsBucket";
  const used = new Set<string>([
    "GlueRole",
    "GlueServiceRole",
    "StateMachineRole",
    "SchedulerRole",
    "MailTopic",
    "DataBucket",
    "ScriptsBucket",
  ]);
  const resources: Record<string, Record<string, unknown>> = {};
  const connectionLogical = new Map<string, string>();
  const secretLogical = new Map<string, string>();
  const glueJobLogical = new Map<string, string>();

  for (const connection of options.connections) {
    const logical = logicalId(`JdbcSecret${connection.secretName}`, used);
    secretLogical.set(connection.name, logical);
    resources[logical] = {
      Type: "AWS::SecretsManager::Secret",
      Properties: {
        Name: `${options.projectName}/${connection.secretName}`.slice(0, 512),
        Description: `JDBC credentials for the migrated Pentaho connection ${connection.name}. Replace the placeholder username, password and URL before running the jobs.`,
        SecretString: secretString(connection.jdbcUrl),
      },
    };
    const connectionId = logicalId(`GlueConnection${connection.secretName}`, used);
    connectionLogical.set(connection.name, connectionId);
    resources[connectionId] = {
      Type: "AWS::Glue::Connection",
      Properties: {
        CatalogId: { Ref: "AWS::AccountId" },
        ConnectionInput: {
          Name: `${options.projectName}-${connection.secretName.toLowerCase()}`.slice(0, 255),
          Description: `Glue JDBC connection for ${connection.name}`.slice(0, 2048),
          ConnectionType: "JDBC",
          ConnectionProperties: {
            JDBC_CONNECTION_URL: connection.jdbcUrl,
            SECRET_ID: { Ref: logical },
          },
        },
      },
    };
  }

  const secretArns = [...secretLogical.values()].map((logical) => ({
    "Fn::GetAtt": [logical, "Arn"],
  }));

  resources.GlueRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "glue.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      Description: `Execution role for the ${options.projectName} Glue jobs`,
      Policies: [
        {
          PolicyName: "GlueJobAccess",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadScripts",
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: {
                  "Fn::Sub": `arn:aws:s3:::\${${scriptsBucket}}/${options.scriptPrefix}/*`,
                },
              },
              {
                Sid: "DataBucketAccess",
                Effect: "Allow",
                Action: [
                  "s3:GetObject",
                  "s3:PutObject",
                  "s3:DeleteObject",
                  "s3:ListBucket",
                  "s3:GetBucketLocation",
                ],
                Resource: [
                  { "Fn::Sub": `arn:aws:s3:::\${${dataBucket}}` },
                  { "Fn::Sub": `arn:aws:s3:::\${${dataBucket}}/*` },
                ],
              },
              {
                Sid: "ReadJdbcSecrets",
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue"],
                Resource:
                  secretArns.length > 0 ? secretArns : ["arn:aws:secretsmanager:*:*:secret:unused"],
              },
              {
                Sid: "Logs",
                Effect: "Allow",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                  "logs:GetLogEvents",
                ],
                Resource: {
                  "Fn::Sub":
                    "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws-glue/*",
                },
              },
            ],
          },
        },
      ],
    },
  };

  const jobDefaults = (needsExcel: boolean): Record<string, unknown> => ({
    "--job-language": "python",
    "--enable-metrics": "true",
    "--enable-continuous-cloudwatch-log": "true",
    "--DataBucket": { Ref: dataBucket },
    "--INPUT_BASE_PATH": { "Fn::Sub": `s3://\${${dataBucket}}/input` },
    "--OUTPUT_BASE_PATH": { "Fn::Sub": `s3://\${${dataBucket}}/output` },
    "--UNMAPPED_BASE_PATH": { "Fn::Sub": `s3://\${${dataBucket}}/unmapped` },
    ...(needsExcel ? { "--additional-python-modules": "openpyxl==3.1.5" } : {}),
  });

  const connectionByName = new Map(
    options.connections.map((connection) => [connection.name, connection]),
  );
  const connectionArguments = (names: string[]): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    for (const name of [...new Set(names)]) {
      const summary = connectionByName.get(name);
      const secret = secretLogical.get(name);
      if (!summary || !secret) continue;
      const slug = connectionSlug(name);
      args[`--CONNECTION_${slug}_SECRET_ARN`] = { "Fn::GetAtt": [secret, "Arn"] };
      args[`--CONNECTION_${slug}_URL`] = summary.jdbcUrl;
      args[`--CONNECTION_${slug}_DRIVER`] = driverClass(summary.type);
    }
    return args;
  };

  const jobProperties = (job: GlueJobTemplate): Record<string, unknown> => {
    const connectionRefs = job.connections
      .map((name) => connectionLogical.get(name))
      .filter((logical): logical is string => logical !== undefined)
      .map((logical) => ({ Ref: logical }));
    return {
      Name: job.name,
      Description: job.description.slice(0, 2048),
      Role: { "Fn::GetAtt": ["GlueRole", "Arn"] },
      GlueVersion: options.glueVersion,
      WorkerType: options.workerType,
      NumberOfWorkers: options.numberOfWorkers,
      Timeout: 120,
      MaxRetries: 0,
      Command: {
        Name: "glueetl",
        PythonVersion: "3",
        ScriptLocation: {
          "Fn::Sub": `s3://\${${scriptsBucket}}/${job.scriptPath}`,
        },
      },
      DefaultArguments: {
        ...jobDefaults(job.needsExcel),
        ...connectionArguments(job.connections),
      },
      ...(connectionRefs.length > 0 ? { Connections: { Connections: connectionRefs } } : {}),
    };
  };

  for (const job of options.glueJobs) {
    const logical = logicalId(`GlueJob${job.name}`, used);
    glueJobLogical.set(job.name, logical);
    resources[logical] = {
      Type: "AWS::Glue::Job",
      Properties: jobProperties(job),
    };
  }

  const anySns = options.stateMachines.some((machine) => machine.usesSns);
  if (anySns) {
    resources[MAIL_TOPIC] = {
      Type: "AWS::SNS::Topic",
      Properties: {
        TopicName: `${options.projectName}-notifications`,
        DisplayName: `${options.projectName} migration notifications`,
      },
    };
  }

  const stateMachineLogical = new Map<string, string>();
  for (const machine of options.stateMachines) {
    const logical = logicalId(`StateMachine${machine.name}`, used);
    stateMachineLogical.set(machine.name, logical);
  }

  const stateMachineRoleStatements: Record<string, unknown>[] = [];
  if (options.stateMachines.some((machine) => machine.usesGlue)) {
    stateMachineRoleStatements.push({
      Sid: "RunGlueJobs",
      Effect: "Allow",
      Action: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJob", "glue:BatchStopJobRun"],
      Resource: {
        "Fn::Sub": `arn:\${AWS::Partition}:glue:\${AWS::Region}:\${AWS::AccountId}:job/${options.projectName}-*`,
      },
    });
    stateMachineRoleStatements.push({
      Sid: "PassGlueRole",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: { "Fn::GetAtt": ["GlueRole", "Arn"] },
      Condition: { StringEquals: { "iam:PassedToService": "glue.amazonaws.com" } },
    });
  }
  if (options.stateMachines.some((machine) => machine.usesNested)) {
    stateMachineRoleStatements.push({
      Sid: "RunNestedStateMachines",
      Effect: "Allow",
      Action: ["states:StartExecution", "states:DescribeExecution", "states:StopExecution"],
      Resource: {
        "Fn::Sub": `arn:\${AWS::Partition}:states:\${AWS::Region}:\${AWS::AccountId}:stateMachine:${options.projectName}-*`,
      },
    });
    stateMachineRoleStatements.push({
      Sid: "SyncNestedStateMachines",
      Effect: "Allow",
      Action: ["events:PutTargets", "events:PutRule", "events:DescribeRule"],
      Resource: {
        "Fn::Sub": `arn:aws:events:\${AWS::Region}:\${AWS::AccountId}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule`,
      },
    });
  }
  if (anySns) {
    stateMachineRoleStatements.push({
      Sid: "PublishNotifications",
      Effect: "Allow",
      Action: "sns:Publish",
      Resource: { Ref: MAIL_TOPIC },
    });
  }
  if (options.stateMachines.some((machine) => machine.usesS3)) {
    stateMachineRoleStatements.push({
      Sid: "ManageS3Files",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:CopyObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [
        { "Fn::Sub": `arn:aws:s3:::\${${dataBucket}}` },
        { "Fn::Sub": `arn:aws:s3:::\${${dataBucket}}/*` },
      ],
    });
  }
  if (stateMachineRoleStatements.length === 0) {
    stateMachineRoleStatements.push({
      Sid: "NoOp",
      Effect: "Allow",
      Action: "states:ListStateMachines",
      Resource: "*",
    });
  }
  resources.StateMachineRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "states.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      Description: `Execution role for the ${options.projectName} state machines`,
      Policies: [
        {
          PolicyName: "StateMachineAccess",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: stateMachineRoleStatements,
          },
        },
      ],
    },
  };

  for (const machine of options.stateMachines) {
    const logical = stateMachineLogical.get(machine.name);
    if (!logical) continue;
    const substitutions: Record<string, unknown> = {
      DataBucket: { Ref: dataBucket },
    };
    if (anySns) {
      substitutions.MailTopicArn = { Ref: MAIL_TOPIC };
    }
    for (const nested of machine.nested) {
      const target = stateMachineLogical.get(nested.stateMachineName);
      if (target) {
        substitutions[nested.placeholder] = { "Fn::GetAtt": [target, "Arn"] };
      }
    }
    resources[logical] = {
      Type: "AWS::StepFunctions::StateMachine",
      Properties: {
        StateMachineName: machine.name,
        StateMachineType: "STANDARD",
        RoleArn: { "Fn::GetAtt": ["StateMachineRole", "Arn"] },
        DefinitionString: {
          "Fn::Sub": [
            definitionsForSub(machine.definitionJson, new Set(Object.keys(substitutions))),
            substitutions,
          ],
        },
      },
    };
  }

  if (options.schedules.length > 0) {
    resources.SchedulerRole = {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        },
        Description: `Starts the ${options.projectName} state machines on schedule`,
        Policies: [
          {
            PolicyName: "StartStateMachines",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "states:StartExecution",
                  Resource: {
                    "Fn::Sub": `arn:\${AWS::Partition}:states:\${AWS::Region}:\${AWS::AccountId}:stateMachine:${options.projectName}-*`,
                  },
                },
              ],
            },
          },
        ],
      },
    };
    for (const schedule of options.schedules) {
      const logical = logicalId(`Schedule${schedule.name}`, used);
      const targetLogical = stateMachineLogical.get(schedule.stateMachineName);
      if (!targetLogical) continue;
      resources[logical] = {
        Type: "AWS::Scheduler::Schedule",
        Properties: {
          Name: schedule.name.slice(0, 64),
          Description: `Migrated Pentaho schedule for ${schedule.stateMachineName}`,
          ScheduleExpression: schedule.expression,
          FlexibleTimeWindow: { Mode: "OFF" },
          State: "ENABLED",
          Target: {
            Arn: { "Fn::GetAtt": [targetLogical, "Arn"] },
            RoleArn: { "Fn::GetAtt": ["SchedulerRole", "Arn"] },
            Input: "{}",
          },
        },
      };
    }
  }

  const outputs: Record<string, unknown> = {
    GlueRoleArn: {
      Description: "Execution role used by the generated Glue jobs",
      Value: { "Fn::GetAtt": ["GlueRole", "Arn"] },
    },
    StateMachineRoleArn: {
      Description: "Execution role used by the generated state machines",
      Value: { "Fn::GetAtt": ["StateMachineRole", "Arn"] },
    },
  };
  for (const [name, logical] of stateMachineLogical) {
    outputs[`StateMachine${safeLogical(name)}`] = {
      Description: `ARN of the state machine for ${name}`,
      Value: { Ref: logical },
    };
  }
  for (const [name, logical] of glueJobLogical) {
    outputs[`GlueJob${safeLogical(name)}`] = {
      Description: `Name of the Glue job for ${name}`,
      Value: { Ref: logical },
    };
  }
  if (anySns) {
    outputs.NotificationTopicArn = {
      Description: "SNS topic used for PDI MAIL entries",
      Value: { Ref: MAIL_TOPIC },
    };
  }

  const template = {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Migration resources for the Pentaho project ${options.projectName}. Generated by pentaho-to-aws; review IAM, endpoints and secrets before deploying.`,
    Parameters: {
      [dataBucket]: {
        Type: "String",
        Description:
          "S3 bucket that holds the migrated data. The generated jobs read and write under this bucket.",
        AllowedPattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      },
      [scriptsBucket]: {
        Type: "String",
        Description: `S3 bucket where this bundle's ${options.scriptPrefix}/ folder was uploaded.`,
        AllowedPattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      },
    },
    Resources: resources,
    Outputs: outputs,
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}

export function cloudFormationSchedules(
  schedules: ScheduleSummary[],
  stateMachineNameForJob: (job: string, file: string) => string | undefined,
  scheduleOverrides: Record<string, string>,
): { name: string; expression: string; stateMachineName: string }[] {
  const used = new Set<string>();
  const result: { name: string; expression: string; stateMachineName: string }[] = [];
  for (const schedule of schedules) {
    if (!schedule.mapped) continue;
    const stateMachineName = stateMachineNameForJob(schedule.job, schedule.file);
    if (!stateMachineName) continue;
    const override =
      scheduleOverrides[`${schedule.job}:${schedule.entry}`] ??
      scheduleOverrides[`${schedule.job}/${schedule.entry}`] ??
      scheduleOverrides[schedule.entry];
    const expression = override?.trim() || schedule.expression;
    if (!expression) continue;
    let base = `${stateMachineName}-${safeLogical(schedule.entry).slice(0, 20)}`.toLowerCase();
    base = base
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    let name = base || "schedule";
    let index = 2;
    while (used.has(name)) {
      name = `${base || "schedule"}-${index}`.slice(0, 64);
      index += 1;
    }
    used.add(name);
    result.push({ name, expression, stateMachineName });
  }
  return result;
}

export type { StateMachineArtifact };
