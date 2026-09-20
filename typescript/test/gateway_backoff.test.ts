import { describe, expect, test } from "bun:test";
import {
  GatewayHttpError,
  GatewayTimeoutError,
  RateLimitExhaustedError,
  callWithBackoff,
} from "../src/run_records.ts";

function recorder(sleeps: number[], errors: Array<{ status: number; attempt: number }>) {
  return {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    onError: (error: GatewayHttpError, attempt: number) => {
      errors.push({ status: error.status, attempt });
    },
  };
}

describe("callWithBackoff", () => {
  test("returns the first successful result without sleeping", async () => {
    const sleeps: number[] = [];
    const errors: Array<{ status: number; attempt: number }> = [];
    const result = await callWithBackoff(async () => "ok", { ...recorder(sleeps, errors), baseDelayMs: 100 });
    expect(result).toBe("ok");
    expect(sleeps).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("retries a 429 with exponential backoff and succeeds", async () => {
    const sleeps: number[] = [];
    const errors: Array<{ status: number; attempt: number }> = [];
    let attempts = 0;
    const result = await callWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new GatewayHttpError(429);
        return "ok";
      },
      { ...recorder(sleeps, errors), baseDelayMs: 100 },
    );
    expect(result).toBe("ok");
    expect(sleeps).toEqual([100, 200]);
    expect(errors).toEqual([
      { status: 429, attempt: 1 },
      { status: 429, attempt: 2 },
    ]);
  });

  test("does not retry other HTTP errors", async () => {
    const sleeps: number[] = [];
    const errors: Array<{ status: number; attempt: number }> = [];
    let attempts = 0;
    await expect(
      callWithBackoff(
        async () => {
          attempts += 1;
          throw new GatewayHttpError(502);
        },
        { ...recorder(sleeps, errors), baseDelayMs: 100 },
      ),
    ).rejects.toThrow(/502/);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("does not retry timeouts", async () => {
    const sleeps: number[] = [];
    await expect(
      callWithBackoff(async () => {
        throw new GatewayTimeoutError();
      }, { ...recorder(sleeps, []), baseDelayMs: 100 }),
    ).rejects.toThrow(GatewayTimeoutError);
    expect(sleeps).toEqual([]);
  });

  test("gives up after the attempt budget and reports the final 429", async () => {
    const sleeps: number[] = [];
    const errors: Array<{ status: number; attempt: number }> = [];
    let attempts = 0;
    await expect(
      callWithBackoff(
        async () => {
          attempts += 1;
          throw new GatewayHttpError(429);
        },
        { ...recorder(sleeps, errors), baseDelayMs: 100, maxAttempts: 3 },
      ),
    ).rejects.toThrow(RateLimitExhaustedError);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(errors.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });
});
