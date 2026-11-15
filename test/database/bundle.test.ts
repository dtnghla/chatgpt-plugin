import { describe, expect, it } from "vitest";
import { buildDatabaseBundle } from "../../src/database/bundle.js";
import { parseDatabaseProject } from "../../src/database/parse.js";
import { GENERATOR_VERSION } from "../../src/server.js";
import { type DatabaseFixtureName, databaseBundle, fixtureFiles } from "../helpers.js";

function buildWithUnits(name: DatabaseFixtureName, dmsMaxCapacityUnits: number) {
  return buildDatabaseBundle(parseDatabaseProject(fixtureFiles(name)), {
    projectName: name,
    replicationType: "full-load-and-cdc",
    dmsMaxCapacityUnits,
    generatedWith: GENERATOR_VERSION,
  });
}

describe("database bundle layout", () => {
  it("packages oracle-hr with the documented file list", () => {
    const bundle = databaseBundle("oracle-hr");
    const paths = bundle.files.map((file) => file.path);
    expect(paths).toEqual([
      "README.md",
      "cloudformation/data-modernization.yaml",
      "dms/replication-settings.json",
      "dms/table-mappings.json",
      "manifest.json",
      "migration-report.md",
      "sql/target/01-schemas.sql",
      "sql/target/02-tables.sql",
      "sql/target/03-views.sql",
      "sql/target/04-constraints-indexes.sql",
    ]);
    expect(paths).toMatchSnapshot();
  });

  it("packages teradata-sales with the documented file list", () => {
    const bundle = databaseBundle("teradata-sales");
    const paths = bundle.files.map((file) => file.path);
    expect(paths).toEqual([
      "README.md",
      "cloudformation/data-modernization.yaml",
      "export/export-teradata.sh",
      "export/teradata-export.tpt",
      "glue/scripts/teradata-sales-sql-apply.py",
      "manifest.json",
      "migration-report.md",
      "sql/apply-plan.json",
      "sql/load/copy.sql",
      "sql/target/01-schemas.sql",
      "sql/target/02-tables.sql",
      "sql/target/03-views.sql",
      "stepfunctions/teradata-sales-warehouse-load.json",
    ]);
    expect(paths).toMatchSnapshot();
  });

  it("packages hive-lake with the documented file list", () => {
    const bundle = databaseBundle("hive-lake");
    const paths = bundle.files.map((file) => file.path);
    expect(paths).toEqual([
      "README.md",
      "cloudformation/data-modernization.yaml",
      "glue/scripts/hive-lake-sql-apply.py",
      "manifest.json",
      "migration-report.md",
      "sql/apply-plan.json",
      "sql/load/load.sql",
      "sql/target/01-databases.sql",
      "sql/target/02-raw-tables.sql",
      "sql/target/03-iceberg-tables.sql",
      "sql/target/04-views-sales.sql",
      "stepfunctions/hive-lake-lake-load.json",
    ]);
    expect(paths).toMatchSnapshot();
  });
});

