import { assert, describe, expect, test, vi } from "vitest";
import {
  DuplicateEventError,
  FraudRiskTooHighError,
  ServiceCallError,
  type WebhookDeps,
  createApp,
} from "./webhook-flagship.js";
import { ErrorGroup } from "../index.js";

function retryableError(message: string): Error & { retryable: boolean } {
  return Object.assign(new Error(message), { retryable: true });
}

function neverSettlesUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      return reject(retryableError("aborted"));
    }

    signal.addEventListener("abort", () => reject(retryableError("aborted")), { once: true });
  });
}

function createDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
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
  };
}

const webhookPayload = {
  eventId: "evt-123",
  orderId: "ord-123",
  userId: "usr-123",
  currency: "USD",
  totalCents: 4200,
  itemSkus: ["SKU-1", "SKU-2"],
};

describe("examples/webhook-flagship", () => {
  test("processes webhook, tolerating non-critical side-effect failure", async () => {
    const deps = createDeps({
      sendReceipt: async () => {
        throw new Error("smtp unavailable");
      },
    });
    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    assert(result.ok, "result.ok should be true");
    expect(result.value.orderId).toBe("ord-123");
    expect(result.value.authorizationId).toBe("auth-1");
    expect(result.value.fraudPolicyVersion).toBe("policy-cache-v1");
    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toContain("ServiceCallError");
  });

  test("fails fast on duplicate event", async () => {
    const deps = createDeps({
      isDuplicateEvent: async () => true,
    });
    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(DuplicateEventError);
  });

  test("retries transient payment failure and succeeds", async () => {
    const attempts = vi.fn();
    attempts
      .mockRejectedValueOnce(retryableError("payment timeout"))
      .mockResolvedValue({ approved: true, authorizationId: "auth-retried" });

    const deps = createDeps({
      authorizePayment: async () => attempts(),
    });

    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    expect(result.ok).toBe(true);
    expect(attempts).toHaveBeenCalledTimes(2);
    assert(result.ok, "result.ok should be true");
    expect(result.value.authorizationId).toBe("auth-retried");
  });

  test("uses fallback risk provider when primary fails", async () => {
    const deps = createDeps({
      riskPrimary: async () => {
        throw retryableError("primary unavailable");
      },
      riskSecondary: async () => 0.2,
    });

    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    expect(result.ok).toBe(true);
    assert(result.ok, "result.ok should be true");
    expect(result.value.riskScore).toBe(0.2);
  });

  test("fails with ErrorGroup when all risk providers fail", async () => {
    const deps = createDeps({
      riskPrimary: async () => {
        throw retryableError("primary unavailable");
      },
      riskSecondary: async () => {
        throw retryableError("secondary unavailable");
      },
    });

    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    assert(!result.ok, "result.ok should be false");
    expect(result.error).toBeInstanceOf(ErrorGroup);
  });

  test("fails with FraudRiskTooHighError when score exceeds threshold", async () => {
    const deps = createDeps({
      riskPrimary: async () => 0.97,
    });

    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    assert(!result.ok, "result.ok should be false");
    expect(result.error).toBeInstanceOf(FraudRiskTooHighError);
  });

  test("aborts in-flight inventory call when payment fails in Op.all", async () => {
    let inventoryAborted = false;
    const deps = createDeps({
      reserveInventory: async (_, signal) => {
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
    });

    const app = createApp(deps);
    const result = await app.processOrderWebhook.run(webhookPayload);
    assert(!result.ok, "result.ok should be false");
    expect(inventoryAborted).toBe(true);
    expect(result.error).toBeInstanceOf(ServiceCallError);
  });
});
