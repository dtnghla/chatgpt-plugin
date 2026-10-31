const VARIABLE = /\$\{([^{}]+)\}|%%([^%]+)%%/g;

export function extractVariables(value: string | undefined): string[] {
  if (!value) return [];
  const result: string[] = [];
  for (const match of value.matchAll(VARIABLE)) {
    const name = (match[1] ?? match[2])?.trim();
    if (name) result.push(name);
  }
  return [...new Set(result)];
}

export function collectVariables(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const name of extractVariables(value)) result.add(name);
  } else if (Array.isArray(value)) {
    for (const item of value) collectVariables(item, result);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectVariables(item, result);
  }
  return result;
}

export function resolveVariable(value: string, variables: Record<string, string>): string {
  return value.replace(
    VARIABLE,
    (match, rawName: string | undefined, legacyName: string | undefined) => {
      const name = (rawName ?? legacyName ?? "").trim();
      return variables[name] ?? match;
    },
  );
}
