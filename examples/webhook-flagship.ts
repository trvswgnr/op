import { Op, TypedError } from "@prodkit/op";

type WebhookPayload = {
  eventId: string;
  orderId: string;
  userId: string;
  currency: string;
  totalCents: number;
  itemSkus: string[];
};

type InventoryReservation = {
  reservationId: string;
  reserved: boolean;
};

type PaymentAuthorization = {
  approved: boolean;
  authorizationId?: string;
  declineReason?: string;
};

type ProcessedOrder = {
  orderId: string;
  reservationId: string;
  authorizationId: string;
  riskScore: number;
  fraudPolicyVersion: string;
  warnings: string[];
};

type PersistedOrder = ProcessedOrder & {
  eventId: string;
  processedAt: string;
};

export type AppDeps = {
  isDuplicateEvent: (eventId: string, signal: AbortSignal) => Promise<boolean>;
  reserveInventory: (payload: WebhookPayload, signal: AbortSignal) => Promise<InventoryReservation>;
  authorizePayment: (payload: WebhookPayload, signal: AbortSignal) => Promise<PaymentAuthorization>;
  riskPrimary: (userId: string, signal: AbortSignal) => Promise<number>;
  riskSecondary: (userId: string, signal: AbortSignal) => Promise<number>;
  loadFraudPolicyFromCache: (signal: AbortSignal) => Promise<string>;
  loadFraudPolicyFromConfig: (signal: AbortSignal) => Promise<string>;
  persistOrder: (order: PersistedOrder, signal: AbortSignal) => Promise<void>;
  markEventProcessed: (eventId: string, signal: AbortSignal) => Promise<void>;
  sendReceipt: (order: ProcessedOrder, signal: AbortSignal) => Promise<void>;
  publishAnalytics: (order: ProcessedOrder, signal: AbortSignal) => Promise<void>;
  nowIso: () => string;
};

const retryTransient = {
  maxAttempts: 3,
  shouldRetry: (cause: unknown) => cause instanceof ServiceCallError && cause.retryable,
  getDelay: (attempt: number) => Math.min(50 * 2 ** (attempt - 1), 200),
};

const BEST_EFFORT_SIDE_EFFECT_CONCURRENCY = 1;

const isString = (value: unknown): value is string => typeof value === "string";

const parseWebhook = (raw: unknown): WebhookPayload | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as Record<string, unknown>;
  if (!isString(payload.eventId)) return null;
  if (!isString(payload.orderId)) return null;
  if (!isString(payload.userId)) return null;
  if (!isString(payload.currency)) return null;
  if (typeof payload.totalCents !== "number") return null;
  if (!Array.isArray(payload.itemSkus)) return null;
  if (payload.itemSkus.some((sku) => !isString(sku))) return null;
  return {
    eventId: payload.eventId,
    orderId: payload.orderId,
    userId: payload.userId,
    currency: payload.currency,
    totalCents: payload.totalCents,
    itemSkus: payload.itemSkus,
  };
};

export class InvalidWebhookError extends TypedError("InvalidWebhookError")<{
  issues: string;
}> {}
export class DuplicateEventError extends TypedError("DuplicateEventError")<{ eventId: string }> {}
export class FraudRiskTooHighError extends TypedError("FraudRiskTooHighError")<{
  userId: string;
  score: number;
  threshold: number;
}> {}
export class InventoryUnavailableError extends TypedError("InventoryUnavailableError")<{
  orderId: string;
}> {}
export class PaymentDeclinedError extends TypedError("PaymentDeclinedError")<{
  orderId: string;
}> {}

export class ServiceCallError extends TypedError("ServiceCallError")<{
  service: string;
  retryable: boolean;
}> {
  static from(service: string, cause: unknown) {
    if (cause instanceof ServiceCallError) return cause;
    const retryable =
      typeof cause === "object" &&
      cause !== null &&
      "retryable" in cause &&
      typeof (cause as { retryable?: unknown }).retryable === "boolean"
        ? (cause as { retryable: boolean }).retryable
        : false;
    return new ServiceCallError({ service, retryable, cause });
  }
}

