import { expect, type Page } from "@playwright/test";
// Stripe-hosted Checkout is third-party UI: changes fail visibly; never replace it
// with a synthetic paid invoice or an API-side entitlement write.
export async function payCheckout(page: Page, kind: "hosting" | "credits") {
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
  await expect(page.getByText(/test mode/i).first()).toBeVisible();
  await expect(
    page
      .getByText(kind === "hosting" ? /25[.,]00|€25/ : /10[.,]00|€10/)
      .first(),
  ).toBeVisible();
  const card = page.locator('input[name="cardNumber"]');
  await card.fill("4242424242424242");
  await page.locator('input[name="cardExpiry"]').fill("1230");
  await page.locator('input[name="cardCvc"]').fill("123");
  await page.locator('input[name="billingName"]').fill("Journey Test");
  const country = page.locator('select[name="billingCountry"]');
  if (await country.isVisible()) await country.selectOption("FI");
  const postal = page.locator('input[name="billingPostalCode"]');
  if (await postal.isVisible()) await postal.fill("00100");
  // No real payment credentials, Link login, saved card, or terms checkbox.
  await page
    .getByRole("button", { name: kind === "hosting" ? /^Subscribe/ : /^Pay/ })
    .click();
}
