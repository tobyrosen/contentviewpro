import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { requireApiToken, tokenMatches, requireRelative, readContained, readOptional, writeContained } from "./security.js";

test("startup policy and digest token checks", () => {
  assert.throws(() => requireApiToken("0.0.0.0", false, ""), /CVP_TOKEN/);
  assert.throws(() => requireApiToken("127.0.0.1", true, " "), /CVP_TOKEN/);
  assert.doesNotThrow(() => requireApiToken("127.0.0.1", false, ""));
  assert.equal(tokenMatches("Bearer secret", "secret"), true);
  for (const header of [undefined, "secret", "Bearer wrong", "Bearer "]) {
    assert.equal(tokenMatches(header, "secret"), false);
  }
});

test("contained files reject traversal, symlinks, and non-regular files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cvp-security-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cvp-outside-"));
  try {
    await fs.mkdir(path.join(root, "drafts"));
    await fs.mkdir(path.join(root, "state"));
    await fs.writeFile(path.join(root, "drafts", "good.md"), "safe");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    assert.equal(await readContained(root, "drafts/good.md", [".md"]), "safe");
    await assert.rejects(readContained(root, "../secret.md", [".md"]));
    assert.throws(() => requireRelative("../secret.md", ".md"));
    assert.throws(() => requireRelative(outside + "/secret.md", ".md"));
    await fs.symlink(path.join(outside, "secret.md"), path.join(root, "drafts", "linked.md"));
    await assert.rejects(readContained(root, "drafts/linked.md", [".md"]));
    await assert.rejects(readContained(root, "drafts/good.md", [".json"]));
    await assert.rejects(readContained(root, "drafts", [".md"]));
    await fs.mkdir(path.join(root, "runs"));
    await fs.writeFile(path.join(outside, "run-1.json"), "{}");
    await fs.symlink(path.join(outside, "run-1.json"), path.join(root, "runs", "run-1.json"));
    await assert.rejects(readContained(root, "runs/run-1.json", [".json"]));
    await fs.symlink(path.join(outside, "secret.md"), path.join(root, "state", "bad.json"));
    await assert.rejects(writeContained(root, "state/bad.json", "{}"));
    await fs.rm(path.join(root, "state"), { recursive: true });
    await fs.symlink(outside, path.join(root, "state"));
    await assert.rejects(writeContained(root, "state/new.json", "{}"));
    assert.equal(await readOptional(root, "drafts/missing.md", [".md"]), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("browser bearer is tab-scoped and cleared on 401", async () => {
  const values = new Map<string, string>();
  let legacyRemoved = false;
  const persistentStorage = {
    removeItem: (key: string) => { assert.equal(key, "cvp_token"); legacyRemoved = true; },
    getItem: () => { throw new Error("persistent token read"); },
    setItem: () => { throw new Error("persistent token write"); },
  };
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent() {}, localStorage: persistentStorage }, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: persistentStorage, configurable: true });
  const oldFetch = globalThis.fetch;
  try {
    const api = await import("../src/lib/api.js");
    assert.ok(legacyRemoved);
    api.setToken("test-token");
    assert.equal(api.getToken(), "test-token");
    globalThis.fetch = async () => new Response("", { status: 401 });
    await assert.rejects(api.fetchArticles(), /Unauthorized/);
    assert.equal(api.getToken(), "");
  } finally {
    globalThis.fetch = oldFetch;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).sessionStorage;
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("API fails closed at startup and submit returns no local path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cvp-api-"));
  const cwd = path.resolve(import.meta.dirname, "..");
  const port = await freePort();
  const launch = (env: Record<string, string>) => spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd, env: { ...process.env, CVP_DATA_DIR: root, CVP_MINER_DIR: "runs", CVP_VOICE_SPEC: "voice.md", CVP_INSIGHTS_ROOT: root, CVP_DISABLE_WATCH: "1", PORT: String(port), HOST: "127.0.0.1", CVP_TOKEN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const denied = launch({ HOST: "0.0.0.0" });
    const deniedOutput: string[] = [];
    denied.stderr.on("data", (chunk) => deniedOutput.push(String(chunk)));
    const code = await new Promise<number | null>((resolve) => denied.on("exit", resolve));
    assert.notEqual(code, 0);
    assert.match(deniedOutput.join(""), /CVP_TOKEN/);

    const insightsDenied = launch({ CVP_MINER_DIR: "runs", CVP_INSIGHTS_ROOT: root });
    const insightsCode = await new Promise<number | null>((resolve) => insightsDenied.on("exit", resolve));
    assert.notEqual(insightsCode, 0);

    await fs.mkdir(path.join(root, "drafts"), { recursive: true });
    await fs.writeFile(path.join(root, "drafts", "test.md"), "First paragraph.");
    const server = launch({ CVP_TOKEN: "secret" });
    const serverErrors: string[] = [];
    server.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { await fetch(`http://127.0.0.1:${port}/api/articles`); ready = true; break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(ready, `server started: ${serverErrors.join("")}`);
      const url = `http://127.0.0.1:${port}/api/articles/test`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
      const headers = { Authorization: "Bearer secret" };
      assert.equal((await fetch(url, { headers })).status, 200);
      const submit = await fetch(url + "/submit", { method: "POST", headers });
      assert.equal(submit.status, 200);
      assert.deepEqual(await submit.json(), { ok: true });
    } finally {
      server.kill();
      if (server.exitCode === null) await new Promise((resolve) => server.on("exit", resolve));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
