import { definitionsForSub } from "../convert/cloudformation.js";
import { ENGINE_LABELS, TARGET_LABELS } from "./labels.js";
import type { SourceEngine, TargetEngine, WorkloadClass } from "./types.js";

const BUCKET_ALLOWED_PATTERN = "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$";

const LOGS_STATEMENT = {
  Sid: "Logs",
  Effect: "Allow",
  Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:GetLogEvents"],
  Resource: {
    "Fn::Sub": "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws-glue/*",
  },
};

const SUBNET_PARAMETER_DESCRIPTION =
  "Private subnets in at least two Availability Zones for DMS and Aurora.";

export interface DatabaseCloudFormationInput {
  projectName: string;
  engine: SourceEngine;
  targetEngine: TargetEngine;
  workloadClass: WorkloadClass;
  replicationType: "full-load" | "full-load-and-cdc";
  dmsMaxCapacityUnits: number;
  tableMappings?: unknown;
  replicationSettings?: unknown;
  datasyncRoot?: string;
  datasyncIncludeFilter?: string;
  /** Step Functions definition JSON for the warehouse class. */
  warehouseDefinition?: string;
  /** Step Functions definition JSON for the lake class. */
  lakeDefinition?: string;
  /** S3 bucket names of lake tables that stay on S3. */
  externalS3Buckets: string[];
}

const DMS_SOURCE_PORTS: Record<string, string> = {
  oracle: "1521",
  sqlserver: "1433",
  mysql: "3306",
  postgresql: "5432",
};

function trustPolicy(services: (string | Record<string, unknown>)[]): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: services.map((service) => ({
      Effect: "Allow",
      Principal: { Service: service },
      Action: "sts:AssumeRole",
    })),
  };
}

function glueSqlApplyJob(
  projectName: string,
  target: string,
  defaultArguments: Record<string, unknown>,
): Record<string, unknown> {
  return {
    Name: `${projectName}-sql-apply`,
    Role: { "Fn::GetAtt": ["SqlApplyRole", "Arn"] },
    Command: {
      Name: "pythonshell",
      PythonVersion: "3.9",
      ScriptLocation: {
        "Fn::Sub": `s3://\${ScriptsBucket}/glue/scripts/${projectName}-sql-apply.py`,
      },
    },
    GlueVersion: "3.0",
    MaxCapacity: 0.0625,
    Timeout: 1440,
    MaxRetries: 0,
    DefaultArguments: {
      "--scripts_bucket": { Ref: "ScriptsBucket" },
      "--plan_key": "sql/apply-plan.json",
      "--target": target,
      ...defaultArguments,
    },
  };
}

function glueStateMachineRoleStatements(projectName: string): Record<string, unknown>[] {
  return [
    {
      Effect: "Allow",
      Action: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJobRuns", "glue:BatchStopJobRun"],
      Resource: {
        "Fn::Sub": `arn:\${AWS::Partition}:glue:\${AWS::Region}:\${AWS::AccountId}:job/${projectName}-sql-apply`,
      },
    },
  ];
}