export const createApp = (deps: AppDeps) => {
  const parseWebhookPayload = Op(function* (raw: unknown) {
    const payload = parseWebhook(raw);
    if (payload === null) {
      return yield* new InvalidWebhookError({ issues: "Invalid webhook payload shape" });
    }
    return payload;
  });

  const checkDuplicate = Op(function* (eventId: string) {
    const duplicate = yield* Op.try(
      (signal) => deps.isDuplicateEvent(eventId, signal),
      (cause) => new ServiceCallError({ service: "idempotency-store", retryable: false, cause }),
    )
      .withRetry(retryTransient)
      .withTimeout(300);

    if (duplicate) return yield* new DuplicateEventError({ eventId });
    return;
  });

  const riskFromProvider = Op(function* (
    providerName: string,
    readRisk: (userId: string, signal: AbortSignal) => Promise<number>,
    userId: string,
  ) {
    return yield* Op.try(
      (signal) => readRisk(userId, signal),
      (cause) => ServiceCallError.from(providerName, cause),
    )
      .withRetry(retryTransient)
      .withTimeout(250);
  });

  const pickRiskScore = Op(function* (userId: string) {
    return yield* Op.any([
      riskFromProvider("risk-primary", deps.riskPrimary, userId),
      riskFromProvider("risk-secondary", deps.riskSecondary, userId),
    ]).withTimeout(600);
  });

  const loadFraudPolicyVersion = Op(function* () {
    return yield* Op.race([
      Op.try(
        (signal) => deps.loadFraudPolicyFromCache(signal),
        (cause) => ServiceCallError.from("fraud-policy-cache", cause),
      ).withTimeout(80),
      Op.try(
        (signal) => deps.loadFraudPolicyFromConfig(signal),
        (cause) => ServiceCallError.from("fraud-policy-config", cause),
      ).withTimeout(200),
    ]);
  });

  const reserveInventory = Op(function* (payload: WebhookPayload) {
    const reservation = yield* Op.try(
      (signal) => deps.reserveInventory(payload, signal),
      (cause) => ServiceCallError.from("inventory", cause),
    )
      .withRetry(retryTransient)
      .withTimeout(500);

    if (!reservation.reserved) {
      return yield* new InventoryUnavailableError({ orderId: payload.orderId });
    }
    return reservation;
  });

  const authorizePayment = Op(function* (payload: WebhookPayload) {
    const payment = yield* Op.try(
      (signal) => deps.authorizePayment(payload, signal),
      (cause) => ServiceCallError.from("payment", cause),
    )
      .withRetry(retryTransient)
      .withTimeout(500);

    if (!payment.approved || payment.authorizationId === undefined) {
      return yield* new PaymentDeclinedError({
        orderId: payload.orderId,
        message: payment.declineReason ?? "Payment provider declined authorization",
      });
    }

    return { ...payment, authorizationId: payment.authorizationId };
  });

  const processOrderWebhook = Op(function* (raw: unknown) {
    const payload = yield* parseWebhookPayload(raw);
    yield* checkDuplicate(payload.eventId);

    const [policyVersionResult] = yield* Op.allSettled([loadFraudPolicyVersion]);
    const fraudPolicyVersion = policyVersionResult.ok ? policyVersionResult.value : "unknown";

    const riskScore = yield* pickRiskScore(payload.userId);
    const riskThreshold = 0.9;
    if (riskScore >= riskThreshold) {
      return yield* new FraudRiskTooHighError({
        userId: payload.userId,
        score: riskScore,
        threshold: riskThreshold,
      });
    }

    // Unbounded fan-out is right when every child should start immediately and fail-fast together.
    const [reservation, payment] = yield* Op.all([
      reserveInventory(payload),
      authorizePayment(payload),
    ]);

    const processed = {
      orderId: payload.orderId,
      reservationId: reservation.reservationId,
      authorizationId: payment.authorizationId,
      riskScore,
      fraudPolicyVersion,
      warnings: [],
    };

    yield* Op.try(
      (signal) =>
        deps.persistOrder(
          { ...processed, eventId: payload.eventId, processedAt: deps.nowIso() },
          signal,
        ),
      (cause) => ServiceCallError.from("orders-store", cause),
    )
      .withRetry(retryTransient)
      .withTimeout(500);

    yield* Op.try(
      (signal) => deps.markEventProcessed(payload.eventId, signal),
      (cause) => ServiceCallError.from("idempotency-store", cause),
    )
      .withRetry(retryTransient)
      .withTimeout(300);

    // Bounded fan-out is useful for best-effort side effects that may share provider limits.
    const [receiptResult, analyticsResult] = yield* Op.allSettled(
      [
        Op.try(
          (signal) => deps.sendReceipt(processed, signal),
          (cause) => ServiceCallError.from("email", cause),
        ).withTimeout(300),
        Op.try(
          (signal) => deps.publishAnalytics(processed, signal),
          (cause) => ServiceCallError.from("analytics", cause),
        ).withTimeout(300),
      ],
      BEST_EFFORT_SIDE_EFFECT_CONCURRENCY,
    );

    const warnings: string[] = [];
    if (!receiptResult.ok) warnings.push(String(receiptResult.error));
    if (!analyticsResult.ok) warnings.push(String(analyticsResult.error));
    return { ...processed, warnings };
  });

  return {
    parseWebhookPayload,
    checkDuplicate,
    pickRiskScore,
    loadFraudPolicyVersion,
    reserveInventory,
    authorizePayment,
    processOrderWebhook,
  };
};
