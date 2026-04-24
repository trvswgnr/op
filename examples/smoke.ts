import { ErrorGroup, Op, TimeoutError, TypedError, UnexpectedError } from "@prodkit/op";
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
  ServiceCallError,
  createApp,
} from "./webhook-flagship.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const isNamedUser = (value: unknown): value is { name: string } => {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
};

const retryableError = (message: string) => Object.assign(new Error(message), { retryable: true });

const neverSettlesUntilAborted = (signal: AbortSignal) =>
  new Promise((_, reject) => {
    if (signal.aborted) return reject(retryableError("aborted"));
    signal.addEventListener("abort", () => reject(retryableError("aborted")), { once: true });
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
  class TooSmallError extends TypedError("TooSmallError") {}

  const localDivide = Op(function* (a: number, b: number) {
    if (b === 0) return yield* Op.fail(new TooSmallError({ message: "division by zero" }));
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

  assert(result.ok && result.value === Math.sqrt(5), "core smoke computation failed");

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

  assert(!timeoutResult.ok && timeoutResult.error instanceof TimeoutError, "timeout smoke failed");

  const unexpectedResult = await Op.try(() => {
    throw "boom";
  }).run();

  assert(
    !unexpectedResult.ok && unexpectedResult.error instanceof UnexpectedError,
    "unexpected error smoke failed",
  );
};

const runSimpleExampleSmoke = async () => {
  const divideOk = await divide.run(10, 2);
  assert(divideOk.ok && divideOk.value === 5, "divide success check failed");

  const divideErr = await divide.run(10, 0);
  assert(
    !divideErr.ok && divideErr.error instanceof DivisionByZeroError,
    "divide error check failed",
  );

  const sqrtOk = await sqrt.run(9);
  assert(sqrtOk.ok && sqrtOk.value === 3, "sqrt success check failed");

  const sqrtErr = await sqrt.run(-1);
  assert(!sqrtErr.ok && sqrtErr.error instanceof NegativeError, "sqrt error check failed");
  if (!sqrtErr.ok && sqrtErr.error instanceof NegativeError) {
    assert(sqrtErr.error.n === -1, "negative error payload check failed");
  }

  const composeResult = await mathComposeProgram.run();
  assert(
    !composeResult.ok && composeResult.error instanceof NegativeError,
    "mathComposeProgram failure check failed",
  );

  const parseOk = await parseUser.run({ name: "Ada" });
  assert(parseOk.ok && parseOk.value.name === "Ada", "parseUser success check failed");

  const parseErr = await parseUser.run({ notName: 1 });
  assert(!parseErr.ok && parseErr.error instanceof ParseError, "parseUser error check failed");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ name: "Ada" }), {
        status: 200,
        statusText: "OK",
      });
    const fetchOk = await fetchData.run("https://example.test/api/users/1");
    assert(
      fetchOk.ok && isNamedUser(fetchOk.value) && fetchOk.value.name === "Ada",
      "fetchData success check failed",
    );

    globalThis.fetch = async () => new Response(null, { status: 404, statusText: "Not Found" });
    const fetchErr = await fetchData.run("https://example.test/missing");
    assert(
      !fetchErr.ok && fetchErr.error instanceof FetchError,
      "fetchData error type check failed",
    );
    if (!fetchErr.ok) {
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
    assert(userOk.ok && userOk.value.name === "Ada", "userProgram composition check failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const runWebhookExampleSmoke = async () => {
  const appWithWarning = createApp(
    createDeps({
      sendReceipt: async () => {
        throw new Error("smtp unavailable");
      },
    }),
  );
  const happyPath = await appWithWarning.processOrderWebhook.run(webhookPayload);
  assert(happyPath.ok, "webhook happy path check failed");
  if (happyPath.ok) {
    assert(happyPath.value.orderId === "ord-123", "happy path order id check failed");
    assert(happyPath.value.authorizationId === "auth-1", "happy path authorization check failed");
    assert(happyPath.value.warnings.length === 1, "happy path warnings check failed");
  }

  const duplicateApp = createApp(createDeps({ isDuplicateEvent: async () => true }));
  const duplicate = await duplicateApp.processOrderWebhook.run(webhookPayload);
  assert(
    !duplicate.ok && duplicate.error instanceof DuplicateEventError,
    "duplicate event check failed",
  );

  let paymentAttempts = 0;
  const retryPaymentApp = createApp(
    createDeps({
      authorizePayment: async () => {
        paymentAttempts += 1;
        if (paymentAttempts === 1) throw retryableError("payment timeout");
        return { approved: true, authorizationId: "auth-retried" };
      },
    }),
  );
  const retryPayment = await retryPaymentApp.processOrderWebhook.run(webhookPayload);
  assert(retryPayment.ok, "retry payment check failed");
  assert(paymentAttempts === 2, "retry payment attempts check failed");

  const fallbackRiskApp = createApp(
    createDeps({
      riskPrimary: async () => {
        throw retryableError("primary unavailable");
      },
      riskSecondary: async () => 0.2,
    }),
  );
  const fallbackRisk = await fallbackRiskApp.processOrderWebhook.run(webhookPayload);
  assert(fallbackRisk.ok && fallbackRisk.value.riskScore === 0.2, "risk fallback check failed");

  const allRiskFailApp = createApp(
    createDeps({
      riskPrimary: async () => {
        throw retryableError("primary unavailable");
      },
      riskSecondary: async () => {
        throw retryableError("secondary unavailable");
      },
    }),
  );
  const allRiskFail = await allRiskFailApp.processOrderWebhook.run(webhookPayload);
  assert(!allRiskFail.ok && allRiskFail.error instanceof ErrorGroup, "all-risk-fail check failed");

  const fraudApp = createApp(createDeps({ riskPrimary: async () => 0.97 }));
  const fraudResult = await fraudApp.processOrderWebhook.run(webhookPayload);
  assert(
    !fraudResult.ok && fraudResult.error instanceof FraudRiskTooHighError,
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
          throw retryableError("inventory aborted");
        }
      },
      authorizePayment: async () => {
        throw new Error("payment terminal failure");
      },
    }),
  );
  const abortedInventoryResult = await abortedInventoryApp.processOrderWebhook.run(webhookPayload);
  assert(
    !abortedInventoryResult.ok && abortedInventoryResult.error instanceof ServiceCallError,
    "inventory abort error type check failed",
  );
  assert(inventoryAborted, "inventory abort propagation check failed");
};

await runCoreApiSmoke();
await runSimpleExampleSmoke();
await runWebhookExampleSmoke();