function buildDatabaseTemplate(input: DatabaseCloudFormationInput): Record<string, unknown> {
  const { projectName, engine, targetEngine, replicationType, dmsMaxCapacityUnits } = input;
  const isPostgresTarget = targetEngine === "aurora-postgresql";
  const sourceEngineName =
    engine === "oracle"
      ? "oracle"
      : engine === "sqlserver"
        ? "sqlserver"
        : engine === "mysql"
          ? "mysql"
          : "postgres";
  const settingsKey =
    engine === "oracle"
      ? "OracleSettings"
      : engine === "sqlserver"
        ? "MicrosoftSqlServerSettings"
        : engine === "mysql"
          ? "MySqlSettings"
          : "PostgreSqlSettings";
  const targetSettingsKey = isPostgresTarget ? "PostgreSqlSettings" : "MySqlSettings";
  const afterConnectScript = isPostgresTarget
    ? "SET session_replication_role = 'replica'"
    : "SET FOREIGN_KEY_CHECKS = 0";

  const parameters: Record<string, unknown> = {
    SubnetIds: {
      Type: "List<AWS::EC2::Subnet::Id>",
      Description: SUBNET_PARAMETER_DESCRIPTION,
    },
    SecurityGroupIds: {
      Type: "List<AWS::EC2::SecurityGroup::Id>",
      Description: "Security groups that let DMS reach the source database and Aurora.",
    },
  };
  if (engine !== "mysql") {
    parameters.SourceDatabaseName = {
      Type: "String",
      MinLength: 1,
      Description:
        "Source database name: Oracle service name or SID, or the SQL Server or PostgreSQL database.",
    };
  }

  const resources: Record<string, Record<string, unknown>> = {
    SourceSecret: {
      Type: "AWS::SecretsManager::Secret",
      Properties: {
        Name: `${projectName}/source-database`,
        Description: `DMS source endpoint credentials for the ${ENGINE_LABELS[engine]} database. Fill username, password, host and port after deployment.`,
        SecretString: JSON.stringify({
          username: "REPLACE_ME",
          password: "REPLACE_ME",
          host: "REPLACE_ME",
          port: DMS_SOURCE_PORTS[engine],
        }),
      },
    },
    AuroraSubnetGroup: {
      Type: "AWS::RDS::DBSubnetGroup",
      Properties: {
        DBSubnetGroupDescription: `${projectName} Aurora subnets`,
        SubnetIds: { Ref: "SubnetIds" },
      },
    },
    AuroraCluster: {
      DeletionPolicy: "Snapshot",
      UpdateReplacePolicy: "Snapshot",
      Type: "AWS::RDS::DBCluster",
      Properties: {
        Engine: isPostgresTarget ? "aurora-postgresql" : "aurora-mysql",
        MasterUsername: "dbadmin",
        ManageMasterUserPassword: true,
        ...(isPostgresTarget ? { DatabaseName: "modernized" } : {}),
        DBSubnetGroupName: { Ref: "AuroraSubnetGroup" },
        VpcSecurityGroupIds: { Ref: "SecurityGroupIds" },
        StorageEncrypted: true,
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 16 },
      },
    },
    AuroraInstance: {
      Type: "AWS::RDS::DBInstance",
      Properties: {
        DBClusterIdentifier: { Ref: "AuroraCluster" },
        DBInstanceClass: "db.serverless",
        Engine: isPostgresTarget ? "aurora-postgresql" : "aurora-mysql",
      },
    },
    TargetSecret: {
      Type: "AWS::SecretsManager::Secret",
      Properties: {
        Name: `${projectName}/target-database`,
        Description:
          "DMS target endpoint credentials. Create a database user in Aurora and fill this secret after deployment; DMS cannot use the RDS-managed master secret because it lacks host and port.",
        SecretString: {
          "Fn::Sub": [
            '{"username":"REPLACE_ME","password":"REPLACE_ME","host":"${Host}","port":"${Port}"}',
            {
              Host: { "Fn::GetAtt": ["AuroraCluster", "Endpoint.Address"] },
              Port: { "Fn::GetAtt": ["AuroraCluster", "Endpoint.Port"] },
            },
          ],
        },
      },
    },
    DmsSecretsRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: trustPolicy([{ "Fn::Sub": "dms.\${AWS::Region}.amazonaws.com" }]),
        Description: `Lets DMS read the ${projectName} endpoint secrets`,
        Policies: [
          {
            PolicyName: "ReadEndpointSecrets",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["secretsmanager:GetSecretValue"],
                  Resource: [{ Ref: "SourceSecret" }, { Ref: "TargetSecret" }],
                },
              ],
            },
          },
        ],
      },
    },
    SourceEndpoint: {
      Type: "AWS::DMS::Endpoint",
      Properties: {
        EndpointType: "source",
        EngineName: sourceEngineName,
        ...(engine !== "mysql" ? { DatabaseName: { Ref: "SourceDatabaseName" } } : {}),
        [settingsKey]: {
          SecretsManagerSecretId: { Ref: "SourceSecret" },
          SecretsManagerAccessRoleArn: { "Fn::GetAtt": ["DmsSecretsRole", "Arn"] },
        },
      },
    },
    TargetEndpoint: {
      Type: "AWS::DMS::Endpoint",
      Properties: {
        EndpointType: "target",
        EngineName: isPostgresTarget ? "aurora-postgresql" : "aurora",
        ...(isPostgresTarget ? { DatabaseName: "modernized" } : {}),
        SslMode: "require",
        [targetSettingsKey]: {
          SecretsManagerSecretId: { Ref: "TargetSecret" },
          SecretsManagerAccessRoleArn: { "Fn::GetAtt": ["DmsSecretsRole", "Arn"] },
          AfterConnectScript: afterConnectScript,
        },
      },
    },
    DmsSubnetGroup: {
      Type: "AWS::DMS::ReplicationSubnetGroup",
      Properties: {
        ReplicationSubnetGroupDescription: `${projectName} DMS subnets`,
        SubnetIds: { Ref: "SubnetIds" },
      },
    },
    Replication: {
      Type: "AWS::DMS::ReplicationConfig",
      Properties: {
        ReplicationConfigIdentifier: `${projectName}-replication`,
        ReplicationType: replicationType,
        ComputeConfig: {
          MaxCapacityUnits: dmsMaxCapacityUnits,
          MultiAZ: false,
          ReplicationSubnetGroupId: { Ref: "DmsSubnetGroup" },
          VpcSecurityGroupIds: { Ref: "SecurityGroupIds" },
        },
        SourceEndpointArn: { Ref: "SourceEndpoint" },
        TargetEndpointArn: { Ref: "TargetEndpoint" },
        TableMappings: input.tableMappings,
        ReplicationSettings: input.replicationSettings,
      },
    },
  };

  const outputs: Record<string, unknown> = {
    AuroraEndpoint: {
      Description: "Aurora cluster endpoint address",
      Value: { "Fn::GetAtt": ["AuroraCluster", "Endpoint.Address"] },
    },
    MasterUserSecretArn: {
      Description: "Secret ARN holding the Aurora master password",
      Value: { "Fn::GetAtt": ["AuroraCluster", "MasterUserSecret.SecretArn"] },
    },
    SourceSecretArn: {
      Description: "Secret ARN to fill with the source database credentials",
      Value: { Ref: "SourceSecret" },
    },
    TargetSecretArn: {
      Description: "Secret ARN to fill with the Aurora target user credentials",
      Value: { Ref: "TargetSecret" },
    },
    ReplicationConfigArn: {
      Description: "ARN used by aws dms start-replication",
      Value: { Ref: "Replication" },
    },
  };

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Parameters: parameters,
    Resources: resources,
    Outputs: outputs,
  };
}

