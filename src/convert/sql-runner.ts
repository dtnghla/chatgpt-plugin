import { boolAt, stringAt } from "../ingest/xml.js";
import type { Job, PentahoConnection } from "../pentaho/types.js";
import { connectionSlug, jdbcUrl } from "./jdbc.js";

export interface SqlEntryPlan {
  job: string;
  entry: string;
  connection?: string;
  sql: string;
  fromFile?: string;
}

export interface SqlRunnerPlan {
  code: string;
  entries: SqlEntryPlan[];
  warnings: string[];
  connections: string[];
}

export function sqlEntries(job: Job): SqlEntryPlan[] {
  return job.entries
    .filter((entry) => entry.type === "SQL")
    .map((entry) => {
      const fromFile = boolAt(entry.raw, "sqlfromfile") === true;
      const fileName = stringAt(entry.raw, "sqlfilename");
      const sql = stringAt(entry.raw, "sql") ?? "";
      return {
        job: job.name,
        entry: entry.name,
        connection: stringAt(entry.raw, "connection"),
        sql: fromFile ? "" : sql,
        fromFile: fromFile ? (fileName ?? "(not specified)") : undefined,
      };
    });
}

export function generateSqlRunner(jobs: Job[], connections: PentahoConnection[]): SqlRunnerPlan {
  const entries = jobs.flatMap((job) => sqlEntries(job));
  const warnings: string[] = [];
  const usedConnections = new Set(
    entries.flatMap((entry) => (entry.connection ? [entry.connection] : [])),
  );
  for (const entry of entries) {
    if (entry.fromFile) {
      warnings.push(
        `SQL entry "${entry.entry}" in ${entry.job} reads its statement from ${entry.fromFile}; that file was not uploaded, so the runner raises an error for this entry.`,
      );
    }
    if (!entry.connection) {
      warnings.push(
        `SQL entry "${entry.entry}" in ${entry.job} has no JDBC connection; the runner raises an error for this entry.`,
      );
    }
  }

  const connectionMap = Object.fromEntries(
    connections
      .filter((connection) => usedConnections.has(connection.name))
      .map((connection) => [
        connection.name,
        {
          slug: connectionSlug(connection.name),
          url: jdbcUrl(connection),
        },
      ]),
  );

  const grouped = new Map<string, { entry: string; connection: string; sql: string }[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.job) ?? [];
    list.push({
      entry: entry.entry,
      connection: entry.connection ?? "",
      sql: entry.sql,
    });
    grouped.set(entry.job, list);
  }

  const lines = [
    "import json",
    "import re",
    "import sys",
    "",
    "import boto3",
    "from awsglue.context import GlueContext",
    "from awsglue.job import Job",
    "from pyspark.context import SparkContext",
    "",
    "def raw_args():",
    "    values = {}",
    "    index = 1",
    "    while index < len(sys.argv):",
    "        item = sys.argv[index]",
    "        if item.startswith('--'):",
    "            key, separator, value = item[2:].partition('=')",
    "            if separator:",
    "                values[key] = value",
    "            elif index + 1 < len(sys.argv) and not sys.argv[index + 1].startswith('--'):",
    "                values[key] = sys.argv[index + 1]",
    "                index += 1",
    "            else:",
    "                values[key] = ''",
    "        index += 1",
    "    return values",
    "",
    "RAW = raw_args()",
    "JOB_NAME = RAW.get('JOB_NAME', 'pentaho-sql-runner')",
    "sc = SparkContext.getOrCreate()",
    "glueContext = GlueContext(sc)",
    "spark = glueContext.spark_session",
    "job = Job(glueContext)",
    "job.init(JOB_NAME, RAW)",
    "",
    `CONNECTIONS = ${JSON.stringify(connectionMap, null, 2)}`,
    `SQL_BY_JOB = ${JSON.stringify(Object.fromEntries(grouped), null, 2)}`,
    "PATTERN = re.compile(r'\\$\\{([^{}]+)\\}|%%([^%]+)%%')",
    "",
    "def substitute(sql):",
    "    def replace(match):",
    "        name = match.group(1) or match.group(2)",
    "        return RAW.get(name, match.group(0))",
    "    return PATTERN.sub(replace, sql)",
    "",
    "def connect(name):",
    "    info = CONNECTIONS.get(name)",
    "    if not info:",
    "        raise ValueError(f'Unknown JDBC connection {name!r}')",
    "    prefix = 'CONNECTION_' + info['slug']",
    "    secret_arn = RAW.get(prefix + '_SECRET_ARN')",
    "    if not secret_arn:",
    "        raise ValueError(f'Missing Glue job argument {prefix}_SECRET_ARN')",
    "    secrets = boto3.client('secretsmanager')",
    "    secret = json.loads(",
    "        secrets.get_secret_value(SecretId=secret_arn)['SecretString']",
    "    )",
    "    url = RAW.get(prefix + '_URL') or secret.get('url') or info['url']",
    "    user = secret.get('username') or 'REPLACE_ME'",
    "    password = secret.get('password') or 'REPLACE_ME'",
    "    driver = RAW.get(prefix + '_DRIVER')",
    "    if driver:",
    "        spark._jvm.java.lang.Class.forName(driver)",
    "    return spark._jvm.java.sql.DriverManager.getConnection(url, user, password)",
    "",
    "def run(job_name, entry_name):",
    "    entries = SQL_BY_JOB.get(job_name, [])",
    "    match = next((item for item in entries if item['entry'] == entry_name), None)",
    "    if match is None:",
    "        raise ValueError(f'Unknown SQL entry {entry_name!r} in job {job_name!r}')",
    "    if not match['sql']:",
    "        raise ValueError(",
    "            f'SQL entry {entry_name!r} has no inline statement; provide the SQL file and update the runner.'",
    "        )",
    "    connection = connect(match['connection'])",
    "    statement = connection.createStatement()",
    "    try:",
    "        statement.execute(substitute(match['sql']))",
    "    finally:",
    "        statement.close()",
    "        connection.close()",
    "",
    "def main():",
    "    job_name = RAW.get('job')",
    "    entry_name = RAW.get('entry')",
    "    if not job_name or not entry_name:",
    "        raise ValueError('The SQL runner requires --job and --entry arguments')",
    "    run(job_name, entry_name)",
    "    job.commit()",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "",
  ];
  return {
    code: lines.join("\n"),
    entries,
    warnings,
    connections: [...usedConnections].sort(),
  };
}
