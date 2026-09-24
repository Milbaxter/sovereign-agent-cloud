if (process.env.JOURNEY_LIVE_ENABLED !== "true")
  throw Error("LIVE_JOURNEY_NOT_ENABLED");
import { secret } from "../../e2e/config.js";
// Read-only verification: this script never creates or weakens an approval rule.
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
)
  throw Error("MANUAL_APPROVED_WORKFLOW_REQUIRED");
const repo = secret("GITHUB_REPOSITORY");
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error("INVALID_REPOSITORY");
const response = await fetch(
  `https://api.github.com/repos/${repo}/environments/customer-journey`,
  {
    headers: {
      authorization: `Bearer ${secret("GH_TOKEN")}`,
      accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(15000),
  },
);
if (!response.ok) throw Error("CANNOT_VERIFY_ENVIRONMENT_REVIEW");
const environment = (await response.json()) as any;
if (
  !environment.protection_rules?.some(
    (rule: any) =>
      rule.type === "required_reviewers" && rule.reviewers?.length > 0,
  )
)
  throw Error("REQUIRED_ENVIRONMENT_REVIEW_MISSING");
secret("JOURNEY_AUTHORIZATION_REFERENCE");
console.log(
  "Protected journey environment has a required reviewer and an authorization record.",
);
