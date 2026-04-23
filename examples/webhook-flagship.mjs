import { Op, TypedError } from "@prodkit/op";

const retryTransient = {
  maxAttempts: 3,
  shouldRetry: (cause) => cause instanceof ServiceCallError && cause.retryable,
  getDelay: (attempt) => Math.min(50 * 2 ** (attempt - 1), 200),
};

const isString = (value) => typeof value === "string";

const parseWebhook = (raw) => {
  if (typeof raw !== "object" || raw === null) return null;
  if (!isString(raw.eventId)) return null;
  if (!isString(raw.orderId)) return null;
  if (!isString(raw.userId)) return null;
  if (!isString(raw.currency)) return null;
  if (typeof raw.totalCents !== "number") return null;
  if (!Array.isArray(raw.itemSkus)) return null;
  if (raw.itemSkus.some((sku) => !isString(sku))) return null;
  return {
    eventId: raw.eventId,
    orderId: raw.orderId,
    userId: raw.userId,
    currency: raw.currency,
    totalCents: raw.totalCents,
    itemSkus: raw.itemSkus,
  };
};

export class InvalidWebhookError extends TypedError("InvalidWebhookError") {}
export class DuplicateEventError extends TypedError("DuplicateEventError") {}
export class FraudRiskTooHighError extends TypedError("FraudRiskTooHighError") {}
export class InventoryUnavailableError extends TypedError("InventoryUnavailableError") {}
export class PaymentDeclinedError extends TypedError("PaymentDeclinedError") {}

export class ServiceCallError extends TypedError("ServiceCallError") {
  static from(service, cause) {
    if (cause instanceof ServiceCallError) return cause;
    const retryable =
      typeof cause === "object" &&
      cause !== null &&
      "retryable" in cause &&
      typeof cause.retryable === "boolean"
        ? cause.retryable
        : false;
    return new ServiceCallError({ service, retryable, cause });
  }
}

export const createApp = (deps) => {
  const parseWebhookPayload = Op(function* (raw) {
    const payload = parseWebhook(raw);
    if (payload === null) {
      return yield* new InvalidWebhookError({ issues: "Invalid webhook payload shape" });
    }
    return payload;
  });

  const checkDuplicate = Op(function* (eventId) {
    const duplicate = yield* Op.try(
      (signal) => deps.isDuplicateEvent(eventId, signal),
      (cause) => new ServiceCallError({ service: "idempotency-store", retryable: false, cause }),
    )
      .withRetry(retryTransient)
      .withTimeout(300);

    if (duplicate) return yield* new DuplicateEventError({ eventId });
    return;
  });

  const riskFromProvider = Op(function* (providerName, readRisk, userId) {
    return yield* Op.try(
      (signal) => readRisk(userId, signal),
      (cause) => ServiceCallError.from(providerName, cause),
    )
      .withRetry(retryTransient)
      .withTimeout(250);
  });

  const pickRiskScore = Op(function* (userId) {
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

  const reserveInventory = Op(function* (payload) {
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

  const authorizePayment = Op(function* (payload) {
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

  const processOrderWebhook = Op(function* (raw) {
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

    const [receiptResult, analyticsResult] = yield* Op.allSettled([
      Op.try(
        (signal) => deps.sendReceipt(processed, signal),
        (cause) => ServiceCallError.from("email", cause),
      ).withTimeout(300),
      Op.try(
        (signal) => deps.publishAnalytics(processed, signal),
        (cause) => ServiceCallError.from("analytics", cause),
      ).withTimeout(300),
    ]);

    const warnings = [];
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
