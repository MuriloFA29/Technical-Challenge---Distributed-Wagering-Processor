import { CurrencyMismatchError, InsufficientFundsError } from "../errors/domain-errors";
import { Money } from "../value-objects/money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletBalanceMovementResult {
  balanceBefore: Money;
  balanceAfter: Money;
  newVersion: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    const now = new Date();
    const currency = props.initialBalance.currency;

    if (props.initialBalance.isNegative()) {
      throw new InsufficientFundsError("0.00", props.initialBalance.amount);
    }

    return new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1, // Version inicia em 1 após a criação
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições de abertura */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money): WalletBalanceMovementResult {
    this.assertSameCurrency(amount);

    if (amount.isNegative()) {
      throw new InsufficientFundsError(this._balance.amount, amount.amount);
    }

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(this._balance.amount, amount.amount);
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return {
      balanceBefore,
      balanceAfter,
      newVersion: this._version,
    };
  }

  credit(amount: Money): WalletBalanceMovementResult {
    this.assertSameCurrency(amount);

    if (amount.isNegative()) {
      throw new InsufficientFundsError(this._balance.amount, amount.amount);
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date();

    return {
      balanceBefore,
      balanceAfter,
      newVersion: this._version,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
