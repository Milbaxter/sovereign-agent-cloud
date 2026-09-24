// Navigation only: the authenticated portal owns provider consent and checkout.
export function portalPath(selection) {
  return selection === "prepaid" ? "/?mode=credits" : "/?mode=byok";
}

export function availability(catalog, selection) {
  const unknown = {
    label: "Open account portal",
    banner: "Preview · Check availability in the account portal.",
    note: "Sign in to confirm availability, provider location, and billing terms. This page does not take payments.",
  };
  if (
    !catalog ||
    !["test", "live"].includes(catalog.billingMode) ||
    typeof catalog.checkoutEnabled !== "boolean" ||
    typeof catalog.creditsEnabled !== "boolean" ||
    !Array.isArray(catalog.models) ||
    catalog.hostingMonthlyCents !== 2500
  )
    return unknown;

  if (catalog.billingMode === "test")
    return {
      ...unknown,
      banner: "Preview · Test-mode billing. No live purchases.",
      note: "The account portal is in test mode. No live subscription is available from this deployment.",
    };
  if (!catalog.checkoutEnabled)
    return {
      ...unknown,
      banner: "Launch preview · Payments are not open yet.",
      note: "You can sign in to the account portal. Checkout stays disabled until launch verification is complete.",
    };
  if (
    selection === "prepaid" &&
    (!catalog.creditsEnabled || !catalog.models.length)
  )
    return {
      ...unknown,
      banner: "Managed hosting · Bring your own model connection.",
      note: "Prepaid inference is not available yet. The account portal will show supported options before checkout.",
    };
  return {
    label: "Continue to account",
    banner: "Founding offer · €25/month plus inference and applicable tax.",
    note: "Verify your email and confirm your model connection in the portal. The final recurring total appears before payment.",
  };
}
