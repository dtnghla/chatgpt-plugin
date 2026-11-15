import type { SourceEngine, SqlStatement } from "./types.js";

const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

/**
 * Returns the index just past a quoted literal (string, quoted identifier,
 * bracketed identifier or dollar-quoted string) starting at `i`, or -1 when
 * the character does not start one.
 */
function literalEnd(text: string, i: number, engine?: SourceEngine): number {
  const ch = text[i];
  if (ch === "'" || ch === '"' || ch === "`") return skipQuoted(text, i, ch);
  if (engine === "sqlserver" && ch === "[") return skipBracketed(text, i);
  if (engine === "postgresql" && ch === "$") {
    DOLLAR_TAG.lastIndex = i;
    const open = DOLLAR_TAG.exec(text);
    if (open) {
      const tag = open[0];
      const close = text.indexOf(tag, i + tag.length);
      return close >= 0 ? close + tag.length : text.length;
    }
  }
  return -1;
}

function skipQuoted(text: string, i: number, quote: string): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        j++;
        continue;
      }
      return j + 1;
    }
  }
  return text.length;
}

function skipBracketed(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "]") {
      if (text[j + 1] === "]") {
        j++;
        continue;
      }
      return j + 1;
    }
  }
  return text.length;
}

function endOfLine(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  return nl >= 0 ? nl : text.length;
}

