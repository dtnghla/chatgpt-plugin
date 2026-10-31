import { boolAt, child, children, stringAt, type XmlNode } from "../ingest/xml.js";
import type { Transformation, TransformationStep } from "../pentaho/types.js";
import { connectionSlug, driverClass } from "./jdbc.js";
import { stepMapping } from "./step-mapping.js";

export interface PathMapping {
  from: string;
  to: string;
}

export interface GlueGenerationOptions {
  stepOverrides?: Record<string, string>;
  pathMappings?: PathMapping[];
}

export interface GlueScriptResult {
  code: string;
  warnings: string[];
  automaticSteps: string[];
  partialSteps: string[];
  manualSteps: string[];
  connections: string[];
  needsExcel: boolean;
  overriddenSteps: string[];
}

function py(value: string | undefined): string {
  return JSON.stringify(value ?? "");
}

function pyNumber(value: string | undefined, fallback = "None"): string {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : fallback;
}

function fieldType(type: string | undefined): string {
  switch ((type ?? "").toLowerCase()) {
    case "integer":
    case "int":
      return "int";
    case "number":
    case "float":
    case "double":
      return "double";
    case "bignumber":
    case "bigdecimal":
      return "decimal(38,9)";
    case "date":
      return "date";
    case "timestamp":
    case "datetime":
      return "timestamp";
    case "boolean":
      return "boolean";
    case "binary":
      return "binary";
    default:
      return "string";
  }
}

function listStrings(value: unknown, key: string, childKey = "name"): string[] {
  const found = (value as Record<string, unknown> | undefined)?.[key];
  const items = Array.isArray(found) ? found : found === undefined ? [] : [found];
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim()) result.push(item.trim());
    } else {
      const name =
        stringAt(item, childKey) ??
        stringAt(item, "field") ??
        stringAt(item, "value") ??
        stringAt(item, "name");
      if (name) result.push(name);
    }
  }
  return result;
}

function firstUpstream(upstream: string[]): string {
  return upstream[0] ?? "spark.range(0).drop('id')";
}

function joinUpstream(upstream: string[]): string {
  if (upstream.length <= 1) return firstUpstream(upstream);
  return upstream
    .slice(1)
    .reduce(
      (left, right) => `${left}.unionByName(${right}, allowMissingColumns=True)`,
      upstream[0] ?? "",
    );
}

interface Condition {
  left: string;
  fn: string;
  right: string;
  rightType: string;
  negated: boolean;
  operator: "AND" | "OR";
}

function parseCondition(value: XmlNode): Condition | undefined {
  const left = stringAt(value, "leftvalue") ?? stringAt(value, "fieldname");
  if (!left) return undefined;
  const valueNode = child(value, "value");
  const type = stringAt(valueNode, "type") ?? stringAt(value, "valuetype") ?? "String";
  const rawRight =
    stringAt(valueNode, "text") ??
    stringAt(value, "rightvalue") ??
    stringAt(value, "comparevalue") ??
    stringAt(value, "mask") ??
    "";
  const right = boolAt(valueNode, "isnull") === true ? "" : rawRight;
  const operator = stringAt(value, "operator")?.toUpperCase() === "OR" ? "OR" : "AND";
  return {
    left,
    fn: (stringAt(value, "function") ?? stringAt(value, "condition") ?? "=").trim().toUpperCase(),
    right,
    rightType: type,
    negated: boolAt(value, "negated") ?? false,
    operator,
  };
}

function literal(value: string, type: string): string {
  const normalized = type.toLowerCase();
  if (
    normalized.includes("integer") ||
    normalized.includes("number") ||
    normalized.includes("bignumber")
  ) {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? value : py(value);
  }
  if (normalized.includes("boolean")) {
    return value.toUpperCase() === "Y" || value.toUpperCase() === "TRUE" ? "True" : "False";
  }
  return py(value);
}

function conditionExpression(condition: Condition): string {
  const col = `F.col(${py(condition.left)})`;
  const right = literal(condition.right, condition.rightType);
  let expression: string;
  switch (condition.fn) {
    case "IS NULL":
      expression = `${col}.isNull()`;
      break;
    case "IS NOT NULL":
      expression = `${col}.isNotNull()`;
      break;
    case "=":
    case "==":
      expression = condition.right === "" ? `${col}.isNull()` : `${col} == ${right}`;
      break;
    case "<>":
    case "!=":
      expression = condition.right === "" ? `${col}.isNotNull()` : `${col} != ${right}`;
      break;
    case ">":
    case ">=":
    case "<":
    case "<=":
      expression = `${col} ${condition.fn} ${right}`;
      break;
    case "LIKE":
      expression = `${col}.like(${py(condition.right)})`;
      break;
    case "NOT LIKE":
      expression = `~${col}.like(${py(condition.right)})`;
      break;
    case "REGEXP":
    case "RLIKE":
      expression = `${col}.rlike(${py(condition.right)})`;
      break;
    case "CONTAINS":
      expression = `${col}.contains(${py(condition.right)})`;
      break;
    case "STARTS WITH":
      expression = `${col}.startswith(${py(condition.right)})`;
      break;
    case "ENDS WITH":
      expression = `${col}.endswith(${py(condition.right)})`;
      break;
    case "IN LIST":
    case "NOT IN LIST": {
      const values = condition.right
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => literal(item, condition.rightType));
      expression = `${col}.isin([${values.join(", ")}])`;
      if (condition.fn === "NOT IN LIST") expression = `~${expression}`;
      break;
    }
    case "BETWEEN": {
      const [low = "", high = ""] = condition.right.split(/[;,]/);
      expression = `${col}.between(${literal(low.trim(), condition.rightType)}, ${literal(high.trim(), condition.rightType)})`;
      break;
    }
    default:
      expression = "F.lit(True)";
      break;
  }
  return condition.negated ? `~(${expression})` : expression;
}

function filterExpression(raw: XmlNode): { expression: string; warnings: string[] } {
  const warnings: string[] = [];
  const compare = child(raw, "compare");
  const outer = child(compare, "condition") ?? child(raw, "condition");
  if (!outer) return { expression: "F.lit(True)", warnings };
  const group = child(outer, "conditions");
  const conditions = group ? children(group, "condition") : [outer];
  if (conditions.length === 0) return { expression: "F.lit(True)", warnings };
  let expression = "";
  for (const conditionNode of conditions) {
    const parsed = parseCondition(conditionNode);
    if (!parsed) {
      warnings.push("A FilterRows condition had no left-hand field and was ignored.");
      continue;
    }
    const part = conditionExpression(parsed);
    if (expression === "") expression = part;
    else expression = `(${expression}) ${parsed.operator} (${part})`;
  }
  if (expression === "") expression = "F.lit(True)";
  if (boolAt(outer, "negated") === true) expression = `~(${expression})`;
  return { expression, warnings };
}

