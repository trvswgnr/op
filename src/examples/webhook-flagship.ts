import path from "node:path";
import { fileURLToPath } from "node:url";
import { Op, TypedError } from "../index.js";
import * as v from "valibot";

function isMainModule(): boolean {
  const entry = typeof process !== "undefined" ? process.argv[1] : undefined;
  if (entry === undefined) return false;
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(thisFile) === path.resolve(entry);
}

export type OrderWebhook = {
  eventId: string;
  orderId: string;
  userId: string;
  currency: string;
  totalCents: number;
  itemSkus: readonly string[];
};

export type ReservationResult = {
  reservationId: string;
  reserved: boolean;
};

export type PaymentResult = {
  approved: boolean;
  authorizationId?: string;
  declineReason?: string;
};

export type ProcessedWebhook = {
  orderId: string;
  reservationId: string;
  authorizationId: string;
  riskScore: number;
  fraudPolicyVersion: string;
  warnings: readonly string[];
};

export type WebhookDeps = {
  isDuplicateEvent: (eventId: string, signal: AbortSignal) => Promise<boolean>;
  reserveInventory: (payload: OrderWebhook, signal: AbortSignal) => Promise<ReservationResult>;
  authorizePayment: (payload: OrderWebhook, signal: AbortSignal) => Promise<PaymentResult>;
  riskPrimary: (userId: string, signal: AbortSignal) => Promise<number>;
  riskSecondary: (userId: string, signal: AbortSignal) => Promise<number>;
  loadFraudPolicyFromCache: (signal: AbortSignal) => Promise<string>;
  loadFraudPolicyFromConfig: (signal: AbortSignal) => Promise<string>;
  persistOrder: (
    payload: ProcessedWebhook & { eventId: string; processedAt: string },
    signal: AbortSignal,
  ) => Promise<void>;
  markEventProcessed: (eventId: string, signal: AbortSignal) => Promise<void>;
  sendReceipt: (payload: ProcessedWebhook, signal: AbortSignal) => Promise<void>;
  publishAnalytics: (payload: ProcessedWebhook, signal: AbortSignal) => Promise<void>;
  nowIso: () => string;
};

const RetryableHint = v.object({ retryable: v.boolean() });
const WebhookPayload = v.object({
  eventId: v.string(),
  orderId: v.string(),
  userId: v.string(),
  currency: v.string(),
  totalCents: v.number(),
  itemSkus: v.array(v.string()),
});

export class InvalidWebhookError extends TypedError("InvalidWebhookError")<{
  issues: v.FlatErrors<typeof WebhookPayload>;
}> {}
export class DuplicateEventError extends TypedError("DuplicateEventError")<{
  eventId: string;
}> {}
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
  static from(service: string, cause: unknown): ServiceCallError {
    if (cause instanceof ServiceCallError) return cause;
    const retryable = v.is(RetryableHint, cause) ? cause.retryable : false;
    return new ServiceCallError({ service, retryable, cause });
  }
}

const retryTransient = {
  maxAttempts: 3,
  shouldRetry: (cause: unknown): boolean => cause instanceof ServiceCallError && cause.retryable,
  getDelay: (attempt: number): number => Math.min(50 * 2 ** (attempt - 1), 200),
};

export const createApp = (deps: WebhookDeps) => {
  const parseWebhookPayload = Op(function* (raw: unknown) {
    const payload = v.safeParse(WebhookPayload, raw);
    if (!payload.success) {
      return yield* new InvalidWebhookError({ issues: v.flatten(payload.issues) });
    }
    return payload.output;
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
    providerName: "risk-primary" | "risk-secondary",
    readRisk: WebhookDeps["riskPrimary"] | WebhookDeps["riskSecondary"],
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

  const reserveInventory = Op(function* (payload: OrderWebhook) {
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

  const authorizePayment = Op(function* (payload: OrderWebhook) {
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

    const [reservation, payment] = yield* Op.all([
      reserveInventory(payload),
      authorizePayment(payload),
    ]);

    const processed: ProcessedWebhook = {
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

if (isMainModule()) {
  console.log(
    "Run webhook-flagship in tests/docs with dependency fakes; see src/examples/webhook-flagship.test.ts",
  );
}
