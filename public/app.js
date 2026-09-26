const $ = (s) => document.querySelector(s),
  notice = (s) => ($("#notice").textContent = s);
const messages = {
  FRESH_LOGIN_REQUIRED: "Request a new sign-in link, then retry this action.",
  LOGIN_REQUIRED: "Your session has ended. Sign in again to continue.",
  EXPIRED_LOGIN_LINK:
    "This sign-in link has expired or was already used. Request a new one.",
  INVALID_REQUEST: "Check the information you entered and try again.",
  AGENT_NOT_READY:
    "Your agent is still being prepared. Wait for setup to finish, then try again.",
  NO_BILLING_ACCOUNT:
    "Billing becomes available after you start a subscription.",
  NO_SUBSCRIPTION: "There is no subscription to cancel yet.",
  COHORT_FULL: "All available places are taken. Please check back later.",
  PAYMENT_PROCESSING:
    "Your payment is being processed. Wait for your account status to update before trying again.",
  CHECKOUT_SELECTION_ALREADY_SAVED:
    "Your existing checkout uses a different model connection. Refresh the page to see the saved selection.",
  ALREADY_SUBSCRIBED:
    "You already have a subscription. Refresh the page to open your agent.",
  SELECT_VERIFIED_MODEL: "Choose an available model before continuing.",
  ACTIVE_CREDIT_AGENT_REQUIRED:
    "AI credit requires an active agent using managed models.",
  RATE_LIMITED: "Too many requests. Wait a minute, then try again.",
  NETWORK_ERROR:
    "Connection interrupted. Check your connection and account status before retrying; your action may have completed.",
  SERVICE_UNAVAILABLE:
    "The service is temporarily unavailable. Check your account status before retrying.",
};
const friendlyError = (error) =>
  messages[error.message] || messages.SERVICE_UNAVAILABLE;
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw Error("NETWORK_ERROR");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok)
    throw Object.assign(
      Error(
        res.status === 429
          ? "RATE_LIMITED"
          : data?.error || "SERVICE_UNAVAILABLE",
      ),
      { status: res.status },
    );
  if (!data || typeof data !== "object") throw Error("SERVICE_UNAVAILABLE");
  return data;
}
let activeActions = 0;
const busy = new WeakSet();
const run = (fn) => async (e) => {
  e?.preventDefault();
  const target = e?.currentTarget;
  if (target && busy.has(target)) return;
  const buttons =
    target?.tagName === "FORM"
      ? [...target.querySelectorAll("button")]
      : target
        ? [target]
        : [];
  const previous = buttons.map((button) => [
    button,
    button.disabled,
    button.textContent,
  ]);
  if (target) {
    busy.add(target);
    target.setAttribute("aria-busy", "true");
  }
  activeActions++;
  for (const button of buttons) {
    button.disabled = true;
    button.textContent = "Working…";
  }
  try {
    await fn(e);
  } catch (err) {
    notice(friendlyError(err));
  } finally {
    activeActions--;
    if (target) {
      busy.delete(target);
      target.removeAttribute("aria-busy");
    }
    for (const [button, disabled, text] of previous) {
      button.disabled = disabled;
      button.textContent = text;
    }
    if (!activeActions) updateRates();
  }
};
const jump = async (path, body = {}) => {
  const data = await api(path, body);
  location.assign(data.url);
};
let catalog, me, timer, renderedAgent, renderedTenantId;
const initialMode = new URLSearchParams(location.search).get("mode");
if (["byok", "credits"].includes(initialMode)) $("#mode").value = initialMode;
let refreshing;
function refresh() {
  if (refreshing) return refreshing;
  clearTimeout(timer);
  let failed = false;
  refreshing = refreshAccount()
    .then(() => {
      $("#connection").textContent = "";
    })
    .catch(() => {
      failed = true;
      $("#connection").textContent =
        "Cannot update your account right now. Reconnecting automatically; your current information may be out of date.";
    })
    .finally(() => {
      refreshing = undefined;
      if (
        failed ||
        ["pending_payment", "provisioning", "awaiting_setup"].includes(
          me?.tenants[0]?.state,
        )
      ) {
        const poll = () => {
          if (activeActions) timer = setTimeout(poll, 10000);
          else return refresh();
        };
        timer = setTimeout(poll, 10000);
      }
    });
  return refreshing;
}
async function refreshAccount() {
  const [nextCatalog, nextAccount] = await Promise.all([
    api("/api/catalog"),
    api("/api/me").catch((error) => {
      if (error.status === 401) return null;
      throw error;
    }),
  ]);
  if (
    !Array.isArray(nextCatalog.models) ||
    typeof nextCatalog.checkoutEnabled !== "boolean" ||
    (nextAccount &&
      (!Array.isArray(nextAccount.tenants) ||
        !nextAccount.wallet ||
        typeof nextAccount.email !== "string"))
  ) {
    throw Error("SERVICE_UNAVAILABLE");
  }
  catalog = nextCatalog;
  me = nextAccount;
  $("#login").hidden = !!me;
  $("#account").hidden = !me;
  if (!catalog.checkoutEnabled)
    notice(
      "Preview: checkout is disabled until launch verification is complete.",
    );
  if (!me) {
    renderedAgent = undefined;
    renderedTenantId = undefined;
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
  const entered =
    renderedTenantId === t?.id
      ? new Map(
          [...area.querySelectorAll("input")].map((input) => [
            input.name,
            input.value,
          ]),
        )
      : new Map();
  if (signature !== renderedAgent) area.replaceChildren();
  if (t && signature !== renderedAgent) {
    const section = document.createElement("section"),
      h = document.createElement("h2");
    h.textContent = "Your agent";
    section.append(h);
    const p = document.createElement("p");
    const states = {
      pending_payment:
        "Waiting for payment confirmation. This page updates automatically.",
      provisioning:
        "Preparing your private server. This can take several minutes; you can leave this page and return later.",
      awaiting_setup:
        "Your server is ready. Open your agent to finish setup and connect your model.",
      ready: "Your agent is ready.",
      suspended: "Your agent is paused.",
      deleted: "Your agent has been deleted.",
    };
    p.textContent = `${states[t.state] || "Your account status is being updated."}${t.error_code ? " Setup needs attention. Contact support before making another purchase." : ""}${t.cancel_at_period_end ? " Cancellation is scheduled for the end of your paid period." : ""}`;
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
    key.autocomplete = "off";
    key.spellcheck = false;
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
    si.name = "publicKey";
    si.autocomplete = "off";
    si.spellcheck = false;
    sl.append(si);
    ssh.append(sl);
    const ipLabel = document.createElement("label");
    ipLabel.textContent =
      "Your public IPv4 address (SSH is allowed only from this address)";
    const ip = document.createElement("input");
    ip.required = true;
    ip.name = "sourceIp";
    ip.autocomplete = "off";
    ip.spellcheck = false;
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
    for (const input of area.querySelectorAll("input")) {
      if (entered.has(input.name)) input.value = entered.get(input.name);
    }
  }
  renderedAgent = signature;
  renderedTenantId = t?.id;
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
})().catch((e) => notice(friendlyError(e)));
