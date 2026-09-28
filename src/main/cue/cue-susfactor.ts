/**
 * 0DIN.ai SusFactor pre-flight check for attacker-controllable Cue input.
 *
 * Cue ingests GitHub issue/PR bodies and comments and hands them to an agent.
 * Those are the only Cue inputs a third party can write, so they are the only
 * ones scored here - task files, CLI prompts, and watched files are the user's
 * own text and scoring them only produced false positives (Maestro's own test
 * fixtures contain injection strings) and fan-out cost.
 *
 * Two-step API: exchange the long-lived `ODIN_API_TOKEN` for a short-lived JWT
 * (900s TTL), then POST content to the sus endpoint. The JWT is cached and
 * refreshed at {@link JWT_REFRESH_AFTER_MS} or on a 401.
 *
 * ## Why chunked scoring is mandatory
 *
 * The classifier scores a whole document, so padding dilutes an injection into
 * invisibility. Measured against the live endpoint, one injected HTML comment
 * scored 0.808 alone and 0.013 after ~2.5KB of ordinary PR prose in front of
 * it - well under any usable threshold. The same document split into 400-char
 * chunks puts the malicious chunk back at 0.998. Whole-document scoring is
 * therefore never correct here; always take the max over chunks.
 *
 * ## Failure policy
 *
 * Fail OPEN. A timeout, 5xx, network error, or missing token lets the item
 * through and logs at WARN. Fail-closed would let a 0DIN outage halt every
 * GitHub-triggered Cue subscription. The caller treats a null verdict as
 * "not suspicious".
 */

import * as crypto from 'crypto';
import { mapWithConcurrency } from '../utils/concurrency';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

const ACCESS_TOKEN_URL = 'https://0din.ai/api/v1/access_tokens';
const SUS_URL = 'https://defense.0din.ai/api/v1/sus';

/** Per-request budget for a single sus call. */
const SUS_TIMEOUT_MS = 3_000;
/** The token exchange is on the critical path too, but it happens once per 750s. */
const TOKEN_TIMEOUT_MS = 5_000;

/**
 * Refresh the JWT this long after issue. The endpoint reports `expires_in: 900`
 * (seconds); refreshing at 750s leaves a 150s margin so an in-flight batch
 * cannot straddle the expiry.
 */
const JWT_REFRESH_AFTER_MS = 750_000;

/**
 * Chunk width and overlap, in characters. The overlap exists so an injection
 * that straddles a boundary still lands whole inside one chunk - without it a
 * split payload is scored as two harmless halves.
 */
export const CHUNK_SIZE = 400;
export const CHUNK_OVERLAP = 100;

/** Parallel sus calls per item. Kept low - this sits in a polling loop. */
const SCORE_CONCURRENCY = 4;

/** Hard cap on scored characters per item, so one enormous body cannot stall a poll. */
const MAX_SCORED_CHARS = 20_000;

export interface SusFactorVerdict {
	/** Highest score across all chunks. */
	score: number;
	/** Number of chunks actually scored. */
	chunks: number;
	/** True when {@link score} met or exceeded the configured threshold. */
	suspicious: boolean;
	/** sha256 of the exact text scored - the dedup/override key. */
	contentHash: string;
}

export interface SusFactorBlockNotice {
	sessionId: string;
	subscriptionName: string;
	eventType: string;
	/** Human-readable item reference, e.g. `owner/repo#412`. */
	itemRef: string;
	url?: string;
	score: number;
	contentHash: string;
}

type Logger = (level: string, message: string, data?: unknown) => void;

// ─── Notifier registration ───────────────────────────────────────────────────

/**
 * The block notification has to reach the renderer, but the poller and its
 * trigger source are constructed far from anything holding a `BrowserWindow`,
 * and Cue injects rather than reaching for globals. Registering the emitter
 * once at engine setup keeps the plumbing to a single call site, matching the
 * module-level state already used by `cue-db` and `cue-active-state`.
 */
let notifier: ((notice: SusFactorBlockNotice) => void) | null = null;

export function setSusFactorNotifier(fn: ((notice: SusFactorBlockNotice) => void) | null): void {
	notifier = fn;
}

export function emitSusFactorBlockNotice(notice: SusFactorBlockNotice): void {
	// Advisory: a missing or throwing notifier must never fail the poll.
	try {
		notifier?.(notice);
	} catch {
		/* notifier is best-effort */
	}
}

// ─── Token cache ─────────────────────────────────────────────────────────────

let cachedJwt: string | null = null;
let cachedJwtAt = 0;

/** Exposed for tests - drops the cached JWT so the next call re-exchanges. */
export function resetSusFactorTokenCache(): void {
	cachedJwt = null;
	cachedJwtAt = 0;
}

function readApiToken(): string | null {
	const raw = process.env.ODIN_API_TOKEN;
	return raw && raw.trim() !== '' ? raw.trim() : null;
}

export function isSusFactorConfigured(): boolean {
	return readApiToken() !== null;
}

