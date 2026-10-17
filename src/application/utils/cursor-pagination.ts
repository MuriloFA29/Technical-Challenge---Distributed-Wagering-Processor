export interface LedgerCursorData {
  createdAt: string;
  id: string;
}

export function encodeCursor(data: LedgerCursorData): string {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeCursor(cursor?: string): LedgerCursorData | null {
  if (!cursor || typeof cursor !== "string") {
    return null;
  }
  try {
    const jsonStr = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed.createdAt === "string" && typeof parsed.id === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