function upstreamVar(
  stepNameValue: string,
  varByStep: Map<string, string>,
  warnings: string[],
  context: string,
): string {
  const variable = varByStep.get(stepNameValue);
  if (!variable) {
    warnings.push(`${context} references step "${stepNameValue}", which is not upstream.`);
    return "spark.range(0).drop('id')";
  }
  return variable;
}

interface ConvertContext {
  step: TransformationStep;
  upstream: string[];
  varByStep: Map<string, string>;
  warnings: string[];
  route: Map<string, string>;
  needsExcel: { value: boolean };
  target: string;
}

function commentBlock(lines: string[]): string[] {
  return lines.map((line) => `# ${line}`.trimEnd());
}

function manualStub(step: TransformationStep, input: string, target: string): string[] {
  const raw = step.raw;
  const source: string[] = [];
  for (const key of ["script", "jsScript", "formula", "class_source", "java_expression"]) {
    const value = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (value) source.push(`${key}:`, ...value.split(/\r?\n/).slice(0, 80));
  }
  const lines = [
    `# TODO (manual): PDI ${step.type} step "${step.name}" is not converted.`,
    `# Replace this stub through step_overrides and review the result.`,
  ];
  if (source.length > 0) lines.push(...commentBlock(source));
  lines.push(`${target} = ${input}`);
  return lines;
}

