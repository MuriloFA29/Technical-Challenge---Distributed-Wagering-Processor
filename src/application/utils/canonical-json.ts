import { createHash } from "crypto";

/**
 * Ordena recursivamente todas as chaves de um objeto para produzir um JSON canônico e determinístico.
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalizeJson(item)).join(",") + "]";
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`
  );

  return "{" + pairs.join(",") + "}";
}

/**
 * Gera o SHA-256 do JSON canônico de campos de negócio relevantes para idempotência.
 */
export function computeCanonicalPayloadHash(businessFields: Record<string, unknown>): string {
  const canonicalString = canonicalizeJson(businessFields);
  return createHash("sha256").update(canonicalString).digest("hex");
}
