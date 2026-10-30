/**
 * Pure prompt and token redaction helpers.
 *
 * Prompts sent to an agent often carry credentials or secrets by accident
 * (API keys, tokens, passwords) and can be arbitrarily large. This redacts
 * common secret shapes and caps the length before the prompt is ever persisted.
 * Pure so both the desktop capture seam and the CLI capture hook redact
 * identically, and so it is trivially testable. The secret shapes themselves
 * live in the canonical `redactSecrets()` (src/shared/redactSecrets.ts).
 */

import { redactSecrets as redactCanonicalSecrets } from '../redactSecrets';

const MAX_PROMPT_CHARS = 4000;

const PLACEHOLDER = '[redacted]';

/** Redact secrets from memory evidence without the ledger's prompt-length cap. */
export function redactSecrets(text: string): string {
	return redactCanonicalSecrets(text, { placeholder: PLACEHOLDER, hexBlobs: true }).text;
}

/**
 * Tokens shaped like a known credential: OpenAI and Anthropic (`sk-`, `rk-`,
 * including `sk-ant-...` and `sk-proj-...`), GitHub (`ghp_`, `gho_`, `ghs_`,
 * `ghu_`, `ghr_`, `github_pat_`), Slack (`xox*-`) and AWS access key ids.
 *
 * Precise on purpose, so it can run over prose (memory files, skills, docs)
 * without eating ordinary words, commit SHAs or `key: value` lines: an `sk-`
 * token needs 20+ characters and a digit, which keeps `sk-learn` out.
 * {@link redactPrompt} adds broader patterns on top for ledger prompts.
 */
const CREDENTIAL_TOKEN_SOURCE = String.raw`\b(?:(?:sk|rk)-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b`;

/** What a redacted credential is replaced with. */
export const REDACTED_PLACEHOLDER = PLACEHOLDER;

/** Whether text holds a credential-shaped token. */
export function containsCredentialToken(text: string): boolean {
	return new RegExp(CREDENTIAL_TOKEN_SOURCE).test(text);
}

/** Replace every credential-shaped token in text, and count them. */
export function redactCredentialTokens(text: string): { text: string; redacted: number } {
	let redacted = 0;
	const out = text.replace(new RegExp(CREDENTIAL_TOKEN_SOURCE, 'g'), () => {
		redacted++;
		return PLACEHOLDER;
	});
	return { text: out, redacted };
}

/**
 * Redact secret-shaped substrings and cap length. Returns undefined for empty
 * input so an absent prompt stays absent rather than becoming an empty string.
 */
export function redactPrompt(prompt: string | undefined): string | undefined {
	if (!prompt) return undefined;
	let out = redactCanonicalSecrets(prompt, { placeholder: PLACEHOLDER, hexBlobs: true }).text;
	if (out.length > MAX_PROMPT_CHARS) {
		out = `${out.slice(0, MAX_PROMPT_CHARS)}...[truncated ${out.length - MAX_PROMPT_CHARS} chars]`;
	}
	return out;
}
