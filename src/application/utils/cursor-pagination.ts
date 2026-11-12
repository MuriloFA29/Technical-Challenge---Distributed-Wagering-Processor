import { InvalidCursorError } from "../errors/application-errors";

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
  let parsed: unknown;
  try {
    const jsonStr = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "createdAt" in parsed &&
    "id" in parsed &&
    typeof (parsed as LedgerCursorData).createdAt === "string" &&
    typeof (parsed as LedgerCursorData).id === "string"
  ) {
    const data = parsed as LedgerCursorData;
    const date = new Date(data.createdAt);
    if (Number.isNaN(date.getTime())) {
      throw new InvalidCursorError("Invalid cursor: createdAt is not a valid date");
    }
    return data;
  }

  return null;
}
