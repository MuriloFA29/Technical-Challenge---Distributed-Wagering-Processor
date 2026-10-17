import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../errors/domain-errors";

export interface MoneyProps {
  amount: string;   // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

// Configuração de precisão de Decimal para cálculos exatos
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  public get amount(): string {
    return this.value.toFixed(2);
  }

  static from(props: MoneyProps): Money {
    if (!props) {
      throw new InvalidMoneyError("Properties are required");
    }

    const { amount, currency } = props;

    if (typeof currency !== "string" || currency.trim().length !== 3) {
      throw new InvalidMoneyError("Currency must be a valid 3-letter ISO-4217 code");
    }

    if (typeof amount !== "string" || amount.trim() === "") {
      throw new InvalidMoneyError("Amount must be a non-empty string");
    }

    const sanitizedAmount = amount.trim();

    // Rejeitar notação científica, caracteres não numéricos além de ponto decimal e sinal
    if (!/^-?\d+(\.\d+)?$/.test(sanitizedAmount)) {
      throw new InvalidMoneyError(`Amount "${amount}" has invalid decimal format`);
    }

    // Validar escala máxima de 2 casas decimais
    const parts = sanitizedAmount.split(".");
    if (parts.length === 2 && parts[1].length > 2) {
      throw new InvalidMoneyError(`Amount "${amount}" cannot have more than 2 decimal places`);
    }

    let decimalVal: Decimal;
    try {
      decimalVal = new Decimal(sanitizedAmount);
    } catch {
      throw new InvalidMoneyError(`Amount "${amount}" could not be parsed to decimal`);
    }

    if (!decimalVal.isFinite()) {
      throw new InvalidMoneyError("Amount cannot be NaN or Infinity");
    }

    return new Money(decimalVal, currency.toUpperCase().trim());
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    if (!other || this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.amount,
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!other || this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other?.currency ?? "undefined");
    }
  }
}
