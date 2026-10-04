/**
 * Secret redaction - the ONE implementation (pure, bundle-safe).
 *
 * Several surfaces persist or display text that may carry a credential: the
 * agent-run ledger stores prompts, Send Feedback echoes a failed provider's
 * output, and Computer History stores whatever text was on screen. Each used to
 * carry its own regex list, and each list had holes the others had closed
 * (one knew `github_pat_`, another knew `AKIA`, none knew card numbers). This
 * module is the union, and every caller routes through it.
 *
 * Output shape: each match becomes a typed placeholder so a reader can tell
 * WHAT was removed without seeing it:
 *
 * - `[REDACTED_API_KEY]`        provider keys and tokens (sk-, ghp_, github_pat_, xox*-;
 *                               GitHub tokens are their own kind so a caller can relabel them)
 * - `[REDACTED_AWS_ACCESS_KEY]` AWS access key ids (AKIA..., ASIA...)
 * - `[REDACTED_BEARER_TOKEN]`   the token after `Bearer `
 * - `[REDACTED_CREDIT_CARD]`    13-19 digit runs that pass the Luhn check
 * - `[REDACTED_SECRET]`         key=value secrets, private key blocks, JWTs,
 *                               and (opt-in) long hex blobs
 *
 * For key=value and Bearer matches the key / `Bearer ` prefix is kept, so the
 * text still reads (`password: [REDACTED_SECRET]`). A caller that needs one
 * opaque placeholder for every match (the agent-run ledger) passes
 * `placeholder`, which replaces the WHOLE match, key included.
 */

/** Which family a redacted span belonged to. */
export type SecretKind =
	| 'api_key'
	| 'github_token'
	| 'aws_access_key'
	| 'bearer'
	| 'credit_card'
	| 'secret';

export const SECRET_PLACEHOLDERS: Readonly<Record<SecretKind, string>> = {
	api_key: '[REDACTED_API_KEY]',
	// GitHub tokens are API keys by default; a caller can label them apart.
	github_token: '[REDACTED_API_KEY]',
	aws_access_key: '[REDACTED_AWS_ACCESS_KEY]',
	bearer: '[REDACTED_BEARER_TOKEN]',
	credit_card: '[REDACTED_CREDIT_CARD]',
	secret: '[REDACTED_SECRET]',
};

export interface RedactSecretsOptions {
	/**
	 * Replace every match (including a key=value key and the `Bearer ` prefix)
	 * with this one string. Overrides `labels`.
	 */
	placeholder?: string;
	/** Per-kind placeholder overrides; the kept prefix behavior is unchanged. */
	labels?: Partial<Record<SecretKind, string>>;
	/**
	 * Also redact bare hex runs of 40+ characters. Off by default: a git SHA is
	 * exactly 40 hex characters, and a recall store full of `[REDACTED_SECRET]`
	 * where commit ids used to be is worse than useless. The agent-run ledger,
	 * which stores prompts rather than screens, opts in.
	 */
	hexBlobs?: boolean;
}

export interface RedactSecretsResult {
	text: string;
	/** True when at least one span was replaced. */
	redacted: boolean;
}

interface Rule {
	kind: SecretKind;
	pattern: RegExp;
	/**
	 * Index of the capture group holding a prefix to keep (key + separator, or
	 * `Bearer `). Absent = the whole match is the secret.
	 */
	keepGroup?: number;
	/** Extra check on the matched secret; false = leave the match alone. */
	accept?: (match: string) => boolean;
}

/** Luhn checksum over a digit string. */
export function passesLuhn(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (d < 0 || d > 9) return false;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

function isCardNumber(match: string): boolean {
	const digits = match.replace(/[ -]/g, '');
	if (digits.length < 13 || digits.length > 19) return false;
	// A run of one repeated digit (0000 0000 0000 0) passes Luhn trivially.
	if (/^(\d)\1+$/.test(digits)) return false;
	return passesLuhn(digits);
}

/**
 * Ordered: wider shapes first so a narrower rule never splits a span a wider
 * one owns (a JWT contains dots a key=value value would stop at; a key=value
 * value may itself look like an `sk-` key).
 */
const RULES: readonly Rule[] = [
	// PEM private key blocks. A block cut off by a capture cap (no END line)
	// is redacted through the end of the text.
	{
		kind: 'secret',
		pattern:
			/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
	},
	// JSON Web Tokens: three base64url segments, the first a JSON header.
	{
		kind: 'secret',
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	},
	// `Bearer <token>`, with or without an `Authorization:` header in front.
	{
		kind: 'bearer',
		pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
		keepGroup: 1,
	},
	// key=value / key: value secrets, including prefixed env names
	// (OPENAI_API_KEY, access_token, aws_secret_access_key) and quoted values.
	// An unquoted value stops at `&` so a query string keeps its other params.
	{
		kind: 'secret',
		pattern:
			/\b((?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|secret(?:[_-]?(?:access[_-]?)?key)?|token|password|passwd|pwd)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;&]+)/gi,
		keepGroup: 1,
	},
	// Provider key prefixes.
	{ kind: 'api_key', pattern: /\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g },
	{ kind: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
	{ kind: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ kind: 'api_key', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	// AWS access key ids (long-term AKIA, temporary ASIA).
	{ kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	// Card numbers: 13-19 digits, optionally grouped by spaces or dashes.
	{
		kind: 'credit_card',
		pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
		accept: isCardNumber,
	},
];

const HEX_BLOB_RULE: Rule = { kind: 'secret', pattern: /\b[A-Fa-f0-9]{40,}\b/g };

/**
 * Replace secret-shaped spans in `text`. Pure; never throws on any string.
 * Empty input returns unchanged with `redacted: false`.
 */
export function redactSecrets(
	text: string,
	options: RedactSecretsOptions = {}
): RedactSecretsResult {
	if (!text) return { text, redacted: false };
	const rules = options.hexBlobs ? [...RULES, HEX_BLOB_RULE] : RULES;
	let out = text;
	let redacted = false;
	for (const rule of rules) {
		out = out.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
			if (rule.accept && !rule.accept(match)) return match;
			redacted = true;
			if (options.placeholder !== undefined) return options.placeholder;
			const label = options.labels?.[rule.kind] ?? SECRET_PLACEHOLDERS[rule.kind];
			if (rule.keepGroup !== undefined) {
				const kept = groups[rule.keepGroup - 1];
				return `${typeof kept === 'string' ? kept : ''}${label}`;
			}
			return label;
		});
	}
	return { text: out, redacted };
}
