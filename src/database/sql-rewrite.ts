import type { ConversionStatus } from "../convert/step-mapping.js";
import type { SourceEngine } from "./types.js";

export interface ViewRewrite {
  sql: string;
  status: ConversionStatus;
  applied: string[];
  manualFeatures: string[];
}

interface LiteralSegment {
  text: string;
  literal: boolean;
}

function splitLiterals(sql: string): LiteralSegment[] {
  const segments: LiteralSegment[] = [];
  let buffer = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (buffer !== "") {
        segments.push({ text: buffer, literal: false });
        buffer = "";
      }
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      segments.push({ text: sql.slice(i, j), literal: true });
      i = j;
    } else {
      buffer += sql[i];
      i++;
    }
  }
  if (buffer !== "") segments.push({ text: buffer, literal: false });
  return segments;
}

function skipSingleQuoted(sql: string, i: number): number {
  for (let j = i + 1; j < sql.length; j++) {
    if (sql[j] === "'") {
      if (sql[j + 1] === "'") {
        j++;
        continue;
      }
      return j + 1;
    }
  }
  return sql.length;
}

/**
 * Replaces the first `name(...)` call with `build(argument)`; the argument is
 * the balanced parenthesized text. Returns the input unchanged when the call
 * is not found or its parentheses never close.
 */
export function rewriteCall(sql: string, name: string, build: (arg: string) => string): string {
  const open = sql.search(new RegExp(`\\b${name}\\s*\\(`, "i"));
  if (open < 0) return sql;
  const parenStart = open + sql.slice(open).indexOf("(");
  let depth = 0;
  for (let i = parenStart; i < sql.length; i++) {
    if (sql[i] === "'") {
      i = skipSingleQuoted(sql, i) - 1;
      continue;
    }
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) {
        const arg = sql.slice(parenStart + 1, i).trim();
        return sql.slice(0, open) + build(arg) + sql.slice(i + 1);
      }
    }
  }
  return sql;
}

type Replacement =
  | { label: string; from: RegExp; to: string }
  | { label: string; call: { name: string; build: (arg: string) => string } };

function applyRegexOutsideLiterals(sql: string, from: RegExp, to: string): string {
  let changed = false;
  const result = splitLiterals(sql)
    .map((segment) => {
      if (segment.literal) return segment.text;
      const next = segment.text.replace(from, to);
      if (next !== segment.text) changed = true;
      return next;
    })
    .join("");
  return changed ? result : sql;
}

function applyCallOutsideLiterals(
  sql: string,
  name: string,
  build: (arg: string) => string,
): string {
  let changed = false;
  const result = splitLiterals(sql)
    .map((segment) => {
      if (segment.literal) return segment.text;
      let piece = segment.text;
      for (;;) {
        const rewritten = rewriteCall(piece, name, build);
        if (rewritten === piece) break;
        piece = rewritten;
      }
      if (piece !== segment.text) changed = true;
      return piece;
    })
    .join("");
  return changed ? result : sql;
}

function applyReplacement(sql: string, replacement: Replacement): string {
  if ("call" in replacement) {
    return applyCallOutsideLiterals(sql, replacement.call.name, replacement.call.build);
  }
  return applyRegexOutsideLiterals(sql, replacement.from, replacement.to);
}

