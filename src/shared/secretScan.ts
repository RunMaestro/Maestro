/**
 * Secret scan: find credentials in text Maestro is about to publish.
 *
 * Three paths send content off the machine on the user's behalf: a GitHub gist,
 * a feedback issue, and a support (debug) package. Each one runs
 * {@link scanForSecrets} first, so a pasted API key in a transcript is caught
 * before it is readable by anyone with the URL.
 *
 * The detectors are regular expressions and need no model, so this scan ALWAYS
 * runs. The optional `secret-screen` Local Models assignment adds a model pass
 * on top of it (see `src/main/local-models/secret-screen.ts`); it never
 * replaces this one.
 *
 * Nothing here returns a secret. A finding carries a preview masked by
 * `maskEnvValue()`, so the list can be shown in a dialog, printed by the CLI,
 * and written to a log.
 *
 * That model pass can also be a System One engine, asked one typed yes or no
 * question ({@link secretScreenSystemOneRequest}). It is extra coverage in the
 * same way: the pattern scan has already run by the time it is asked.
 *
 * Pure: it imports only `agentEnvironment` and the System One vocabulary, so
 * the renderer, the main process, and the CLI bundle can all use it. It never
 * reads `process.env` itself (the renderer's `process` is a shim): a caller
 * that wants configured values matched passes them in as `env`.
 */

import { isSecretEnvKey, maskEnvValue } from './agentEnvironment';
import { noul, type SystemOneAnswers, type SystemOneTaskRequest } from './local-models/system-one';

export type SecretKind =
	| 'aws-access-key'
	| 'github-token'
	| 'anthropic-key'
	| 'openai-key'
	| 'slack-token'
	| 'private-key'
	| 'env-var-value'
	| 'generic-api-key'
	| 'model-flagged';

export interface SecretFinding {
	kind: SecretKind;
	/**
	 * 1-based line of the first occurrence. 0 when the finding has no line: a
	 * model verdict covers the whole text.
	 */
	line: number;
	/** The secret, masked. Safe to show, print, and log. */
	preview: string;
	/**
	 * What the secret was found beside: the variable name for `env-var-value`
	 * and `generic-api-key`, the model or System One engine for `model-flagged`.
	 */
	name?: string;
	/** Which part of the content it is in, when the caller scanned several. */
	source?: string;
	/** How many times this same value appears. Absent when it appears once. */
	occurrences?: number;
}

/** What a publishing path answers with when it refuses. */
export interface SecretScreenRefusal {
	success: false;
	error: string;
	code: typeof SECRETS_FOUND_CODE;
	secretFindings: SecretFinding[];
	/** Why the optional model pass did not run, when one is assigned. */
	secretScreenNote?: string;
}

/** The fields a publishing response gains. Present only on a refusal. */
export interface SecretScreenFields {
	code?: string;
	secretFindings?: SecretFinding[];
	secretScreenNote?: string;
}

export const SECRETS_FOUND_CODE = 'SECRETS_FOUND';

export const SECRET_KIND_LABELS: Readonly<Record<SecretKind, string>> = {
	'aws-access-key': 'AWS access key',
	'github-token': 'GitHub token',
	'anthropic-key': 'Anthropic API key',
	'openai-key': 'OpenAI API key',
	'slack-token': 'Slack token',
	'private-key': 'Private key',
	'env-var-value': 'Configured secret',
	'generic-api-key': 'Credential',
	'model-flagged': 'Flagged by model',
};

/**
 * Configured environment variables, as a record or as entries. Entries let a
 * caller pass one name several times, which is what several agents each
 * holding their own `ANTHROPIC_API_KEY` looks like.
 */
export type SecretScanEnv =
	| Readonly<Record<string, string | undefined>>
	| ReadonlyArray<readonly [name: string, value: string | undefined]>;

export interface SecretScanOptions {
	/**
	 * The value of each variable whose name `isSecretEnvKey()` flags is searched
	 * for in the content.
	 */
	env?: SecretScanEnv;
	/** Stamped on every finding, for a caller scanning several parts. */
	source?: string;
}

