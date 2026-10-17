import {
  InvalidTransactionStateError,
  ReferenceRequirementError,
} from "../errors/domain-errors";
import { LedgerDirection } from "./wallet-ledger-entry";
import { Money } from "../value-objects/money";

export enum WagerTransactionKind {
  Opening = "OPENING",   // interno: crédito de abertura da wallet (não aceito externamente)
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",                      // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE",    // aguardando a transação referenciada
  Processed = "PROCESSED",                  // aplicada (terminal)
  Rejected = "REJECTED",                    // violação de regra de negócio (terminal)
  Failed = "FAILED",                        // erro permanente de infraestrutura (terminal)
}

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceType = "INVALID_REFERENCE_TYPE",
  DuplicateReversal = "DUPLICATE_REVERSAL",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  InvalidPayload = "INVALID_PAYLOAD",
  OpeningOperationNotAllowed = "OPENING_OPERATION_NOT_ALLOWED",
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
  MaxRetriesExceeded = "MAX_RETRIES_EXCEEDED",
  InternalError = "INTERNAL_ERROR",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  observedBalance?: Money;
  createdAt: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _observedBalance?: Money,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const isReferenceRequired =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (isReferenceRequired && !props.referenceExternalTransactionId) {
      throw new ReferenceRequirementError(props.kind);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    observedBalance: Money,
    at: Date = new Date()
  ): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    if (referenceTransactionId) {
      this._referenceTransactionId = referenceTransactionId;
    }
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, observedBalance?: Money, at: Date = new Date()): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new ReferenceRequirementError("ROLLBACK requires referenced transaction to calculate direction");
        }
        const refDirection = reference.ledgerDirectionFor();
        return refDirection === LedgerDirection.Credit
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      default:
        throw new Error(`Kind ${this.kind} does not generate ledger direction`);
    }
  }

  private assertNotTerminal(targetState: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, targetState);
    }
  }
}