function convertStep(context: ConvertContext): string[] {
  const { step, upstream, varByStep, warnings, route, target } = context;
  const raw = step.raw;
  const type = step.type.toLowerCase();
  const input = firstUpstream(upstream);
  const inputJoined = joinUpstream(upstream);
  const lines: string[] = [];
  const sink = ["tableoutput", "textfileoutput", "jsonoutput", "exceloutput"].includes(type);

  switch (type) {
    case "tableinput": {
      const connection = step.connection;
      if (!connection) {
        warnings.push(`TableInput "${step.name}" has no connection.`);
        lines.push(`raise ValueError(${py(`TableInput ${step.name} has no connection`)})`);
        return lines;
      }
      const sql = stringAt(raw, "sql") ?? "";
      lines.push(
        "# SQL is passed as a subquery; remove vendor-specific syntax that Spark cannot parse.",
      );
      lines.push(`${target} = read_jdbc(pdi_value(${py(sql)}), ${py(connectionSlug(connection))})`);
      break;
    }
    case "csvinput": {
      const file = stringAt(raw, "filename") ?? stringAt(child(raw, "file"), "name") ?? "";
      const separator = stringAt(raw, "delimiter") ?? stringAt(raw, "separator") ?? ",";
      if (separator.length > 1) {
        warnings.push(
          `CsvInput "${step.name}" uses a multi-character delimiter; Spark uses the first character.`,
        );
      }
      const header = boolAt(raw, "header") ?? true;
      const fields = children(child(raw, "fields"), "field").map((field) => ({
        name: stringAt(field, "name") ?? "",
        type: fieldType(stringAt(field, "type")),
      }));
      lines.push(
        `${target} = read_csv(pdi_path(${py(file)}, "INPUT_BASE_PATH"), ${py(separator.slice(0, 1))}, ${header ? "True" : "False"}, ${JSON.stringify(fields)})`,
      );
      break;
    }
    case "textfileinput": {
      const files = children(raw, "file")
        .map((file) => stringAt(file, "name"))
        .filter((name): name is string => Boolean(name));
      const separator = stringAt(raw, "separator") ?? ",";
      if (separator.length > 1) {
        warnings.push(
          `TextFileInput "${step.name}" uses a multi-character separator; Spark uses the first character.`,
        );
      }
      const header = boolAt(raw, "header") ?? false;
      const fields = children(child(raw, "fields"), "field").map((field) => ({
        name: stringAt(field, "name") ?? "",
        type: fieldType(stringAt(field, "type")),
      }));
      if (files.length === 0) warnings.push(`TextFileInput "${step.name}" has no input file.`);
      lines.push(
        `${target} = read_csv([${files.map((file) => `pdi_path(${py(file)}, "INPUT_BASE_PATH")`).join(", ")}], ${py(separator.slice(0, 1))}, ${header ? "True" : "False"}, ${JSON.stringify(fields)})`,
      );
      break;
    }
    case "jsoninput": {
      const file = stringAt(raw, "filename") ?? stringAt(child(raw, "file"), "name") ?? "";
      lines.push(`${target} = spark.read.json(pdi_path(${py(file)}, "INPUT_BASE_PATH"))`);
      break;
    }
    case "excelinput": {
      context.needsExcel.value = true;
      const files = children(raw, "file");
      const file = stringAt(files[0], "name") ?? "";
      const sheets = children(child(raw, "sheets"), "sheet")
        .map((sheet) => stringAt(sheet, "name"))
        .filter((name): name is string => Boolean(name));
      lines.push(
        `${target} = read_excel(pdi_path(${py(file)}, "INPUT_BASE_PATH"), ${py(sheets[0] ?? "")})`,
      );
      if (file.toLowerCase().endsWith(".xls")) {
        warnings.push(
          `ExcelInput "${step.name}" uses .xls; the generated job requests xlrd as well as openpyxl.`,
        );
      }
      break;
    }
    case "rowgenerator":
    case "generaterows": {
      const fields = children(child(raw, "fields"), "field").map((field) => ({
        name: stringAt(field, "name") ?? "",
        value: stringAt(field, "value") ?? "",
        type: fieldType(stringAt(field, "type")),
      }));
      const limit = Math.max(
        1,
        Number(stringAt(raw, "row_limit") ?? stringAt(raw, "limit") ?? "1") || 1,
      );
      if (fields.length === 0) warnings.push(`Row generator "${step.name}" has no fields.`);
      const columns = fields
        .map(
          (field) =>
            `F.lit(${literal(field.value, field.type)}).cast(${py(field.type)}).alias(${py(field.name)})`,
        )
        .join(", ");
      lines.push(
        `${target} = spark.range(${limit}).select(${columns || "F.lit(1).alias('value')"})`,
      );
      break;
    }
    case "getvariable": {
      const variables = children(raw, "variable").map((variable) => ({
        name: stringAt(variable, "name") ?? "",
        type: fieldType(stringAt(variable, "type")),
      }));
      if (variables.length === 0) {
        lines.push(`${target} = ${inputJoined}`);
      } else {
        const assignments = variables
          .filter((variable) => variable.name)
          .map(
            (variable) =>
              `F.lit(pdi_value('${"$"}{${variable.name}}')).cast(${py(variable.type)}).alias(${py(variable.name)})`,
          )
          .join(", ");
        if (upstream.length === 0) {
          lines.push(`${target} = spark.range(1).select(${assignments})`);
        } else {
          lines.push(
            `${target} = ${input}.withColumns({${variables.map((variable) => `${py(variable.name)}: F.lit(pdi_value('${"$"}{${variable.name}}'))`).join(", ")}})`,
          );
        }
      }
      break;
    }
    case "addconstants": {
      let current = input;
      for (const field of children(child(raw, "fields"), "field")) {
        const name = stringAt(field, "name");
        if (!name) continue;
        const type = fieldType(stringAt(field, "type"));
        const value = stringAt(field, "value") ?? "";
        current = `${current}.withColumn(${py(name)}, F.lit(${literal(value, type)}).cast(${py(type)}))`;
      }
      lines.push(`${target} = ${current}`);
      break;
    }
    case "dummy":
    case "writetolog": {
      if (type === "writetolog") {
        const message = stringAt(raw, "logmessage") ?? step.name;
        lines.push(`logger.info(${py(`PDI WriteToLog ${step.name}: ${message}`)})`);
      }
      lines.push(`${target} = ${inputJoined}`);
      break;
    }
    case "abort": {
      lines.push(
        `raise RuntimeError(${py(stringAt(raw, "message") ?? `PDI Abort step ${step.name}`)})`,
      );
      return lines;
    }
    case "filterrows": {
      const filter = filterExpression(raw);
      warnings.push(...filter.warnings);
      lines.push(`${target} = ${input}.filter(${filter.expression})`);
      break;
    }
    case "numberrange": {
      const field = stringAt(raw, "input_field") ?? stringAt(raw, "fieldname") ?? "";
      let expression = "F.lit(None)";
      for (const rule of [...children(child(raw, "rules"), "rule")].reverse()) {
        const lower = stringAt(rule, "lower_bound");
        const upper = stringAt(rule, "upper_bound");
        const value = stringAt(rule, "value") ?? "";
        const conditions: string[] = [];
        if (lower && lower !== "-") {
          conditions.push(`F.col(${py(field)}) >= ${literal(lower, "Number")}`);
        }
        if (upper && upper !== "-") {
          conditions.push(`F.col(${py(field)}) < ${literal(upper, "Number")}`);
        }
        if (conditions.length === 0) continue;
        expression = `F.when(${conditions.join(" & ")}, F.lit(${py(value)})).otherwise(${expression})`;
      }
      const resultField =
        stringAt(raw, "result_fieldname") ?? stringAt(raw, "result_field") ?? "range";
      lines.push(`${target} = ${input}.withColumn(${py(resultField)}, ${expression})`);
      break;
    }
    case "sortrows": {
      const fields = children(child(raw, "fields"), "field");
      const order = fields
        .map((field) => {
          const name = stringAt(field, "name");
          return name
            ? `F.col(${py(name)}).${boolAt(field, "ascending") === false ? "desc" : "asc"}()`
            : "";
        })
        .filter(Boolean)
        .join(", ");
      lines.push(`${target} = ${input}${order ? `.orderBy(${order})` : ""}`);
      break;
    }
    case "unique": {
      const names = listStrings(child(raw, "fields"), "field");
      lines.push(
        `${target} = ${input}${names.length ? `.dropDuplicates([${names.map(py).join(", ")}])` : ".dropDuplicates()"}`,
      );
      break;
    }
    case "groupby": {
      const groupNames = listStrings(child(raw, "group"), "field", "name");
      const aggregates = children(child(raw, "fields"), "field").map((field) => {
        const typeName = (stringAt(field, "type") ?? "").toUpperCase();
        const subject = stringAt(field, "subject") ?? "";
        const alias = stringAt(field, "aggregate") ?? stringAt(field, "name") ?? subject;
        let expression: string;
        if (typeName.includes("COUNT_ALL")) expression = "F.count('*')";
        else if (typeName.includes("COUNT")) {
          expression = `F.count(${subject ? `F.col(${py(subject)})` : "'*'"})`;
        } else if (typeName.includes("AVERAGE") || typeName === "AVG") {
          expression = `F.avg(F.col(${py(subject)}))`;
        } else if (typeName.includes("STD")) expression = `F.stddev(F.col(${py(subject)}))`;
        else if (typeName.includes("MEDIAN")) {
          expression = `F.percentile_approx(F.col(${py(subject)}), 0.5)`;
        } else if (typeName.includes("MIN")) expression = `F.min(F.col(${py(subject)}))`;
        else if (typeName.includes("MAX")) expression = `F.max(F.col(${py(subject)}))`;
        else if (typeName.includes("FIRST")) {
          expression = `F.first(F.col(${py(subject)}), ignorenulls=True)`;
        } else if (typeName.includes("LAST")) {
          expression = `F.last(F.col(${py(subject)}), ignorenulls=True)`;
        } else if (typeName.includes("CONCAT")) {
          expression = `F.concat_ws(",", F.collect_list(F.col(${py(subject)})))`;
        } else expression = `F.sum(F.col(${py(subject)}))`;
        return `${expression}.alias(${py(alias || `${typeName}_${subject}`)})`;
      });
      const aggregateSql = aggregates.join(", ") || "F.count('*').alias('count')";
      if (groupNames.length === 0) {
        lines.push(`${target} = ${input}.agg(${aggregateSql})`);
      } else {
        lines.push(
          `${target} = ${input}.groupBy(${groupNames.map((name) => `F.col(${py(name)})`).join(", ")}).agg(${aggregateSql})`,
        );
      }
      break;
    }
    case "calculator": {
      let current = input;
      for (const calculation of children(raw, "calculation")) {
        const name = stringAt(calculation, "field_name") ?? "";
        if (!name) continue;
        const calc = (stringAt(calculation, "calc_type") ?? "").toUpperCase();
        const a = stringAt(calculation, "field_a") ?? "";
        const b = stringAt(calculation, "field_b") ?? "";
        const c = stringAt(calculation, "field_c") ?? "";
        const col = (field: string) =>
          /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(field) ? `F.lit(${field})` : `F.col(${py(field)})`;
        const binary: Record<string, string> = {
          ADD: `${col(a)} + ${col(b)}`,
          SUBTRACT: `${col(a)} - ${col(b)}`,
          MULTIPLY: `${col(a)} * ${col(b)}`,
          DIVIDE: `${col(a)} / ${col(b)}`,
          MODULO: `${col(a)} % ${col(b)}`,
          POWER: `F.pow(${col(a)}, ${col(b)})`,
          MIN: `F.least(${col(a)}, ${col(b)})`,
          MAX: `F.greatest(${col(a)}, ${col(b)})`,
          DATE_ADD: `F.date_add(${col(a)}, ${b ? col(b) : "0"})`,
          DATE_DIFF: `F.datediff(${col(a)}, ${col(b)})`,
        };
        const unary: Record<string, string> = {
          ABS: `F.abs(${col(a)})`,
          CEIL: `F.ceil(${col(a)})`,
          FLOOR: `F.floor(${col(a)})`,
          SQRT: `F.sqrt(${col(a)})`,
          ROUND: `F.round(${col(a)}, ${b ? col(b) : "0"})`,
          LOWER: `F.lower(${col(a)})`,
          UPPER: `F.upper(${col(a)})`,
          TRIM: `F.trim(${col(a)})`,
          LENGTH: `F.length(${col(a)})`,
          YEAR_OF_DATE: `F.year(${col(a)})`,
          MONTH_OF_DATE: `F.month(${col(a)})`,
          DAY_OF_MONTH: `F.dayofmonth(${col(a)})`,
          HOUR_OF_DAY: `F.hour(${col(a)})`,
          MINUTE_OF_HOUR: `F.minute(${col(a)})`,
          SECOND_OF_MINUTE: `F.second(${col(a)})`,
          DAY_OF_WEEK: `F.dayofweek(${col(a)})`,
          WEEK_OF_YEAR: `F.weekofyear(${col(a)})`,
          QUARTER: `F.quarter(${col(a)})`,
          CONCAT: `F.concat(${[a, b, c].filter(Boolean).map(col).join(", ")})`,
          NVL: `F.coalesce(${col(a)}, ${col(b)})`,
          NULLIF: `F.when(${col(a)} == ${col(b)}, F.lit(None)).otherwise(${col(a)})`,
        };
        let expression = binary[calc] ?? unary[calc];
        if (!expression) {
          if (calc === "CONSTANT") expression = `F.lit(${py(a)})`;
          else {
            expression = "F.lit(None)";
            warnings.push(`Calculator "${step.name}" uses unsupported calc_type "${calc}".`);
          }
        }
        current = `${current}.withColumn(${py(name)}, ${expression})`;
      }
      lines.push(`${target} = ${current}`);
      break;
    }
    case "selectvalues": {
      let current = input;
      const fieldsNode = child(raw, "fields") ?? raw;
      const select = listStrings(fieldsNode, "field");
      if (select.length > 0 && boolAt(fieldsNode, "select_unspecified") !== true) {
        current = `${current}.select([${select.map((name) => `F.col(${py(name)})`).join(", ")}])`;
      }
      for (const meta of children(fieldsNode, "meta")) {
        const name = stringAt(meta, "name");
        if (!name) continue;
        const rename = stringAt(meta, "rename");
        if (rename && rename !== name) {
          current = `${current}.withColumnRenamed(${py(name)}, ${py(rename)})`;
        }
        const type = stringAt(meta, "type");
        if (type) {
          current = `${current}.withColumn(${py(rename || name)}, F.col(${py(rename || name)}).cast(${py(fieldType(type))}))`;
        }
      }
      for (const remove of children(fieldsNode, "remove")) {
        const name = stringAt(remove, "name");
        if (name) current = `${current}.drop(${py(name)})`;
      }
      lines.push(`${target} = ${current}`);
      break;
    }
    case "mergejoin": {
      const step1 = stringAt(raw, "step1") ?? "";
      const step2 = stringAt(raw, "step2") ?? "";
      const left = upstreamVar(step1, varByStep, warnings, `MergeJoin "${step.name}"`);
      const right = upstreamVar(step2, varByStep, warnings, `MergeJoin "${step.name}"`);
      const keys1 = listStrings(child(raw, "keys_1"), "key");
      const keys2 = listStrings(child(raw, "keys_2"), "key");
      const howRaw = (stringAt(raw, "join_type") ?? "INNER").toUpperCase();
      const how = howRaw.includes("FULL")
        ? "full_outer"
        : howRaw.includes("LEFT")
          ? "left_outer"
          : howRaw.includes("RIGHT")
            ? "right_outer"
            : "inner";
      if (keys1.length === 0 || keys1.length !== keys2.length) {
        warnings.push(`MergeJoin "${step.name}" has mismatched join keys.`);
      }
      if (keys1.length === keys2.length && keys1.every((key, index) => key === keys2[index])) {
        lines.push(`${target} = ${left}.join(${right}, [${keys1.map(py).join(", ")}], ${py(how)})`);
      } else if (keys1.length > 0) {
        const condition = keys1
          .map((key, index) => `${left}[${py(key)}] == ${right}[${py(keys2[index] ?? key)}]`)
          .join(" & ");
        lines.push(`${target} = ${left}.join(${right}, ${condition}, ${py(how)})`);
        for (const key of keys2) lines.push(`${target} = ${target}.drop(${right}[${py(key)}])`);
      } else {
        lines.push(`${target} = ${left}.crossJoin(${right})`);
        warnings.push(`MergeJoin "${step.name}" has no keys; generated a cross join.`);
      }
      break;
    }
    case "streamlookup": {
      const from = stringAt(raw, "from") ?? "";
      const right = upstreamVar(from, varByStep, warnings, `StreamLookup "${step.name}"`);
      const lookup = child(raw, "lookup");
      const keys = children(lookup, "key");
      const keyPairs = keys.map((key) => ({
        name: stringAt(key, "name") ?? "",
        field: stringAt(key, "field") ?? stringAt(key, "name") ?? "",
      }));
      const values = children(lookup, "value").map((value) => ({
        name: stringAt(value, "name") ?? "",
        rename: stringAt(value, "rename") ?? stringAt(value, "name") ?? "",
        defaultValue: stringAt(value, "default") ?? "",
      }));
      const condition = keyPairs
        .map((key) => `${input}[${py(key.name)}] == ${right}[${py(key.field)}]`)
        .join(" & ");
      lines.push(`${target} = ${input}.join(${right}, ${condition || "F.lit(True)"}, "left")`);
      for (const key of keyPairs) {
        if (key.name !== key.field) {
          lines.push(`${target} = ${target}.drop(${right}[${py(key.field)}])`);
        }
      }
      for (const value of values) {
        if (!value.name) continue;
        const source = `${target}[${py(value.name)}]`;
        if (value.defaultValue) {
          lines.push(
            `${target} = ${target}.withColumn(${py(value.rename || value.name)}, F.coalesce(${source}, F.lit(${py(value.defaultValue)})))`,
          );
        } else if (value.rename && value.rename !== value.name) {
          lines.push(
            `${target} = ${target}.withColumnRenamed(${py(value.name)}, ${py(value.rename)})`,
          );
        }
      }
      break;
    }
    case "dblookup": {
      const connection = step.connection;
      const table = stringAt(raw, "table") ?? "";
      const lookup = child(raw, "lookup");
      const keys = children(lookup, "key");
      const values = children(lookup, "value");
      if (!connection || !table) {
        warnings.push(
          `DatabaseLookup "${step.name}" has no connection or table; generated a pass-through.`,
        );
        lines.push(`${target} = ${input}`);
        break;
      }
      const lookupVar = `${target}_lookup`;
      lines.push(
        `${lookupVar} = read_jdbc(${py(`SELECT * FROM ${table}`)}, ${py(connectionSlug(connection))})`,
      );
      const condition = keys
        .map((key) => {
          const left = stringAt(key, "field") ?? stringAt(key, "name") ?? "";
          const right = stringAt(key, "name") ?? left;
          return `${input}[${py(left)}] == ${lookupVar}[${py(right)}]`;
        })
        .join(" & ");
      lines.push(`${target} = ${input}.join(${lookupVar}, ${condition || "F.lit(True)"}, "left")`);
      for (const value of values) {
        const name = stringAt(value, "name") ?? "";
        const rename = stringAt(value, "rename") ?? name;
        const defaultValue = stringAt(value, "default");
        if (!name) continue;
        if (defaultValue) {
          lines.push(
            `${target} = ${target}.withColumn(${py(rename)}, F.coalesce(${target}[${py(name)}], F.lit(${py(defaultValue)})))`,
          );
        } else if (rename !== name) {
          lines.push(`${target} = ${target}.withColumnRenamed(${py(name)}, ${py(rename)})`);
        }
      }
      lines.push(
        `# TODO (partial): review DatabaseLookup "${step.name}" caching and case sensitivity.`,
      );
      break;
    }
    case "valuemapper": {
      const field = stringAt(raw, "field_to_use") ?? "";
      const targetField = stringAt(raw, "target_field") ?? field;
      const mappings = children(child(raw, "fields"), "field");
      let expression = stringAt(raw, "non_match_default")
        ? `F.lit(${py(stringAt(raw, "non_match_default"))})`
        : "F.lit(None)";
      for (const mapping of [...mappings].reverse()) {
        const source = stringAt(mapping, "source_value") ?? "";
        const value = stringAt(mapping, "target_value") ?? "";
        const condition =
          source === ""
            ? `F.col(${py(field)}).isNull()`
            : `F.col(${py(field)}).cast("string") == ${py(source)}`;
        expression = `F.when(${condition}, F.lit(${py(value)})).otherwise(${expression})`;
      }
      lines.push(`${target} = ${input}.withColumn(${py(targetField)}, ${expression})`);
      break;
    }
    case "switchcase": {
      const field = stringAt(raw, "fieldname") ?? "";
      const contains = boolAt(raw, "use_contains") ?? false;
      const cases = children(child(raw, "cases"), "case");
      const caseConditions: string[] = [];
      for (const [index, item] of cases.entries()) {
        const value = stringAt(item, "value") ?? "";
        const targetStep = stringAt(item, "target_step") ?? "";
        const condition = contains
          ? `F.col(${py(field)}).contains(${py(value)})`
          : `F.col(${py(field)}) == ${py(value)}`;
        caseConditions.push(condition);
        if (targetStep) {
          const routeVar = `${target}_route_${index}`;
          lines.push(`${routeVar} = ${input}.filter(${condition})`);
          route.set(targetStep, routeVar);
        }
      }
      const defaultTarget = stringAt(raw, "default_target_step") ?? "";
      if (defaultTarget) {
        const routeVar = `${target}_route_default`;
        const condition =
          caseConditions.length > 0
            ? `~(${caseConditions.map((item) => `(${item})`).join(" | ")})`
            : "F.lit(True)";
        lines.push(`${routeVar} = ${input}.filter(${condition})`);
        route.set(defaultTarget, routeVar);
      }
      lines.push(`${target} = ${input}`);
      break;
    }
    case "splitfieldtorows": {
      const field =
        stringAt(raw, "splitfield") ?? stringAt(raw, "fieldname") ?? stringAt(raw, "field") ?? "";
      const delimiter = stringAt(raw, "delimiter") ?? ",";
      const newField = stringAt(raw, "newfield") ?? "value";
      lines.push(
        `${target} = ${input}.withColumn(${py(newField)}, F.explode(F.split(F.col(${py(field)}), ${py(delimiter)})))`,
      );
      break;
    }
    case "sequence":
    case "addsequence": {
      const name = stringAt(raw, "valuename") ?? "sequence";
      const start = pyNumber(stringAt(raw, "start_at"), "1");
      const increment = pyNumber(stringAt(raw, "increment_by"), "1");
      lines.push(
        `${target} = ${input}.withColumn(${py(name)}, ((F.row_number().over(Window.orderBy(F.monotonically_increasing_id())) - 1) * ${increment} + ${start}).cast("long"))`,
      );
      break;
    }
    case "rownormaliser": {
      const typeField = stringAt(raw, "typefield") ?? "type";
      const fieldName = stringAt(raw, "fieldname") ?? "field";
      const keyField = stringAt(raw, "keyfield") ?? "key";
      const values = listStrings(child(raw, "keyvalue"), "keyvalue", "name");
      if (values.length === 0) {
        warnings.push(`RowNormaliser "${step.name}" has no key/value definitions.`);
        lines.push(`${target} = ${input}`);
      } else {
        const expressions = values
          .map(
            (value) =>
              `F.struct(F.lit(${py(value)}).alias(${py(typeField)}), F.col(${py(value)}).alias(${py(fieldName)}))`,
          )
          .join(", ");
        lines.push(
          `${target} = ${input}.select(F.col("*"), F.explode(F.array(${expressions})).alias(${py(keyField)}))`,
        );
        lines.push(
          `${target} = ${target}.select("*", F.col(${py(keyField)})[${py(typeField)}].alias(${py(typeField)}), F.col(${py(keyField)})[${py(fieldName)}].alias(${py(fieldName)})).drop(${py(keyField)})`,
        );
      }
      break;
    }
    case "denormaliser": {
      const groupNames = listStrings(child(raw, "group"), "field", "name");
      const keyField = stringAt(raw, "key_field") ?? "";
      const targetFields = children(child(raw, "fields"), "field");
      const resultField = stringAt(raw, "resultfield") ?? "value";
      if (!keyField || targetFields.length === 0) {
        warnings.push(
          `RowDenormaliser "${step.name}" is missing its key field; generated a pass-through.`,
        );
        lines.push(`${target} = ${input}`);
        break;
      }
      const aggregations = targetFields
        .map((field) => {
          const name = stringAt(field, "name") ?? "";
          if (!name) return "";
          return `F.max(F.when(F.col(${py(keyField)}) == ${py(name)}, F.col(${py(resultField)}))).alias(${py(name)})`;
        })
        .filter(Boolean)
        .join(", ");
      lines.push(
        `${target} = ${input}.groupBy(${groupNames.map((name) => `F.col(${py(name)})`).join(", ") || "F.lit(1)"}).agg(${aggregations || "F.count('*').alias('count')"})`,
      );
      lines.push(
        `# TODO (partial): verify the RowDenormaliser "${step.name}" key field and aggregation.`,
      );
      break;
    }
    case "splitfields": {
      const field = stringAt(raw, "fieldname") ?? stringAt(raw, "field") ?? "";
      const delimiter = stringAt(raw, "delimiter") ?? ",";
      const newFields = listStrings(child(raw, "fields"), "field");
      if (newFields.length === 0) {
        warnings.push(`SplitFields "${step.name}" has no output fields.`);
        lines.push(`${target} = ${input}`);
      } else {
        lines.push(`${target} = ${input}`);
        for (const [index, name] of newFields.entries()) {
          lines.push(
            `${target} = ${target}.withColumn(${py(name)}, F.split(F.col(${py(field)}), ${py(delimiter)})[${index}])`,
          );
        }
      }
      break;
    }
    case "concatfields": {
      const field = stringAt(raw, "targetfield") ?? stringAt(raw, "fieldname") ?? "concat";
      const separator = stringAt(raw, "separator") ?? "";
      const sourceFields = listStrings(child(raw, "fields"), "field");
      lines.push(
        `${target} = ${input}.withColumn(${py(field)}, F.concat_ws(${py(separator)}, ${sourceFields.map((name) => `F.col(${py(name)})`).join(", ") || "F.lit('')"}))`,
      );
      break;
    }
    case "ifnull": {
      const field = stringAt(raw, "fieldname") ?? stringAt(raw, "field") ?? "";
      const replacement = stringAt(raw, "replacevalue") ?? stringAt(raw, "value") ?? "";
      lines.push(
        `${target} = ${input}.withColumn(${py(field)}, F.coalesce(F.col(${py(field)}), F.lit(${py(replacement)})))`,
      );
      break;
    }
    case "replacestring": {
      const field = stringAt(raw, "fieldname") ?? stringAt(raw, "field") ?? "";
      const search = stringAt(raw, "search") ?? stringAt(raw, "string_to_replace") ?? "";
      const replace = stringAt(raw, "replace") ?? stringAt(raw, "replace_with") ?? "";
      lines.push(
        `${target} = ${input}.withColumn(${py(field)}, F.regexp_replace(F.col(${py(field)}), ${py(search)}, ${py(replace)}))`,
      );
      break;
    }
    case "sql": {
      const sql = stringAt(raw, "sql") ?? "";
      const connection = step.connection;
      if (connection) {
        lines.push(
          `${target} = read_jdbc(pdi_value(${py(sql)}), ${py(connectionSlug(connection))})`,
        );
      } else {
        lines.push(`${target} = spark.sql(pdi_value(${py(sql)}))`);
      }
      break;
    }
    case "tableoutput": {
      const connection = step.connection;
      if (!connection) {
        warnings.push(`TableOutput "${step.name}" has no connection.`);
        lines.push(`raise ValueError(${py(`TableOutput ${step.name} has no connection`)})`);
        return lines;
      }
      const table = stringAt(raw, "table") ?? "";
      const truncate = boolAt(raw, "truncate") ?? false;
      lines.push(
        `write_jdbc(${input}, ${py(table)}, ${py(connectionSlug(connection))}, ${truncate ? "True" : "False"})`,
      );
      lines.push(`${target} = ${input}`);
      break;
    }
    case "insertupdate":
    case "update":
    case "delete": {
      const connection = step.connection;
      const table = stringAt(raw, "table") ?? stringAt(raw, "table_name") ?? "";
      if (!connection || !table) {
        warnings.push(
          `${step.type} "${step.name}" has no connection or table; generated a pass-through.`,
        );
        lines.push(`${target} = ${input}`);
        break;
      }
      const staging = `${table}__staging`;
      lines.push(`write_jdbc(${input}, ${py(staging)}, ${py(connectionSlug(connection))}, True)`);
      lines.push(
        `# TODO (partial): run a MERGE or UPDATE/DELETE from ${staging} into ${table} after reviewing keys.`,
      );
      lines.push(`${target} = ${input}`);
      break;
    }
    case "dimensionlookup": {
      lines.push(`# TODO (partial): ${step.type} "${step.name}" needs SCD2 bookkeeping.`);
      lines.push(
        "# The template below is a starting point; add the business key and version columns.",
      );
      lines.push(`${target} = ${input}`);
      break;
    }
    case "textfileoutput": {
      const file = stringAt(child(raw, "file"), "name") ?? stringAt(raw, "filename") ?? "";
      const separator = stringAt(raw, "separator") ?? ",";
      const header = boolAt(raw, "header") ?? false;
      const enclosure = stringAt(raw, "enclosure") ?? '"';
      const path = `pdi_path(${py(file)}, "OUTPUT_BASE_PATH")`;
      lines.push(
        `write_csv(${input}, ${path}, ${py(separator.slice(0, 1))}, ${header ? "True" : "False"}, ${py(enclosure)})`,
      );
      lines.push(`${target} = ${input}`);
      break;
    }
    case "jsonoutput": {
      const file = stringAt(child(raw, "file"), "name") ?? stringAt(raw, "filename") ?? "";
      const path = `pdi_path(${py(file)}, "OUTPUT_BASE_PATH")`;
      lines.push(`write_json(${input}, ${path})`);
      lines.push(`${target} = ${input}`);
      break;
    }
    case "exceloutput": {
      context.needsExcel.value = true;
      const file = stringAt(child(raw, "file"), "name") ?? stringAt(raw, "filename") ?? "";
      const path = `pdi_path(${py(file)}, "OUTPUT_BASE_PATH")`;
      lines.push(`write_excel(${input}, ${path})`);
      lines.push(`${target} = ${input}`);
      break;
    }
    default:
      lines.push(...manualStub(step, inputJoined, target));
      break;
  }
  if (sink) {
    lines.push(`# ${step.name} is a sink; downstream hops reuse its input.`);
  }
  return lines;
}

