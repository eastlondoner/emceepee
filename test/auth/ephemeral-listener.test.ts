import { afterEach, describe, expect, test } from "bun:test";
import { EphemeralCallbackListener } from "../../src/auth/backend/ephemeral-listener.js";

const cleanups: EphemeralCallbackListener[] = [];
afterEach(async () => {
  for (const l of cleanups.splice(0)) {
    await l.close();
  }
});

describe("EphemeralCallbackListener", () => {
  test("resolves with code on a valid callback", async () => {
    const listener = await EphemeralCallbackListener.start({ expectedState: "abc" });
    cleanups.push(listener);

    const url = new URL(listener.redirectUri);
    url.searchParams.set("code", "the-code");
    url.searchParams.set("state", "abc");

    const [res, result] = await Promise.all([fetch(url.toString()), listener.result]);
    expect(res.status).toBe(200);
    expect(result.code).toBe("the-code");
    expect(result.state).toBe("abc");
    expect(result.error).toBeUndefined();
  });

  test("rejects a state mismatch without consuming the promise", async () => {
    const listener = await EphemeralCallbackListener.start({
      expectedState: "expected",
      timeoutMs: 500,
    });
    cleanups.push(listener);

    const bad = new URL(listener.redirectUri);
    bad.searchParams.set("code", "x");
    bad.searchParams.set("state", "wrong");
    const res = await fetch(bad.toString());
    expect(res.status).toBe(400);

    // The real callback should still work afterwards.
    const good = new URL(listener.redirectUri);
    good.searchParams.set("code", "x");
    good.searchParams.set("state", "expected");
    await fetch(good.toString());

    const result = await listener.result;
    expect(result.code).toBe("x");
  });

  test("surfaces OAuth error=access_denied", async () => {
    const listener = await EphemeralCallbackListener.start({ expectedState: "abc" });
    cleanups.push(listener);

    const url = new URL(listener.redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "nope");
    url.searchParams.set("state", "abc");
    await fetch(url.toString());

    const result = await listener.result;
    expect(result.error).toBe("access_denied");
    expect(result.errorDescription).toBe("nope");
  });

  test("times out cleanly when no callback arrives", async () => {
    const listener = await EphemeralCallbackListener.start({
      expectedState: "x",
      timeoutMs: 80,
    });
    cleanups.push(listener);

    const result = await listener.result;
    expect(result.error).toBe("timeout");
  });

  test("refuses non-loopback bind", async () => {
    await expect(
      EphemeralCallbackListener.start({ expectedState: "x", host: "0.0.0.0" })
    ).rejects.toThrow(/non-loopback/);
  });

  test("close() after resolution does not throw", async () => {
    const listener = await EphemeralCallbackListener.start({
      expectedState: "x",
      timeoutMs: 50,
    });
    await listener.result;
    await listener.close();
    await listener.close();
  });
});
