import { describe, expect, test } from "bun:test";
import { PendingFlowRegistry } from "../../src/auth/backend/pending-flows.js";

function make(): { registry: PendingFlowRegistry; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const registry = new PendingFlowRegistry({
    ttlMs: 60_000,
    sweepIntervalMs: 1_000_000,
    now: () => clock.now,
  });
  return { registry, clock };
}

describe("PendingFlowRegistry", () => {
  test("register + findByState", () => {
    const { registry } = make();
    const flow = registry.register({
      state: "s1",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "https://issuer.example/auth?state=s1",
      codeVerifier: "v1",
    });
    expect(flow.createdAt).toBeGreaterThan(0);
    expect(registry.findByState("s1")?.state).toBe("s1");
    expect(registry.findByServer("disk")?.state).toBe("s1");
  });

  test("consumeByState removes the flow", () => {
    const { registry } = make();
    registry.register({
      state: "s1",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "https://issuer.example/auth",
      codeVerifier: "v1",
    });
    const consumed = registry.consumeByState("s1");
    expect(consumed?.serverName).toBe("disk");
    expect(registry.findByState("s1")).toBeUndefined();
    expect(registry.findByServer("disk")).toBeUndefined();
    registry.shutdown();
  });

  test("registering a new flow for the same server evicts the old state entry", () => {
    const { registry } = make();
    registry.register({
      state: "s1",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "u1",
      codeVerifier: "v1",
    });
    registry.register({
      state: "s2",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "u2",
      codeVerifier: "v2",
    });
    expect(registry.findByServer("disk")?.state).toBe("s2");
    expect(registry.findByState("s1")).toBeUndefined();
    registry.shutdown();
  });

  test("expired flows are dropped on lookup and sweep", () => {
    const { registry, clock } = make();
    registry.register({
      state: "s1",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "u1",
      codeVerifier: "v1",
    });
    clock.now += 61_000;
    expect(registry.findByState("s1")).toBeUndefined();
    registry.register({
      state: "s2",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "u2",
      codeVerifier: "v2",
    });
    clock.now += 61_000;
    registry.sweep();
    expect(registry.size()).toBe(0);
    registry.shutdown();
  });

  test("addSubscriber appends to an in-flight flow", () => {
    const { registry } = make();
    registry.register({
      state: "s1",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "u1",
      codeVerifier: "v1",
    });
    expect(registry.addSubscriber("disk", "sess2")).toBe(true);
    const flow = registry.findByServer("disk");
    expect(flow?.sessionIds.size).toBe(2);
    expect(flow?.sessionIds.has("sess1")).toBe(true);
    expect(flow?.sessionIds.has("sess2")).toBe(true);
    // Idempotent: adding the same subscriber again doesn't grow the set.
    registry.addSubscriber("disk", "sess2");
    expect(flow?.sessionIds.size).toBe(2);
    // Returns false for unknown servers.
    expect(registry.addSubscriber("unknown", "sess3")).toBe(false);
    registry.shutdown();
  });

  test("shutdown clears state and stops sweeper", () => {
    const { registry } = make();
    registry.register({
      state: "s1",
      serverName: "disk",
      sessionIds: new Set(["sess1"]),
      issuerUrl: "https://issuer.example",
      authorizationUrl: "u1",
      codeVerifier: "v1",
    });
    registry.shutdown();
    expect(registry.size()).toBe(0);
  });
});
