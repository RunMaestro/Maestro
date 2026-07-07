/**
 * Prompt redaction + capping (F6 / ISC-6.5) - PURE.
 *
 * The ledger stores a run's prompt for context, but a prompt can carry secrets
 * (API keys, tokens, passwords) and can be arbitrarily large. This redacts
 * common secret shapes and caps the length before the prompt is ever persisted.
 * Pure so both the desktop capture seam and the CLI capture hook redact
 * identically, and so it is trivially testable.
 */

const MAX_PROMPT_CHARS = 4000;

/** Secret-shaped patterns replaced with a fixed placeholder. */
const SECRET_PATTERNS: readonly RegExp[] = [
	// Common provider key prefixes: sk-..., ghp_..., github_pat_..., xoxb-..., AKIA...
	/\b(sk|rk)-[A-Za-z0-9]{16,}\b/g,
	/\bghp_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	// Bearer tokens and key=value secrets.
	/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
	/\b(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*\S+/gi,
	// Long base64/hex blobs that look like credentials.
	/\b[A-Fa-f0-9]{40,}\b/g,
];

const PLACEHOLDER = '[redacted]';

/**
 * Redact secret-shaped substrings and cap length. Returns undefined for empty
 * input so an absent prompt stays absent rather than becoming an empty string.
 */
export function redactPrompt(prompt: string | undefined): string | undefined {
	if (!prompt) return undefined;
	let out = prompt;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, PLACEHOLDER);
	}
	if (out.length > MAX_PROMPT_CHARS) {
		out = `${out.slice(0, MAX_PROMPT_CHARS)}...[truncated ${out.length - MAX_PROMPT_CHARS} chars]`;
	}
	return out;
}
