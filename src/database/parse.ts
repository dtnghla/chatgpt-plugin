import type { InputFile } from "../ingest/types.js";
import { IngestError } from "../ingest/types.js";
import { sha256 } from "../migration/package.js";
import { detectEngine } from "./detect.js";
import { ENGINE_LABELS } from "./labels.js";
import { splitStatements, stripComments } from "./split.js";
import type {
  ColumnDef,
  DatabaseFile,
  DatabaseProject,
  ForeignKey,
  IndexDef,
  ProceduralKind,
  ProceduralObject,
  SequenceDef,
  SourceEngine,
  SqlStatement,
  TableDef,
  ViewDef,
} from "./types.js";

const ACCEPTED_EXTENSIONS = new Set([
  ".sql",
  ".ddl",
  ".hql",
  ".btq",
  ".bteq",
  ".pks",
  ".pkb",
  ".pls",
]);

const FALLBACK_SCHEMAS: Record<SourceEngine, string> = {
  oracle: "public",
  sqlserver: "dbo",
  mysql: "public",
  postgresql: "public",
  teradata: "public",
  netezza: "public",
  hive: "default",
};

const DETECTION_ERROR =
  "Could not detect the source database engine from the uploaded files. Pass source_engine as one of oracle, sqlserver, mysql, postgresql, teradata, netezza or hive.";
const EMPTY_ERROR =
  "No tables, views or procedural objects were found. Upload DDL exports such as .sql, .ddl, .hql or BTEQ scripts, or a ZIP of them.";

/** Removes passwords from CREATE USER / PASSWORD assignments and .LOGON lines. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(IDENTIFIED\s+BY|PASSWORD\s*=?)\s*('[^']*'|"[^"]*"|\S+)/gi, "$1 ***REDACTED***")
    .replace(/^\s*\.LOGON\b.*$/gim, ".LOGON ***REDACTED***");
}

interface Identifier {
  text: string;
  quoted: boolean;
  end: number;
}

const BARE_IDENT = /[A-Za-z_#@$][\w$#@]*/y;
const WORD = /[A-Za-z_][\w$#@]*/y;

function parseIdentifierAt(text: string, pos: number): Identifier | null {
  const ch = text[pos];
  if (ch === '"' || ch === "`") {
    for (let j = pos + 1; j < text.length; j++) {
      if (text[j] === ch) {
        if (text[j + 1] === ch) {
          j++;
          continue;
        }
        return { text: text.slice(pos + 1, j), quoted: true, end: j + 1 };
      }
    }
    return null;
  }
  if (ch === "[") {
    for (let j = pos + 1; j < text.length; j++) {
      if (text[j] === "]") {
        if (text[j + 1] === "]") {
          j++;
          continue;
        }
        return { text: text.slice(pos + 1, j), quoted: true, end: j + 1 };
      }
    }
    return null;
  }
  BARE_IDENT.lastIndex = pos;
  const match = BARE_IDENT.exec(text);
  if (!match) return null;
  return { text: match[0], quoted: false, end: pos + match[0].length };
}

function matchWordAt(text: string, pos: number): Identifier | null {
  WORD.lastIndex = pos;
  const match = WORD.exec(text);
  if (!match) return null;
  return { text: match[0], quoted: false, end: pos + match[0].length };
}

function wordAtIs(text: string, pos: number, expected: string): boolean {
  return matchWordAt(text, pos)?.text.toUpperCase() === expected;
}

interface NameChain {
  parts: Identifier[];
  end: number;
}

/** Parses a dotted identifier chain such as `db.schema.table` or `[dbo].[t]`. */
function parseNameChain(text: string, from: number): NameChain | null {
  const parts: Identifier[] = [];
  let pos = from;
  for (;;) {
    while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
    const part = parseIdentifierAt(text, pos);
    if (!part) break;
    parts.push(part);
    pos = part.end;
    let dot = pos;
    while (dot < text.length && /\s/.test(text.charAt(dot))) dot++;
    if (text[dot] === ".") {
      pos = dot + 1;
      continue;
    }
    break;
  }
  if (parts.length === 0) return null;
  return { parts, end: pos };
}

function foldIdent(
  part: { text: string; quoted: boolean } | undefined,
  engine: SourceEngine,
): string {
  if (!part) return "";
  if (part.quoted) return part.text;
  if (engine === "oracle") return part.text.toUpperCase();
  if (engine === "postgresql" || engine === "hive") return part.text.toLowerCase();
  return part.text;
}

function skipSpace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
  return pos;
}

/** Length of the quoted literal starting at i, or 0. */
function literalLengthAt(text: string, i: number): number {
  const ch = text[i];
  if (ch === "'" || ch === '"' || ch === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === ch) {
        if (text[j + 1] === ch) {
          j++;
          continue;
        }
        return j + 1 - i;
      }
    }
    return text.length - i;
  }
  if (ch === "[") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "]") {
        if (text[j + 1] === "]") {
          j++;
          continue;
        }
        return j + 1 - i;
      }
    }
    return text.length - i;
  }
  if (ch === "$") {
    const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
    if (open) {
      const tag = open[0];
      const close = text.indexOf(tag, i + tag.length);
      return close >= 0 ? close + tag.length - i : text.length - i;
    }
  }
  return 0;
}

