import { portalPath, availability } from "./portal.js";

const demoSteps = [
  {
    prompt:
      "Help me plan a quiet weekend. I like walks, good coffee, and keeping things under €100.",
    response:
      "Let’s leave some breathing room. A long walk on Saturday, a café stop, and a relaxed Sunday at home. I’ll use your €100 budget as the limit for this example.",
    memory: "Context: quiet weekends · walking · €100 budget",
  },
  {
    prompt: "Turn that into a simple plan I can adjust.",
    response:
      "Saturday: a morning walk and coffee, with the afternoon free. Sunday: a home-cooked brunch and time for your own projects. Next, we’d check local options and actual prices.",
    memory: "A draft plan, with room to change your mind",
  },
  {
    prompt: "And what about next weekend?",
    response:
      "Starting from the same preferences: somewhere calm, time outdoors, and a €100 budget. Would you like to keep it local or try somewhere new?",
    memory: "Your preferences carried into the next conversation",
  },
];
let demoIndex = 0;
function renderDemo() {
  const step = demoSteps[demoIndex];
  const body = document.getElementById("demo-body");
  body.replaceChildren();
  const user = document.createElement("p");
  user.className = "user-message";
  user.textContent = step.prompt;
  const agent = document.createElement("div");
  agent.className = "agent-message";
  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = "YOUR AGENT · EXAMPLE RESPONSE";
  const response = document.createElement("p");
  response.textContent = step.response;
  const memory = document.createElement("span");
  memory.className = "memory-chip";
  memory.textContent = step.memory;
  agent.append(label, response, memory);
  body.append(user, agent);
  document.getElementById("step-count").textContent = `0${demoIndex + 1} / 03`;
  document.getElementById("demo-prev").disabled = demoIndex === 0;
  document.getElementById("demo-next").textContent =
    demoIndex === 2 ? "Start again ↻" : "Next step →";
}
document.getElementById("demo-prev").addEventListener("click", () => {
  demoIndex = Math.max(0, demoIndex - 1);
  renderDemo();
});
document.getElementById("demo-next").addEventListener("click", () => {
  demoIndex = (demoIndex + 1) % demoSteps.length;
  renderDemo();
});
renderDemo();
document.querySelectorAll('input[name="inference"]').forEach((input) =>
  input.addEventListener("change", () => {
    document.getElementById("billing-explanation").textContent =
      input.value === "byok"
        ? "€25/month for hosting, plus usage billed directly by your chosen provider. No inference credit is included."
        : "€25/month for hosting, plus separately purchased inference credit. Usage draws from a visible prepaid balance; no unlimited usage is included.";
  }),
);

let publicCatalog = null;
function updateAccountLink() {
  const selected = document.querySelector(
    'input[name="inference"]:checked',
  ).value;
  const state = availability(publicCatalog, selected);
  document.getElementById("account-link").href = portalPath(selected);
  document.getElementById("account-link").textContent = state.label;
  document.getElementById("checkout-note").textContent = state.note;
  document.getElementById("availability-banner").textContent = state.banner;
}
document
  .querySelectorAll('input[name="inference"]')
  .forEach((input) => input.addEventListener("change", updateAccountLink));
updateAccountLink();
(async () => {
  try {
    const response = await fetch("/api/catalog", {
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Catalog unavailable");
    publicCatalog = await response.json();
  } catch {
    publicCatalog = null;
  }
  updateAccountLink();
})();
