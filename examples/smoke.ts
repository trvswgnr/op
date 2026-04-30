import { ErrorGroup, Op, TimeoutError, TaggedError, UnhandledException } from "@prodkit/op";
import {
  DivisionByZeroError,
  FetchError,
  HttpError,
  NegativeError,
  ParseError,
  divide,
  fetchData,
  mathComposeProgram,
  parseUser,
  sqrt,
  userProgram,
} from "./simple.ts";
import {
  DuplicateEventError,
  FraudRiskTooHighError,
  InvalidWebhookError,
  ServiceCallError,
  createApp,
} from "./webhook.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const isNamedUser = (value: unknown): value is { name: string } => {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
};

class RetryableError extends Error {
  retryable = true;
}

const neverSettlesUntilAborted = (signal: AbortSignal) =>
  new Promise((_, reject) => {
    if (signal.aborted) return reject(new RetryableError("aborted"));
    signal.addEventListener("abort", () => reject(new RetryableError("aborted")), { once: true });
  });

const createDeps = (overrides = {}) => ({
  isDuplicateEvent: async () => false,
  reserveInventory: async () => ({ reservationId: "res-1", reserved: true }),
  authorizePayment: async () => ({ approved: true, authorizationId: "auth-1" }),
  riskPrimary: async () => 0.12,
  riskSecondary: async () => 0.11,
  loadFraudPolicyFromCache: async () => "policy-cache-v1",
  loadFraudPolicyFromConfig: async () => "policy-config-v1",
  persistOrder: async () => undefined,
  markEventProcessed: async () => undefined,
  sendReceipt: async () => undefined,
  publishAnalytics: async () => undefined,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const webhookPayload = {
  eventId: "evt-123",
  orderId: "ord-123",
  userId: "usr-123",
  currency: "USD",
  totalCents: 4200,
  itemSkus: ["SKU-1", "SKU-2"],
};

const runCoreApiSmoke = async () => {
  class TooSmallError extends TaggedError("TooSmallError")<{ message: string }>() {}

  const localDivide = Op(function* (a: number, b: number) {
    if (b === 0) return yield* new TooSmallError({ message: "division by zero" });
    return a / b;
  });

  const localSqrt = Op(function* (n: number) {
    if (n < 0) return yield* new TooSmallError({ message: "negative input" });
    return Math.sqrt(n);
  });

  const compute = Op(function* () {
    const quotient = yield* localDivide(25, 5);
    const rooted = yield* localSqrt(quotient);
    return rooted;
  });

  const result = await compute
    .withRetry({
      maxAttempts: 2,
      shouldRetry: () => false,
      getDelay: () => 10,
    })
    .withTimeout(500)
    .run();

  assert(result.isOk() && result.value === Math.sqrt(5), "core smoke computation failed");

  const timeoutResult = await Op.try(
    (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        });
      }),
  )
    .withTimeout(1)
    .run();

  assert(
    timeoutResult.isErr() && timeoutResult.error instanceof TimeoutError,
    "timeout smoke failed",
  );

  const unexpectedResult = await Op.try(() => {
    throw "boom";
  }).run();

  assert(
    unexpectedResult.isErr() && unexpectedResult.error instanceof UnhandledException,
    "unexpected error smoke failed",
  );
};