function skipLiteral(text: string, i: number): number {
  const length = literalLengthAt(text, i);
  return length > 0 ? i + length : i;
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const lit = skipLiteral(text, i);
    if (lit > i) {
      i = lit;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

interface TopLevelMatch {
  index: number;
  length: number;
}

/** Finds a sticky-regex match at top-level paren depth, outside literals. */
function findTopLevel(text: string, from: number, regex: RegExp): TopLevelMatch | null {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const lit = skipLiteral(text, i);
    if (lit > i) {
      i = lit;
      continue;
    }
    const ch = text[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      regex.lastIndex = i;
      const match = regex.exec(text);
      if (match) return { index: i, length: match[0].length };
    }
    i++;
  }
  return null;
}

/** Locates the first top-level column list, or an AS SELECT / LIKE clause. */
function findTableBodyStart(
  text: string,
  from: number,
): { kind: "columns"; open: number; close: number } | { kind: "query" } | null {
  const asSelect = /\bAS\s*\(?\s*SELECT\b/y;
  const like = /\bLIKE\b/y;
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const lit = skipLiteral(text, i);
    if (lit > i) {
      i = lit;
      continue;
    }
    const ch = text[i];
    if (depth === 0) {
      if (ch === "(") {
        const close = matchParen(text, i);
        if (close < 0) return null;
        return { kind: "columns", open: i, close };
      }
      asSelect.lastIndex = i;
      if (asSelect.test(text)) return { kind: "query" };
      like.lastIndex = i;
      if (like.test(text)) return { kind: "query" };
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    i++;
  }
  return null;
}

function splitColumnList(list: string): string[] {
  const elements: string[] = [];
  let angle = 0;
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < list.length) {
    const lit = literalLengthAt(list, i);
    if (lit > 0) {
      current += list.slice(i, i + lit);
      i += lit;
      continue;
    }
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && depth === 0 && angle === 0) {
      elements.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim() !== "") elements.push(current.trim());
  return elements.filter((element) => element !== "");
}

const CONTINUATION_WORDS = new Set([
  "PRECISION",
  "VARYING",
  "RAW",
  "WITH",
  "WITHOUT",
  "LOCAL",
  "TIME",
  "ZONE",
  "TO",
  "MONTH",
  "SECOND",
  "YEAR",
  "DAY",
  "HOUR",
  "MINUTE",
  "LARGE",
  "OBJECT",
  "UNSIGNED",
  "ZEROFILL",
]);

/** Column type text: first word plus attached (…) or <…> plus continuation words. */
function parseTypeText(element: string, from: number): { text: string; end: number } | null {
  const first = matchWordAt(element, skipSpace(element, from));
  if (!first) return null;
  let text = first.text.toUpperCase();
  let pos = first.end;
  if (element[pos] === "(") {
    const close = matchParen(element, pos);
    if (close > 0) {
      text += element.slice(pos, close + 1);
      pos = close + 1;
    }
  } else if (element[pos] === "<") {
    let depth = 0;
    for (let i = pos; i < element.length; i++) {
      if (element[i] === "<") depth++;
      else if (element[i] === ">") {
        depth--;
        if (depth === 0) {
          text += element.slice(pos, i + 1).toUpperCase();
          pos = i + 1;
          break;
        }
      }
    }
  }
  for (;;) {
    const scan = skipSpace(element, pos);
    const word = matchWordAt(element, scan);
    if (!word || !CONTINUATION_WORDS.has(word.text.toUpperCase())) break;
    text += ` ${word.text.toUpperCase()}`;
    pos = word.end;
    if (element[pos] === "(") {
      const close = matchParen(element, pos);
      if (close > 0) {
        text += element.slice(pos, close + 1);
        pos = close + 1;
      }
    }
  }
  return { text, end: pos };
}

const DEFAULT_STOP =
  /\b(NOT|PRIMARY|UNIQUE|REFERENCES|IDENTITY|GENERATED|AUTO_INCREMENT|CHARACTER|COLLATE|FORMAT|TITLE|COMPRESS|COMMENT|ENCODE|CHECK|CONSTRAINT|ON)\b/y;

/** Attribute keywords that terminate a captured DEFAULT expression. */
const ATTRIBUTE_KEYWORDS = new Set([
  "NOT",
  "PRIMARY",
  "UNIQUE",
  "REFERENCES",
  "DEFAULT",
  "IDENTITY",
  "GENERATED",
  "AUTO_INCREMENT",
  "CHARACTER",
  "COLLATE",
  "FORMAT",
  "TITLE",
  "COMPRESS",
  "COMMENT",
  "ENCODE",
  "CHECK",
  "CONSTRAINT",
  "ON",
]);

interface ColumnAttributes {
  nullable: boolean;
  identity: boolean;
  charset?: string;
  caseInsensitive: boolean;
  defaultExpression?: string;
  inlinePrimaryKey?: string[];
  inlineUnique?: boolean;
  inlineForeignKey?: ForeignKey;
}

function captureDefault(attrs: string, from: number): { text: string; end: number } | null {
  let depth = 0;
  let i = from;
  let end = from;
  while (i < attrs.length) {
    const lit = literalLengthAt(attrs, i);
    if (lit > 0) {
      i += lit;
      end = i;
      continue;
    }
    const ch = attrs[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      DEFAULT_STOP.lastIndex = i;
      if (DEFAULT_STOP.test(attrs)) break;
    }
    i++;
    end = i;
  }
  const text = attrs.slice(from, end).trim();
  return text === "" ? null : { text, end };
}

function parseInlineList(text: string, open: number, engine: SourceEngine): string[] {
  const close = matchParen(text, open);
  if (close < 0) return [];
  return splitColumnList(text.slice(open + 1, close)).map((element) => {
    const chain = parseNameChain(element, 0);
    if (chain && chain.parts.length === 1 && chain.end === element.trimEnd().length) {
      return foldIdent(chain.parts[0], engine);
    }
    return element.trim();
  });
}

function parseColumnAttributes(
  attrs: string,
  engine: SourceEngine,
  columnName: string,
  tableSchema: string,
  start: number,
): ColumnAttributes {
  const result: ColumnAttributes = { nullable: true, identity: false, caseInsensitive: false };
  let i = start;
  while (i < attrs.length) {
    const lit = literalLengthAt(attrs, i);
    if (lit > 0) {
      i += lit;
      continue;
    }
    if (attrs[i] === "(") {
      const close = matchParen(attrs, i);
      i = close > 0 ? close + 1 : attrs.length;
      continue;
    }
    const word = matchWordAt(attrs, i);
    if (!word) {
      i++;
      continue;
    }
    const upper = word.text.toUpperCase();
    if (!ATTRIBUTE_KEYWORDS.has(upper)) {
      i = word.end;
      continue;
    }
    switch (upper) {
      case "NOT": {
        const scan = skipSpace(attrs, word.end);
        const next = matchWordAt(attrs, scan);
        if (next?.text.toUpperCase() === "NULL") {
          result.nullable = false;
          i = next.end;
        } else if (next?.text.toUpperCase() === "CASESPECIFIC") {
          result.caseInsensitive = true;
          i = next.end;
        } else {
          i = word.end;
        }
        break;
      }
      case "PRIMARY": {
        const scan = skipSpace(attrs, word.end);
        const next = matchWordAt(attrs, scan);
        if (next?.text.toUpperCase() === "KEY") {
          result.nullable = false;
          result.inlinePrimaryKey = [columnName];
          i = next.end;
          if (attrs[i] === "(") {
            const close = matchParen(attrs, i);
            if (close > 0) {
              result.inlinePrimaryKey = parseInlineList(attrs, i, engine);
              i = close + 1;
            }
          }
        } else {
          i = word.end;
        }
        break;
      }
      case "UNIQUE": {
        result.inlineUnique = true;
        i = word.end;
        break;
      }
      case "REFERENCES": {
        const scan = skipSpace(attrs, word.end);
        const chain = parseNameChain(attrs, scan);
        if (!chain) {
          i = word.end;
          break;
        }
        i = chain.end;
        const referenced: ForeignKey = {
          columns: [columnName],
          referencedSchema: "",
          referencedTable: "",
          referencedColumns: [],
        };
        if (chain.parts.length >= 2) {
          referenced.referencedSchema = foldIdent(chain.parts[chain.parts.length - 2], engine);
          referenced.referencedTable = foldIdent(chain.parts[chain.parts.length - 1], engine);
        } else {
          referenced.referencedSchema = tableSchema;
          referenced.referencedTable = foldIdent(chain.parts[0], engine);
        }
        const open = skipSpace(attrs, i);
        if (attrs[open] === "(") {
          referenced.referencedColumns = parseInlineList(attrs, open, engine);
          const close = matchParen(attrs, open);
          i = close > 0 ? close + 1 : attrs.length;
        }
        result.inlineForeignKey = referenced;
        break;
      }
      case "DEFAULT": {
        const captured = captureDefault(attrs, word.end);
        if (captured) {
          result.defaultExpression = captured.text;
          i = captured.end;
        } else {
          i = word.end;
        }
        break;
      }
      case "IDENTITY": {
        result.identity = true;
        i = word.end;
        if (attrs[i] === "(") {
          const close = matchParen(attrs, i);
          i = close > 0 ? close + 1 : attrs.length;
        }
        break;
      }
      case "GENERATED": {
        const asIdentity = findTopLevel(attrs, word.end, /\bAS\s+IDENTITY\b/y);
        if (asIdentity) {
          result.identity = true;
          let after = skipSpace(attrs, asIdentity.index + asIdentity.length);
          if (attrs[after] === "(") {
            const close = matchParen(attrs, after);
            after = close > 0 ? close + 1 : attrs.length;
          }
          i = after;
        } else {
          i = word.end;
        }
        break;
      }
      case "AUTO_INCREMENT": {
        result.identity = true;
        i = word.end;
        break;
      }
      case "CHARACTER": {
        const setScan = skipSpace(attrs, word.end);
        const set = matchWordAt(attrs, setScan);
        if (set?.text.toUpperCase() === "SET") {
          const charsetScan = skipSpace(attrs, set.end);
          const charset = matchWordAt(attrs, charsetScan);
          if (charset) {
            result.charset = charset.text.toUpperCase();
            i = charset.end;
            break;
          }
        }
        i = word.end;
        break;
      }
      case "FORMAT":
      case "TITLE":
      case "COMMENT": {
        const scan = skipSpace(attrs, word.end);
        const lit = literalLengthAt(attrs, scan);
        i = lit > 0 ? scan + lit : word.end;
        break;
      }
      case "COMPRESS": {
        const scan = skipSpace(attrs, word.end);
        const lit = literalLengthAt(attrs, scan);
        if (lit > 0) i = scan + lit;
        else if (attrs[scan] === "(") {
          const close = matchParen(attrs, scan);
          i = close > 0 ? close + 1 : word.end;
        } else i = word.end;
        break;
      }
      case "COLLATE":
      case "ENCODE": {
        const next = matchWordAt(attrs, skipSpace(attrs, word.end));
        i = next ? next.end : word.end;
        break;
      }
      case "CHECK": {
        const open = skipSpace(attrs, word.end);
        if (attrs[open] === "(") {
          const close = matchParen(attrs, open);
          i = close > 0 ? close + 1 : attrs.length;
        } else {
          i = word.end;
        }
        break;
      }
      case "CONSTRAINT": {
        const next = parseIdentifierAt(attrs, skipSpace(attrs, word.end));
        i = next ? next.end : word.end;
        break;
      }
      case "ON": {
        const next = matchWordAt(attrs, skipSpace(attrs, word.end));
        i = next ? next.end : word.end;
        break;
      }
      default: {
        i = word.end;
        break;
      }
    }
  }
  return result;
}

type ParsedElement =
  | {
      kind: "column";
      column: ColumnDef;
      inlinePrimaryKey?: string[];
      inlineUnique?: boolean;
      inlineForeignKey?: ForeignKey;
    }
  | { kind: "primary_key"; columns: string[] }
  | { kind: "unique"; columns: string[] }
  | { kind: "foreign_key"; columns: string[]; referenced: ForeignKey }
  | { kind: "check" }
  | { kind: "period" }
  | { kind: "index"; name: string | null; columns: string[]; unique: boolean; expression: boolean }
  | { kind: "unknown" };

function indexColumnsFromList(
  list: string,
  engine: SourceEngine,
): { columns: string[]; expression: boolean } {
  let expression = false;
  const columns: string[] = [];
  for (const element of splitColumnList(list)) {
    const chain = parseNameChain(element, 0);
    if (chain && chain.parts.length === 1 && chain.end === element.trimEnd().length) {
      columns.push(foldIdent(chain.parts[0], engine));
    } else {
      expression = true;
      columns.push(element.trim());
    }
  }
  return { columns, expression };
}

function referencedTableOf(
  chain: NameChain,
  engine: SourceEngine,
  tableSchema: string,
): ForeignKey {
  const referenced: ForeignKey = {
    columns: [],
    referencedSchema: "",
    referencedTable: "",
    referencedColumns: [],
  };
  if (chain.parts.length >= 2) {
    referenced.referencedSchema = foldIdent(chain.parts[chain.parts.length - 2], engine);
    referenced.referencedTable = foldIdent(chain.parts[chain.parts.length - 1], engine);
  } else {
    referenced.referencedSchema = tableSchema;
    referenced.referencedTable = foldIdent(chain.parts[0], engine);
  }
  return referenced;
}

function parseElement(element: string, engine: SourceEngine, tableSchema: string): ParsedElement {
  const trimmed = element.trim();
  let rest = trimmed;
  let indexUnique = false;
  const constraintHead = /^CONSTRAINT\b/y;
  constraintHead.lastIndex = 0;
  if (constraintHead.test(trimmed)) {
    const name = parseIdentifierAt(trimmed, skipSpace(trimmed, "CONSTRAINT".length));
    if (!name) return { kind: "unknown" };
    rest = trimmed.slice(name.end).trim();
  }
  if (/^PRIMARY\s+KEY\b/i.test(rest)) {
    const open = rest.indexOf("(");
    if (open < 0) return { kind: "unknown" };
    return { kind: "primary_key", columns: parseInlineList(rest, open, engine) };
  }
  const uniqueHead = /^UNIQUE\b/iy;
  uniqueHead.lastIndex = 0;
  if (uniqueHead.test(rest)) {
    let scan = skipSpace(rest, "UNIQUE".length);
    const next = matchWordAt(rest, scan);
    if (next && (next.text.toUpperCase() === "KEY" || next.text.toUpperCase() === "INDEX")) {
      indexUnique = true;
      scan = skipSpace(rest, next.end);
    }
    if (rest[scan] !== "(") return { kind: "unknown" };
    const open = scan;
    if (indexUnique) {
      const close = matchParen(rest, open);
      if (close < 0) return { kind: "unknown" };
      const parsed = indexColumnsFromList(rest.slice(open + 1, close), engine);
      return {
        kind: "index",
        name: null,
        columns: parsed.columns,
        unique: true,
        expression: parsed.expression,
      };
    }
    return { kind: "unique", columns: parseInlineList(rest, open, engine) };
  }
  if (/^FOREIGN\s+KEY\b/i.test(rest)) {
    const open = rest.indexOf("(");
    if (open < 0) return { kind: "unknown" };
    const close = matchParen(rest, open);
    if (close < 0) return { kind: "unknown" };
    const columns = parseInlineList(rest, open, engine);
    let scan = skipSpace(rest, close + 1);
    const referencesHead = /\bREFERENCES\b/iy;
    referencesHead.lastIndex = scan;
    if (!referencesHead.test(rest)) return { kind: "unknown" };
    scan = skipSpace(rest, referencesHead.lastIndex);
    const chain = parseNameChain(rest, scan);
    if (!chain) return { kind: "unknown" };
    const referenced = referencedTableOf(chain, engine, tableSchema);
    referenced.columns = columns;
    const after = skipSpace(rest, chain.end);
    if (rest[after] === "(") {
      referenced.referencedColumns = parseInlineList(rest, after, engine);
    }
    return { kind: "foreign_key", columns, referenced };
  }
  if (/^CHECK\b/i.test(rest)) {
    return { kind: "check" };
  }
  if (/^PERIOD\s+FOR\b/i.test(rest)) {
    return { kind: "period" };
  }
  const keyHead = /^(FULLTEXT\s+)?(KEY|INDEX)\b/iy;
  keyHead.lastIndex = 0;
  const keyMatch = keyHead.exec(rest);
  if (keyMatch) {
    let scan = skipSpace(rest, keyMatch[0].length);
    let name: string | null = null;
    const candidate = parseIdentifierAt(rest, scan);
    if (candidate) {
      const open = skipSpace(rest, candidate.end);
      if (rest[open] === "(") {
        name = candidate.text;
        scan = open;
      }
    }
    if (rest[scan] !== "(") return { kind: "unknown" };
    const close = matchParen(rest, scan);
    if (close < 0) return { kind: "unknown" };
    const parsed = indexColumnsFromList(rest.slice(scan + 1, close), engine);
    return {
      kind: "index",
      name,
      columns: parsed.columns,
      unique: indexUnique,
      expression: parsed.expression,
    };
  }
  // Column element: <ident> <type> <attributes>, or <ident> AS (expr) [PERSISTED].
  const name = parseIdentifierAt(trimmed, 0);
  if (!name) return { kind: "unknown" };
  const afterName = skipSpace(trimmed, name.end);
  if (/^AS\s*\(/iy.test(trimmed.slice(afterName))) {
    const open = trimmed.indexOf("(", afterName);
    const close = matchParen(trimmed, open);
    if (close < 0) return { kind: "unknown" };
    return {
      kind: "column",
      column: {
        name: foldIdent(name, engine),
        sourceType: "COMPUTED",
        nullable: true,
        identity: false,
        caseInsensitive: false,
        computed: trimmed.slice(open + 1, close).trim(),
      },
    };
  }
  const type = parseTypeText(trimmed, afterName);
  if (!type) return { kind: "unknown" };
  const attributes = parseColumnAttributes(
    trimmed,
    engine,
    foldIdent(name, engine),
    tableSchema,
    type.end,
  );
  const baseType = type.text.split(" ")[0];
  const column: ColumnDef = {
    name: foldIdent(name, engine),
    sourceType: type.text,
    nullable: attributes.nullable,
    identity:
      attributes.identity ||
      baseType === "SERIAL" ||
      baseType === "BIGSERIAL" ||
      baseType === "SMALLSERIAL",
    caseInsensitive: attributes.caseInsensitive,
  };
  if (attributes.charset !== undefined) column.charset = attributes.charset;
  if (attributes.defaultExpression !== undefined)
    column.defaultExpression = attributes.defaultExpression;
  const result: Extract<ParsedElement, { kind: "column" }> = { kind: "column", column };
  if (attributes.inlinePrimaryKey) result.inlinePrimaryKey = attributes.inlinePrimaryKey;
  if (attributes.inlineUnique) result.inlineUnique = true;
  if (attributes.inlineForeignKey) result.inlineForeignKey = attributes.inlineForeignKey;
  return result;
}

// --- Statement classification ------------------------------------------------

const CREATE_EXCLUSION_RE =
  /^CREATE\s+(TABLESPACE|DIRECTORY|CONTEXT|STATISTICS|CLUSTER|PROFILE|MATERIALIZED\s+VIEW\s+LOG|PARTITION\s+FUNCTION|PARTITION\s+SCHEME)\b/i;
const TEMP_TABLE_RE =
  /^CREATE\s+(OR\s+REPLACE\s+)?((SET|MULTISET)\s+)?(GLOBAL\s+TEMPORARY|TEMPORARY|TEMP|VOLATILE)\s+((SET|MULTISET)\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const TABLE_RE =
  /^CREATE\s+(OR\s+REPLACE\s+)?((MULTISET|SET|EXTERNAL|UNLOGGED|TRANSIENT)\s+)*TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const VIEW_RE =
  /^(CREATE\s+(OR\s+REPLACE\s+)?(OR\s+ALTER\s+)?((NO)?FORCE\s+|(NON)?EDITIONABLE\s+|MATERIALIZED\s+|RECURSIVE\s+)*|REPLACE\s+)VIEW\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const INDEX_RE =
  /^CREATE\s+(UNIQUE\s+)?((CLUSTERED|NONCLUSTERED|BITMAP|FULLTEXT|SPATIAL)\s+)*INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const SEQUENCE_RE = /^CREATE\s+SEQUENCE\s+(IF\s+NOT\s+EXISTS\s+)?/i;
const PROCEDURAL_RE =
  /^(CREATE\s+(OR\s+REPLACE\s+)?(OR\s+ALTER\s+)?((NON)?EDITIONABLE\s+|DEFINER\s*=\s*\S+\s+)*|REPLACE\s+)(?<kind>PROCEDURE|PROC|FUNCTION|TRIGGER|PACKAGE\s+BODY|PACKAGE|TYPE\s+BODY|TYPE|MACRO)\s+/i;

const PROCEDURAL_KINDS: Record<string, ProceduralKind> = {
  PROCEDURE: "procedure",
  PROC: "procedure",
  FUNCTION: "function",
  TRIGGER: "trigger",
  "PACKAGE BODY": "package_body",
  PACKAGE: "package",
  "TYPE BODY": "type",
  TYPE: "type",
  MACRO: "macro",
};

interface FeaturePattern {
  label: string;
  pattern: RegExp;
  sqlserverOnly?: RegExp;
}

const FEATURE_PATTERNS: FeaturePattern[] = [
  {
    label: "dynamic SQL",
    pattern:
      /EXECUTE\s+IMMEDIATE|\bsp_executesql\b|\bEXEC(UTE)?\s*\(|\bPREPARE\s+\w+\s+FROM\b|EXECUTE\s+format\s*\(/i,
  },
  { label: "cursors", pattern: /\bCURSOR\b/i },
  {
    label: "exception handling",
    pattern:
      /\bEXCEPTION\s+WHEN\b|\bBEGIN\s+TRY\b|\bDECLARE\s+(CONTINUE|EXIT|UNDO)\s+HANDLER\b|\bRAISERROR\b|\bTHROW\b|\bRAISE\b|\bSIGNAL\b/i,
  },
  { label: "transaction control", pattern: /\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i },
  { label: "Oracle supplied packages", pattern: /\b(UTL|DBMS)_\w+/i },
  { label: "bulk operations", pattern: /\bBULK\s+COLLECT\b|\bFORALL\b/i },
  { label: "autonomous transactions", pattern: /PRAGMA\s+AUTONOMOUS_TRANSACTION/i },
  {
    label: "temporary tables",
    pattern: /\bGLOBAL\s+TEMPORARY\b|\bVOLATILE\s+TABLE\b|\bCREATE\s+TEMP(ORARY)?\s+TABLE\b/i,
    sqlserverOnly:
      /#\w+|\bGLOBAL\s+TEMPORARY\b|\bVOLATILE\s+TABLE\b|\bCREATE\s+TEMP(ORARY)?\s+TABLE\b/i,
  },
  {
    label: "external access",
    pattern: /\bxp_cmdshell\b|\bOPEN(QUERY|ROWSET|DATASOURCE)\b|\bUTL_(HTTP|FILE|SMTP|TCP)\b/i,
  },
  { label: "BTEQ file export/import", pattern: /^\s*\.(EXPORT|IMPORT)\b/im },
  { label: "BTEQ control flow", pattern: /^\s*\.(IF|GOTO|LABEL)\b/im },
];

function featureList(text: string, engine: SourceEngine): string[] {
  const features: string[] = [];
  for (const entry of FEATURE_PATTERNS) {
    const pattern =
      entry.sqlserverOnly && engine === "sqlserver" ? entry.sqlserverOnly : entry.pattern;
    if (pattern.test(text)) features.push(entry.label);
  }
  return features;
}

function complexityFor(lines: number, features: string[]): "low" | "medium" | "high" {
  if (
    lines > 300 ||
    features.includes("dynamic SQL") ||
    features.includes("external access") ||
    features.length >= 4
  ) {
    return "high";
  }
  if (lines > 50 || features.length >= 2) return "medium";
  return "low";
}

function lineCount(text: string): number {
  const parts = text.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function trackCurrentSchema(
  sql: string,
  engine: SourceEngine,
  current: string | undefined,
): string | undefined {
  const take = (chain: NameChain | null): string | undefined => {
    if (!chain || chain.parts.length < 1) return current;
    return foldIdent(chain.parts[0], engine);
  };
  switch (engine) {
    case "sqlserver":
    case "mysql":
    case "hive": {
      const match = /^USE\s+/iy.exec(sql);
      return match ? take(parseNameChain(sql, match[0].length)) : current;
    }
    case "teradata": {
      const match = /^DATABASE\s+/iy.exec(sql);
      return match ? take(parseNameChain(sql, match[0].length)) : current;
    }
    case "postgresql": {
      const match = /^SET\s+SEARCH_PATH\s+(?:TO|=)\s*/iy.exec(sql);
      return match ? take(parseNameChain(sql, match[0].length)) : current;
    }
    case "oracle": {
      const match = /^ALTER\s+SESSION\s+SET\s+CURRENT_SCHEMA\s*=\s*/iy.exec(sql);
      return match ? take(parseNameChain(sql, match[0].length)) : current;
    }
    case "netezza": {
      const match = /^SET\s+SCHEMA\s+/iy.exec(sql);
      return match ? take(parseNameChain(sql, match[0].length)) : current;
    }
  }
}

interface PendingAlter {
  file: string;
  line: number;
  schema: string;
  name: string;
  kind: "primary_key" | "unique" | "foreign_key";
  columns: string[];
  foreignKey?: ForeignKey;
}

function clauseColumns(rest: string, regex: RegExp, engine: SourceEngine): string[] | null {
  const found = findTopLevel(rest, 0, regex);
  if (!found) return null;
  const open = found.index + found.length - 1;
  if (rest[open] !== "(") return null;
  return parseInlineList(rest, open, engine);
}

function parseTableClauses(rest: string, table: TableDef, engine: SourceEngine): void {
  if (engine === "teradata") {
    if (/\bNO\s+PRIMARY\s+INDEX\b/i.test(rest)) {
      table.distribution = { kind: "random", columns: [] };
    } else {
      const unique = clauseColumns(rest, /\bUNIQUE\s+PRIMARY\s+INDEX\s*\(/y, engine);
      const plain = unique ?? clauseColumns(rest, /\bPRIMARY\s+INDEX\s*\(/y, engine);
      if (plain) table.distribution = { kind: "key", columns: plain };
    }
    const partitionAt = findTopLevel(rest, 0, /\bPARTITION\s+BY\b/y);
    if (partitionAt) {
      const after = partitionAt.index + partitionAt.length;
      const stop = findTopLevel(
        rest,
        after,
        /\b(NO\s+PRIMARY\s+INDEX|UNIQUE\s+PRIMARY\s+INDEX|PRIMARY\s+INDEX|INDEX)\b/y,
      );
      const text = rest.slice(after, stop ? stop.index : rest.length).trim();
      if (text !== "") table.partitioning = text;
      const rangeN = /\bRANGE_N\s*\(/iy;
      rangeN.lastIndex = skipSpace(rest, after);
      if (rangeN.exec(rest)) {
        const first = parseIdentifierAt(rest, skipSpace(rest, rangeN.lastIndex));
        if (first) table.sortColumns = [foldIdent(first, engine)];
      }
    }
  } else if (engine === "netezza") {
    if (/\bDISTRIBUTE\s+ON\s+RANDOM\b/i.test(rest)) {
      table.distribution = { kind: "random", columns: [] };
    } else {
      const distributed = clauseColumns(rest, /\bDISTRIBUTE\s+ON\s*\(/y, engine);
      if (distributed) table.distribution = { kind: "key", columns: distributed };
    }
    const organized = clauseColumns(rest, /\bORGANIZE\s+ON\s*\(/y, engine);
    if (organized) table.sortColumns = organized;
  } else if (engine === "oracle") {
    const partition = /PARTITION\s+BY\s+(RANGE|LIST|HASH)\s*\(([^)]*)\)/i.exec(rest);
    if (partition) {
      table.partitioning = `${partition[1]?.toUpperCase()} (${(partition[2] ?? "").trim()})`;
    }
    if (/\bORGANIZATION\s+EXTERNAL\b/i.test(rest)) table.external = true;
  } else if (engine === "mysql") {
    const engineMatch = /\bENGINE\s*=\s*(\w+)/i.exec(rest);
    if (engineMatch) table.mysqlEngine = engineMatch[1];
  } else if (engine === "hive") {
    const partitionedAt = findTopLevel(rest, 0, /\bPARTITIONED\s+BY\s*\(/y);
    if (partitionedAt) {
      const open = partitionedAt.index + partitionedAt.length - 1;
      const close = matchParen(rest, open);
      if (close > 0) {
        for (const element of splitColumnList(rest.slice(open + 1, close))) {
          const parsed = parseElement(element, engine, table.schema);
          if (parsed.kind === "column") table.partitionColumns.push(parsed.column);
        }
      }
    }
    const clustered = findTopLevel(rest, 0, /\bCLUSTERED\s+BY\s*\(/y);
    const into = /\bINTO\s+(\d+)\s+BUCKETS\b/i.exec(rest);
    if (clustered && into) {
      const open = clustered.index + clustered.length - 1;
      table.buckets = { columns: parseInlineList(rest, open, engine), count: Number(into[1]) };
    }
    const rowFormatAt = findTopLevel(rest, 0, /\bROW\s+FORMAT\b/y);
    const storedAsAt = findTopLevel(rest, 0, /\bSTORED\s+AS\b/y);
    const locationAt = findTopLevel(rest, 0, /\bLOCATION\b/y);
    const tblPropertiesAt = findTopLevel(rest, 0, /\bTBLPROPERTIES\b/y);
    let rowFormat: string | undefined;
    let storedAs = "";
    let format = "TEXTFILE";
    const tblProperties: Record<string, string> = {};
    if (rowFormatAt) {
      const stop = findTopLevel(
        rest,
        rowFormatAt.index + rowFormatAt.length,
        /\b(STORED\s+AS|LOCATION|TBLPROPERTIES)\b/y,
      );
      const text = rest.slice(rowFormatAt.index, stop ? stop.index : rest.length).trim();
      if (text !== "") rowFormat = text;
    }
    if (storedAsAt) {
      const stop = findTopLevel(
        rest,
        storedAsAt.index + storedAsAt.length,
        /\b(ROW\s+FORMAT|LOCATION|TBLPROPERTIES)\b/y,
      );
      storedAs = rest.slice(storedAsAt.index, stop ? stop.index : rest.length).trim();
      const word = matchWordAt(rest, skipSpace(rest, storedAsAt.index + storedAsAt.length));
      if (word?.text.toUpperCase() === "INPUTFORMAT") {
        const scan = skipSpace(rest, word.end);
        const lit = literalLengthAt(rest, scan);
        const classText = lit > 1 ? rest.slice(scan + 1, scan + lit - 1).toLowerCase() : "";
        format = classText.includes("parquet")
          ? "PARQUET"
          : classText.includes("orc")
            ? "ORC"
            : classText.includes("avro")
              ? "AVRO"
              : classText.includes("text")
                ? "TEXTFILE"
                : "CUSTOM";
      } else if (word) {
        format = word.text.toUpperCase();
      }
    }
    if (locationAt) {
      const scan = skipSpace(rest, locationAt.index + locationAt.length);
      const lit = literalLengthAt(rest, scan);
      if (lit > 1) table.location = rest.slice(scan + 1, scan + lit - 1);
    }
    if (tblPropertiesAt) {
      const open = skipSpace(rest, tblPropertiesAt.index + tblPropertiesAt.length);
      if (rest[open] === "(") {
        const close = matchParen(rest, open);
        if (close > 0) {
          for (const pair of splitColumnList(rest.slice(open + 1, close))) {
            const match =
              /^'([^']*)'\s*=\s*'([^']*)'$/.exec(pair) ?? /^"([^"]*)"\s*=\s*"([^"]*)"$/.exec(pair);
            if (match && match[1] !== undefined && match[2] !== undefined)
              tblProperties[match[1]] = match[2];
          }
        }
      }
    }
    table.hive = {
      ...(rowFormat !== undefined ? { rowFormat } : {}),
      storedAs,
      format,
      tblProperties,
    };
  }
}

export function parseDatabaseProject(
  files: InputFile[],
  options: { engine?: SourceEngine; defaultSchema?: string } = {},
): DatabaseProject {
  const warnings: string[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const accepted: {
    path: string;
    text: string;
    bytes: number;
    hash: string;
    statements: number;
  }[] = [];
  for (const file of sorted) {
    if (!ACCEPTED_EXTENSIONS.has(fileExtension(file.path))) {
      warnings.push(
        `Skipped ${file.path}: only .sql, .ddl, .hql, .btq, .bteq, .pks, .pkb and .pls files are accepted.`,
      );
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
    } catch {
      warnings.push(`${file.path} is not valid UTF-8; skipped.`);
      continue;
    }
    text = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    accepted.push({
      path: file.path,
      text,
      bytes: file.data.byteLength,
      hash: sha256(file.data),
      statements: 0,
    });
  }
  if (accepted.length === 0) throw new IngestError(EMPTY_ERROR);

  let engine: SourceEngine;
  let engineDetection: "argument" | "detected";
  let perFile: Map<string, SourceEngine | undefined> | undefined;
  if (options.engine) {
    engine = options.engine;
    engineDetection = "argument";
  } else {
    const detection = detectEngine(accepted);
    if (!detection.engine) throw new IngestError(DETECTION_ERROR);
    engine = detection.engine;
    engineDetection = "detected";
    perFile = detection.perFile;
    for (const file of accepted) {
      const own = perFile.get(file.path);
      if (own && own !== engine) {
        warnings.push(
          `${file.path} looks like ${ENGINE_LABELS[own]} DDL, but the project was analyzed as ${ENGINE_LABELS[engine]}.`,
        );
      }
    }
  }

  const tables: TableDef[] = [];
  const views: ViewDef[] = [];
  const indexes: IndexDef[] = [];
  const sequences: SequenceDef[] = [];
  const procedural: ProceduralObject[] = [];
  const temporaryTables: string[] = [];
  const unparsed: { file: string; line: number; snippet: string }[] = [];
  const recordedSchemas = new Set<string>();
  const pendingAlters: PendingAlter[] = [];
  const unnamedIndexes = new Map<string, number>();
  const fallback = { used: false };
  const extensions: string[] = [];
  let synonyms = 0;
  let grants = 0;
  let otherStatements = 0;

  const resolveName = (
    parts: Identifier[],
    currentSchema: string | undefined,
  ): { schema: string; name: string } => {
    if (parts.length >= 2) {
      return {
        schema: foldIdent(parts[parts.length - 2], engine),
        name: foldIdent(parts[parts.length - 1], engine),
      };
    }
    const name = foldIdent(parts[0], engine);
    if (currentSchema) return { schema: currentSchema, name };
    if (options.defaultSchema) {
      return { schema: foldIdent({ text: options.defaultSchema, quoted: false }, engine), name };
    }
    fallback.used = true;
    return { schema: foldIdent({ text: FALLBACK_SCHEMAS[engine], quoted: false }, engine), name };
  };

  const resolveSchemaOnly = (currentSchema: string | undefined): string => {
    if (currentSchema) return currentSchema;
    if (options.defaultSchema)
      return foldIdent({ text: options.defaultSchema, quoted: false }, engine);
    fallback.used = true;
    return foldIdent({ text: FALLBACK_SCHEMAS[engine], quoted: false }, engine);
  };

  const pushUnparsed = (stmt: SqlStatement): void => {
    unparsed.push({
      file: stmt.file,
      line: stmt.line,
      snippet: redactSecrets(stmt.sql).slice(0, 120),
    });
  };

  const nextUnnamedIndex = (qualifiedTable: string, tableName: string): string => {
    const n = (unnamedIndexes.get(qualifiedTable) ?? 0) + 1;
    unnamedIndexes.set(qualifiedTable, n);
    return `idx_${tableName}_${n}`;
  };

  const maybeAddBteqObject = (
    file: { path: string; text: string },
    statements: SqlStatement[],
  ): void => {
    const ext = fileExtension(file.path);
    const hasDotCommand = statements.some((stmt) => /^\.[A-Za-z]/.test(stmt.sql));
    if (ext !== ".btq" && ext !== ".bteq" && !(engine === "teradata" && hasDotCommand)) return;
    const base = file.path.split("/").pop() ?? file.path;
    const name = base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length) : base;
    let schema: string | undefined;
    for (const stmt of statements) {
      const match = /^DATABASE\s+/iy.exec(stmt.sql);
      if (!match) continue;
      const chain = parseNameChain(stmt.sql, match[0].length);
      if (chain && chain.parts.length === 1) {
        schema = foldIdent(chain.parts[0], engine);
        break;
      }
    }
    if (!schema) schema = resolveSchemaOnly(undefined);
    const features = featureList(stripComments(file.text, engine), engine);
    const lines = lineCount(file.text);
    procedural.push({
      schema,
      name,
      kind: "bteq_script",
      file: file.path,
      line: 1,
      lines,
      features,
      complexity: complexityFor(lines, features),
    });
  };

  const parseTableStatement = (stmt: SqlStatement, prefix: RegExpExecArray): void => {
    const sql = stmt.sql;
    const chain = parseNameChain(sql, prefix[0].length);
    if (!chain) {
      pushUnparsed(stmt);
      return;
    }
    const resolved = resolveName(chain.parts, currentFileSchema);
    const body = findTableBodyStart(sql, chain.end);
    if (!body) {
      pushUnparsed(stmt);
      return;
    }
    const table: TableDef = {
      schema: resolved.schema,
      name: resolved.name,
      file: stmt.file,
      line: stmt.line,
      sql: redactSecrets(stmt.sql),
      columns: [],
      partitionColumns: [],
      primaryKey: [],
      uniqueKeys: [],
      foreignKeys: [],
      checks: 0,
      sortColumns: [],
      external: /\bEXTERNAL\b/i.test(prefix[0]),
      setTable: /\bSET\b/i.test(prefix[0]),
      createdFromQuery: false,
    };
    if (body.kind === "query") {
      table.createdFromQuery = true;
      tables.push(table);
      return;
    }
    for (const element of splitColumnList(sql.slice(body.open + 1, body.close))) {
      const parsed = parseElement(element, engine, table.schema);
      switch (parsed.kind) {
        case "column": {
          table.columns.push(parsed.column);
          if (parsed.inlinePrimaryKey) table.primaryKey = parsed.inlinePrimaryKey;
          if (parsed.inlineUnique) table.uniqueKeys.push([parsed.column.name]);
          if (parsed.inlineForeignKey) table.foreignKeys.push(parsed.inlineForeignKey);
          break;
        }
        case "primary_key":
          table.primaryKey = parsed.columns;
          break;
        case "unique":
          table.uniqueKeys.push(parsed.columns);
          break;
        case "foreign_key":
          table.foreignKeys.push(parsed.referenced);
          break;
        case "check":
          table.checks++;
          break;
        case "index": {
          const qualifiedTable = `${table.schema}.${table.name}`;
          const name = parsed.name
            ? foldIdent({ text: parsed.name, quoted: false }, engine)
            : nextUnnamedIndex(qualifiedTable, table.name);
          indexes.push({
            schema: table.schema,
            name,
            table: qualifiedTable,
            columns: parsed.columns,
            unique: parsed.unique,
            bitmap: false,
            expression: parsed.expression,
            file: stmt.file,
            line: stmt.line,
            sql: redactSecrets(stmt.sql),
          });
          break;
        }
        default:
          break;
      }
    }
    parseTableClauses(sql.slice(body.close + 1), table, engine);
    tables.push(table);
  };

  const parseViewStatement = (stmt: SqlStatement, prefix: RegExpExecArray): void => {
    const sql = stmt.sql;
    const chain = parseNameChain(sql, prefix[0].length);
    if (!chain) {
      pushUnparsed(stmt);
      return;
    }
    const as = findTopLevel(sql, chain.end, /\bAS\b/y);
    if (!as) {
      pushUnparsed(stmt);
      return;
    }
    let body = sql.slice(as.index + as.length).trim();
    body = body.replace(/\s+WITH\s+READ\s+ONLY\s*$/i, "").trim();
    const resolved = resolveName(chain.parts, currentFileSchema);
    views.push({
      schema: resolved.schema,
      name: resolved.name,
      file: stmt.file,
      line: stmt.line,
      sql: redactSecrets(stmt.sql),
      body: redactSecrets(body),
      materialized: /\bMATERIALIZED\b/i.test(prefix[0]),
    });
  };

  const parseIndexStatement = (stmt: SqlStatement): void => {
    const sql = stmt.sql;
    const prefix = INDEX_RE.exec(sql);
    if (!prefix) {
      pushUnparsed(stmt);
      return;
    }
    let pos = skipSpace(sql, prefix[0].length);
    let columns: string[] | null = null;
    let expression = false;
    let indexName: NameChain | null = null;
    if (sql[pos] === "(") {
      // Teradata style: column list before ON.
      const close = matchParen(sql, pos);
      if (close < 0) {
        pushUnparsed(stmt);
        return;
      }
      const parsed = indexColumnsFromList(sql.slice(pos + 1, close), engine);
      columns = parsed.columns;
      expression = parsed.expression;
      pos = skipSpace(sql, close + 1);
    } else {
      const candidate = parseNameChain(sql, pos);
      if (candidate) {
        const open = skipSpace(sql, candidate.end);
        if (wordAtIs(sql, open, "ON")) {
          indexName = candidate;
          pos = candidate.end;
        }
      }
    }
    const on = /\s*ON\s+/iy;
    on.lastIndex = pos;
    const onMatch = on.exec(sql);
    if (!onMatch) {
      pushUnparsed(stmt);
      return;
    }
    pos = on.lastIndex;
    const tableChain = parseNameChain(sql, pos);
    if (!tableChain) {
      pushUnparsed(stmt);
      return;
    }
    pos = skipSpace(sql, tableChain.end);
    if (columns === null) {
      if (sql[pos] !== "(") {
        pushUnparsed(stmt);
        return;
      }
      const close = matchParen(sql, pos);
      if (close < 0) {
        pushUnparsed(stmt);
        return;
      }
      const parsed = indexColumnsFromList(sql.slice(pos + 1, close), engine);
      columns = parsed.columns;
      expression = parsed.expression;
    }
    const tableResolved = resolveName(tableChain.parts, currentFileSchema);
    const qualifiedTable = `${tableResolved.schema}.${tableResolved.name}`;
    const name = indexName
      ? foldIdent(indexName.parts[indexName.parts.length - 1], engine)
      : nextUnnamedIndex(qualifiedTable, tableResolved.name);
    indexes.push({
      schema: indexName
        ? resolveName(indexName.parts, currentFileSchema).schema
        : resolveSchemaOnly(currentFileSchema),
      name,
      table: qualifiedTable,
      columns,
      unique: /\bUNIQUE\b/i.test(prefix[0]),
      bitmap: /\bBITMAP\b/i.test(prefix[0]),
      expression,
      file: stmt.file,
      line: stmt.line,
      sql: redactSecrets(stmt.sql),
    });
  };

  const parseSequenceStatement = (stmt: SqlStatement, prefix: RegExpExecArray): void => {
    const sql = stmt.sql;
    const chain = parseNameChain(sql, prefix[0].length);
    if (!chain) {
      pushUnparsed(stmt);
      return;
    }
    const currentSchema = currentFileSchema;
    const resolved = resolveName(chain.parts, currentSchema);
    const start = /\bSTART\s+WITH\s+(-?\d+)/i.exec(sql)?.[1];
    const increment = /\bINCREMENT\s+BY\s+(-?\d+)/i.exec(sql)?.[1];
    sequences.push({
      schema: resolved.schema,
      name: resolved.name,
      file: stmt.file,
      line: stmt.line,
      sql: redactSecrets(stmt.sql),
      ...(start !== undefined ? { start } : {}),
      ...(increment !== undefined ? { increment } : {}),
    });
  };

  const parseProceduralStatement = (stmt: SqlStatement, prefix: RegExpExecArray): void => {
    const kindText = (prefix.groups?.kind ?? "").toUpperCase().replaceAll(/\s+/g, " ");
    const kind = PROCEDURAL_KINDS[kindText] ?? "procedure";
    const chain = parseNameChain(stmt.sql, prefix[0].length);
    if (!chain) {
      pushUnparsed(stmt);
      return;
    }
    const resolved = resolveName(chain.parts, currentFileSchema);
    const lines = stmt.text.split("\n").length;
    const features = featureList(stmt.sql, engine);
    procedural.push({
      schema: resolved.schema,
      name: resolved.name,
      kind,
      file: stmt.file,
      line: stmt.line,
      lines,
      features,
      complexity: complexityFor(lines, features),
    });
  };

  const tryParseAlterTable = (stmt: SqlStatement): boolean => {
    const sql = stmt.sql;
    const head = /^ALTER\s+TABLE\s+/iy.exec(sql);
    if (!head) return false;
    let pos = head[0].length;
    const only = /\s*ONLY\s+/iy;
    only.lastIndex = pos;
    const onlyMatch = only.exec(sql);
    if (onlyMatch) pos = only.lastIndex;
    const chain = parseNameChain(sql, pos);
    if (!chain) return false;
    pos = chain.end;
    const withCheck = /\s*WITH\s+(NO\s*)?CHECK\s+/iy;
    withCheck.lastIndex = pos;
    const withMatch = withCheck.exec(sql);
    if (withMatch) pos = withCheck.lastIndex;
    const add = /\s*ADD\s+/iy;
    add.lastIndex = pos;
    const addMatch = add.exec(sql);
    if (!addMatch) return false;
    pos = add.lastIndex;
    const constraint = /\s*CONSTRAINT\s+/iy;
    constraint.lastIndex = pos;
    const constraintMatch = constraint.exec(sql);
    if (constraintMatch) {
      const cname = parseIdentifierAt(sql, constraint.lastIndex);
      if (!cname) return false;
      pos = cname.end;
    }
    const kind = /\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY)\s*\(/iy;
    kind.lastIndex = pos;
    const kindMatch = kind.exec(sql);
    if (!kindMatch) return false;
    const open = kind.lastIndex - 1;
    const close = matchParen(sql, open);
    if (close < 0) return false;
    const columns = parseInlineList(sql, open, engine);
    const resolved = resolveName(chain.parts, currentFileSchema);
    const keyword = (kindMatch[1] ?? "").toUpperCase();
    if (keyword === "PRIMARY KEY") {
      pendingAlters.push({
        file: stmt.file,
        line: stmt.line,
        ...resolved,
        kind: "primary_key",
        columns,
      });
      return true;
    }
    if (keyword === "UNIQUE") {
      pendingAlters.push({
        file: stmt.file,
        line: stmt.line,
        ...resolved,
        kind: "unique",
        columns,
      });
      return true;
    }
    let after = skipSpace(sql, close + 1);
    const references = /\s*REFERENCES\s+/iy;
    references.lastIndex = after;
    const refMatch = references.exec(sql);
    if (!refMatch) return false;
    after = references.lastIndex;
    const refChain = parseNameChain(sql, skipSpace(sql, after));
    if (!refChain) return false;
    const referenced = referencedTableOf(refChain, engine, resolved.schema);
    referenced.columns = columns;
    const listOpen = skipSpace(sql, refChain.end);
    if (sql[listOpen] === "(") {
      referenced.referencedColumns = parseInlineList(sql, listOpen, engine);
    }
    pendingAlters.push({
      file: stmt.file,
      line: stmt.line,
      ...resolved,
      kind: "foreign_key",
      columns,
      foreignKey: referenced,
    });
    return true;
  };

  // The current schema of the file that owns the statement, tracked per file.
  let currentFileSchema: string | undefined;

  for (const file of accepted) {
    const statements = splitStatements(file.text, file.path, engine);
    file.statements = statements.length;
    currentFileSchema = undefined;
    for (const stmt of statements) {
      currentFileSchema = trackCurrentSchema(stmt.sql, engine, currentFileSchema);
      const sql = stmt.sql;
      if (CREATE_EXCLUSION_RE.test(sql)) {
        otherStatements++;
        continue;
      }
      const temp = TEMP_TABLE_RE.exec(sql);
      if (temp) {
        const chain = parseNameChain(sql, temp[0].length);
        if (chain) {
          const resolved = resolveName(chain.parts, currentFileSchema);
          temporaryTables.push(`${resolved.schema}.${resolved.name}`);
        }
        continue;
      }
      const table = TABLE_RE.exec(sql);
      if (table) {
        parseTableStatement(stmt, table);
        continue;
      }
      const view = VIEW_RE.exec(sql);
      if (view) {
        parseViewStatement(stmt, view);
        continue;
      }
      if (INDEX_RE.test(sql)) {
        parseIndexStatement(stmt);
        continue;
      }
      const sequence = SEQUENCE_RE.exec(sql);
      if (sequence) {
        parseSequenceStatement(stmt, sequence);
        continue;
      }
      const procMatch = PROCEDURAL_RE.exec(sql);
      if (procMatch) {
        parseProceduralStatement(stmt, procMatch);
        continue;
      }
      if (
        /^CREATE\s+(USER|ROLE|LOGIN)\b/i.test(sql) ||
        /^CREATE\s+(PUBLIC\s+)?DATABASE\s+LINK\b/i.test(sql) ||
        /^ALTER\s+(USER|ROLE|LOGIN)\b/i.test(sql)
      ) {
        otherStatements++;
        continue;
      }
      if (/^CREATE\s+(PUBLIC\s+)?SYNONYM\b/i.test(sql)) {
        synonyms++;
        continue;
      }
      if (/^(GRANT|REVOKE)\b/i.test(sql)) {
        grants++;
        continue;
      }
      const extension = /^CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?/iy.exec(sql);
      if (extension) {
        const chain = parseNameChain(sql, extension[0].length);
        if (chain) extensions.push(foldIdent(chain.parts[chain.parts.length - 1], engine));
        continue;
      }
      const schemaStatement = /^CREATE\s+(SCHEMA|DATABASE)\s+(IF\s+NOT\s+EXISTS\s+)?/iy.exec(sql);
      if (schemaStatement) {
        const chain = parseNameChain(sql, schemaStatement[0].length);
        if (chain) recordedSchemas.add(foldIdent(chain.parts[chain.parts.length - 1], engine));
        continue;
      }
      if (/^ALTER\s+TABLE\b/i.test(sql)) {
        if (tryParseAlterTable(stmt)) continue;
        otherStatements++;
        continue;
      }
      if (/^CREATE\b/i.test(sql)) {
        pushUnparsed(stmt);
        continue;
      }
      otherStatements++;
    }
    maybeAddBteqObject(file, statements);
  }

  for (const alter of pendingAlters) {
    const table = tables.find(
      (candidate) => candidate.schema === alter.schema && candidate.name === alter.name,
    );
    if (!table) {
      warnings.push(
        `ALTER TABLE in ${alter.file}:${alter.line} targets ${alter.schema}.${alter.name}, which was not found.`,
      );
      continue;
    }
    if (alter.kind === "primary_key") table.primaryKey = alter.columns;
    else if (alter.kind === "unique") table.uniqueKeys.push(alter.columns);
    else if (alter.foreignKey) table.foreignKeys.push(alter.foreignKey);
  }

  if (tables.length + views.length + indexes.length + sequences.length + procedural.length === 0) {
    throw new IngestError(EMPTY_ERROR);
  }

  const schemas = new Set<string>();
  for (const table of tables) schemas.add(table.schema);
  for (const view of views) schemas.add(view.schema);
  for (const sequence of sequences) schemas.add(sequence.schema);
  for (const schema of recordedSchemas) schemas.add(schema);

  const databaseFiles: DatabaseFile[] = accepted.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.hash,
    statements: file.statements,
    ...(perFile ? { detectedEngine: perFile.get(file.path) } : {}),
  }));

  return {
    engine,
    engineDetection,
    files: databaseFiles,
    schemas: [...schemas].sort((a, b) => a.localeCompare(b)),
    tables,
    views,
    indexes,
    sequences,
    procedural,
    temporaryTables,
    schemaFallbackUsed: fallback.used,
    extensions,
    synonyms,
    grants,
    otherStatements,
    unparsed,
    warnings,
  };
}
