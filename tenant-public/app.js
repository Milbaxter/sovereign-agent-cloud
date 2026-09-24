const $ = (s) => document.querySelector(s);
let info;
const notice = (s) => ($("#notice").textContent = s);
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
const run = (f) => async (e) => {
  e?.preventDefault();
  try {
    await f();
  } catch (err) {
    notice(err.message);
  }
};
$("#copy").onclick = run(async () => {
  await navigator.clipboard.writeText(info.gatewayToken);
  notice("Gateway token copied. Paste it only into your OpenClaw dashboard.");
});
$("#devices").onclick = run(async () => {
  const devices = await api("/api/local/devices");
  $("#pending").textContent = JSON.stringify(devices, null, 2);
  if (devices.pending?.length === 1) {
    $('#pair input[name="requestId"]').value = devices.pending[0].requestId;
    $('#pair input[name="publicKey"]').value = devices.pending[0].publicKey;
  }
});
$("#pair").onsubmit = run(async () => {
  await api("/api/local/pair", Object.fromEntries(new FormData($("#pair"))));
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
  $("#setup").hidden = info.action !== "access";
  $("#export").hidden = info.action !== "export";
  $("#mode").textContent =
    info.mode === "credits"
      ? "Your managed model connection is configured. Buy credit in your account before the first chat."
      : "Choose your model provider in the setup wizard, then connect your messaging channels.";
})().catch((e) => notice(e.message));
