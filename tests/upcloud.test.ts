import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpCloud, assertEncryptedStorage } from "../src/providers/upcloud.js";
import { launchGate, type Config } from "../src/config.js";

test("server creation explicitly requests encryption of the cloned root disk", async (t) => {
  let request: any;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.upcloud.com/1.3/server");
    assert.equal(init.method, "POST");
    request = JSON.parse(String(init.body));
    return Response.json({ server: { uuid: "vm1" } });
  });
  const cloud = new UpCloud({
    UPCLOUD_TOKEN: "test-only",
    UPCLOUD_ZONE: "fi-hel1",
    UPCLOUD_PLAN: "test",
    UPCLOUD_TEMPLATE: "template1",
    ADMIN_SSH_PUBLIC_KEY: "ssh-ed25519 TEST",
  } as Config);
  await cloud.create("agent.test", "tenant1", "#!/bin/sh\ntrue");
  const disks = request.server.storage_devices.storage_device;
  assert.equal(disks.length, 1);
  assert.equal(disks[0].action, "clone");
  assert.equal(disks[0].storage, "template1");
  assert.equal(disks[0].encrypted, "yes");
});

test("encryption verification requires affirmative evidence for every disk", () => {
  const disk = { storage: "disk1", type: "disk", storage_encrypted: "yes" };
  const server = (devices: unknown) => ({
    storage_devices: { storage_device: devices },
  });
  assert.doesNotThrow(() => assertEncryptedStorage(server([disk])));
  assert.doesNotThrow(() =>
    assertEncryptedStorage(server([disk, { ...disk, storage: "disk2" }])),
  );
  for (const devices of [
    undefined,
    [],
    {},
    [null],
    [{ ...disk, storage: "" }],
    [{ ...disk, type: undefined }],
    [{ ...disk, storage_encrypted: undefined }],
    [{ ...disk, storage_encrypted: "no" }],
    [{ ...disk, storage_encrypted: true }],
    [disk, { ...disk, storage: "disk2", storage_encrypted: "no" }],
  ])
    assert.throws(
      () => assertEncryptedStorage(server(devices)),
      /PROVIDER_STORAGE_ENCRYPTION_UNVERIFIED/,
    );
});

test("live launch requires storage encryption evidence even when other gates pass", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sac-storage-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "evidence.json");
  const evidence = JSON.parse(await readFile("release-evidence.json", "utf8"));
  for (const key of Object.keys(evidence))
    evidence[key] = { passed: true, evidence: "synthetic test fixture only" };
  const c = {
    CHECKOUT_ENABLED: true,
    BILLING_MODE: "live",
    RELEASE_EVIDENCE_FILE: path,
  } as Config;
  for (const value of [
    undefined,
    { passed: false, evidence: "pending" },
    { passed: true, evidence: " " },
  ]) {
    evidence.storageEncryption = value;
    await writeFile(path, JSON.stringify(evidence));
    assert.throws(() => launchGate(c), /LAUNCH_EVIDENCE_MISSING/);
  }
  evidence.storageEncryption = { passed: true, evidence: "synthetic evidence" };
  await writeFile(path, JSON.stringify(evidence));
  assert.doesNotThrow(() => launchGate(c));
});