/**
 * Shortest environment value worth searching for. A shorter one (`1`, `true`,
 * `dev`) matches ordinary text everywhere.
 */
export const MIN_ENV_SECRET_LENGTH = 8;

/** Shortest value the generic `name = value` detector reads as a credential. */
export const MIN_GENERIC_SECRET_LENGTH = 16;

/** Bits per character a generic value needs. English prose sits near 3. */
export const MIN_GENERIC_SECRET_ENTROPY = 3.5;

interface PatternDetector {
	kind: Exclude<SecretKind, 'env-var-value' | 'generic-api-key' | 'model-flagged' | 'private-key'>;
	pattern: RegExp;
}

/**
 * Provider tokens, most specific first. Order matters only for the label: a
 * span one detector claimed is not reported again by a later one.
 */
const PATTERN_DETECTORS: readonly PatternDetector[] = [
	{ kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{
		kind: 'openai-key',
		pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}\b/g,
	},
	{
		kind: 'github-token',
		pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
	},
	{ kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: 'slack-token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
];

/**
 * A PEM private key header, with the base64 body that follows it. The body may
 * be split by real newlines or by the escaped newline a key has inside JSON.
 * Nothing follows the repeated group, so it cannot backtrack.
 */
const PRIVATE_KEY_PATTERN =
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----((?:(?:\\[nr]|\s)*[A-Za-z0-9+/=]+)*)/g;

/**
 * `name = value` and `"name": "value"`, where the name says credential. Group
 * 1 is the name, group 2 the value.
 */
const GENERIC_ASSIGNMENT_PATTERN =
	/\b([A-Za-z0-9_.-]{0,40}(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_.-]{0,40})["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_+/=.~-]{16,})/gi;

/** Values people write in examples. Never a real credential. */
const PLACEHOLDER_PATTERN = /^(?:your|my|example|sample|dummy|test|changeme|placeholder|redacted)/i;

interface Span {
	start: number;
	end: number;
}

interface RawFinding extends Span {
	kind: SecretKind;
	/** The matched secret itself. Used for de-duplication, never returned. */
	value: string;
	preview: string;
	name?: string;
}

/**
 * Scan text for secrets.
 *
 * One finding per distinct secret value, at the line it first appears on, in
 * document order. A value repeated through the text carries `occurrences`
 * instead of filling the list.
 */
export function scanForSecrets(content: string, options: SecretScanOptions = {}): SecretFinding[] {
	if (!content) return [];

	const raw: RawFinding[] = [];
	const claimed: Span[] = [];
	const claim = (finding: RawFinding): void => {
		if (claimed.some((span) => finding.start < span.end && span.start < finding.end)) return;
		claimed.push({ start: finding.start, end: finding.end });
		raw.push(finding);
	};

	for (const { kind, pattern } of PATTERN_DETECTORS) {
		for (const match of content.matchAll(pattern)) {
			const value = match[0];
			const start = match.index ?? 0;
			claim({ kind, value, preview: maskEnvValue(value), start, end: start + value.length });
		}
	}

	for (const match of content.matchAll(PRIVATE_KEY_PATTERN)) {
		const start = match.index ?? 0;
		const header = match[0].slice(0, match[0].indexOf('-----', 5) + 5);
		const body = (match[1] ?? '').replace(/\\[nr]|\s/g, '');
		claim({
			kind: 'private-key',
			value: match[0],
			preview: body ? `${header} ${maskEnvValue(body)}` : header,
			start,
			end: start + match[0].length,
		});
	}

	for (const [name, value] of secretEnvEntries(options.env)) {
		for (let at = content.indexOf(value); at !== -1; at = content.indexOf(value, at + 1)) {
			claim({
				kind: 'env-var-value',
				value,
				preview: maskEnvValue(value),
				name,
				start: at,
				end: at + value.length,
			});
		}
	}

	for (const match of content.matchAll(GENERIC_ASSIGNMENT_PATTERN)) {
		const value = match[2];
		if (!looksLikeGenericSecret(value)) continue;
		const start = (match.index ?? 0) + match[0].length - value.length;
		claim({
			kind: 'generic-api-key',
			value,
			preview: maskEnvValue(value),
			name: match[1],
			start,
			end: start + value.length,
		});
	}

	raw.sort((a, b) => a.start - b.start);
	const lineAt = lineLocator(content);
	const byValue = new Map<string, SecretFinding>();
	for (const finding of raw) {
		const key = `${finding.kind}:${finding.value}`;
		const seen = byValue.get(key);
		if (seen) {
			seen.occurrences = (seen.occurrences ?? 1) + 1;
			continue;
		}
		byValue.set(key, {
			kind: finding.kind,
			line: lineAt(finding.start),
			preview: finding.preview,
			...(finding.name ? { name: finding.name } : {}),
			...(options.source ? { source: options.source } : {}),
		});
	}
	return [...byValue.values()];
}

/**
 * The configured values worth searching for: a secret-named variable whose
 * value is long enough to be one and is not a path. `SSH_AUTH_SOCK` and
 * `*_KEY_FILE` name a location, and a location is not the credential.
 */
function secretEnvEntries(env: SecretScanEnv | undefined): Array<[string, string]> {
	if (!env) return [];
	const entries: Array<[string, string]> = [];
	const seen = new Set<string>();
	const pairs: ReadonlyArray<readonly [string, string | undefined]> = Array.isArray(env)
		? env
		: Object.entries(env);
	for (const [name, rawValue] of pairs) {
		const value = rawValue?.trim();
		if (!value || value.length < MIN_ENV_SECRET_LENGTH) continue;
		if (!isSecretEnvKey(name)) continue;
		if (/^(?:[~/\\]|[A-Za-z]:[\\/])/.test(value)) continue;
		if (/^\d+$/.test(value)) continue;
		// Two variables holding one value are one secret; the first name labels it.
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push([name, value]);
	}
	return entries;
}

/**
 * Whether a value beside a credential-sounding name reads as a real one: mixed
 * letters and digits, not a placeholder, and random enough. This is what keeps
 * `token: someLongVariableName` and `api_key=your_api_key_here` out.
 */
function looksLikeGenericSecret(value: string): boolean {
	if (value.length < MIN_GENERIC_SECRET_LENGTH) return false;
	if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
	if (PLACEHOLDER_PATTERN.test(value)) return false;
	if (/(.)\1{5,}/.test(value)) return false;
	// A path, or a dotted code reference such as `process.env.API_TOKEN_V2`.
	if (/^(?:~|\.{0,2}\/)/.test(value)) return false;
	if (/^[A-Za-z_$][\w$]{0,23}(?:\.[A-Za-z_$][\w$]{0,23})+$/.test(value)) return false;
	return shannonEntropy(value) >= MIN_GENERIC_SECRET_ENTROPY;
}

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
	if (!value) return 0;
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

/** A function from a character offset to its 1-based line. */
function lineLocator(content: string): (offset: number) => number {
	const starts = [0];
	for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1)) {
		starts.push(at + 1);
	}
	return (offset) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (starts[mid] <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
}

/**
 * One finding as a line of text: `GitHub token ••••••••abcd (logs.json, line 12)`.
 * The dialog and the CLI both print it, so they cannot describe a finding
 * differently.
 */
export function describeSecretFinding(finding: SecretFinding): string {
	const kind = SECRET_KIND_LABELS[finding.kind];
	let label = kind;
	if (finding.name) {
		label =
			finding.kind === 'model-flagged' ? `${kind} (${finding.name})` : `${kind} ${finding.name}`;
	}
	const where = [
		finding.source,
		finding.line > 0 ? `line ${finding.line}` : null,
		finding.occurrences && finding.occurrences > 1 ? `${finding.occurrences} times` : null,
	].filter(Boolean);
	return `${label} ${finding.preview}${where.length > 0 ? ` (${where.join(', ')})` : ''}`;
}

/** What the model pass is asked about on System One: everything about to be published. */
export interface SecretScreenSystemOneInput {
	text: string;
}

/** The id of the one question the secret screen asks a System One engine. */
export const SECRET_SCREEN_QUESTION_ID = 'secret';

/**
 * P(yes) at or above which a System One answer flags the content. The
 * midpoint, which is where a classifier's positive label becomes its most
 * likely one: the rule the model pass already flags by.
 */
export const SECRET_SCREEN_FLAG_PROBABILITY = 0.5;

/**
 * The model pass as a System One request: the content is the state, and one
 * yes or no question is asked about it.
 *
 * Every request to an engine is redacted on its way out
 * (`redactSystemOneRequest`), so a secret a pattern knows never reaches the
 * engine: it reads a `[REDACTED_...]` marker in its place. The question says a
 * marker is not a finding, because the pattern scan has reported that one
 * already. What is left for the engine is what no pattern has a shape for.
 */
export function secretScreenSystemOneRequest(
	input: SecretScreenSystemOneInput
): SystemOneTaskRequest {
	return {
		state: input.text,
		questions: {
			[SECRET_SCREEN_QUESTION_ID]: noul(
				'Does this content contain a secret that must not be published?',
				{
					true: 'The content holds a live credential: an API key, an access token, a password, a private key, a connection string with a password in it, or a session cookie.',
					false:
						'The content holds no credential. A placeholder, an example value, a variable name with no value, and a marker such as [REDACTED_API_KEY] or [REDACTED_SECRET] are not secrets.',
				}
			),
		},
	};
}

/**
 * Read a System One answer as the model pass's verdict. `engineLabel` names the
 * engine that answered, the way a classifier finding names its model. Returns
 * `null` when the answers hold no yes or no for the screen's question: the
 * caller reports that the pass did not run, never that the content is clean.
 */
export function secretScreenVerdictFromSystemOne(
	answers: SystemOneAnswers,
	engineLabel: string
): { finding: SecretFinding | null } | null {
	const answer = answers[SECRET_SCREEN_QUESTION_ID];
	if (answer?.type !== 'noul') return null;
	if (answer.probability < SECRET_SCREEN_FLAG_PROBABILITY) return { finding: null };
	return {
		finding: {
			kind: 'model-flagged',
			line: 0,
			preview: `secret ${answer.probability.toFixed(2)}`,
			name: engineLabel,
		},
	};
}

/**
 * The refusal every publishing path returns when the scan found something and
 * the caller did not allow it. `what` names the thing that was not sent ("the
 * gist", "the feedback").
 */
export function secretScreenRefusal(
	findings: SecretFinding[],
	what: string,
	note?: string
): SecretScreenRefusal {
	const count = findings.length;
	return {
		success: false,
		error: `Found ${count} possible secret${count === 1 ? '' : 's'} in ${what}. Nothing was sent.`,
		code: SECRETS_FOUND_CODE,
		secretFindings: findings,
		...(note ? { secretScreenNote: note } : {}),
	};
}

/** Whether a publishing response is a secret-screen refusal. */
export function isSecretScreenRefusal<T extends SecretScreenFields>(
	response: T | null | undefined
): response is T & { secretFindings: SecretFinding[] } {
	return Array.isArray(response?.secretFindings) && response.secretFindings.length > 0;
}

/** The CLI flag that publishes past a finding. One spelling for every verb. */
export const ALLOW_SECRETS_FLAG = '--allow-secrets';

/**
 * The lines a CLI verb prints under its refusal: one per masked finding, the
 * model note when there is one, and how to send it anyway.
 */
export function secretScreenReportLines(response: SecretScreenFields): string[] {
	const lines = (response.secretFindings ?? []).map(
		(finding) => `  - ${describeSecretFinding(finding)}`
	);
	if (response.secretScreenNote) lines.push(`Note: ${response.secretScreenNote}`);
	lines.push(`Remove them, or re-run with ${ALLOW_SECRETS_FLAG} to send it anyway.`);
	return lines;
}
