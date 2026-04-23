import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { FileDcrStore, normalizeIssuer } from "../../src/auth/backend/dcr-store.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "emceepee-dcr-"));
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeClient(overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
  return {
    client_id: "cid-1",
    client_secret: "secret",
    redirect_uris: ["http://localhost:8080/oauth/callback"],
    ...overrides,
  } as OAuthClientInformationFull;
}

describe("FileDcrStore", () => {
  test("normalizeIssuer strips trailing slash + lowercases host", () => {
    expect(normalizeIssuer("https://Issuer.Example/")).toBe("https://issuer.example");
    expect(normalizeIssuer("https://issuer.example/realm/")).toBe(
      "https://issuer.example/realm"
    );
  });

  test("put and get round-trip by issuer", () => {
    const dir = tmpDir();
    cleanups.push(dir);
    const store = new FileDcrStore({ path: join(dir, "dcr.json") });
    store.put("https://issuer.example", makeClient());
    expect(store.get("https://issuer.example")?.client_id).toBe("cid-1");
    expect(store.get("https://Issuer.Example/")?.client_id).toBe("cid-1");
  });

  test("persists across instances", () => {
    const dir = tmpDir();
    cleanups.push(dir);
    const path = join(dir, "dcr.json");
    new FileDcrStore({ path }).put("https://issuer.example", makeClient());
    const second = new FileDcrStore({ path });
    expect(second.size()).toBe(1);
    expect(second.get("https://issuer.example")?.client_id).toBe("cid-1");
  });

  test("atomic write leaves a single json file", () => {
    const dir = tmpDir();
    cleanups.push(dir);
    const path = join(dir, "dcr.json");
    const store = new FileDcrStore({ path });
    store.put("https://issuer.example", makeClient());
    store.put("https://other.example", makeClient({ client_id: "cid-2" }));

    const files = readdirSync(dir).filter((f) => !f.endsWith(".tmp"));
    expect(files).toEqual(["dcr.json"]);
    const body = JSON.parse(readFileSync(path, "utf-8")) as { clients: Record<string, unknown> };
    expect(Object.keys(body.clients).sort()).toEqual([
      "https://issuer.example",
      "https://other.example",
    ]);
  });

  test("corrupt file is moved aside and store starts empty", () => {
    const dir = tmpDir();
    cleanups.push(dir);
    const path = join(dir, "dcr.json");
    writeFileSync(path, "not json!");
    const store = new FileDcrStore({ path });
    expect(store.size()).toBe(0);
    const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(backups.length).toBe(1);
  });

  test("delete removes an entry", () => {
    const dir = tmpDir();
    cleanups.push(dir);
    const path = join(dir, "dcr.json");
    const store = new FileDcrStore({ path });
    store.put("https://issuer.example", makeClient());
    store.delete("https://issuer.example");
    expect(store.get("https://issuer.example")).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});
