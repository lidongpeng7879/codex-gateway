import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createApp, eventHandler, toNodeListener } from "h3";
import { tailscaleAccountForEvent } from "../../server/utils/gateway/auth/tailscale.ts";

const keys = [
  "CODEX_GATEWAY_TAILSCALE_LOGIN",
  "CODEX_GATEWAY_TAILSCALE_USER",
  "CODEX_GATEWAY_TAILSCALE_ORIGIN",
] as const;
const original = keys.map((key) => process.env[key]);
const origin = "https://gateway.example.ts.net:8443";
let server: Server;
let base = "";
const valid = {
  host: "gateway.example.ts.net:8443",
  origin,
  "content-type": "application/json",
  "tailscale-user-login": "owner@example.com",
};
before(async () => {
  process.env.CODEX_GATEWAY_TAILSCALE_LOGIN = "owner@example.com";
  process.env.CODEX_GATEWAY_TAILSCALE_USER = "existing-user";
  process.env.CODEX_GATEWAY_TAILSCALE_ORIGIN = origin;
  const app = createApp().use(
    eventHandler((event) => ({ account: tailscaleAccountForEvent(event) })),
  );
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  keys.forEach((key, i) => {
    const value = original[i];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});
async function request(headers: Record<string, string>) {
  // Native HTTP preserves the proxy's Host header; fetch rewrites Host to the target URL.
  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest(base, { method: "POST", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve(new Response(body, { status: response.statusCode ?? 500 })));
    });
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("HTTP auth test timed out")));
    request.end("{}");
  });
}
void test("exact trusted local proxy identity maps to configured account", async () => {
  const response = await request(valid);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account: "existing-user" });
});
for (const [name, key, value] of [
  ["another identity", "tailscale-user-login", "attacker@example.com"],
  ["multiple identities", "tailscale-user-login", "owner@example.com, attacker@example.com"],
  ["another host", "host", "attacker.example"],
  ["another origin", "origin", "https://attacker.example"],
  ["null origin", "origin", "null"],
  ["form content type", "content-type", "application/x-www-form-urlencoded"],
  ["cross-site fetch", "sec-fetch-site", "cross-site"],
] as const) {
  void test(`rejects ${name}`, async () =>
    assert.equal((await request({ ...valid, [key]: value })).status, 403));
}
void test("forwarded identity/IP does not replace missing identity header", async () => {
  const headers: Record<string, string> = {
    ...valid,
    "x-forwarded-for": "127.0.0.1",
    "x-tailscale-user-login": "owner@example.com",
  };
  delete headers["tailscale-user-login"];
  assert.equal((await request(headers)).status, 403);
});
void test("missing Origin is rejected", async () => {
  const headers: Record<string, string> = { ...valid };
  delete headers.origin;
  assert.equal((await request(headers)).status, 403);
});
void test("partial configuration fails closed", async () => {
  delete process.env.CODEX_GATEWAY_TAILSCALE_ORIGIN;
  try {
    assert.equal((await request(valid)).status, 503);
  } finally {
    process.env.CODEX_GATEWAY_TAILSCALE_ORIGIN = origin;
  }
});
void test("disabled mode is not an anonymous login", async () => {
  keys.forEach((key) => {
    delete process.env[key];
  });
  assert.equal((await request(valid)).status, 404);
});
