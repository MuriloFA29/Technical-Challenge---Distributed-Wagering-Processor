import { describe, expect, it } from "bun:test";
import {
  canonicalizeJson,
  computeCanonicalPayloadHash,
} from "../../src/application/utils/canonical-json";

describe("Canonical JSON & Payload Hash", () => {
  describe("canonicalizeJson", () => {
    it("deve serializar valores primitivos corretamente", () => {
      expect(canonicalizeJson(null)).toBe("null");
      expect(canonicalizeJson("abc")).toBe('"abc"');
      expect(canonicalizeJson(0)).toBe("0");
      expect(canonicalizeJson(-0)).toBe("0");
      expect(canonicalizeJson(42.5)).toBe("42.5");
      expect(canonicalizeJson(Number.NaN)).toBe("null");
      expect(canonicalizeJson(Number.POSITIVE_INFINITY)).toBe("null");
      expect(canonicalizeJson(true)).toBe("true");
      expect(canonicalizeJson(false)).toBe("false");
    });

    it("deve ordenar chaves no topo e em objetos aninhados sem espaços", () => {
      const input = {
        z: 1,
        a: {
          d: "four",
          b: { y: true, x: false },
          c: null,
        },
        m: "mid",
      };

      expect(canonicalizeJson(input)).toBe(
        '{"a":{"b":{"x":false,"y":true},"c":null,"d":"four"},"m":"mid","z":1}'
      );
    });

    it("deve preservar a ordem dos elementos de arrays enquanto ordena chaves de objetos internos", () => {
      expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]");
      expect(
        canonicalizeJson([
          { b: 1, a: 2 },
          { d: 3, c: 4 },
        ])
      ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
    });

    it("deve refletir o comportamento de undefined em objetos e arrays", () => {
      expect(canonicalizeJson([1, undefined, 2])).toBe("[1,,2]");
      expect(canonicalizeJson({ b: 2, a: undefined })).toBe('{"a":undefined,"b":2}');
    });

    it("deve serializar instância de Date como objeto vazio por não possuir chaves enumeráveis", () => {
      const date = new Date("2026-01-01T00:00:00.000Z");
      expect(canonicalizeJson(date)).toBe("{}");
    });

    it("deve lançar TypeError ao tentar serializar bigint", () => {
      expect(() => canonicalizeJson(10n)).toThrow(TypeError);
    });
  });

  describe("computeCanonicalPayloadHash", () => {
    it("deve gerar o SHA-256 esperado para objeto vazio", () => {
      const hash = computeCanonicalPayloadHash({});
      expect(hash).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("deve ser determinístico independente da ordem de inserção das chaves", () => {
      const payloadA = {
        walletId: "w-1",
        money: { currency: "BRL", amount: "100.00" },
        metadata: [{ z: 1, a: 2 }],
      };
      const payloadB = {
        metadata: [{ a: 2, z: 1 }],
        money: { amount: "100.00", currency: "BRL" },
        walletId: "w-1",
      };

      expect(computeCanonicalPayloadHash(payloadA)).toBe(computeCanonicalPayloadHash(payloadB));
    });

    it("deve gerar hashes distintos quando chave, valor, tipo ou ordem de array muda", () => {
      const base = { amount: 10, tags: ["a", "b"] };
      const diffKey = { value: 10, tags: ["a", "b"] };
      const diffValue = { amount: 20, tags: ["a", "b"] };
      const diffType = { amount: "10", tags: ["a", "b"] };
      const diffArrayOrder = { amount: 10, tags: ["b", "a"] };

      const baseHash = computeCanonicalPayloadHash(base);
      expect(computeCanonicalPayloadHash(diffKey)).not.toBe(baseHash);
      expect(computeCanonicalPayloadHash(diffValue)).not.toBe(baseHash);
      expect(computeCanonicalPayloadHash(diffType)).not.toBe(baseHash);
      expect(computeCanonicalPayloadHash(diffArrayOrder)).not.toBe(baseHash);
    });
  });
});
