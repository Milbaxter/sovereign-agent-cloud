const $ = (s) => document.querySelector(s);
let info;
const notice = (s) => ($("#notice").textContent = s);
const errors = {
  SIGN_IN_FROM_YOUR_ACCOUNT:
    "Your session has ended. Return to your account and open your agent again.",
  AGENT_SUSPENDED:
    "Your agent is paused. Return to your account to check billing or contact support for an export.",
  DEVICE_DOES_NOT_MATCH_THIS_SESSION:
    "This request no longer matches your browser. Open the dashboard in this browser, then find it again.",
  FORBIDDEN:
    "Your access has ended. Return to your account and open your agent again.",
  LOGIN_REQUIRED:
    "Your access has ended. Return to your account and open your agent again.",
  FRESH_EXPORT_HANDOFF_REQUIRED:
    "Return to your account and request a new export before downloading.",
  EXPORT_EXPIRED:
    "This download has expired. Request a new export from your account.",
  NETWORK_ERROR:
    "Connection interrupted. Check your connection before trying again. Your action may have completed.",
  RATE_LIMITED: "Too many requests. Wait a minute, then try again.",
};
async function api(path, body) {
  let r;
  try {
    r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(
        path === "/api/local/export" ? 360000 : 70000,
      ),
    });
  } catch {
    throw Error("NETWORK_ERROR");
  }
  const d = await r.json().catch(() => null);
  if (!r.ok)
    throw Error(
      r.status === 429 ? "RATE_LIMITED" : d?.error || "OPERATION_FAILED",
    );
  if (!d || typeof d !== "object") throw Error("OPERATION_FAILED");
  return d;
}
const busy = new WeakSet();
const run = (f) => async (e) => {
  e?.preventDefault();
  const target = e?.currentTarget;
  if (target && busy.has(target)) return;
  const button =
    target?.tagName === "FORM" ? target.querySelector("button") : target;
  const label = button?.textContent;
  if (target) {
    busy.add(target);
    target.setAttribute("aria-busy", "true");
  }
  if (button) {
    button.disabled = true;
    button.textContent = "Working…";
  }
  try {
    await f();
  } catch (err) {
    notice(
      errors[err.message] ||
        "This action could not be completed. Return to your account to check your agent’s status, then try again.",
    );
  } finally {
    if (target) {
      busy.delete(target);
      target.removeAttribute("aria-busy");
    }
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
};
$("#copy").onclick = run(async () => {
  if (!info?.gatewayToken) {
    notice(
      "Your setup details are not available. Return to your account and open your agent again.",
    );
    return;
  }
  try {
    await navigator.clipboard.writeText(info.gatewayToken);
    notice(
      "Connection key copied. Paste it into your OpenClaw dashboard’s Gateway token field.",
    );
  } catch {
    notice(
      "Clipboard access was blocked. Allow clipboard access for this site, then try again.",
    );
  }
});
$("#devices").onclick = run(async () => {
  $("#pair").hidden = true;
  $('#pair input[name="requestId"]').value = "";
  $('#pair input[name="publicKey"]').value = "";
  const devices = await api("/api/local/devices");
  if (devices.pending?.length === 1) {
    $('#pair input[name="requestId"]').value = devices.pending[0].requestId;
    $('#pair input[name="publicKey"]').value = devices.pending[0].publicKey;
    $("#pair").hidden = false;
    $("#pending").textContent =
      "Your browser is ready to connect. Approve it below, then return to the dashboard.";
  } else {
    $("#pending").textContent =
      devices.pending?.length > 1
        ? "More than one connection request was found. Close duplicate dashboard tabs, reconnect, then find this browser again."
        : "No waiting connection found. Open the dashboard, paste your connection key and connect, then return here and try again. If already approved, you can use the dashboard directly.";
  }
});
$("#pair").onsubmit = run(async () => {
  await api("/api/local/pair", Object.fromEntries(new FormData($("#pair"))));
  $("#pair").hidden = true;
  $("#pending").textContent =
    "Browser approved. Return to the dashboard and reconnect to start chatting.";
  notice("Device approved. Reconnect your OpenClaw dashboard.");
});
$("#download").onclick = run(async () => {
  notice("Preparing your encrypted export…");
  $("#download").disabled = true;
  try {
    const d = await api("/api/local/export", {});
    const a = document.createElement("a");
    a.href = d.url;
    a.textContent = "Download encrypted archive";
    a.className = "button";
    $("#link").replaceChildren(a);
    notice("Ready. This download expires in ten minutes.");
  } finally {
    $("#download").disabled = false;
  }
});
(async () => {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  if (ticket) {
    history.replaceState(null, "", location.pathname);
    const d = await api("/handoff", { ticket });
    location.replace(d.next);
    return;
  }
  info = await api("/api/local/info");
  $("#account-link").href = info.controlOrigin;
  $("#account-link").hidden = false;
  $("#setup").hidden = info.action !== "access";
  $("#export").hidden = info.action !== "export";
  $("#mode").textContent =
    info.mode === "credits"
      ? "Your managed model connection is configured. Buy credit in your account before the first chat."
      : "Choose your model provider in the setup wizard, then connect your messaging channels.";
})().catch((e) =>
  notice(
    errors[e.message] ||
      "Setup could not be loaded. Return to your account and open your agent again.",
  ),
);