const runSimpleExampleSmoke = async () => {
  const divideOk = await divide.run(10, 2);
  assert(divideOk.isOk() && divideOk.value === 5, "divide success check failed");

  const divideErr = await divide.run(10, 0);
  assert(
    divideErr.isErr() && divideErr.error instanceof DivisionByZeroError,
    "divide error check failed",
  );

  const sqrtOk = await sqrt.run(9);
  assert(sqrtOk.isOk() && sqrtOk.value === 3, "sqrt success check failed");

  const sqrtErr = await sqrt.run(-1);
  assert(sqrtErr.isErr() && sqrtErr.error instanceof NegativeError, "sqrt error check failed");
  if (sqrtErr.isErr() && sqrtErr.error instanceof NegativeError) {
    assert(sqrtErr.error.n === -1, "negative error payload check failed");
  }

  const composeResult = await mathComposeProgram.run();
  assert(
    composeResult.isErr() && composeResult.error instanceof NegativeError,
    "mathComposeProgram failure check failed",
  );

  const parseOk = await parseUser.run({ name: "Ada" });
  assert(parseOk.isOk() && parseOk.value.name === "Ada", "parseUser success check failed");

  const parseErr = await parseUser.run({ notName: 1 });
  assert(parseErr.isErr() && parseErr.error instanceof ParseError, "parseUser error check failed");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ name: "Ada" }), {
        status: 200,
        statusText: "OK",
      });
    const fetchOk = await fetchData.run("https://example.test/api/users/1");
    assert(
      fetchOk.isOk() && isNamedUser(fetchOk.value) && fetchOk.value.name === "Ada",
      "fetchData success check failed",
    );

    globalThis.fetch = async () => new Response(null, { status: 404, statusText: "Not Found" });
    const fetchErr = await fetchData.run("https://example.test/missing");
    assert(
      fetchErr.isErr() && fetchErr.error instanceof FetchError,
      "fetchData error type check failed",
    );
    if (fetchErr.isErr()) {
      assert(fetchErr.error.cause instanceof HttpError, "fetchData cause type check failed");
    }

    globalThis.fetch = async (url) => {
      assert(String(url) === "/api/users/123", "userProgram URL check failed");
      return new Response(JSON.stringify({ name: "Ada" }), {
        status: 200,
        statusText: "OK",
      });
    };
    const userOk = await userProgram.run("123");
    assert(userOk.isOk() && userOk.value.name === "Ada", "userProgram composition check failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const runWebhookExampleSmoke = async () => {
  let analyticsPublished = false;
  const appWithWarning = createApp(
    createDeps({
      sendReceipt: async () => {
        throw new Error("smtp unavailable");
      },
      publishAnalytics: async () => {
        analyticsPublished = true;
      },
    }),
  );
  const happyPath = await appWithWarning.processOrderWebhook.run(webhookPayload);
  assert(happyPath.isOk(), "webhook happy path check failed");
  if (happyPath.isOk()) {
    assert(happyPath.value.orderId === "ord-123", "happy path order id check failed");
    assert(happyPath.value.authorizationId === "auth-1", "happy path authorization check failed");
    assert(happyPath.value.warnings.length === 1, "happy path warnings check failed");
  }
  assert(analyticsPublished, "bounded allSettled drain check failed");

  const duplicateApp = createApp(createDeps({ isDuplicateEvent: async () => true }));
  const duplicate = await duplicateApp.processOrderWebhook.run(webhookPayload);
  assert(
    duplicate.isErr() && duplicate.error instanceof DuplicateEventError,
    "duplicate event check failed",
  );

  const invalidNegativeCents = await appWithWarning.processOrderWebhook.run({
    ...webhookPayload,
    totalCents: -1,
  });
  assert(
    invalidNegativeCents.isErr() && invalidNegativeCents.error instanceof InvalidWebhookError,
    "negative totalCents validation check failed",
  );

  const invalidNaNCents = await appWithWarning.processOrderWebhook.run({
    ...webhookPayload,
    totalCents: Number.NaN,
  });
  assert(
    invalidNaNCents.isErr() && invalidNaNCents.error instanceof InvalidWebhookError,
    "NaN totalCents validation check failed",
  );

  let paymentAttempts = 0;
  const retryPaymentApp = createApp(
    createDeps({
      authorizePayment: async () => {
        paymentAttempts += 1;
        if (paymentAttempts === 1) throw new RetryableError("payment timeout");
        return { approved: true, authorizationId: "auth-retried" };
      },
    }),
  );
  const retryPayment = await retryPaymentApp.processOrderWebhook.run(webhookPayload);
  assert(retryPayment.isOk(), "retry payment check failed");
  assert(paymentAttempts === 2, "retry payment attempts check failed");

  const fallbackRiskApp = createApp(
    createDeps({
      riskPrimary: async () => {
        throw new RetryableError("primary unavailable");
      },
      riskSecondary: async () => 0.2,
    }),
  );
  const fallbackRisk = await fallbackRiskApp.processOrderWebhook.run(webhookPayload);
  assert(fallbackRisk.isOk() && fallbackRisk.value.riskScore === 0.2, "risk fallback check failed");

  const allRiskFailApp = createApp(
    createDeps({
      riskPrimary: async () => {
        throw new RetryableError("primary unavailable");
      },
      riskSecondary: async () => {
        throw new RetryableError("secondary unavailable");
      },
    }),
  );
  const allRiskFail = await allRiskFailApp.processOrderWebhook.run(webhookPayload);
  assert(
    allRiskFail.isErr() && allRiskFail.error instanceof ErrorGroup,
    "all-risk-fail check failed",
  );

  const fraudApp = createApp(createDeps({ riskPrimary: async () => 0.97 }));
  const fraudResult = await fraudApp.processOrderWebhook.run(webhookPayload);
  assert(
    fraudResult.isErr() && fraudResult.error instanceof FraudRiskTooHighError,
    "fraud gate check failed",
  );

  let inventoryAborted = false;
  const abortedInventoryApp = createApp(
    createDeps({
      reserveInventory: async (_: unknown, signal: AbortSignal) => {
        try {
          await neverSettlesUntilAborted(signal);
          throw new Error("unreachable");
        } catch {
          inventoryAborted = signal.aborted;
          throw new RetryableError("inventory aborted");
        }
      },
      authorizePayment: async () => {
        throw new Error("payment terminal failure");
      },
    }),
  );
  const abortedInventoryResult = await abortedInventoryApp.processOrderWebhook.run(webhookPayload);
  assert(
    abortedInventoryResult.isErr() && abortedInventoryResult.error instanceof ServiceCallError,
    "inventory abort error type check failed",
  );
  assert(inventoryAborted, "inventory abort propagation check failed");
};

await runCoreApiSmoke();
await runSimpleExampleSmoke();
await runWebhookExampleSmoke();
