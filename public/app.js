const $ = (s) => document.querySelector(s),
  notice = (s) => ($("#notice").textContent = s);
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error);
  return data;
}
const run = (fn) => async (e) => {
  e?.preventDefault();
  try {
    await fn(e);
  } catch (err) {
    notice(
      err.message === "FRESH_LOGIN_REQUIRED"
        ? "Request a new sign-in link before exporting, changing SSH access, or cancelling."
        : err.message,
    );
  }
};
const jump = async (path, body = {}) => {
  const data = await api(path, body);
  location.assign(data.url);
};
let catalog, me, timer, renderedAgent;
const initialMode = new URLSearchParams(location.search).get("mode");
if (["byok", "credits"].includes(initialMode)) $("#mode").value = initialMode;
async function refresh() {
  clearTimeout(timer);
  catalog = await api("/api/catalog");
  try {
    me = await api("/api/me");
  } catch {
    me = null;
  }
  $("#login").hidden = !!me;
  $("#account").hidden = !me;
  if (!catalog.checkoutEnabled)
    notice(
      "Preview: checkout is disabled until launch verification is complete.",
    );
  if (!me) {
    renderedAgent = undefined;
    $("#agent").replaceChildren();
    return;
  }
  $("#email").textContent = me.email;
  const t = me.tenants[0];
  $("#purchase").hidden = !!t && t.state !== "pending_payment";
  $("#checkout").disabled = !catalog.checkoutEnabled;
  $("#topup").disabled =
    !catalog.checkoutEnabled ||
    !catalog.creditsEnabled ||
    !t ||
    t.mode !== "credits" ||
    !["ready", "awaiting_setup"].includes(t.state);
  const selectedModel = $("#model").value;
  $("#model").replaceChildren(
    ...catalog.models.map((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.label} · ${m.provider} · ${m.country}`;
      return o;
    }),
  );
  if (catalog.models.some((m) => m.id === selectedModel))
    $("#model").value = selectedModel;
  if (t?.state === "pending_payment") {
    $("#mode").value = t.mode;
    if (t.model_id) $("#model").value = t.model_id;
  }
  $("#mode").disabled = t?.state === "pending_payment";
  $("#model").disabled = t?.state === "pending_payment";
  $("#balance").textContent =
    `Balance: €${(Number(me.wallet.balance) / 1e6).toFixed(2)}. Reserved for requests: €${(Number(me.wallet.reserved) / 1e6).toFixed(4)}.${Number(me.wallet.debt) > 0 ? " Payment reversal outstanding; inference is paused." : ""}`;
  if (me.wallet.usageReviewRequired)
    $("#balance").textContent +=
      " AI usage is paused while a provider charge is reviewed. Reserved funds remain held; buying more credits will not clear this review. Contact support.";
  const area = $("#agent");
  const signature = JSON.stringify(t ?? null);
  if (signature !== renderedAgent) area.replaceChildren();
  if (t && signature !== renderedAgent) {
    const section = document.createElement("section"),
      h = document.createElement("h2");
    h.textContent = "Your agent";
    section.append(h);
    const p = document.createElement("p");
    p.textContent = `Status: ${t.state.replaceAll("_", " ")}${t.error_code ? " — setup needs attention" : ""}${t.cancel_at_period_end ? " · cancellation scheduled" : ""}`;
    section.append(p);
    const button = (text, fn, disabled = false) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.disabled = disabled;
      b.onclick = run(fn);
      section.append(b);
    };
    button(
      "Open my agent",
      () => jump(`/api/tenants/${t.id}/access`),
      !["awaiting_setup", "ready"].includes(t.state),
    );
    const ex = document.createElement("form");
    const label = document.createElement("label");
    label.textContent = "Export encryption key (age public recipient)";
    const key = document.createElement("input");
    key.name = "recipient";
    key.placeholder = "age1…";
    key.required = true;
    label.append(key);
    ex.append(label);
    const submit = document.createElement("button");
    submit.textContent = "Export complete agent";
    submit.disabled = !["awaiting_setup", "ready"].includes(t.state);
    ex.append(submit);
    ex.onsubmit = run(() =>
      jump(`/api/tenants/${t.id}/export`, { recipient: key.value.trim() }),
    );
    section.append(ex);
    if (t.state === "suspended") {
      const notice = document.createElement("p");
      notice.textContent =
        "Your server is offline. Data is retained for 30 days after suspension. Renew to resume, or contact support for an export during retention.";
      section.append(notice);
    }
    const ssh = document.createElement("form");
    const sl = document.createElement("label");
    sl.textContent = "SSH public key (Ed25519)";
    const si = document.createElement("input");
    si.required = true;
    sl.append(si);
    ssh.append(sl);
    const ipLabel = document.createElement("label");
    ipLabel.textContent =
      "Your public IPv4 address (SSH is allowed only from this address)";
    const ip = document.createElement("input");
    ip.required = true;
    ipLabel.append(ip);
    ssh.append(ipLabel);
    const sb = document.createElement("button");
    sb.textContent = "Add SSH key";
    sb.disabled = !["awaiting_setup", "ready"].includes(t.state);
    ssh.append(sb);
    ssh.onsubmit = run(async () => {
      await api(`/api/tenants/${t.id}/ssh-key`, {
        publicKey: si.value.trim(),
        sourceIp: ip.value.trim(),
      });
      notice(
        "SSH key saved. Connect as root from the IPv4 address you specified.",
      );
    });
    section.append(ssh);
    button("Cancel at period end", async () => {
      if (
        confirm(
          "Cancel hosting at the end of the paid period? Data is retained for 30 days after suspension.",
        )
      ) {
        await api(`/api/tenants/${t.id}/cancel`, {});
        await refresh();
      }
    });
    area.append(section);
  }
  renderedAgent = signature;
  if (
    t &&
    ["pending_payment", "provisioning", "awaiting_setup"].includes(t.state)
  ) {
    timer = setTimeout(() => void refresh().catch(() => {}), 10000);
  }
  updateRates();
}
function updateRates() {
  const credits = $("#mode").value === "credits";
  $("#model-label").hidden = !credits;
  const model = catalog?.models.find((m) => m.id === $("#model").value);
  $("#rates").textContent = credits
    ? model
      ? `Inference runs in ${model.country}. Per million tokens: €${model.inputEuroPerMillion} input, €${model.cachedEuroPerMillion} cached input, €${model.outputEuroPerMillion} output. Buy credit after your agent is provisioned.`
      : "No managed model has passed verification yet."
    : "Your provider receives prompts and bills you directly.";
  $("#checkout").disabled =
    !catalog?.checkoutEnabled ||
    (credits && (!catalog.creditsEnabled || !model));
}
$("#login-form").onsubmit = run(async () => {
  await api("/api/auth/request", {
    email: new FormData($("#login-form")).get("email"),
    mode: $("#mode").value,
  });
  notice("Check your email. Open the link and confirm sign-in.");
});
$("#reauth").onclick = run(async () => {
  await api("/api/auth/request", { email: me.email, mode: $("#mode").value });
  notice(
    "Check your email and open the new link, then retry your action. Your agent stays running.",
  );
});
$("#logout").onclick = run(async () => {
  await api("/api/auth/logout", {});
  await refresh();
});
$("#purchase-form").onsubmit = run(() =>
  jump("/api/checkout", {
    mode: $("#mode").value,
    ...($("#mode").value === "credits" ? { modelId: $("#model").value } : {}),
  }),
);
$("#topup").onclick = run(() => jump("/api/credits/checkout"));
$("#billing").onclick = run(() => jump("/api/billing/portal"));
$("#ledger").onclick = run(async () => {
  $("#usage").textContent = JSON.stringify(
    await api("/api/credits/ledger"),
    null,
    2,
  );
});
$("#mode").onchange = updateRates;
$("#model").onchange = updateRates;
(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1)),
    secret = fragment.get("login");
  if (secret) {
    history.replaceState(null, "", location.pathname + location.search);
    if (confirm("Sign in to Your Agent using this email link?"))
      await api("/api/auth/consume", { token: secret });
  }
  await refresh();
})().catch((e) => notice(e.message));
