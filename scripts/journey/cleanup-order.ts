// Provider outages are independent: a Stripe failure must not skip VM deletion.
export async function cleanupStages(
  stages: { name: string; run: () => Promise<void> }[],
) {
  const failures: string[] = [];
  for (const stage of stages)
    try {
      await stage.run();
    } catch {
      failures.push(stage.name);
    }
  return failures;
}
