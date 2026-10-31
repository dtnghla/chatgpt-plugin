import type { PentahoConnection } from "../pentaho/types.js";

export function connectionSlug(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "DEFAULT";
}

export function driverClass(type: string): string {
  const normalized = type.toUpperCase();
  if (normalized.includes("MYSQL") || normalized.includes("MARIADB"))
    return "com.mysql.cj.jdbc.Driver";
  if (normalized.includes("POSTGRES") || normalized.includes("GREENPLUM"))
    return "org.postgresql.Driver";
  if (normalized.includes("MSSQL") || normalized.includes("SQLSERVER"))
    return "com.microsoft.sqlserver.jdbc.SQLServerDriver";
  if (normalized.includes("ORACLE")) return "oracle.jdbc.OracleDriver";
  if (normalized.includes("DB2")) return "com.ibm.db2.jcc.DB2Driver";
  if (normalized.includes("H2")) return "org.h2.Driver";
  if (normalized.includes("SNOWFLAKE")) return "net.snowflake.client.jdbc.SnowflakeDriver";
  return "org.postgresql.Driver";
}

function safePart(value: string | undefined, fallback: string): string {
  return value?.trim() ? value.trim().replace(/\$\{[^}]+\}/g, "REPLACE_ME") : fallback;
}

export function jdbcUrl(connection: PentahoConnection): string {
  if (connection.url?.trim()) return safePart(connection.url, "REPLACE_ME");
  const type = connection.type.toUpperCase();
  const host = safePart(connection.host, "REPLACE_ME");
  const port = safePart(connection.port, "");
  const database = safePart(connection.database, "REPLACE_ME");
  const portPart = port ? `:${port}` : "";
  if (type.includes("MYSQL") || type.includes("MARIADB")) {
    return `jdbc:mysql://${host}${portPart}/${database}`;
  }
  if (type.includes("POSTGRES") || type.includes("GREENPLUM")) {
    return `jdbc:postgresql://${host}${portPart}/${database}`;
  }
  if (type.includes("MSSQL") || type.includes("SQLSERVER")) {
    return `jdbc:sqlserver://${host}${portPart};databaseName=${database};encrypt=true;trustServerCertificate=false`;
  }
  if (type.includes("ORACLE")) {
    return `jdbc:oracle:thin:@//${host}${portPart}/${database}`;
  }
  if (type.includes("DB2")) {
    return `jdbc:db2://${host}${portPart}/${database}`;
  }
  if (type.includes("H2")) {
    return `jdbc:h2:${connection.database ?? "REPLACE_ME"}`;
  }
  return `jdbc:${type.toLowerCase()}://${host}${portPart}/${database}`;
}

export function jdbcSecretName(connection: PentahoConnection): string {
  return `${connectionSlug(connection.name)}_JDBC`;
}