async function getJwt(now: number, force: boolean): Promise<string | null> {
	if (!force && cachedJwt && now - cachedJwtAt < JWT_REFRESH_AFTER_MS) {
		return cachedJwt;
	}
	const apiToken = readApiToken();
	if (!apiToken) return null;

	const res = await fetchWithTimeout(
		ACCESS_TOKEN_URL,
		{ method: 'POST', headers: { Authorization: apiToken } },
		TOKEN_TIMEOUT_MS
	);
	if (!res.ok) {
		throw new Error(`0DIN token exchange failed: HTTP ${res.status}`);
	}
	const body = (await res.json()) as { token?: unknown };
	if (typeof body.token !== 'string' || body.token === '') {
		throw new Error('0DIN token exchange returned no token');
	}
	cachedJwt = body.token;
	cachedJwtAt = now;
	return cachedJwt;
}

// ─── Chunking ────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping fixed-width chunks. Text at or under one chunk
 * width is returned as a single chunk so short bodies cost exactly one call.
 */
export function chunkForScoring(
	text: string,
	size: number = CHUNK_SIZE,
	overlap: number = CHUNK_OVERLAP
): string[] {
	const trimmed = text.length > MAX_SCORED_CHARS ? text.slice(0, MAX_SCORED_CHARS) : text;
	if (trimmed.length <= size) return trimmed.trim() === '' ? [] : [trimmed];

	const stride = Math.max(1, size - overlap);
	const chunks: string[] = [];
	for (let start = 0; start < trimmed.length; start += stride) {
		chunks.push(trimmed.slice(start, start + size));
		if (start + size >= trimmed.length) break;
	}
	return chunks;
}

export function hashContent(text: string): string {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

async function scoreChunk(jwt: string, chunk: string): Promise<number | null> {
	const res = await fetchWithTimeout(
		SUS_URL,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: chunk }),
		},
		SUS_TIMEOUT_MS
	);
	if (res.status === 401) {
		// Signals the caller to force a token refresh and retry once.
		throw new UnauthorizedError();
	}
	if (!res.ok) {
		throw new Error(`0DIN sus call failed: HTTP ${res.status}`);
	}
	const body = (await res.json()) as { score?: unknown };
	return typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : null;
}

class UnauthorizedError extends Error {
	constructor() {
		super('0DIN sus call returned 401');
		this.name = 'UnauthorizedError';
	}
}

async function scoreAllChunks(jwt: string, chunks: string[]): Promise<Array<number | null>> {
	return mapWithConcurrency(chunks, SCORE_CONCURRENCY, (chunk) => scoreChunk(jwt, chunk));
}

/**
 * Score `text` and return the max-over-chunks verdict, or `null` when the check
 * could not run (no token, timeout, upstream error). `null` means fail open -
 * callers must treat it as not-suspicious.
 *
 * Every completed scoring is logged, including passes, so the threshold can be
 * retuned against real traffic rather than a synthetic corpus.
 */
