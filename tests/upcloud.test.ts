import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchGate, type Config } from "../src/config.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UpCloud,
  assertEncryptedStorage,
  createRejected,
  type UpCloudConfig,
} from "../src/providers/upcloud.js";

const config: UpCloudConfig = {
  UPCLOUD_TOKEN: "test-secret",
  UPCLOUD_ZONE: "fi-hel1",
  UPCLOUD_PLAN: "selected-plan",
  UPCLOUD_TEMPLATE: "selected-template",
  ADMIN_SSH_PUBLIC_KEY: "ssh-ed25519 test-key",
  BILLING_MODE: "test",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

test("cloud-init creation enables metadata and passes the bootstrap script and SSH key", async () => {
  const cloud = new UpCloud(config, async (url, init) => {
    assert.equal(url, "https://api.upcloud.com/1.3/server");
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-secret",
    );
    const { server } = JSON.parse(String(init?.body));
    assert.equal(server.metadata, "yes");
    assert.equal(server.firewall, "on");
    assert.equal(server.zone, "fi-hel1");
    assert.equal(server.user_data, "#!/bin/bash\ntouch /root/booted");
    assert.equal(server.login_user.create_password, "no");
    assert.deepEqual(server.login_user.ssh_keys.ssh_key, [
      config.ADMIN_SSH_PUBLIC_KEY,
    ]);
    assert.deepEqual(
      server.networking.interfaces.interface.map((i: any) => i.type),
      ["public"],
    );
    return json({ server: { uuid: "created-vm" } }, 202);
  });
  assert.equal(
    (
      await cloud.create(
        "tenant.example",
        "tenant-id",
        "#!/bin/bash\ntouch /root/booted",
      )
    ).uuid,
    "created-vm",
  );
});

test("provider error codes survive without exposing error descriptions or inputs", async () => {
  const cloud = new UpCloud(config, async () =>
    json(
      {
        error: {
          error_code: "METADATA_DISABLED_ON_CLOUD-INIT",
          error_message: "secret echoed input: test-secret",
        },
      },
      409,
    ),
  );
  await assert.rejects(
    cloud.create("tenant.example", "tenant", "private-userdata"),
    (error: any) => {
      assert.equal(
        error.message,
        "UPCLOUD_409_METADATA_DISABLED_ON_CLOUD_INIT",
      );
      assert.equal(error.status, 409);
      assert.equal(createRejected(error), true);
      assert.ok(!JSON.stringify(error).includes("test-secret"));
      return true;
    },
  );
});

test("non-JSON and untrusted error codes remain safe status-only failures", async () => {
  for (const response of [
    new Response("proxy failure with private input", { status: 502 }),
    json({ error: { error_code: "secret echoed input" } }, 502),
  ]) {
    const cloud = new UpCloud(config, async () => response);
    await assert.rejects(cloud.call("/account"), (error: any) => {
      assert.equal(error.message, "UPCLOUD_502");
      assert.equal(createRejected(error), false);
      return true;
    });
  }
});

test("transport errors and timeouts cannot trigger a second create", () => {
  for (const status of [undefined, 408, 500, 502, 503, 504])
    assert.equal(createRejected({ status }), false);
  for (const status of [400, 401, 402, 403, 404, 409, 422, 429])
    assert.equal(createRejected({ status }), true);
});

test("missing token fails before any network request", async () => {
  const cloud = new UpCloud({ ...config, UPCLOUD_TOKEN: "" }, async () => {
    assert.fail("must not contact the provider");
  });
  await assert.rejects(cloud.call("/account"), /UPCLOUD_TOKEN_REQUIRED/);
});

test("inventory reads later pages and refuses malformed inventory", async () => {
  const cloud = new UpCloud(config, async (url) => {
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    return json({
      servers: {
        server:
          offset === 0
            ? Array.from({ length: 100 }, (_, i) => ({
                uuid: String(i),
                hostname: `other-${i}`,
              }))
            : [{ uuid: "target", hostname: "tenant.example" }],
      },
    });
  });
  assert.equal((await cloud.find("tenant.example")).uuid, "target");
  const malformed = new UpCloud(config, async () => json({}));
  await assert.rejects(
    malformed.find("tenant.example"),
    /UPCLOUD_INVALID_INVENTORY/,
  );
});

test("deletion waits for stop and retries disk cleanup after VM is already gone", async () => {
  const calls: string[] = [];
  let exists = true;
  const cloud = new UpCloud(config, async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/1.3", "");
    calls.push(`${init?.method} ${path}`);
    if (path === "/server/vm" && init?.method === "GET")
      return exists
        ? json({ server: { state: "started" } })
        : json({ error: { error_code: "SERVER_NOT_FOUND" } }, 404);
    if (path.endsWith("/stop"))
      return json({ server: { state: "maintenance" } }, 202);
    assert.equal(path, "/storage/disk");
    assert.equal(init?.method, "DELETE");
    return new Response(null, { status: 204 });
  });
  await assert.rejects(cloud.destroy("vm", ["disk"]), /WAITING_FOR_STOP/);
  assert.ok(!calls.some((c) => c.startsWith("DELETE")));
  exists = false;
  await cloud.destroy("vm", ["disk"]);
  assert.equal(calls.at(-1), "DELETE /storage/disk");
});

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

test("parking stops the VM and verifies a non-compute-billed plan without deleting disks", async () => {
  const cloud = new UpCloud({} as Config);
  let state = "started",
    plan = "STARTER-2xCPU-4GB";
  const actions: string[] = [];
  cloud.details = async () => ({ state, plan });
  cloud.call = async (path, method, body: any) => {
    if (path.endsWith("/stop")) {
      assert.equal(body.stop_server.timeout, 120);
      actions.push("stop");
      state = "stopped";
    } else {
      assert.equal(method, "PUT");
      assert.equal(state, "stopped");
      assert.deepEqual(body, { server: { plan: "CLOUDNATIVE-1xCPU-4GB" } });
      actions.push("plan");
      plan = body.server.plan;
    }
  };
  await cloud.park("vm1");
  await cloud.park("vm1");
  assert.deepEqual(actions, ["stop", "plan"]);
});

test("parking waits for confirmed shutdown and rejects an unconfirmed plan change", async () => {
  const cloud = new UpCloud({} as Config);
  let state = "started";
  cloud.details = async () => ({ state, plan: "STARTER-2xCPU-4GB" });
  cloud.call = async (_path, method) => {
    assert.notEqual(method, "DELETE");
  };
  await assert.rejects(cloud.park("vm1"), /WAITING_FOR_STOP/);
  state = "stopped";
  await assert.rejects(cloud.park("vm1"), /PROVIDER_PLAN_NOT_CONFIRMED/);
});
