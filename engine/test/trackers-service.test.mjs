import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { ClientStore } from "../dist/test/messaging/oauth.js";
import { ensureRegisteredClient } from "../dist/test/trackers/service.js";

test("ensureRegisteredClient: registers once; same port+issuer reuses; a new port or issuer registers again", async () => {
  const [a, b] = [await startFakeAuth(), await startFakeAuth()];
  try {
    const store = new ClientStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hf-reg-")), "linear-client.json"));
    const uri = (port) => `http://127.0.0.1:${port}/oauth/callback`;

    const first = await ensureRegisteredClient(store, { redirectUri: uri(47832), issuer: a.issuer });
    assert.equal(a.registrations.length, 1);
    assert.deepEqual(a.registrations[0].redirect_uris, [uri(47832)]);
    assert.equal(store.load().clientId, first.clientId);

    const again = await ensureRegisteredClient(store, { redirectUri: uri(47832), issuer: a.issuer });
    assert.equal(again.clientId, first.clientId);
    assert.equal(a.registrations.length, 1, "same port and issuer → no new registration");

    const moved = await ensureRegisteredClient(store, { redirectUri: uri(47900), issuer: a.issuer });
    assert.equal(a.registrations.length, 2, "new redirect port → registered again");
    assert.notEqual(moved.clientId, undefined);
    assert.equal(store.load().redirectUri, uri(47900));

    await ensureRegisteredClient(store, { redirectUri: uri(47900), issuer: b.issuer });
    assert.equal(b.registrations.length, 1, "another issuer → registered with it");
    assert.equal(store.load().issuer, b.issuer);
  } finally {
    await a.close();
    await b.close();
  }
});
