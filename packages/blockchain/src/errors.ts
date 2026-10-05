export class ChainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The RPC endpoint is unreachable, timing out or returning server errors. Retryable. */
export class RpcUnavailable extends ChainError {}

/** The transaction or call reverted. `reason` is the decoded custom error name when known. Not retryable. */
export class Reverted extends ChainError {
  constructor(
    message: string,
    public readonly reason?: string,
    public readonly args?: readonly unknown[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The sending account cannot pay for gas. Not retryable until topped up. */
export class InsufficientGas extends ChainError {}
