import { describe, expect, test } from "bun:test";
import { BackendTokenStore } from "../../src/auth/backend/token-store.js";

describe("BackendTokenStore", () => {
  test("getOrCreate returns stable reference", () => {
    const store = new BackendTokenStore();
    const a = store.getOrCreate("disk");
    const b = store.getOrCreate("disk");
    expect(a).toBe(b);
  });

  test("update merges fields", () => {
    const store = new BackendTokenStore();
    store.update("disk", { issuerUrl: "https://issuer.example" });
    store.update("disk", { codeVerifier: "verifier" });
    const entry = store.get("disk");
    expect(entry?.issuerUrl).toBe("https://issuer.example");
    expect(entry?.codeVerifier).toBe("verifier");
  });

  test("clearTokens drops tokens but keeps DCR/verifier info", () => {
    const store = new BackendTokenStore();
    store.update("disk", {
      tokens: { access_token: "a", token_type: "Bearer" },
      issuerUrl: "https://issuer.example",
      codeVerifier: "v",
    });
    store.clearTokens("disk");
    const entry = store.get("disk");
    expect(entry?.tokens).toBeUndefined();
    expect(entry?.issuerUrl).toBe("https://issuer.example");
    expect(entry?.codeVerifier).toBe("v");
  });

  test("clearVerifier drops verifier + state", () => {
    const store = new BackendTokenStore();
    store.update("disk", { codeVerifier: "v", pendingState: "s" });
    store.clearVerifier("disk");
    const entry = store.get("disk");
    expect(entry?.codeVerifier).toBeUndefined();
    expect(entry?.pendingState).toBeUndefined();
  });

  test("clear drops entry entirely", () => {
    const store = new BackendTokenStore();
    store.update("disk", { issuerUrl: "https://issuer.example" });
    store.clear("disk");
    expect(store.get("disk")).toBeUndefined();
  });
});
