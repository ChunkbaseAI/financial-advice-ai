import type { ErrorKind, EvaluationAttempt, GatewayUsage, RunRecordError } from "./run_record_schema.ts";

export interface AttemptEvidence {
  /** The gateway generation id from the response, looked up after the batch so usage stays gateway-reported. */
  generationId?: string | null;
  /** Token counts reported in the response body, used as a fallback when the lookup reports none. */
  bodyUsage?: { input_tokens: number; output_tokens: number } | null;
}

export type AttemptOutcome =
  | ({ status: "parsed"; answer: unknown; rawResponse: unknown; usage: GatewayUsage | null; elapsedMs: number } & AttemptEvidence)
  | ({ status: "invalid-response"; rawResponse: unknown; usage: GatewayUsage | null; elapsedMs: number; message: string } & AttemptEvidence)
  | {
      status: "transport-error";
      error: { kind: ErrorKind; message: string; status?: number };
      rawResponse: unknown;
      usage: GatewayUsage | null;
      elapsedMs: number;
    };

export interface RetryPolicyOutcome {
  status: "answered" | "execution-error";
  answer?: unknown;
  error?: RunRecordError;
  attempts: EvaluationAttempt[];
  firstAttemptInvalid: boolean;
  retried: boolean;
}

export interface RetryPolicyOptions {
  /**
   * Performs one model attempt. The attempt number is 1 or 2; the caller appends
   * the frozen retry instruction from the protocol when it is 2. The outcome
   * reports invalid output itself; the policy never inspects answer content,
   * so a valid answer is never retried for disagreeing with expectations.
   */
  attempt: (attemptNumber: number) => Promise<AttemptOutcome>;
}

function toEvaluationAttempt(outcome: AttemptOutcome, index: number): EvaluationAttempt {
  switch (outcome.status) {
    case "parsed":
      return {
        index,
        raw_response: outcome.rawResponse,
        parsed_answer: outcome.answer,
        usage: outcome.usage,
        elapsed_ms: outcome.elapsedMs,
        error: null,
        ...(outcome.generationId !== undefined ? { generation_id: outcome.generationId } : {}),
        ...(outcome.bodyUsage !== undefined ? { body_usage: outcome.bodyUsage } : {}),
      };
    case "invalid-response":
      return {
        index,
        raw_response: outcome.rawResponse,
        parsed_answer: null,
        usage: outcome.usage,
        elapsed_ms: outcome.elapsedMs,
        error: { kind: "invalid-response", message: outcome.message },
        ...(outcome.generationId !== undefined ? { generation_id: outcome.generationId } : {}),
        ...(outcome.bodyUsage !== undefined ? { body_usage: outcome.bodyUsage } : {}),
      };
    case "transport-error":
      return {
        index,
        raw_response: outcome.rawResponse,
        parsed_answer: null,
        usage: outcome.usage,
        elapsed_ms: outcome.elapsedMs,
        error:
          outcome.error.status === undefined
            ? { kind: outcome.error.kind, message: outcome.error.message }
            : { kind: outcome.error.kind, message: outcome.error.message, status: outcome.error.status },
      };
  }
}

export async function runWithRetryPolicy(options: RetryPolicyOptions): Promise<RetryPolicyOutcome> {
  const first = await options.attempt(1);
  const firstAttempt = toEvaluationAttempt(first, 1);

  if (first.status === "transport-error") {
    return {
      status: "execution-error",
      error: firstAttempt.error ?? { kind: "other", message: "transport error" },
      attempts: [firstAttempt],
      firstAttemptInvalid: false,
      retried: false,
    };
  }
  if (first.status === "parsed") {
    return { status: "answered", answer: first.answer, attempts: [firstAttempt], firstAttemptInvalid: false, retried: false };
  }

  const second = await options.attempt(2);
  const secondAttempt = toEvaluationAttempt(second, 2);
  if (second.status === "transport-error") {
    return {
      status: "execution-error",
      error: secondAttempt.error ?? { kind: "other", message: "transport error" },
      attempts: [firstAttempt, secondAttempt],
      firstAttemptInvalid: true,
      retried: true,
    };
  }
  if (second.status === "parsed") {
    return { status: "answered", answer: second.answer, attempts: [firstAttempt, secondAttempt], firstAttemptInvalid: true, retried: true };
  }

  return {
    status: "execution-error",
    error: {
      kind: "invalid-response",
      message: "two failed attempts; execution error, never a pass or a caught mistake",
    },
    attempts: [firstAttempt, secondAttempt],
    firstAttemptInvalid: true,
    retried: true,
  };
}