function scriptPreamble(pathMappings: PathMapping[]): string[] {
  const mappings = pathMappings
    .map(
      (mapping) =>
        [
          mapping.from.replaceAll("\\", "/").trim().replace(/\/+$/g, ""),
          mapping.to.replaceAll("\\", "/").trim().replace(/\/+$/g, ""),
        ] as const,
    )
    .filter(([from, to]) => from !== "" && to !== "")
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  return [
    "# Generated by pentaho-to-aws. Review the migration report before deploying.",
    "import json",
    "import os",
    "import posixpath",
    "import re",
    "import sys",
    "from pyspark.context import SparkContext",
    "from pyspark.sql import Window, functions as F, types as T",
    "from pyspark.sql.types import StructField, StructType",
    "from awsglue.context import GlueContext",
    "from awsglue.job import Job",
    "",
    "ARGS = {}",
    "_argv = sys.argv[1:]",
    "for _index, _arg in enumerate(_argv):",
    "    if _arg.startswith('--') and _index + 1 < len(_argv):",
    "        ARGS[_arg[2:]] = _argv[_index + 1]",
    "",
    "JOB_NAME = ARGS.get('JOB_NAME', 'pentaho-job')",
    `PATH_MAPPINGS = ${JSON.stringify(mappings)}`,
    "sc = SparkContext.getOrCreate()",
    "glueContext = GlueContext(sc)",
    "spark = glueContext.spark_session",
    "logger = glueContext.get_logger()",
    "job = Job(glueContext)",
    "job.init(JOB_NAME, ARGS)",
    "",
    "def pdi_value(value):",
    "    if value is None:",
    "        return ''",
    "    def replace(match):",
    "        key = match.group(1) or match.group(2)",
    "        return str(ARGS.get(key, os.environ.get(key, match.group(0))))",
    "    return re.sub(r'\\$\\{([^{}]+)\\}|%%([^%]+)%%', replace, str(value))",
    "",
    "def pdi_path(value, base_key):",
    "    raw = pdi_value(value)",
    "    had_internal = bool(re.match(r'^\\$\\{Internal\\.', raw))",
    "    text = raw.replace('\\\\', '/')",
    "    text = re.sub(r'^\\$\\{Internal\\.(?:Transformation|Job)\\.Filename\\.Directory\\}', '', text)",
    "    if text.startswith('s3://'):",
    "        return text",
    "    if text.startswith('file://'):",
    "        text = text[7:]",
    "    lowered = text.lower()",
    "    for prefix, target in PATH_MAPPINGS:",
    "        normalised = prefix.replace('\\\\', '/').rstrip('/')",
    "        if lowered == normalised.lower() or lowered.startswith(normalised.lower() + '/'):",
    "            rest = posixpath.normpath(text[len(prefix):].lstrip('/')).lstrip('/')",
    "            if rest == '.':",
    "                rest = ''",
    "            return pdi_value(target.rstrip('/') + (('/' + rest) if rest else ''))",
    "    is_local = bool(re.match(r'^[A-Za-z]:', text)) or text.startswith('/')",
    "    if had_internal:",
    "        text = posixpath.normpath('/' + text.lstrip('/')).lstrip('/')",
    "        is_local = False",
    "    base = ARGS.get('UNMAPPED_BASE_PATH') if is_local else ARGS.get(base_key)",
    "    base = base or ARGS.get('INPUT_BASE_PATH') or ARGS.get('OUTPUT_BASE_PATH') or ''",
    "    if not base:",
    "        raise ValueError('No base path configured for ' + str(value))",
    "    name = os.path.basename(text) if is_local else text.lstrip('/')",
    "    return base.rstrip('/') + '/' + name",
    "",
    "def schema_from(fields):",
    "    types = {'int': T.IntegerType(), 'double': T.DoubleType(), 'decimal(38,9)': T.DecimalType(38, 9), 'date': T.DateType(), 'timestamp': T.TimestampType(), 'boolean': T.BooleanType(), 'binary': T.BinaryType(), 'string': T.StringType()}",
    "    return StructType([StructField(name, types.get(kind, T.StringType()), True) for name, kind in fields])",
    "",
    "def read_csv(paths, sep, header, fields):",
    "    reader = spark.read.option('sep', sep or ',').option('header', 'true' if header else 'false')",
    "    if fields and not header:",
    "        reader = reader.schema(schema_from(fields))",
    "    frame = reader.csv(paths)",
    "    if fields and header:",
    "        for name, kind in fields:",
    "            if name in frame.columns:",
    "                frame = frame.withColumn(name, F.col(name).cast(T.StringType() if kind == 'string' else schema_from([(name, kind)]).fields[0].dataType))",
    "    return frame",
    "",
    "def read_excel(path, sheet):",
    "    import pandas as pd",
    "    local = download_to_local(path)",
    "    frame = pd.read_excel(local, sheet_name=sheet or 0)",
    "    return spark.createDataFrame(frame)",
    "",
    "def download_to_local(path):",
    "    if not path.startswith('s3://'):",
    "        return path",
    "    import boto3",
    "    bucket, key = path[5:].split('/', 1)",
    "    local = '/tmp/' + os.path.basename(key)",
    "    boto3.client('s3').download_file(bucket, key, local)",
    "    return local",
    "",
    "def jdbc_options(slug):",
    "    import boto3",
    "    secret_arn = ARGS.get('CONNECTION_' + slug + '_SECRET_ARN')",
    "    url = ARGS.get('CONNECTION_' + slug + '_URL')",
    "    if not secret_arn or not url:",
    "        raise ValueError('Missing Glue JDBC arguments for connection ' + slug)",
    "    secret = json.loads(boto3.client('secretsmanager', region_name=ARGS.get('AWS_REGION', os.environ.get('AWS_REGION', 'us-east-1'))).get_secret_value(SecretId=secret_arn)['SecretString'])",
    "    options = {'url': url, 'user': secret.get('username', ''), 'password': secret.get('password', '')}",
    "    driver = ARGS.get('CONNECTION_' + slug + '_DRIVER')",
    "    if driver:",
    "        options['driver'] = driver",
    "    return options",
    "",
    "def read_jdbc(sql, slug):",
    "    query = pdi_value(sql).strip().rstrip(';')",
    "    return spark.read.format('jdbc').options(**jdbc_options(slug), dbtable='(' + query + ') AS pentaho_input').load()",
    "",
    "def write_jdbc(frame, table, slug, truncate):",
    "    writer = frame.write.format('jdbc').options(**jdbc_options(slug))",
    "    if truncate:",
    "        writer = writer.mode('overwrite').option('truncate', 'true')",
    "    else:",
    "        writer = writer.mode('append')",
    "    writer.option('dbtable', table).save()",
    "",
    "def write_csv(frame, path, sep, header, quote):",
    "    frame.coalesce(1).write.mode('overwrite').option('sep', sep or ',').option('header', 'true' if header else 'false').option('quote', quote).csv(path)",
    "",
    "def write_json(frame, path):",
    "    frame.coalesce(1).write.mode('overwrite').json(path)",
    "",
    "def write_excel(frame, path):",
    "    import pandas as pd",
    "    local = '/tmp/' + os.path.basename(path)",
    "    frame.toPandas().to_excel(local, index=False)",
    "    if path.startswith('s3://'):",
    "        import boto3",
    "        bucket, key = path[5:].split('/', 1)",
    "        boto3.client('s3').upload_file(local, bucket, key)",
    "",
    "try:",
  ];
}

