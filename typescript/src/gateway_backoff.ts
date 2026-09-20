export class GatewayHttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `gateway returned HTTP ${status}`);
    this.name = "GatewayHttpError";
    this.status = status;
  }
}

export class GatewayTimeoutError extends Error {
  constructor(message = "gateway call timed out") {
    super(message);
    this.name = "GatewayTimeoutError";
  }
}

export class RateLimitExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`gateway returned 429 on all ${attempts} attempt(s); preserving this as an error record`);
    this.name = "RateLimitExhaustedError";
    this.attempts = attempts;
  }
}

export interface BackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: GatewayHttpError, attempt: number) => void;
}

export async function callWithBackoff<T>(call: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof GatewayHttpError) || error.status !== 429) throw error;
      options.onError?.(error, attempt);
      if (attempt === maxAttempts) throw new RateLimitExhaustedError(maxAttempts);
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new RateLimitExhaustedError(maxAttempts);
}