const ORACLE_REPLACEMENTS: Replacement[] = [
  { label: "NVL", from: /\bNVL\s*\(/gi, to: "COALESCE(" },
  { label: "SYSDATE", from: /\bSYSDATE\b/gi, to: "LOCALTIMESTAMP(0)" },
  { label: "SYSTIMESTAMP", from: /\bSYSTIMESTAMP\b/gi, to: "CURRENT_TIMESTAMP" },
  { label: "DUAL", from: /\s+FROM\s+DUAL\b/gi, to: "" },
  { label: "MINUS", from: /\bMINUS\b/gi, to: "EXCEPT" },
];

const SQLSERVER_REPLACEMENTS: Replacement[] = [
  { label: "ISNULL", from: /\bISNULL\s*\(/gi, to: "COALESCE(" },
  { label: "GETDATE", from: /\bGETDATE\s*\(\s*\)/gi, to: "LOCALTIMESTAMP" },
  { label: "SYSDATETIME", from: /\bSYSDATETIME\s*\(\s*\)/gi, to: "LOCALTIMESTAMP" },
  { label: "GETUTCDATE", from: /\bGETUTCDATE\s*\(\s*\)/gi, to: "(now() AT TIME ZONE 'utc')" },
  { label: "LEN", from: /\bLEN\s*\(/gi, to: "LENGTH(" },
  { label: "NEWID", from: /\bNEWID\s*\(\s*\)/gi, to: "gen_random_uuid()" },
  { label: "brackets", from: /\[([^\]]+)\]/gi, to: '"$1"' },
  { label: "NOLOCK", from: /\s*WITH\s*\(\s*NOLOCK\s*\)/gi, to: "" },
];

const TERADATA_REPLACEMENTS: Replacement[] = [
  { label: "LOCKING", from: /\bLOCKING\s+ROW\s+FOR\s+ACCESS\b/gi, to: "" },
  { label: "SEL", from: /\bSEL\b/gi, to: "SELECT" },
  { label: "ZEROIFNULL", call: { name: "ZEROIFNULL", build: (arg) => `COALESCE(${arg}, 0)` } },
  { label: "NULLIFZERO", call: { name: "NULLIFZERO", build: (arg) => `NULLIF(${arg}, 0)` } },
  { label: "CHARACTERS", from: /\bCHARACTERS\s*\(/gi, to: "LENGTH(" },
];

const NETEZZA_REPLACEMENTS: Replacement[] = [
  { label: "NOW", from: /\bNOW\s*\(\s*\)/gi, to: "GETDATE()" },
  { label: "ISNULL", from: /\bISNULL\s*\(/gi, to: "NVL(" },
];

const HIVE_REPLACEMENTS: Replacement[] = [
  { label: "backticks", from: /`([^`]+)`/gi, to: '"$1"' },
  { label: "NVL", from: /\bNVL\s*\(/gi, to: "COALESCE(" },
  { label: "SIZE", from: /\bSIZE\s*\(/gi, to: "CARDINALITY(" },
];

const REPLACEMENTS: Partial<Record<SourceEngine, Replacement[]>> = {
  oracle: ORACLE_REPLACEMENTS,
  sqlserver: SQLSERVER_REPLACEMENTS,
  teradata: TERADATA_REPLACEMENTS,
  netezza: NETEZZA_REPLACEMENTS,
  hive: HIVE_REPLACEMENTS,
};

interface Flag {
  label: string;
  pattern: RegExp;
}

const FLAGS: Partial<Record<SourceEngine, Flag[]>> = {
  oracle: [
    { label: "DECODE", pattern: /\bDECODE\s*\(/i },
    { label: "Oracle outer join (+)", pattern: /\(\+\)/i },
    { label: "ROWNUM", pattern: /\bROWNUM\b/i },
    { label: "CONNECT BY", pattern: /\bCONNECT\s+BY\b/i },
    { label: "NVL2", pattern: /\bNVL2\s*\(/i },
    { label: "sequence pseudo-columns", pattern: /\.(NEXTVAL|CURRVAL)\b/i },
  ],
  sqlserver: [
    { label: "TOP", pattern: /\bTOP\s*\(?\s*\d+/i },
    { label: "DATEADD", pattern: /\bDATEADD\s*\(/i },
    { label: "DATEDIFF", pattern: /\bDATEDIFF\s*\(/i },
    { label: "CHARINDEX", pattern: /\bCHARINDEX\s*\(/i },
    { label: "CONVERT", pattern: /\bCONVERT\s*\(/i },
    { label: "APPLY", pattern: /\b(CROSS|OUTER)\s+APPLY\b/i },
  ],
  teradata: [
    { label: "QUALIFY", pattern: /\bQUALIFY\b/i },
    { label: "FORMAT phrase", pattern: /\bFORMAT\s+'/i },
    { label: "SAMPLE", pattern: /\bSAMPLE\b/i },
    { label: "CASESPECIFIC", pattern: /\bCASESPECIFIC\b/i },
  ],
  netezza: [{ label: "AGE", pattern: /\bAGE\s*\(/i }],
  hive: [
    { label: "LATERAL VIEW", pattern: /\bLATERAL\s+VIEW\b/i },
    { label: "collect_set/collect_list", pattern: /\bCOLLECT_(SET|LIST)\s*\(/i },
    { label: "INSTR", pattern: /\bINSTR\s*\(/i },
    { label: "RLIKE", pattern: /\bRLIKE\b/i },
    { label: "Hive distribution clauses", pattern: /\b(DISTRIBUTE|SORT|CLUSTER)\s+BY\b/i },
  ],
};

/**
 * Rewrites a view body for the target dialect. Replacements run in order and
 * only outside single-quoted literals; flags mark constructs that need manual
 * work and make the result status `manual`.
 */
export function rewriteViewSql(engine: SourceEngine, body: string): ViewRewrite {
  if (engine === "mysql" || engine === "postgresql") {
    return { sql: body, status: "automatic", applied: [], manualFeatures: [] };
  }
  let sql = body;
  const applied: string[] = [];
  for (const replacement of REPLACEMENTS[engine] ?? []) {
    const next = applyReplacement(sql, replacement);
    if (next !== sql) applied.push(replacement.label);
    sql = next;
  }
  sql = sql.trim();
  const manualFeatures = (FLAGS[engine] ?? [])
    .filter((flag) => flag.pattern.test(sql))
    .map((flag) => flag.label);
  const status: ConversionStatus = manualFeatures.length > 0 ? "manual" : "partial";
  return { sql, status, applied, manualFeatures };
}

const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;

function unwrapParens(expression: string): string {
  let expr = expression.trim();
  for (;;) {
    if (!expr.startsWith("(") || !expr.endsWith(")")) return expr;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")") {
        depth--;
        if (depth === 0 && i < expr.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) return expr;
    expr = expr.slice(1, -1).trim();
  }
}

/**
 * Translates a column DEFAULT expression for Aurora PostgreSQL (from oracle or
 * SQL Server) and Redshift DDL. Returns undefined when the expression cannot
 * be translated; the generated DDL then omits the default.
 */
export function translateDefault(
  engine: SourceEngine,
  expression: string,
  _targetType: string,
): string | undefined {
  const expr = unwrapParens(expression);
  if (NUMERIC_LITERAL.test(expr) || /^'[\s\S]*'$/.test(expr) || /^NULL$/i.test(expr)) {
    return expr;
  }
  switch (engine) {
    case "oracle":
      if (/^SYSDATE$/i.test(expr)) return "LOCALTIMESTAMP(0)";
      if (/^SYSTIMESTAMP$/i.test(expr)) return "CURRENT_TIMESTAMP";
      return undefined;
    case "sqlserver":
      if (/^GETDATE\s*\(\s*\)$/i.test(expr)) return "LOCALTIMESTAMP";
      if (/^SYSDATETIME\s*\(\s*\)$/i.test(expr)) return "LOCALTIMESTAMP";
      if (/^CURRENT_TIMESTAMP$/i.test(expr)) return "LOCALTIMESTAMP";
      if (/^GETUTCDATE\s*\(\s*\)$/i.test(expr)) return "(now() AT TIME ZONE 'utc')";
      if (/^SYSUTCDATETIME\s*\(\s*\)$/i.test(expr)) return "(now() AT TIME ZONE 'utc')";
      if (/^NEWID\s*\(\s*\)$/i.test(expr)) return "gen_random_uuid()";
      return undefined;
    case "teradata":
    case "netezza":
      if (/^CURRENT_DATE$/i.test(expr)) return "CURRENT_DATE";
      if (/^CURRENT_TIMESTAMP$/i.test(expr)) return "GETDATE()";
      if (/^NOW\s*\(\s*\)$/i.test(expr)) return "GETDATE()";
      return undefined;
    default:
      return undefined;
  }
}