function buildWarehouseTemplate(input: DatabaseCloudFormationInput): Record<string, unknown> {
  const { projectName } = input;
  const resources: Record<string, Record<string, unknown>> = {
    RedshiftRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: trustPolicy([
          "redshift.amazonaws.com",
          "redshift-serverless.amazonaws.com",
        ]),
        Description: `Lets the ${projectName} Redshift namespace read the staging bucket`,
        Policies: [
          {
            PolicyName: "StagingBucketAccess",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["s3:GetObject", "s3:ListBucket"],
                  Resource: [
                    { "Fn::Sub": "arn:${AWS::Partition}:s3:::${StagingBucket}" },
                    { "Fn::Sub": "arn:${AWS::Partition}:s3:::${StagingBucket}/*" },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    Namespace: {
      Type: "AWS::RedshiftServerless::Namespace",
      Properties: {
        NamespaceName: `${projectName}-ns`,
        AdminUsername: "dbadmin",
        ManageAdminPassword: true,
        DbName: "dev",
        DefaultIamRoleArn: { "Fn::GetAtt": ["RedshiftRole", "Arn"] },
        IamRoles: [{ "Fn::GetAtt": ["RedshiftRole", "Arn"] }],
      },
    },
    Workgroup: {
      Type: "AWS::RedshiftServerless::Workgroup",
      Properties: {
        WorkgroupName: `${projectName}-wg`,
        NamespaceName: { Ref: "Namespace" },
        BaseCapacity: 8,
        PubliclyAccessible: false,
        SubnetIds: { Ref: "SubnetIds" },
        SecurityGroupIds: { Ref: "SecurityGroupIds" },
      },
    },
    SqlApplyRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: trustPolicy(["glue.amazonaws.com"]),
        Description: `Runs the ${projectName}-sql-apply Glue job`,
        Policies: [
          {
            PolicyName: "SqlApplyAccess",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["s3:GetObject"],
                  Resource: [
                    { "Fn::Sub": "arn:${AWS::Partition}:s3:::\${ScriptsBucket}/glue/scripts/*" },
                    { "Fn::Sub": "arn:${AWS::Partition}:s3:::\${ScriptsBucket}/sql/*" },
                  ],
                },
                {
                  Effect: "Allow",
                  Action: [
                    "redshift-data:ExecuteStatement",
                    "redshift-data:DescribeStatement",
                    "redshift-data:GetStatementResult",
                  ],
                  Resource: "*",
                },
                {
                  Effect: "Allow",
                  Action: ["redshift-serverless:GetCredentials"],
                  Resource: { "Fn::GetAtt": ["Workgroup", "Workgroup.WorkgroupArn"] },
                },
                LOGS_STATEMENT,
              ],
            },
          },
        ],
      },
    },
    SqlApplyJob: {
      Type: "AWS::Glue::Job",
      Properties: glueSqlApplyJob(projectName, "redshift-serverless", {
        "--workgroup": { Ref: "Workgroup" },
        "--database": "dev",
        "--staging_bucket": { Ref: "StagingBucket" },
      }),
    },
    StateMachineRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: trustPolicy(["states.amazonaws.com"]),
        Description: `Runs the ${projectName} warehouse load state machine`,
        Policies: [
          {
            PolicyName: "RunSqlApplyJob",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: glueStateMachineRoleStatements(projectName),
            },
          },
        ],
      },
    },
    LoadStateMachine: {
      Type: "AWS::StepFunctions::StateMachine",
      Properties: {
        StateMachineName: `${projectName}-warehouse-load`,
        StateMachineType: "STANDARD",
        RoleArn: { "Fn::GetAtt": ["StateMachineRole", "Arn"] },
        DefinitionString: input.warehouseDefinition ?? "",
      },
    },
  };

  const outputs: Record<string, unknown> = {
    WorkgroupName: {
      Description: "Redshift workgroup used by the Data API",
      Value: { Ref: "Workgroup" },
    },
    NamespaceName: {
      Description: "Redshift Serverless namespace name",
      Value: { Ref: "Namespace" },
    },
    SqlApplyJobName: {
      Description: "Glue job that applies the SQL phases",
      Value: { Ref: "SqlApplyJob" },
    },
    StateMachineArn: {
      Description: "ARN used by aws stepfunctions start-execution",
      Value: { Ref: "LoadStateMachine" },
    },
  };

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Parameters: {
      ScriptsBucket: {
        Type: "String",
        Description: "S3 bucket where this bundle's glue/scripts/ and sql/ folders were uploaded.",
        AllowedPattern: BUCKET_ALLOWED_PATTERN,
      },
      StagingBucket: {
        Type: "String",
        Description: "S3 staging bucket holding the exported table files.",
        AllowedPattern: BUCKET_ALLOWED_PATTERN,
      },
      SubnetIds: {
        Type: "List<AWS::EC2::Subnet::Id>",
        Description: "Private subnets for the Redshift Serverless workgroup.",
      },
      SecurityGroupIds: {
        Type: "List<AWS::EC2::SecurityGroup::Id>",
        Description: "Security groups for the Redshift Serverless workgroup.",
      },
    },
    Resources: resources,
    Outputs: outputs,
  };
}

