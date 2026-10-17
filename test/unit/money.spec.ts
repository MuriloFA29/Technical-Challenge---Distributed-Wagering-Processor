import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors/domain-errors";
import { Money } from "../../src/domain/value-objects/money";

describe("Money Value Object", () => {
  it("deve criar uma instância válida de Money", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });
    expect(money.amount).toBe("25.00");
    expect(money.currency).toBe("BRL");
    expect(money.toString()).toBe("25.00 BRL");
    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("deve criar Money.zero", () => {
    const zero = Money.zero("BRL");
    expect(zero.amount).toBe("0.00");
    expect(zero.isZero()).toBe(true);
  });

  it("deve somar valores monetários da mesma moeda", () => {
    const m1 = Money.from({ amount: "10.50", currency: "BRL" });
    const m2 = Money.from({ amount: "4.50", currency: "BRL" });
    const sum = m1.add(m2);

    expect(sum.amount).toBe("15.00");
    expect(sum.currency).toBe("BRL");
  });

  it("deve subtrair valores monetários da mesma moeda", () => {
    const m1 = Money.from({ amount: "10.50", currency: "BRL" });
    const m2 = Money.from({ amount: "4.50", currency: "BRL" });
    const diff = m1.subtract(m2);

    expect(diff.amount).toBe("6.00");
  });

  it("deve rejeitar operações entre moedas diferentes", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it("deve rejeitar mais de 2 casas decimais", () => {
    expect(() => Money.from({ amount: "25.001", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  it("deve rejeitar notação científica e formatos inválidos", () => {
    expect(() => Money.from({ amount: "1e10", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "Infinity", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "abc", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  it("deve comparar valores corretamente", () => {
    const m1 = Money.from({ amount: "10.00", currency: "BRL" });
    const m2 = Money.from({ amount: "20.00", currency: "BRL" });
    const m3 = Money.from({ amount: "10.00", currency: "BRL" });

    expect(m1.isLessThan(m2)).toBe(true);
    expect(m2.isGreaterThan(m1)).toBe(true);
    expect(m1.equals(m3)).toBe(true);
    expect(m1.equals(m2)).toBe(false);
  });
});
