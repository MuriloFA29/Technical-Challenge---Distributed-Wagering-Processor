export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} with currency ${currency} already exists`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(identifier: string) {
    super(`Transaction ${identifier} not found`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor(idempotencyKey: string) {
    super(`Idempotency conflict for key "${idempotencyKey}": payload does not match original request`);
  }
}
