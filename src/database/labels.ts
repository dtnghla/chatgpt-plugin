import type { SourceEngine, TargetEngine } from "./types.js";

export const ENGINE_LABELS: Record<SourceEngine, string> = {
  oracle: "Oracle",
  sqlserver: "SQL Server",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  teradata: "Teradata",
  netezza: "Netezza",
  hive: "Hive",
};

export const TARGET_LABELS: Record<TargetEngine, string> = {
  "aurora-postgresql": "Aurora PostgreSQL",
  "aurora-mysql": "Aurora MySQL",
  "redshift-serverless": "Redshift Serverless",
  "athena-iceberg": "Athena (Apache Iceberg)",
};
