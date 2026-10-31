export type ConversionStatus = "automatic" | "partial" | "manual";

export interface StepMapping {
  status: ConversionStatus;
  /** Short description used in reports and the workbench. */
  conversion: string;
  /** Additional caveat for partial mappings. */
  caveat?: string;
}

/**
 * Registry of PDI transformation step types. Keys are lower-case step types.
 * Automatic steps are converted without a caveat, partial steps get generated
 * code plus a TODO, and manual steps are passed through with a stub that the
 * model can replace through step_overrides.
 */
const MAPPINGS: Record<string, StepMapping> = {
  abort: { status: "automatic", conversion: "Raises a RuntimeError in the Glue job" },
  addconstants: { status: "automatic", conversion: "withColumn and lit" },
  addsequence: {
    status: "partial",
    conversion: "row_number window with the configured start and increment",
    caveat: "The sequence is assigned after a shuffle, so the order may differ from PDI.",
  },
  calculator: {
    status: "automatic",
    conversion: "withColumn expressions for arithmetic, string, date and null functions",
  },
  concatfields: { status: "automatic", conversion: "concat_ws" },
  csvinput: { status: "automatic", conversion: "spark.read.csv with a declared schema" },
  dblookup: {
    status: "partial",
    conversion: "left join against a JDBC lookup and default values",
    caveat:
      "Only exact-key lookups are generated; caching and case-insensitive matches are not reproduced.",
  },
  delete: {
    status: "partial",
    conversion: "staging DataFrame plus a generated JDBC statement",
    caveat: "The delete is not executed automatically; review the generated SQL fragment.",
  },
  denormaliser: {
    status: "partial",
    conversion: "pivot or aggregate template",
    caveat: "Generated from the field definitions; verify group and target columns.",
  },
  dimensionlookup: {
    status: "partial",
    conversion: "SCD2 template with a MERGE SQL fragment",
    caveat: "Slowly changing dimension bookkeeping needs review against the target schema.",
  },
  dummy: { status: "automatic", conversion: "DataFrame pass-through" },
  excelinput: {
    status: "partial",
    conversion: "pandas read_excel converted to a Spark DataFrame",
    caveat:
      "Requires pandas and openpyxl in the Glue job, and the file is downloaded to the worker first.",
  },
  exceloutput: {
    status: "partial",
    conversion: "toPandas().to_excel uploaded to S3",
    caveat: "The result must fit on one worker and requires pandas and openpyxl.",
  },
  filterrows: { status: "automatic", conversion: "DataFrame.filter with the PDI condition tree" },
  formulastep: {
    status: "manual",
    conversion: "Pass-through stub; the formula is preserved in the report",
    caveat: "Write PySpark for this step through step_overrides.",
  },
  generaterows: { status: "automatic", conversion: "spark.range with literal fields" },
  getvariable: {
    status: "partial",
    conversion: "values are resolved as Glue arguments",
    caveat: "The step becomes a pass-through; variables are bound when the job starts.",
  },
  groupby: { status: "automatic", conversion: "groupBy().agg() with PDI aggregate types" },
  http: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Network calls need a Lambda task or a reviewed override.",
  },
  ifnull: { status: "automatic", conversion: "coalesce" },
  insertupdate: {
    status: "partial",
    conversion: "staging DataFrame plus a generated MERGE SQL",
    caveat: "The merge needs a target key and is not executed automatically.",
  },
  javascript: {
    status: "manual",
    conversion: "Pass-through stub with the original script in the report",
    caveat: "Rewrite the JavaScript as PySpark through step_overrides.",
  },
  javafilter: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Rewrite the Java filter as a PySpark condition through step_overrides.",
  },
  jsoninput: {
    status: "partial",
    conversion: "spark.read.json",
    caveat: "PDI path-level field selection is not reproduced; review the inferred schema.",
  },
  jsonoutput: { status: "automatic", conversion: "DataFrame.write.json" },
  mapping: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Mapping steps need a separate generated job or a reviewed override.",
  },
  mergejoin: { status: "automatic", conversion: "DataFrame.join on the PDI key pairs" },
  numberrange: { status: "automatic", conversion: "nested when/otherwise" },
  replacestring: { status: "automatic", conversion: "regexp_replace" },
  rest: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Call the API from a Lambda task or a reviewed override.",
  },
  rowgenerator: { status: "automatic", conversion: "spark.range with literal fields" },
  rownormaliser: {
    status: "partial",
    conversion: "explode of a struct array",
    caveat: "Field mapping is generated from the type/key definitions; review the result columns.",
  },
  selectvalues: {
    status: "automatic",
    conversion: "select, withColumnRenamed, cast and drop",
  },
  sequence: {
    status: "partial",
    conversion: "row_number window with the configured start and increment",
    caveat: "The sequence is assigned after a shuffle, so the order may differ from PDI.",
  },
  setvariable: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Set variables in the state machine or Glue arguments instead.",
  },
  simplemapping: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Mapping steps need a separate generated job or a reviewed override.",
  },
  sortrows: { status: "automatic", conversion: "orderBy" },
  splitfields: { status: "automatic", conversion: "split and positional extraction" },
  splitfieldtorows: {
    status: "automatic",
    conversion: "split and explode",
  },
  sql: { status: "automatic", conversion: "read_jdbc or spark.sql" },
  streamlookup: { status: "automatic", conversion: "left join on lookup keys with defaults" },
  switchcase: { status: "automatic", conversion: "filtered route DataFrames" },
  tableinput: { status: "automatic", conversion: "read_jdbc with the SQL as a subquery" },
  tableoutput: { status: "automatic", conversion: "DataFrame.write.jdbc" },
  textfileinput: { status: "automatic", conversion: "spark.read.csv with a declared schema" },
  textfileoutput: { status: "automatic", conversion: "DataFrame.write.csv" },
  unique: { status: "automatic", conversion: "dropDuplicates" },
  update: {
    status: "partial",
    conversion: "staging DataFrame plus a generated MERGE SQL",
    caveat: "The update is not executed automatically; review the generated SQL fragment.",
  },
  userdefinedjavaclass: {
    status: "manual",
    conversion: "Pass-through stub with the original class source in the report",
    caveat: "Rewrite the Java class as PySpark through step_overrides.",
  },
  userdefinedjavaexpression: {
    status: "manual",
    conversion: "Pass-through stub",
    caveat: "Rewrite the Java expression as PySpark through step_overrides.",
  },
  valuemapper: { status: "automatic", conversion: "nested when/otherwise" },
  writetolog: { status: "automatic", conversion: "logger.info and pass-through" },
};

const MANUAL: StepMapping = {
  status: "manual",
  conversion: "Pass-through stub",
  caveat: "This step is not converted; review it and add PySpark through step_overrides.",
};

export function stepMapping(type: string): StepMapping {
  return MAPPINGS[type.toLowerCase()] ?? MANUAL;
}

export function isSupportedStepType(type: string): boolean {
  return stepMapping(type).status !== "manual";
}

export function isManualStepType(type: string): boolean {
  return stepMapping(type).status === "manual";
}

export function mappingTypes(status: ConversionStatus): string[] {
  return Object.keys(MAPPINGS).filter((type) => MAPPINGS[type]?.status === status);
}

export function stepMappingTable(): Record<string, StepMapping> {
  return Object.fromEntries(Object.entries(MAPPINGS).sort(([a], [b]) => a.localeCompare(b)));
}
