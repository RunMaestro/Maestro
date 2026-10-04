/**
 * Prompt redaction + capping (F6 / ISC-6.5) - PURE.
 *
 * The ledger stores a run's prompt for context, but a prompt can carry secrets
 * (API keys, tokens, passwords) and can be arbitrarily large. This redacts
 * common secret shapes and caps the length before the prompt is ever persisted.
 * Pure so both the desktop capture seam and the CLI capture hook redact
 * identically, and so it is trivially testable. The secret shapes themselves
 * live in the canonical `redactSecrets()` (src/shared/redactSecrets.ts).
 */

import { redactSecrets } from '../redactSecrets';

const MAX_PROMPT_CHARS = 4000;

/**
 * The ledger uses one opaque placeholder for every secret shape (key included)
 * and also scrubs long hex blobs: it stores prompts, where a 40+ hex run is far
 * more likely a credential than a commit id the reader needs to see.
 */
const PLACEHOLDER = '[redacted]';

/**
 * Redact secret-shaped substrings and cap length. Returns undefined for empty
 * input so an absent prompt stays absent rather than becoming an empty string.
 */
export function redactPrompt(prompt: string | undefined): string | undefined {
	if (!prompt) return undefined;
	let out = redactSecrets(prompt, { placeholder: PLACEHOLDER, hexBlobs: true }).text;
	if (out.length > MAX_PROMPT_CHARS) {
		out = `${out.slice(0, MAX_PROMPT_CHARS)}...[truncated ${out.length - MAX_PROMPT_CHARS} chars]`;
	}
	return out;
}
