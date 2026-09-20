// Which billing mode the claude TUI came up on.
//
// maestro-p exists to spend a Claude subscription plan's quota rather than
// per-token API credit, and claude's startup header is the only place it says
// which one it picked, beside the model name:
//   "Fable 5.1 · Claude Max"
//   "Fable 5.1 · API Usage Billing"
// claude drops to API Usage Billing silently whenever it cannot read the
// subscription login, and the JSONL transcript records nothing about it. A
// run-mode turn then bills API credit with no error, and `--status` exits with a
// parse failure because the /usage panel never renders, which points the
// debugging at the parser. An unset USER was the first observed cause (#1577).

import { classifyCredentialKind } from '../shared/providerAuthIdentity';

// Anchored on the header's `·` separator: the same screen carries resumed
// history, which can mention the phrase in prose. `\s*` because cursor-addressed
// paints lose their inter-word spaces once ANSI is stripped.
const API_USAGE_BILLING_RE = /·\s*API\s*Usage\s*Billing/i;

/** True when ANSI-stripped TUI text shows claude's API Usage Billing header. */
export function showsApiUsageBilling(text: string): boolean {
	return API_USAGE_BILLING_RE.test(text);
}

export interface ApiUsageBillingDiagnosis {
	/** The environment asked for API billing: an API key, a gateway, or Bedrock/Vertex. */
	expected: boolean;
	/** Why claude is on API Usage Billing, as one or two sentences. */
	reason: string;
}

/**
 * Explain an API Usage Billing header from the environment claude was started
 * with. An API key, a gateway, or a cloud provider in that environment makes the
 * header expected; otherwise claude was meant to use a login and missed it.
 */
export function diagnoseApiUsageBilling(
	env: NodeJS.ProcessEnv,
	configDir: string
): ApiUsageBillingDiagnosis {
	const definedEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) definedEnv[key] = value;
	}
	const credential = classifyCredentialKind('claude-code', definedEnv);
	if (credential.kind !== 'oauth') {
		return {
			expected: true,
			reason: `claude is on API Usage Billing because ${credential.envVarName ?? 'an API credential'} is set in its environment.`,
		};
	}
	return {
		expected: false,
		reason:
			`claude started on API Usage Billing instead of a Claude subscription plan. ` +
			`If ${configDir} is logged in to a subscription, claude could not read that login from this environment (an unset USER variable is one known cause).`,
	};
}
