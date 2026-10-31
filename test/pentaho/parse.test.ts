import { describe, expect, it } from "vitest";
import { IngestError, type InputFile } from "../../src/ingest/types.js";
import { parsePentahoProject } from "../../src/pentaho/parse.js";
import { extractVariables, resolveVariable } from "../../src/pentaho/variables.js";
import { fixtureFiles } from "../helpers.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function file(path: string, content: string): InputFile {
  return { path, data: encode(content) };
}

const STEP = (name: string, type: string, body = ""): string =>
  `<step><name>${name}</name><type>${type}</type>${body}</step>`;

describe("parsePentahoProject", () => {
  const project = parsePentahoProject(fixtureFiles());

  it("inventories every supported file without exposing contents", () => {
    expect(project.files).toHaveLength(7);
    expect(project.files.map((entry) => entry.path)).toEqual([
      "jobs/child.kjb",
      "jobs/nightly.kjb",
      "kettle.properties",
      "repository-export.xml",
      "transforms/customers.ktr",
      "transforms/exports.ktr",
      "transforms/orders.ktr",
    ]);
    expect(project.files.map((entry) => entry.kind)).toEqual([
      "job",
      "job",
      "properties",
      "repository",
      "transformation",
      "transformation",
      "transformation",
    ]);
    for (const entry of project.files) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("parses transformations, steps, hops and parameters", () => {
    expect(project.transformations.map((transformation) => transformation.name)).toEqual([
      "repo_dim",
      "customers",
      "exports",
      "orders",
    ]);
    const byName = new Map(
      project.transformations.map((transformation) => [transformation.name, transformation]),
    );
    const customers = byName.get("customers");
    expect(customers?.file).toBe("transforms/customers.ktr");
    expect(customers?.description).toBe("Load customer master data from the landing zone.");
    expect(customers?.steps).toHaveLength(8);
    expect(customers?.hops).toHaveLength(7);
    expect(customers?.parameters).toEqual([
      {
        name: "RUN_DATE",
        defaultValue: "2026-01-01",
        description: "Logical run date passed by the scheduler.",
      },
    ]);
    expect(customers?.connections).toEqual(["warehouse"]);
    expect(customers?.variables).toEqual(["DB_HOST", "Internal.Transformation.Filename.Directory"]);
    const write = customers?.steps.find((step) => step.name === "Write customers");
    expect(write?.type).toBe("TableOutput");
    expect(write?.connection).toBe("warehouse");
    expect(write?.raw.table).toBe("dim_customers");
    const filter = customers?.hops.find((hop) => hop.to === "Deduplicate");
    expect(filter).toMatchObject({ enabled: true, unconditional: false });

    const orders = byName.get("orders");
    expect(orders?.steps).toHaveLength(4);
    expect(orders?.hops.map((hop) => `${hop.from}->${hop.to}`)).toEqual([
      "Read orders->Aggregate by country",
      "Aggregate by country->Order columns",
      "Order columns->Write extract",
    ]);
    expect(orders?.connections).toEqual(["warehouse"]);
    expect(orders?.variables).toEqual(["DB_HOST", "RUN_DATE"]);

    const exports = byName.get("exports");
    expect(exports?.steps.map((step) => step.type)).toEqual([
      "ExcelInput",
      "SelectValues",
      "ExcelOutput",
    ]);
    expect(exports?.variables).toEqual([
      "Internal.Transformation.Filename.Directory",
      "REPORT_DATE",
    ]);
  });

  it("parses jobs, entries, conditional hops and schedules", () => {
    expect(project.jobs.map((job) => job.name)).toEqual(["child", "nightly_load", "repo_job"]);
    const byName = new Map(project.jobs.map((job) => [job.name, job]));
    const child = byName.get("child");
    expect(child?.entries).toHaveLength(7);
    expect(child?.hops).toHaveLength(7);
    expect(child?.entries.filter((entry) => entry.start)).toHaveLength(1);
    expect(child?.entries.map((entry) => entry.type)).toEqual([
      "SPECIAL",
      "SET_VARIABLES",
      "WAIT",
      "WRITE_TO_LOG",
      "EVAL",
      "SPECIAL",
      "SPECIAL",
    ]);

    const nightly = byName.get("nightly_load");
    expect(nightly?.entries).toHaveLength(10);
    expect(nightly?.hops).toHaveLength(15);
    expect(nightly?.parameters).toEqual([
      {
        name: "RUN_DATE",
        defaultValue: "2026-01-01",
        description: "Set by the scheduler.",
      },
    ]);
    expect(nightly?.connections).toEqual(["warehouse"]);
    const start = nightly?.entries.find((entry) => entry.start);
    expect(start).toMatchObject({
      name: "Start",
      schedulerType: 2,
      repeat: true,
      hour: 2,
      minutes: 15,
    });
    const failureHop = nightly?.hops.find(
      (hop) => hop.from === "Load orders" && hop.to === "Failure",
    );
    expect(failureHop).toMatchObject({ enabled: true, unconditional: false, evaluation: "N" });
    const childEntry = nightly?.entries.find((entry) => entry.name === "Run child job");
    expect(childEntry?.type).toBe("JOB");
    expect(childEntry?.raw.filename).toBe("${Internal.Job.Filename.Directory}/child.kjb");
  });

  it("maps schedules from START entries", () => {
    expect(project.schedules).toEqual([
      {
        job: "nightly_load",
        file: "jobs/nightly.kjb",
        entry: "Start",
        schedulerType: 2,
        repeat: true,
        intervalSeconds: 0,
        intervalMinutes: 0,
        hour: 2,
        minutes: 15,
        weekDay: 1,
        dayOfMonth: 1,
      },
    ]);
  });

  it("extracts connections once and drops source passwords", () => {
    expect(project.connections.map((connection) => connection.name)).toEqual([
      "warehouse",
      "landing",
    ]);
    const warehouse = project.connections[0];
    expect(warehouse).toMatchObject({
      name: "warehouse",
      type: "POSTGRESQL",
      host: "${DB_HOST}",
      database: "retail",
      port: "5432",
      username: "etl",
      hasPassword: true,
      sourceFile: "jobs/nightly.kjb",
    });
    expect(Object.keys(warehouse ?? {})).not.toContain("password");
    expect(project.connections[1]).toMatchObject({
      name: "landing",
      host: "s3.amazonaws.com",
      database: "retail-landing",
      hasPassword: false,
      sourceFile: "repository-export.xml",
    });
    const serialized = JSON.stringify(project);
    expect(serialized).not.toContain("SuperSecret!23");
    expect(serialized).not.toContain("abc123token");
    expect(serialized).not.toContain("Encrypted 2be98");
  });

  it("redacts secret-like kettle.properties values and warns", () => {
    expect(project.properties).toEqual({
      DB_HOST: "retail-db.internal.example.com",
      DB_PORT: "5432",
      RUN_DATE: "2026-01-01",
      REPORT_DATE: "2026-01-31",
      DB_PASSWORD: "***REDACTED***",
      API_TOKEN: "***REDACTED***",
    });
    const redactions = project.warnings.filter((warning) => warning.startsWith("Redacted"));
    expect(redactions).toHaveLength(2);
    expect(redactions.join("\n")).toContain("DB_PASSWORD");
    expect(redactions.join("\n")).toContain("API_TOKEN");
  });

  it("parses repository exports into transformations and jobs", () => {
    const repoTransform = project.transformations.find(
      (transformation) => transformation.name === "repo_dim",
    );
    expect(repoTransform?.file).toBe("repository-export.xml");
    expect(repoTransform?.steps.map((step) => step.name)).toEqual([
      "Generate keys",
      "Tag source",
      "Finish",
    ]);
    expect(repoTransform?.hops).toHaveLength(2);
    const repoJob = project.jobs.find((job) => job.name === "repo_job");
    expect(repoJob?.file).toBe("repository-export.xml");
    expect(repoJob?.entries.map((entry) => entry.type)).toEqual(["SPECIAL", "TRANS", "SPECIAL"]);
    expect(project.files.find((entry) => entry.path === "repository-export.xml")?.kind).toBe(
      "repository",
    );
  });

  it("warns about and skips files it cannot use", () => {
    const projectWithExtras = parsePentahoProject([
      ...fixtureFiles(),
      file("notes.txt", "not part of the project"),
      file("plain.xml", "<notes><note>hello</note></notes>"),
      file("broken.ktr", "<transformation><step></transformation>"),
      file("evil.kjb", '<!DOCTYPE job [<!ENTITY x "y">]><job/>'),
    ]);
    expect(projectWithExtras.transformations).toHaveLength(4);
    expect(projectWithExtras.files.map((entry) => entry.path)).not.toContain("notes.txt");
    expect(projectWithExtras.files.map((entry) => entry.path)).not.toContain("broken.ktr");
    const warnings = projectWithExtras.warnings.join("\n");
    expect(warnings).toMatch(/Skipped notes\.txt/);
    expect(warnings).toMatch(/Skipped plain\.xml/);
    expect(warnings).toMatch(/broken\.ktr is not well-formed XML/);
    expect(warnings).toMatch(/evil\.kjb contains a DOCTYPE or ENTITY/);
  });

  it("throws when no transformation or job can be parsed", () => {
    expect(() => parsePentahoProject([file("notes.txt", "hello")])).toThrow(IngestError);
    expect(() => parsePentahoProject([])).toThrow(/No Pentaho transformations or jobs/);
  });

  it("warns on multiple START entries and conflicting connections", () => {
    const content = `<?xml version="1.0"?>
<transformation>
  <info><name>conflict</name></info>
  <connection><name>db</name><server>one.example.com</server><type>POSTGRESQL</type></connection>
  ${STEP("Start", "Dummy")}
</transformation>`;
    const second = `<?xml version="1.0"?>
<transformation>
  <info><name>other</name></info>
  <connection><name>db</name><server>two.example.com</server><type>POSTGRESQL</type></connection>
  ${STEP("Start", "Dummy")}
</transformation>`;
    const job = `<?xml version="1.0"?>
<job>
  <name>multi</name>
  <entries>
    <entry><name>Start</name><type>SPECIAL</type><start>Y</start><schedulerType>1</schedulerType></entry>
    <entry><name>Again</name><type>SPECIAL</type><start>Y</start><schedulerType>1</schedulerType></entry>
  </entries>
</job>`;
    const parsed = parsePentahoProject([
      file("a/conflict.ktr", content),
      file("b/other.ktr", second),
      file("c/multi.kjb", job),
    ]);
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.connections[0]?.host).toBe("one.example.com");
    expect(parsed.warnings.join("\n")).toMatch(/Connection name "db" is defined differently/);
    expect(parsed.warnings.join("\n")).toMatch(/more than one START entry/);
    expect(parsed.schedules).toHaveLength(2);
  });
});

describe("Pentaho variables", () => {
  it("extracts ${...} and %%...%% references without duplicates", () => {
    expect(
      extractVariables(
        "${DB_HOST}:${DB_PORT} and %%LEGACY%% and ${DB_HOST} and ${Internal.Job.Filename.Directory}",
      ),
    ).toEqual(["DB_HOST", "DB_PORT", "LEGACY", "Internal.Job.Filename.Directory"]);
    expect(extractVariables(undefined)).toEqual([]);
  });

  it("resolves known variables and leaves unknown references intact", () => {
    expect(resolveVariable("${A}/%%B%%/${C}", { A: "one", B: "two" })).toBe("one/two/${C}");
  });
});