export async function scoreSusFactor(
	text: string,
	threshold: number,
	onLog: Logger,
	context: string
): Promise<SusFactorVerdict | null> {
	const chunks = chunkForScoring(text);
	if (chunks.length === 0) return null;

	const contentHash = hashContent(text);
	const startedAt = Date.now();

	try {
		let jwt = await getJwt(startedAt, false);
		if (!jwt) {
			onLog(
				'warn',
				`[CUE] SusFactor skipped for ${context}: ODIN_API_TOKEN is not set - processing normally`
			);
			return null;
		}

		let scores: Array<number | null>;
		try {
			scores = await scoreAllChunks(jwt, chunks);
		} catch (err) {
			if (!(err instanceof UnauthorizedError)) throw err;
			// JWT rejected before its nominal expiry - re-exchange once and retry.
			jwt = await getJwt(Date.now(), true);
			if (!jwt) return null;
			scores = await scoreAllChunks(jwt, chunks);
		}

		const usable = scores.filter((s): s is number => s !== null);
		if (usable.length === 0) {
			onLog(
				'warn',
				`[CUE] SusFactor returned no usable score for ${context} - processing normally`
			);
			return null;
		}

		const score = Math.max(...usable);
		const verdict: SusFactorVerdict = {
			score,
			chunks: chunks.length,
			suspicious: score >= threshold,
			contentHash,
		};

		onLog(
			verdict.suspicious ? 'warn' : 'cue',
			`[CUE] SusFactor ${verdict.suspicious ? 'BLOCK' : 'pass'} ${context}: score=${score.toFixed(4)} threshold=${threshold} chunks=${chunks.length} in ${Date.now() - startedAt}ms`
		);
		return verdict;
	} catch (err) {
		// Fail open: 0DIN being slow or down must not halt Cue processing.
		onLog(
			'warn',
			`[CUE] SusFactor check failed for ${context} - processing normally (fail-open): ${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
}

// ─── GitHub event guard ──────────────────────────────────────────────────────

/**
 * Concatenate the attacker-controllable text on a GitHub event.
 *
 * Title, body, and new comment bodies only. Everything else on the payload
 * (repo, branch, author, labels, URLs) is either GitHub-generated or too short
 * to carry an injection, and scoring it just burns calls. The title is folded
 * in because it is third-party text and almost always rides along in the first
 * chunk for free.
 */
export function extractGitHubScorableText(payload: Record<string, unknown>): string {
	const parts: string[] = [];
	const title = typeof payload.title === 'string' ? payload.title : '';
	const body = typeof payload.body === 'string' ? payload.body : '';
	if (title.trim() !== '') parts.push(title);
	if (body.trim() !== '') parts.push(body);

	const comments = Array.isArray(payload.new_comments) ? payload.new_comments : [];
	for (const comment of comments) {
		if (comment && typeof comment === 'object' && 'body' in comment) {
			const commentBody = (comment as { body?: unknown }).body;
			if (typeof commentBody === 'string' && commentBody.trim() !== '') {
				parts.push(commentBody);
			}
		}
	}
	return parts.join('\n\n');
}

function describeItem(payload: Record<string, unknown>): string {
	const repo = typeof payload.repo === 'string' ? payload.repo : 'unknown-repo';
	const number = payload.number ?? '?';
	return `${repo}#${number}`;
}

export interface GuardGitHubEventParams {
	event: { id: string; type: string; payload: Record<string, unknown> };
	sessionId: string;
	subscriptionId: string;
	subscriptionName: string;
	enabled: boolean;
	threshold: number;
	onLog: Logger;
}

/**
 * Decide whether a GitHub event may reach an agent.
 *
 * Returns `true` to emit, `false` to drop. Drops are recorded and the user is
 * toasted exactly once per distinct content hash; a re-poll of the same
 * unchanged item short-circuits on the stored verdict without touching the
 * network. An overridden block (`allowed = 1`) emits normally.
 *
 * Never throws - any unexpected failure falls through to `true` (fail open).
 */
export async function guardGitHubEvent(params: GuardGitHubEventParams): Promise<boolean> {
	try {
		return await guardGitHubEventInner(params);
	} catch (err) {
		// Belt and braces on the documented never-throws contract: the caller is
		// a fire-and-forget poll callback, so a rejection here would be an
		// unhandled rejection AND would silently drop the event.
		params.onLog(
			'warn',
			`[CUE] SusFactor guard errored - processing normally (fail-open): ${err instanceof Error ? err.message : String(err)}`
		);
		return true;
	}
}

async function guardGitHubEventInner(params: GuardGitHubEventParams): Promise<boolean> {
	const { event, enabled, threshold, onLog } = params;
	if (!enabled) return true;
	if (!isSusFactorConfigured()) return true;

	const text = extractGitHubScorableText(event.payload);
	if (text.trim() === '') return true;

	const itemRef = describeItem(event.payload);
	const context = `${itemRef} (${event.type})`;

	// Lazy imports keep the DB out of the module graph for callers that only
	// want the pure scoring helpers (and out of unit tests that never init it).
	const { getSusFactorBlock, recordSusFactorBlock, markSusFactorNotified } =
		await import('./cue-db');

	const contentHash = hashContent(text);
	const prior = getSusFactorBlock(contentHash);
	if (prior) {
		if (prior.allowed) {
			onLog('cue', `[CUE] SusFactor override in effect for ${context} - processing normally`);
			return true;
		}
		// Already scored and already reported. Stay silent: GitHub polling
		// revisits open items every cycle and re-toasting would be spam.
		onLog('cue', `[CUE] SusFactor: ${context} still blocked (score ${prior.score.toFixed(4)})`);
		return false;
	}

	const verdict = await scoreSusFactor(text, threshold, onLog, context);
	// Fail open: null means the check could not run, not that the item is clean.
	if (!verdict || !verdict.suspicious) return true;

	const url = typeof event.payload.url === 'string' ? event.payload.url : null;
	recordSusFactorBlock({
		contentHash: verdict.contentHash,
		subscriptionId: params.subscriptionId,
		sessionId: params.sessionId,
		subscriptionName: params.subscriptionName,
		eventType: event.type,
		itemRef,
		url,
		score: verdict.score,
		threshold,
		eventJson: JSON.stringify(event),
		blockedAt: Date.now(),
	});

	emitSusFactorBlockNotice({
		sessionId: params.sessionId,
		subscriptionName: params.subscriptionName,
		eventType: event.type,
		itemRef,
		url: url ?? undefined,
		score: verdict.score,
		contentHash: verdict.contentHash,
	});
	markSusFactorNotified(verdict.contentHash);

	onLog(
		'error',
		`[CUE] SusFactor BLOCKED ${context} (score ${verdict.score.toFixed(4)} >= ${threshold}). The agent was not run. Override with the content hash ${verdict.contentHash.slice(0, 12)}.`
	);
	return false;
}