function stepVariable(step: TransformationStep): string {
  const hash = Math.abs(
    [...step.name].reduce((value, char) => (value * 31 + char.charCodeAt(0)) | 0, 0),
  ).toString(36);
  return `df_${step.name.replace(/[^A-Za-z0-9_]/g, "_")}_${hash}`;
}

function lastAssignment(lines: string[]): string | undefined {
  for (const line of [...lines].reverse()) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function overrideFor(
  step: TransformationStep,
  transformation: Transformation,
  overrides: Record<string, string>,
): string | undefined {
  const keys = [
    `${transformation.file}#${step.name}`,
    `${transformation.name}#${step.name}`,
    step.name,
  ];
  for (const key of keys) {
    const value = overrides[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function graphOrder(transformation: Transformation, warnings: string[]): string[] {
  const { steps, hops } = transformation;
  const byName = new Map(steps.map((step) => [step.name, step]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const step of steps) {
    incoming.set(step.name, []);
    outgoing.set(step.name, []);
  }
  for (const hop of hops) {
    if (!hop.enabled) continue;
    if (!byName.has(hop.from) || !byName.has(hop.to)) {
      warnings.push(`Hop ${hop.from} -> ${hop.to} references a missing step.`);
      continue;
    }
    incoming.get(hop.to)?.push(hop.from);
    outgoing.get(hop.from)?.push(hop.to);
  }
  const inDegree = new Map([...incoming].map(([name, sources]) => [name, sources.length]));
  const queue = steps
    .filter((step) => (inDegree.get(step.name) ?? 0) === 0)
    .map((step) => step.name);
  const order: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name) continue;
    order.push(name);
    for (const next of outgoing.get(name) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== steps.length) {
    warnings.push(
      "The transformation graph contains a cycle; steps in the cycle are generated in file order.",
    );
    for (const step of steps) if (!order.includes(step.name)) order.push(step.name);
  }
  return order;
}

export function generateGlueScript(
  transformation: Transformation,
  options: GlueGenerationOptions = {},
): GlueScriptResult {
  const warnings: string[] = [];
  const automaticSteps: string[] = [];
  const partialSteps: string[] = [];
  const manualSteps: string[] = [];
  const overriddenSteps: string[] = [];
  const connections = new Set<string>();
  const needsExcel = { value: false };
  const overrides = options.stepOverrides ?? {};
  const steps = transformation.steps;
  const byName = new Map(steps.map((step) => [step.name, step]));
  const incoming = new Map<string, string[]>();
  for (const step of steps) incoming.set(step.name, []);
  for (const hop of transformation.hops) {
    if (!hop.enabled) continue;
    if (!byName.has(hop.from) || !byName.has(hop.to)) continue;
    incoming.get(hop.to)?.push(hop.from);
  }
  const order = graphOrder(transformation, warnings);
  const varByStep = new Map<string, string>();
  const route = new Map<string, string>();
  const body: string[] = [];

  for (const name of order) {
    const step = byName.get(name);
    if (!step) continue;
    const mapping = stepMapping(step.type);
    if (mapping.status === "automatic") automaticSteps.push(step.type);
    else if (mapping.status === "partial") partialSteps.push(step.type);
    else manualSteps.push(step.type);
    if (step.connection) connections.add(step.connection);

    const upstream = (incoming.get(name) ?? []).map(
      (source) => route.get(source) ?? varByStep.get(source) ?? "spark.range(0).drop('id')",
    );
    const target = stepVariable(step);
    body.push(`# Step: ${step.name} (${step.type})`);
    const override = overrideFor(step, transformation, overrides);
    if (override !== undefined) {
      const code = override
        .replace(/\r\n/g, "\n")
        .replace(/^\n+|\n+$/g, "")
        .split("\n");
      if (code.join("").trim() === "") {
        warnings.push(`The step override for "${step.name}" is empty and was ignored.`);
      } else {
        overriddenSteps.push(step.name);
        body.push(
          `# Model-written override for step "${step.name}" (${step.type}); review required.`,
        );
        body.push(...code);
        const assigned = lastAssignment(code);
        if (!assigned) {
          body.push(`${target} = ${upstream[0] ?? "spark.range(0).drop('id')"}`);
        }
        varByStep.set(name, assigned ?? target);
        continue;
      }
    }

    const lines = convertStep({
      step,
      upstream,
      varByStep,
      warnings,
      route,
      needsExcel,
      target,
    });
    body.push(...lines);
    const assigned = lastAssignment(lines);
    const stepVar = assigned ?? target;
    if (!assigned) {
      body.push(`${stepVar} = ${upstream[0] ?? "spark.range(0).drop('id')"}`);
    }
    varByStep.set(name, stepVar);
    const isSink = ["tableoutput", "textfileoutput", "jsonoutput", "exceloutput"].includes(
      step.type.toLowerCase(),
    );
    const downstream = (transformation.hops ?? []).filter(
      (hop) => hop.enabled && hop.from === name,
    );
    if (isSink && downstream.length === 0) {
      body.push(`logger.info(${py(`Completed ${step.name}`)})`);
    }
    if (downstream.length === 0 && !isSink) {
      body.push(`write_json(${stepVar}, pdi_path(${py(`${step.name}.json`)}, "OUTPUT_BASE_PATH"))`);
    }
  }
  if (order.length === 0) warnings.push("The transformation has no steps.");

  const imports = scriptPreamble(options.pathMappings ?? []);
  const bodyText = body.length > 0 ? body.join("\n") : "    pass";
  const suffix = [
    "    job.commit()",
    "except Exception:",
    "    logger.exception('Pentaho migration job failed')",
    "    raise",
    "",
  ];
  const code = [...imports, ...bodyText.split("\n").map((line) => `    ${line}`), ...suffix].join(
    "\n",
  );
  return {
    code: `${code}\n`,
    warnings,
    automaticSteps: [...new Set(automaticSteps)].sort(),
    partialSteps: [...new Set(partialSteps)].sort(),
    manualSteps: [...new Set(manualSteps)].sort(),
    connections: [...connections].sort(),
    needsExcel: needsExcel.value,
    overriddenSteps: [...new Set(overriddenSteps)].sort(),
  };
}

export function scriptConnectionArguments(connection: { name: string; type: string }): {
  slug: string;
  driver: string;
} {
  return { slug: connectionSlug(connection.name), driver: driverClass(connection.type) };
}

export function transformationExcelNeeded(transformation: Transformation): boolean {
  return transformation.steps.some((step) =>
    ["excelinput", "exceloutput"].includes(step.type.toLowerCase()),
  );
}