describe("oracle-hr bundle content", () => {
  const bundle = databaseBundle("oracle-hr");
  const contents = bundle.contents;
  const file = (path: string): string => contents[path] ?? "";

  it("generates the sequences and tables with mapped types", () => {
    const tables = file("sql/target/02-tables.sql");
    expect(tables).toContain(
      "CREATE SEQUENCE IF NOT EXISTS hr.employees_seq START WITH 1000 INCREMENT BY 1;",
    );
    expect(tables).toContain("CREATE TABLE IF NOT EXISTS hr.employees (");
    expect(tables).toContain("    employee_id integer NOT NULL");
    expect(tables).toContain("    hire_date timestamp(0) NOT NULL DEFAULT LOCALTIMESTAMP(0)");
    expect(tables).toContain("    resume text");
    expect(tables).toContain("    CONSTRAINT employees_pkey PRIMARY KEY (employee_id)");
    expect(tables).toContain(
      "-- MANUAL: column geo (SDO_GEOMETRY) generated as text: Requires PostGIS; enable the extension and convert the column to geometry.",
    );
  });

  it("rewrites the partial view and comments out the manual view", () => {
    const views = file("sql/target/03-views.sql");
    expect(views).toContain("COALESCE(e.commission_pct, 0)");
    expect(views).toContain("LOCALTIMESTAMP(0) AS as_of");
    const manualBlock = views.split("\n\n").find((block) => block.includes("dept_summary_v"));
    expect(manualBlock).toBeDefined();
    for (const line of manualBlock?.split("\n") ?? []) {
      if (line === "") continue;
      expect(line.startsWith("-- "), line).toBe(true);
    }
  });

  it("emits the foreign key, indexes and bitmap review", () => {
    const constraints = file("sql/target/04-constraints-indexes.sql");
    expect(constraints).toContain(
      "ALTER TABLE hr.employees ADD CONSTRAINT employees_fk1 FOREIGN KEY (department_id) REFERENCES hr.departments (department_id);",
    );
    const bitmapLine = constraints
      .split("\n")
      .find((line) => line.includes("CREATE INDEX IF NOT EXISTS emp_dept_bix"));
    expect(bitmapLine).toBe(
      "CREATE INDEX IF NOT EXISTS emp_dept_bix ON hr.employees (department_id);",
    );
    const bitmapBlock = constraints.split("\n\n").find((block) => block.includes("emp_dept_bix"));
    expect(bitmapBlock).toContain("-- REVIEW: bitmap index recreated as a B-tree index.");
  });

  it("selects the parsed schema and adds the lowercase rules", () => {
    const mappings = JSON.parse(file("dms/table-mappings.json")) as {
      rules: {
        "rule-type": string;
        "rule-name": string;
        "object-locator": Record<string, string>;
      }[];
    };
    const selections = mappings.rules.filter((rule) => rule["rule-type"] === "selection");
    expect(selections).toHaveLength(1);
    expect(selections[0]?.["object-locator"]["schema-name"]).toBe("HR");
    const transformations = mappings.rules.filter((rule) => rule["rule-type"] === "transformation");
    expect(transformations.map((rule) => rule["rule-name"])).toEqual([
      "lowercase-schemas",
      "lowercase-tables",
      "lowercase-columns",
    ]);
  });

  it("declares the DMS endpoints and replication config", () => {
    const template = JSON.parse(file("cloudformation/data-modernization.yaml")) as {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    expect(template.Resources.SourceEndpoint?.Properties.EngineName).toBe("oracle");
    expect(template.Resources.TargetEndpoint?.Properties.EngineName).toBe("aurora-postgresql");
    const replication = template.Resources.Replication?.Properties as Record<string, unknown>;
    expect(replication.ReplicationType).toBe("full-load-and-cdc");
    expect(replication.ComputeConfig).toMatchObject({ MaxCapacityUnits: 16 });
  });
});

describe("teradata-sales bundle content", () => {
  const bundle = databaseBundle("teradata-sales");
  const contents = bundle.contents;
  const file = (path: string): string => contents[path] ?? "";

  it("uses DISTSTYLE/SORTKEY clauses", () => {
    const tables = file("sql/target/02-tables.sql");
    expect(tables).toContain("DISTSTYLE KEY DISTKEY (order_id)");
    expect(tables).toContain("SORTKEY (order_date)");
    expect(tables).toContain("status char(1) COLLATE case_insensitive");
    expect(tables).toContain("note varchar(800)");
    expect(tables).toContain("DISTSTYLE AUTO");
    expect(tables).not.toContain("vt_stage");
  });

  it("copies only the movable tables", () => {
    const copy = file("sql/load/copy.sql");
    expect(copy).toContain("COPY sales.orders FROM");
    expect(copy).toContain("COPY sales.order_lines FROM");
    expect(copy).not.toContain("sales.customers");
  });

  it("writes the Teradata export script with the documented casts", () => {
    const script = file("export/export-teradata.sh");
    expect(script).toContain("TargetFile='orders.psv'");
    expect(script).toContain("CAST(CAST(order_date AS FORMAT ''YYYY-MM-DD'') AS VARCHAR(10))");
    expect(script).toContain(': "${TD_PASSWORD:?Set TD_PASSWORD in the environment}"');
  });

  it("orchestrates the load with Step Functions", () => {
    const definition = JSON.parse(file("stepfunctions/teradata-sales-warehouse-load.json")) as {
      StartAt: string;
      States: Record<string, { Parameters?: Record<string, unknown> }>;
    };
    expect(definition.StartAt).toBe("ApplySchema");
    expect(definition.States.ApplySchema?.Parameters).toMatchObject({
      JobName: "teradata-sales-sql-apply",
    });
  });
});

describe("hive-lake bundle content", () => {
  const bundle = databaseBundle("hive-lake");
  const contents = bundle.contents;
  const file = (path: string): string => contents[path] ?? "";

  it("creates raw tables over the copied locations", () => {
    const raw = file("sql/target/02-raw-tables.sql");
    expect(raw).toContain("LOCATION 's3://${LakeBucket}/raw/data/sales/orders/'");
    expect(raw).toContain("LOCATION 's3://legacy-clickstream/clicks/'");
    expect(raw).toContain("TBLPROPERTIES ('skip.header.line.count'='1')");
    expect(raw).not.toContain("order_events");
  });

  it("creates Iceberg tables with partitions and buckets", () => {
    const iceberg = file("sql/target/03-iceberg-tables.sql");
    expect(iceberg).toContain("PARTITIONED BY (order_date)");
    expect(iceberg).toContain("PARTITIONED BY (bucket(8, customer_id))");
    expect(iceberg).toContain("country string");
    expect(iceberg).toContain("segment int");
    expect(iceberg).not.toContain("order_events");
  });

  it("repairs partitions and inserts the CHAR cast", () => {
    const load = file("sql/load/load.sql");
    expect(load).toContain("MSCK REPAIR TABLE sales_raw.orders;");
    expect(load).toContain(
      "INSERT INTO sales.customers SELECT customer_id, name, CAST(country AS varchar), segment FROM sales_raw.customers;",
    );
    expect(load).not.toContain("order_events");
  });

  it("wires the DataSync task with the include filter", () => {
    const template = JSON.parse(file("cloudformation/data-modernization.yaml")) as {
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    const includes = (
      template.Resources.CopyTask?.Properties.Includes as { Value: string }[] | undefined
    )?.map((entry) => entry.Value);
    expect(includes).toEqual(["/data/sales/orders|/user/hive/warehouse/sales.db/customers"]);
    expect(template.Resources.HdfsLocation?.Properties.Subdirectory).toBe("/");
  });
});

describe("database bundle hygiene", () => {
  it("never includes source passwords", () => {
    for (const name of ["oracle-hr", "teradata-sales", "hive-lake"] as const) {
      for (const [path, content] of Object.entries(databaseBundle(name).contents)) {
        expect(content, `${name}:${path}`).not.toContain("S3cretPw!");
        expect(content, `${name}:${path}`).not.toContain("T3raPass!");
      }
    }
  });

  it("is deterministic for the same input and options", () => {
    for (const name of ["oracle-hr", "teradata-sales", "hive-lake"] as const) {
      expect(databaseBundle(name).id).toBe(databaseBundle(name).id);
    }
  });

  it("changes the bundle id when DMS capacity units change", () => {
    expect(buildWithUnits("oracle-hr", 32).id).not.toBe(databaseBundle("oracle-hr").id);
  });

  it("packages every file with a newline terminator", () => {
    for (const name of ["oracle-hr", "teradata-sales", "hive-lake"] as const) {
      for (const [path, content] of Object.entries(databaseBundle(name).contents)) {
        expect(content.endsWith("\n"), `${name}:${path}`).toBe(true);
      }
    }
  });
});
