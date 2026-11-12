import { describe, expect, it } from "bun:test";
import { decodeCursor, encodeCursor } from "../../src/application/utils/cursor-pagination";

describe("Cursor Pagination", () => {
  describe("encodeCursor", () => {
    it("deve codificar createdAt e id em base64url sem padding", () => {
      const encoded = encodeCursor({
        createdAt: "2026-01-15T12:30:00.000Z",
        id: "01950000-0000-7000-8000-000000000001",
      });

      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
    });
  });

  describe("decodeCursor", () => {
    it("deve realizar roundtrip completo com encodeCursor", () => {
      const original = {
        createdAt: "2026-02-20T08:45:12.345Z",
        id: "01950000-0000-7000-8000-000000000099",
      };

      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);

      expect(decoded).toEqual(original);
    });

    it("deve retornar null para undefined, string vazia ou tipos não-string", () => {
      expect(decodeCursor(undefined)).toBeNull();
      expect(decodeCursor("")).toBeNull();
      expect(decodeCursor(null as unknown as string)).toBeNull();
      expect(decodeCursor(123 as unknown as string)).toBeNull();
      expect(decodeCursor({} as unknown as string)).toBeNull();
    });

    it("deve retornar null para base64url inválido ou JSON malformado", () => {
      expect(decodeCursor("not-valid-json")).toBeNull();
      expect(decodeCursor("!!!@@@###")).toBeNull();

      const truncated = Buffer.from('{"createdAt":"2026-01-01', "utf8").toString("base64url");
      expect(decodeCursor(truncated)).toBeNull();
    });

    it("deve retornar null para primitivos JSON válidos", () => {
      for (const raw of ["null", "123", '"hello"', "true", "false"]) {
        const cursor = Buffer.from(raw, "utf8").toString("base64url");
        expect(decodeCursor(cursor)).toBeNull();
      }
    });

    it("deve retornar null para arrays JSON", () => {
      const cursor = Buffer.from('["2026-01-01T00:00:00.000Z","id-1"]', "utf8").toString(
        "base64url"
      );
      expect(decodeCursor(cursor)).toBeNull();
    });

    it("deve retornar null quando faltam campos obrigatórios ou têm tipo inválido", () => {
      const invalidPayloads = [
        {},
        { id: "id-1" },
        { createdAt: "2026-01-01T00:00:00.000Z" },
        { createdAt: 123456, id: "id-1" },
        { createdAt: "2026-01-01T00:00:00.000Z", id: 999 },
        { createdAt: null, id: "id-1" },
        { createdAt: "2026-01-01T00:00:00.000Z", id: null },
      ];

      for (const payload of invalidPayloads) {
        const cursor = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        expect(decodeCursor(cursor)).toBeNull();
      }
    });
  });
});
