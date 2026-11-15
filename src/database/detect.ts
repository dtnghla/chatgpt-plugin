import { stripComments } from "./split.js";
import type { SourceEngine } from "./types.js";

/** Tie-break order for equal scores. */
const TIE_BREAK: readonly SourceEngine[] = [
  "oracle",
  "sqlserver",
  "teradata",
  "netezza",
  "hive",
  "postgresql",
  "mysql",
];

const EXTENSION_BONUS: Record<string, SourceEngine> = {
  ".hql": "hive",
  ".btq": "teradata",
  ".bteq": "teradata",
  ".pks": "oracle",
  ".pkb": "oracle",
  ".pls": "oracle",
};

interface Pattern {
  source: string;
  multiline?: boolean;
  weight: 1 | 3;
}

const PATTERNS: Record<SourceEngine, Pattern[]> = {
  oracle: [
    { source: "\\bVARCHAR2\\b", weight: 3 },
    { source: "\\bCREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\b", weight: 3 },
    { source: "^\\s*/\\s*$", multiline: true, weight: 3 },
    { source: "\\bNUMBER\\s*\\(", weight: 1 },
    { source: "\\bNVARCHAR2\\b", weight: 1 },
    { source: "\\bSYSDATE\\b", weight: 1 },
    { source: "\\bPLS_INTEGER\\b", weight: 1 },
    { source: "\\bCLOB\\b", weight: 1 },
    { source: "\\bTABLESPACE\\b", weight: 1 },
  ],
  sqlserver: [
    { source: "^\\s*GO\\s*$", multiline: true, weight: 3 },
    { source: "\\[dbo\\]", weight: 3 },
    { source: "\\bNVARCHAR\\s*\\(\\s*MAX\\s*\\)", weight: 1 },
    { source: "\\bIDENTITY\\s*\\(", weight: 1 },
    { source: "\\bDATETIME2\\b", weight: 1 },
    { source: "\\bUNIQUEIDENTIFIER\\b", weight: 1 },
    { source: "\\bSET\\s+ANSI_NULLS\\b", weight: 1 },
    { source: "\\bNONCLUSTERED\\b", weight: 1 },
  ],
  mysql: [
    { source: "\\bENGINE\\s*=", weight: 3 },
    { source: "`[^`\\n]+`", weight: 3 },
    { source: "\\bAUTO_INCREMENT\\b", weight: 1 },
    { source: "\\bDEFAULT\\s+CHARSET\\b", weight: 1 },
    { source: "\\bUNSIGNED\\b", weight: 1 },
    { source: "\\bTINYINT\\s*\\(", weight: 1 },
  ],
  postgresql: [
    { source: "\\bLANGUAGE\\s+plpgsql\\b", weight: 3 },
    { source: "\\bOWNER\\s+TO\\b", weight: 3 },
    { source: "\\bBIGSERIAL\\b", weight: 1 },
    { source: "\\bSERIAL\\b", weight: 1 },
    { source: "\\bJSONB\\b", weight: 1 },
    { source: "\\bTIMESTAMPTZ\\b", weight: 1 },
    { source: "\\bSET\\s+search_path\\b", weight: 1 },
    { source: "::[a-z]", weight: 1 },
  ],
  teradata: [
    { source: "\\bMULTISET\\b", weight: 3 },
    { source: "\\bPRIMARY\\s+INDEX\\b", weight: 3 },
    {
      source: "^\\s*\\.(LOGON|LOGOFF|QUIT|EXPORT|IMPORT|IF|LABEL|GOTO|RUN)\\b",
      multiline: true,
      weight: 3,
    },
    { source: "\\bBYTEINT\\b", weight: 1 },
    { source: "\\bNO\\s+FALLBACK\\b", weight: 1 },
    { source: "\\bCASESPECIFIC\\b", weight: 1 },
    { source: "\\bCHARACTER\\s+SET\\s+(LATIN|UNICODE)\\b", weight: 1 },
    { source: "\\bVOLATILE\\b", weight: 1 },
    { source: "\\bREPLACE\\s+VIEW\\b", weight: 1 },
  ],
  netezza: [
    { source: "\\bDISTRIBUTE\\s+ON\\b", weight: 3 },
    { source: "\\bORGANIZE\\s+ON\\b", weight: 3 },
    { source: "\\bNZPLSQL\\b", weight: 1 },
    { source: "\\bGENERATE\\s+(EXPRESS\\s+)?STATISTICS\\b", weight: 1 },
    { source: "\\bBYTEINT\\b", weight: 1 },
  ],
  hive: [
    { source: "\\bSTORED\\s+AS\\b", weight: 3 },
    { source: "\\bROW\\s+FORMAT\\b", weight: 3 },
    { source: "\\bLOCATION\\s+'(hdfs|s3a?|viewfs):", weight: 3 },
    { source: "\\bPARTITIONED\\s+BY\\b", weight: 1 },
    { source: "\\bTBLPROPERTIES\\b", weight: 1 },
    { source: "\\bCREATE\\s+EXTERNAL\\s+TABLE\\b", weight: 1 },
    { source: "\\bINTO\\s+\\d+\\s+BUCKETS\\b", weight: 1 },
    { source: "\\bSTRING\\b", weight: 1 },
  ],
};

function countMatches(text: string, pattern: Pattern): number {
  const flags = pattern.multiline ? "gim" : "gi";
  const regex = new RegExp(pattern.source, flags);
  return text.match(regex)?.length ?? 0;
}

function scoreFile(path: string, text: string, engine: SourceEngine): number {
  const stripped = stripComments(text);
  let score = 0;
  for (const pattern of PATTERNS[engine]) {
    score += Math.min(countMatches(stripped, pattern), 5) * pattern.weight;
  }
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && EXTENSION_BONUS[path.slice(dot).toLowerCase()] === engine) score += 5;
  return score;
}

function winner(scores: Record<SourceEngine, number>): SourceEngine | undefined {
  let best = 0;
  let engine: SourceEngine | undefined;
  for (const candidate of TIE_BREAK) {
    const score = scores[candidate];
    if (score > best) {
      best = score;
      engine = candidate;
    }
  }
  return engine;
}

export function detectEngine(files: { path: string; text: string }[]): {
  engine?: SourceEngine;
  perFile: Map<string, SourceEngine | undefined>;
} {
  const totals: Record<SourceEngine, number> = {
    oracle: 0,
    sqlserver: 0,
    mysql: 0,
    postgresql: 0,
    teradata: 0,
    netezza: 0,
    hive: 0,
  };
  const perFile = new Map<string, SourceEngine | undefined>();
  for (const file of files) {
    const scores: Record<SourceEngine, number> = {
      oracle: 0,
      sqlserver: 0,
      mysql: 0,
      postgresql: 0,
      teradata: 0,
      netezza: 0,
      hive: 0,
    };
    for (const engine of TIE_BREAK) scores[engine] = scoreFile(file.path, file.text, engine);
    perFile.set(file.path, winner(scores));
    for (const engine of TIE_BREAK) totals[engine] += scores[engine];
  }
  return { engine: winner(totals), perFile };
}