function buildLakeTemplate(input: DatabaseCloudFormationInput): Record<string, unknown> {
  const { projectName } = input;
  const hasDataSync = input.datasyncRoot !== undefined;
  const resources: Record<string, Record<string, unknown>> = {};
  if (hasDataSync) {
    resources.DataSyncRole = {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: trustPolicy(["datasync.amazonaws.com"]),
        Description: `Lets DataSync write the ${projectName} raw data`,
        Policies: [
          {
            PolicyName: "LakeBucketAccess",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: [
                    "s3:GetBucketLocation",
                    "s3:ListBucket",
                    "s3:ListBucketMultipartUploads",
                  ],
                  Resource: [{ "Fn::Sub": "arn:${AWS::Partition}:s3:::${LakeBucket}" }],
                },
                {
                  Effect: "Allow",
                  Action: [
                    "s3:AbortMultipartUpload",
                    "s3:DeleteObject",
                    "s3:GetObject",
                    "s3:GetObjectTagging",
                    "s3:ListMultipartUploadParts",
                    "s3:PutObject",
                    "s3:PutObjectTagging",
                  ],
                  Resource: [{ "Fn::Sub": "arn:${AWS::Partition}:s3:::${LakeBucket}/*" }],
                },
              ],
            },
          },
        ],
      },
    };
    resources.HdfsLocation = {
      Type: "AWS::DataSync::LocationHDFS",
      Properties: {
        AgentArns: [{ Ref: "DataSyncAgentArn" }],
        AuthenticationType: "SIMPLE",
        SimpleUser: { Ref: "HdfsUser" },
        NameNodes: [
          {
            Hostname: { Ref: "HdfsNameNodeHost" },
            Port: { Ref: "HdfsNameNodePort" },
          },
        ],
        Subdirectory: input.datasyncRoot ?? "/",
      },
    };
    resources.LakeLocation = {
      Type: "AWS::DataSync::LocationS3",
      Properties: {
        S3BucketArn: { "Fn::Sub": "arn:${AWS::Partition}:s3:::${LakeBucket}" },
        S3Config: { BucketAccessRoleArn: { "Fn::GetAtt": ["DataSyncRole", "Arn"] } },
        Subdirectory: "/raw",
      },
    };
    resources.CopyTask = {
      Type: "AWS::DataSync::Task",
      Properties: {
        Name: `${projectName}-hdfs-copy`,
        ...(input.datasyncIncludeFilter
          ? { Includes: [{ FilterType: "SIMPLE_PATTERN", Value: input.datasyncIncludeFilter }] }
          : {}),
        Options: { VerifyMode: "ONLY_FILES_TRANSFERRED" },
        SourceLocationArn: { Ref: "HdfsLocation" },
        DestinationLocationArn: { Ref: "LakeLocation" },
      },
    };
  }

  resources.AthenaWorkGroup = {
    Type: "AWS::Athena::WorkGroup",
    Properties: {
      Name: `${projectName}-lake`,
      State: "ENABLED",
      RecursiveDeleteOption: true,
      WorkGroupConfiguration: {
        EnforceWorkGroupConfiguration: true,
        EngineVersion: { SelectedEngineVersion: "Athena engine version 3" },
        ResultConfiguration: {
          OutputLocation: { "Fn::Sub": "s3://\${LakeBucket}/athena-results/" },
        },
      },
    },
  };

  const sqlApplyStatements: Record<string, unknown>[] = [
    {
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: [
        { "Fn::Sub": "arn:${AWS::Partition}:s3:::\${ScriptsBucket}/glue/scripts/*" },
        { "Fn::Sub": "arn:${AWS::Partition}:s3:::\${ScriptsBucket}/sql/*" },
      ],
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [
        { "Fn::Sub": "arn:${AWS::Partition}:s3:::${LakeBucket}" },
        { "Fn::Sub": "arn:${AWS::Partition}:s3:::${LakeBucket}/*" },
      ],
    },
  ];
  if (input.externalS3Buckets.length > 0) {
    sqlApplyStatements.push({
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:ListBucket"],
      Resource: input.externalS3Buckets.flatMap((bucket) => [
        { "Fn::Sub": `arn:\${AWS::Partition}:s3:::${bucket}` },
        { "Fn::Sub": `arn:\${AWS::Partition}:s3:::${bucket}/*` },
      ]),
    });
  }
  sqlApplyStatements.push(
    {
      Effect: "Allow",
      Action: ["athena:StartQueryExecution", "athena:GetQueryExecution"],
      Resource: {
        "Fn::Sub": [
          "arn:${AWS::Partition}:athena:${AWS::Region}:${AWS::AccountId}:workgroup/${AthenaWorkGroup}",
          { AthenaWorkGroup: { Ref: "AthenaWorkGroup" } },
        ],
      },
    },
    {
      Effect: "Allow",
      Action: [
        "glue:BatchCreatePartition",
        "glue:BatchGetPartition",
        "glue:CreateDatabase",
        "glue:CreatePartition",
        "glue:CreateTable",
        "glue:DeleteTable",
        "glue:GetDatabase",
        "glue:GetDatabases",
        "glue:GetPartition",
        "glue:GetPartitions",
        "glue:GetTable",
        "glue:GetTables",
        "glue:UpdateTable",
      ],
      Resource: [
        {
          "Fn::Sub": "arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:catalog",
        },
        {
          "Fn::Sub": "arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:database/*",
        },
        {
          "Fn::Sub": "arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:table/*/*",
        },
      ],
    },
    LOGS_STATEMENT,
  );
  resources.SqlApplyRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: trustPolicy(["glue.amazonaws.com"]),
      Description: `Runs the ${projectName}-sql-apply Glue job`,
      Policies: [
        {
          PolicyName: "SqlApplyAccess",
          PolicyDocument: { Version: "2012-10-17", Statement: sqlApplyStatements },
        },
      ],
    },
  };
  resources.SqlApplyJob = {
    Type: "AWS::Glue::Job",
    Properties: glueSqlApplyJob(projectName, "athena-iceberg", {
      "--athena_workgroup": { Ref: "AthenaWorkGroup" },
      "--lake_bucket": { Ref: "LakeBucket" },
    }),
  };

  const stateMachineStatements = glueStateMachineRoleStatements(projectName);
  if (hasDataSync) {
    stateMachineStatements.push(
      {
        Effect: "Allow",
        Action: ["datasync:StartTaskExecution"],
        Resource: [{ Ref: "CopyTask" }],
      },
      {
        Effect: "Allow",
        Action: ["datasync:DescribeTaskExecution"],
        Resource: [{ "Fn::Sub": "\${CopyTask}/execution/*" }],
      },
    );
  }
  resources.StateMachineRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: trustPolicy(["states.amazonaws.com"]),
      Description: `Runs the ${projectName} lake load state machine`,
      Policies: [
        {
          PolicyName: "RunSqlApplyJob",
          PolicyDocument: { Version: "2012-10-17", Statement: stateMachineStatements },
        },
      ],
    },
  };
  resources.LoadStateMachine = {
    Type: "AWS::StepFunctions::StateMachine",
    Properties: {
      StateMachineName: `${projectName}-lake-load`,
      StateMachineType: "STANDARD",
      RoleArn: { "Fn::GetAtt": ["StateMachineRole", "Arn"] },
      ...(hasDataSync && input.lakeDefinition
        ? {
            DefinitionString: {
              "Fn::Sub": [
                definitionsForSub(input.lakeDefinition, new Set(["DataSyncTaskArn"])),
                { DataSyncTaskArn: { Ref: "CopyTask" } },
              ],
            },
          }
        : { DefinitionString: input.lakeDefinition ?? "" }),
    },
  };

  const outputs: Record<string, unknown> = {
    AthenaWorkGroupName: {
      Description: "Athena work group that runs the load statements",
      Value: { Ref: "AthenaWorkGroup" },
    },
    SqlApplyJobName: {
      Description: "Glue job that applies the SQL phases",
      Value: { Ref: "SqlApplyJob" },
    },
    StateMachineArn: {
      Description: "ARN used by aws stepfunctions start-execution",
      Value: { Ref: "LoadStateMachine" },
    },
  };
  if (hasDataSync) {
    outputs.CopyTaskArn = {
      Description: "DataSync task that copies HDFS data to the raw prefix",
      Value: { Ref: "CopyTask" },
    };
  }

  const parameters: Record<string, unknown> = {
    ScriptsBucket: {
      Type: "String",
      Description: "S3 bucket where this bundle's glue/scripts/ and sql/ folders were uploaded.",
      AllowedPattern: BUCKET_ALLOWED_PATTERN,
    },
    LakeBucket: {
      Type: "String",
      Description: "S3 bucket that holds the raw files, Iceberg data and query results.",
      AllowedPattern: BUCKET_ALLOWED_PATTERN,
    },
  };
  if (hasDataSync) {
    parameters.DataSyncAgentArn = {
      Type: "String",
      Description: "ARN of the DataSync agent that can reach the HDFS NameNode.",
    };
    parameters.HdfsNameNodeHost = {
      Type: "String",
      Description: "Host name of the HDFS NameNode.",
    };
    parameters.HdfsNameNodePort = {
      Type: "Number",
      Default: 8020,
      Description: "RPC port of the HDFS NameNode.",
    };
    parameters.HdfsUser = {
      Type: "String",
      Default: "hdfs",
      Description: "HDFS user the DataSync agent authenticates as.",
    };
  }

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Parameters: parameters,
    Resources: resources,
    Outputs: outputs,
  };
}

export function generateDatabaseCloudFormation(input: DatabaseCloudFormationInput): string {
  const template = {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Data modernization resources for ${input.projectName} (${ENGINE_LABELS[input.engine]} to ${TARGET_LABELS[input.targetEngine]}). Generated by aws-data-modernizer; review IAM, networking and secrets before deploying.`,
    ...(input.workloadClass === "database"
      ? buildDatabaseTemplate(input)
      : input.workloadClass === "warehouse"
        ? buildWarehouseTemplate(input)
        : buildLakeTemplate(input)),
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}
