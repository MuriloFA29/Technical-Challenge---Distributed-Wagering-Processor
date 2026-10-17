export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(`Invalid money: ${message}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, got ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(currentBalance: string, requestedAmount: string) {
    super(`Insufficient funds: current balance is ${currentBalance}, requested ${requestedAmount}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(currentState: string, targetState: string) {
    super(`Cannot transition transaction from ${currentState} to ${targetState}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor(details: string) {
    super(`Ledger entry is not balanced: ${details}`);
  }
}

export class ReferenceRequirementError extends DomainError {
  constructor(kind: string) {
    super(`Transaction kind ${kind} requires a valid reference transaction`);
  }
}

export class ReferenceMismatchError extends DomainError {
  constructor(details: string) {
    super(`Referenced transaction does not match criteria: ${details}`);
  }
}

export class DuplicateReversalError extends DomainError {
  constructor(referenceId: string, kind: string) {
    super(`Transaction ${referenceId} has already been reversed by a ${kind} operation`);
  }
}