/** Removes `--`, `/*` and (mysql) `#` comments, keeping strings verbatim. */
export function stripComments(text: string, engine?: SourceEngine): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const ch = out[i];
      if (ch !== "\n" && ch !== "\r") out[i] = " ";
    }
  };
  let i = 0;
  while (i < text.length) {
    const lit = literalEnd(text, i, engine);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const ch = text[i];
    if (ch === "-" && text[i + 1] === "-") {
      const end = endOfLine(text, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close >= 0 ? close + 2 : text.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (engine === "mysql" && ch === "#") {
      const end = endOfLine(text, i);
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

function isSpace(text: string, i: number): boolean {
  return /\s/.test(text.charAt(i));
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function dropSemicolon(sql: string): string {
  return sql.endsWith(";") ? sql.slice(0, -1) : sql;
}

/** Oracle statements end at `;`, or at a `/`-only line whose slash is the terminator. */
function dropOracleTerminator(sql: string): string {
  if (sql.endsWith("/")) return sql.slice(0, -1);
  return dropSemicolon(sql);
}

function dropSuffix(suffix: string) {
  return (sql: string) => (sql.endsWith(suffix) ? sql.slice(0, sql.length - suffix.length) : sql);
}

function keep(sql: string): string {
  return sql;
}

function makeStatement(
  text: string,
  stripped: string,
  file: string,
  start: number,
  end: number,
  stripTerminator: (sql: string) => string,
): SqlStatement {
  let sql = stripped.slice(start, end).trim();
  sql = stripTerminator(sql).trim();
  return { file, line: lineOf(text, start), text: text.slice(start, end).trim(), sql };
}

/** Finds the next `;` at paren depth 0 outside literals, in [from, to). */
function scanSemicolon(stripped: string, from: number, to: number, engine: SourceEngine): number {
  let depth = 0;
  let i = from;
  while (i < to) {
    const lit = literalEnd(stripped, i, engine);
    if (lit > 0) {
      i = lit;
      continue;
    }
    const ch = stripped[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) return i + 1;
    i++;
  }
  return to;
}

/** Index of the end of the next line whose entire content is `/`, or -1. */
function findSlashLineEnd(stripped: string, from: number, to: number): number {
  let lineStart = from === 0 ? 0 : stripped.lastIndexOf("\n", from - 1) + 1;
  while (lineStart <= to) {
    const lineEnd = endOfLine(stripped, lineStart);
    const line = stripped.slice(lineStart, Math.min(lineEnd, to));
    if (/^\s*\/\s*$/.test(line)) return Math.min(lineEnd, to);
    if (lineEnd >= to) return -1;
    lineStart = lineEnd + 1;
  }
  return -1;
}

function splitOracle(text: string, stripped: string, file: string): SqlStatement[] {
  const PROC_PREFIX =
    /^(CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b|DECLARE\b|BEGIN\b)/i;
  const statements: SqlStatement[] = [];
  const n = text.length;
  let p = 0;
  while (p < n) {
    while (p < n && isSpace(stripped, p)) p++;
    if (p >= n) break;
    const procedural = PROC_PREFIX.test(stripped.slice(p));
    let end: number;
    if (procedural) {
      const slash = findSlashLineEnd(stripped, p, n);
      end = slash >= 0 ? slash : n;
    } else {
      let depth = 0;
      let i = p;
      end = n;
      while (i < n) {
        const lit = literalEnd(stripped, i, "oracle");
        if (lit > 0) {
          i = lit;
          continue;
        }
        const ch = stripped[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (ch === ";" && depth === 0) {
          end = i + 1;
          break;
        } else if (ch === "/") {
          // A `/`-only line also ends a plain statement.
          const lineStart = stripped.lastIndexOf("\n", i) + 1;
          const lineEnd = endOfLine(stripped, i);
          if (/^\s*\/\s*$/.test(stripped.slice(lineStart, lineEnd))) {
            end = lineEnd;
            break;
          }
        }
        i++;
      }
    }
    statements.push(makeStatement(text, stripped, file, p, end, dropOracleTerminator));
    p = end;
  }
  return statements.filter((statement) => statement.sql !== "");
}

function findGoLine(stripped: string, from: number): { start: number; end: number } | null {
  let lineStart = from === 0 ? 0 : stripped.lastIndexOf("\n", from - 1) + 1;
  while (lineStart < stripped.length) {
    const lineEnd = endOfLine(stripped, lineStart);
    if (/^\s*GO(\s+\d+)?\s*$/i.test(stripped.slice(lineStart, lineEnd))) {
      return { start: lineStart, end: Math.min(lineEnd + 1, stripped.length) };
    }
    if (lineEnd >= stripped.length) return null;
    lineStart = lineEnd + 1;
  }
  return null;
}

function splitSqlServer(text: string, stripped: string, file: string): SqlStatement[] {
  const PROC_BATCH = /^CREATE\s+(OR\s+ALTER\s+)?(PROCEDURE|PROC|FUNCTION|TRIGGER|VIEW)\b/i;
  const statements: SqlStatement[] = [];
  const n = text.length;
  let p = 0;
  while (p < n) {
    const go = findGoLine(stripped, p);
    const batchEnd = go ? go.start : n;
    let s = p;
    while (s < batchEnd && isSpace(stripped, s)) s++;
    if (s < batchEnd) {
      if (PROC_BATCH.test(stripped.slice(s, batchEnd))) {
        statements.push(makeStatement(text, stripped, file, s, batchEnd, keep));
      } else {
        let i = s;
        while (i < batchEnd) {
          const end = scanSemicolon(stripped, i, batchEnd, "sqlserver");
          statements.push(makeStatement(text, stripped, file, i, end, dropSemicolon));
          i = end;
          while (i < batchEnd && isSpace(stripped, i)) i++;
          if (i >= batchEnd) break;
        }
      }
    }
    if (!go) break;
    p = go.end;
  }
  return statements.filter((statement) => statement.sql !== "");
}

function matchDelimiterLine(stripped: string, p: number): { token: string; end: number } | null {
  const lineStart = stripped.lastIndexOf("\n", p - 1) + 1;
  if (stripped.slice(lineStart, p).trim() !== "") return null;
  const lineEnd = endOfLine(stripped, p);
  const match = /^DELIMITER\s+(\S+)\s*$/i.exec(stripped.slice(p, lineEnd));
  if (!match) return null;
  return { token: match[1] ?? ";", end: lineEnd };
}

function scanToken(stripped: string, from: number, to: number, token: string): number {
  let i = from;
  while (i < to) {
    const lit = literalEnd(stripped, i, "mysql");
    if (lit > 0) {
      i = lit;
      continue;
    }
    if (stripped.startsWith(token, i)) return i + token.length;
    i++;
  }
  return to;
}

function splitMysql(text: string, stripped: string, file: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const n = text.length;
  let p = 0;
  let delimiter = ";";
  while (p < n) {
    while (p < n && isSpace(stripped, p)) p++;
    if (p >= n) break;
    const delimiterLine = matchDelimiterLine(stripped, p);
    if (delimiterLine) {
      delimiter = delimiterLine.token;
      p = delimiterLine.end;
      continue;
    }
    const end =
      delimiter === ";"
        ? scanSemicolon(stripped, p, n, "mysql")
        : scanToken(stripped, p, n, delimiter);
    statements.push(
      makeStatement(
        text,
        stripped,
        file,
        p,
        end,
        delimiter === ";" ? dropSemicolon : dropSuffix(delimiter),
      ),
    );
    p = end;
  }
  return statements.filter((statement) => statement.sql !== "");
}

function scanTeradataProcedure(stripped: string, from: number, to: number): number {
  const BEGIN = /\bBEGIN\b/y;
  const CASE = /\bCASE\b/y;
  const END = /\bEND\b/y;
  const END_GUARD = /\s*(IF|LOOP|WHILE|REPEAT|FOR)\b/y;
  let keywordDepth = 0;
  let parenDepth = 0;
  let seenBegin = false;
  let i = from;
  while (i < to) {
    const lit = literalEnd(stripped, i, "teradata");
    if (lit > 0) {
      i = lit;
      continue;
    }
    const ch = stripped[i];
    if (ch === "(") {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      i++;
      continue;
    }
    if (ch === ";" && keywordDepth === 0 && parenDepth === 0 && seenBegin) return i + 1;
    BEGIN.lastIndex = i;
    if (BEGIN.test(stripped)) {
      keywordDepth++;
      seenBegin = true;
      i += 5;
      continue;
    }
    CASE.lastIndex = i;
    if (CASE.test(stripped)) {
      keywordDepth++;
      i += 4;
      continue;
    }
    END.lastIndex = i;
    if (END.test(stripped)) {
      END_GUARD.lastIndex = i + 3;
      keywordDepth += END_GUARD.test(stripped) ? 0 : -1;
      keywordDepth = Math.max(0, keywordDepth);
      i += 3;
      continue;
    }
    i++;
  }
  return to;
}

function splitTeradata(text: string, stripped: string, file: string): SqlStatement[] {
  const PROC_START = /^(CREATE|REPLACE)\s+PROCEDURE\b/i;
  const DOT_COMMAND = /^\.[A-Za-z]+/;
  const statements: SqlStatement[] = [];
  const n = text.length;
  let p = 0;
  while (p < n) {
    while (p < n && isSpace(stripped, p)) p++;
    if (p >= n) break;
    const lineEnd = endOfLine(stripped, p);
    if (DOT_COMMAND.test(stripped.slice(p, lineEnd))) {
      statements.push(makeStatement(text, stripped, file, p, lineEnd, keep));
      p = lineEnd;
      continue;
    }
    let end: number;
    if (PROC_START.test(stripped.slice(p))) {
      end = scanTeradataProcedure(stripped, p, n);
    } else {
      end = scanSemicolon(stripped, p, n, "teradata");
    }
    statements.push(makeStatement(text, stripped, file, p, end, dropSemicolon));
    p = end;
  }
  return statements.filter((statement) => statement.sql !== "");
}

function splitNetezza(text: string, stripped: string, file: string): SqlStatement[] {
  const PROC_START = /^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i;
  const END_PROC = /\bEND_PROC\b/y;
  const statements: SqlStatement[] = [];
  const n = text.length;
  let p = 0;
  while (p < n) {
    while (p < n && isSpace(stripped, p)) p++;
    if (p >= n) break;
    let end: number;
    if (PROC_START.test(stripped.slice(p))) {
      end = n;
      let i = p;
      let foundEndProc = false;
      while (i < n) {
        const lit = literalEnd(stripped, i, "netezza");
        if (lit > 0) {
          i = lit;
          continue;
        }
        if (!foundEndProc) {
          END_PROC.lastIndex = i;
          const match = END_PROC.exec(stripped);
          if (match) {
            foundEndProc = true;
            i += 8;
            continue;
          }
        } else if (stripped[i] === ";") {
          end = i + 1;
          break;
        }
        i++;
      }
    } else {
      end = scanSemicolon(stripped, p, n, "netezza");
    }
    statements.push(makeStatement(text, stripped, file, p, end, dropSemicolon));
    p = end;
  }
  return statements.filter((statement) => statement.sql !== "");
}

function splitDefault(
  text: string,
  stripped: string,
  file: string,
  engine: SourceEngine,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const n = text.length;
  let p = 0;
  while (p < n) {
    while (p < n && isSpace(stripped, p)) p++;
    if (p >= n) break;
    const end = scanSemicolon(stripped, p, n, engine);
    statements.push(makeStatement(text, stripped, file, p, end, dropSemicolon));
    p = end;
  }
  return statements.filter((statement) => statement.sql !== "");
}

/**
 * Splits a script into statements using per-engine terminator rules.
 * `text` and the comment-stripped form must share offsets; statements carry
 * both the raw slice (`text`) and the cleaned SQL (`sql`).
 */
export function splitStatements(text: string, file: string, engine: SourceEngine): SqlStatement[] {
  const stripped = stripComments(text, engine);
  switch (engine) {
    case "oracle":
      return splitOracle(text, stripped, file);
    case "sqlserver":
      return splitSqlServer(text, stripped, file);
    case "mysql":
      return splitMysql(text, stripped, file);
    case "teradata":
      return splitTeradata(text, stripped, file);
    case "netezza":
      return splitNetezza(text, stripped, file);
    default:
      return splitDefault(text, stripped, file, engine);
  }
}
