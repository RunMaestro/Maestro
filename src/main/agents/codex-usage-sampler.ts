/**
 * Codex Usage Sampler
 *
 * Reads Codex CLI OAuth metadata from CODEX_HOME/auth.json and asks the
 * ChatGPT quota metadata endpoint for the account's active rate-limit windows.
 * This is intentionally isolated from the renderer so auth tokens never leave
 * the main process.
 */

import type { CodexUsageSnapshot, CodexUsageWindow } from '../stores/codexUsageStore';
import { resolveCodexHomeKey } from '../stores/codexUsageStore';
import { codexAuthHeaders, readCodexAuth } from './codex-auth';
import { captureMessage } from '../utils/sentry';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { DURATION_LADDER_DAYS, humanizeDuration } from '../../shared/duration';

const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Longest `limit_window_seconds` still filed as the short "session" bucket.
 *
 * ChatGPT's session window is 5h today and its long window is 7d, so the
 * boundary sits well clear of both. The ceiling rather than an equality test
 * means a plan that reports a slightly different short window (3h, 6h) is still
 * a session rather than silently becoming a weekly.
 */
const SESSION_WINDOW_MAX_SECONDS = 6 * 60 * 60;

/**
 * HTTP statuses from the Codex quota endpoint that say nothing about Maestro.
 *
 * - 401/403: this CODEX_HOME isn't logged in. Surfaced to the UI as
 *   `unauthenticated`.
 * - 408/429/5xx: the upstream is throttling us or is degraded. The sampler runs
 *   on a timer, so a single ChatGPT outage reports once per tick per install -
 *   the dominant source of MAESTRO-RR volume.
 *
 * Anything else (a 4xx that implies we sent a malformed request) still reports,
 * because that would be our bug.
 */
function isExpectedQuotaStatus(status: number): boolean {
	return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export interface SampleCodexUsageOptions {
	codexHome: string;
	timeoutMs?: number;
}

interface WhamUsageWindow {
	used_percent?: unknown;
	reset_at?: unknown;
	/**
	 * How long the window the percentage is measured over runs for. This is the
	 * only field that tells a 5h session bucket apart from a weekly one - the
	 * slot a window arrives in does not, because plans order them differently.
	 * Older responses omit it, so every consumer treats it as optional.
	 */
	limit_window_seconds?: unknown;
}

interface WhamUsageResponse {
	email?: unknown;
	plan_type?: unknown;
	rate_limit?: {
		limit_reached?: unknown;
		primary_window?: WhamUsageWindow;
		secondary_window?: WhamUsageWindow;
	};
	additional_rate_limits?: Array<{
		limit_name?: unknown;
		metered_feature?: unknown;
		rate_limit?: {
			primary_window?: WhamUsageWindow;
			secondary_window?: WhamUsageWindow;
		};
	}>;
	/**
	 * Reset-credit inventory, which the usage payload already carries - so the
	 * count beside the bars costs no extra request. The full per-credit list
	 * (ids, titles, expiry) needs the dedicated read in `codex-reset-credits.ts`.
	 */
	rate_limit_reset_credits?: {
		available_count?: unknown;
		applicable_available_count?: unknown;
	};
}

export async function sampleCodexUsage(opts: SampleCodexUsageOptions): Promise<CodexUsageSnapshot> {
	const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: opts.codexHome });
	const sampledAt = new Date().toISOString();

	const auth = await readCodexAuth(codexHomeKey);
	if (!auth.ok) {
		return {
			sampledAt,
			codexHomeKey,
			authState: auth.kind,
			...(auth.email ? { email: auth.email } : {}),
			error: auth.error,
		};
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(
			CODEX_USAGE_ENDPOINT,
			{ headers: codexAuthHeaders(auth) },
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
		);
	} catch {
		// A thrown fetch means the request never completed: the user is offline,
		// DNS/TLS failed, the endpoint is unreachable, or our own abort timeout
		// fired. All are expected, recoverable, user-environment conditions - not
		// Maestro bugs - so don't report them to Sentry. The UI still reflects the
		// failure via the returned `error` field. (MAESTRO-RR)
		return {
			sampledAt,
			codexHomeKey,
			authState: 'error',
			email: auth.email,
			error: 'Failed to request Codex quota metadata.',
		};
	}

	if (!response.ok) {
		const status = response.status;
		// Un-logged-in CODEX_HOMEs and a throttled or degraded upstream are
		// expected, recoverable states we surface through the returned snapshot,
		// not failures worth a Sentry breadcrumb. Only report genuinely
		// unexpected HTTP errors. See isExpectedQuotaStatus (MAESTRO-RR).
		if (!isExpectedQuotaStatus(status)) {
			void reportCodexUsageFailure(codexHomeKey, `http ${status}`);
		}
		return {
			sampledAt,
			codexHomeKey,
			authState: status === 401 || status === 403 ? 'unauthenticated' : 'error',
			email: auth.email,
			error:
				status === 401 || status === 403
					? 'Codex auth token was rejected. Run `codex login` for this CODEX_HOME.'
					: `Codex quota endpoint returned HTTP ${status}.`,
		};
	}

	let body: WhamUsageResponse;
	try {
		body = (await response.json()) as WhamUsageResponse;
	} catch (err) {
		void reportCodexUsageFailure(codexHomeKey, `json: ${formatError(err)}`);
		return {
			sampledAt,
			codexHomeKey,
			authState: 'error',
			email: auth.email,
			error: 'Codex quota endpoint returned malformed JSON.',
		};
	}

	const rateLimit = body.rate_limit ?? {};
	const { session, weekly } = classifyUsageWindows(
		rateLimit.primary_window,
		rateLimit.secondary_window
	);

	return {
		sampledAt,
		codexHomeKey,
		authState: 'authenticated',
		email: typeof body.email === 'string' && body.email.length > 0 ? body.email : auth.email,
		planType: typeof body.plan_type === 'string' ? body.plan_type : undefined,
		session,
		weekly,
		additionalLimits: parseAdditionalLimits(body.additional_rate_limits),
		resetCredits: parseResetCreditCounts(body.rate_limit_reset_credits),
	};
}

/**
 * The two reset-credit counts, kept apart deliberately.
 *
 * `available` is inventory; `applicable` is how many would take effect right
 * now, which the API reports as 0 whenever no window is consumed enough for a
 * reset to change anything. An absent `applicable` stays `undefined` rather
 * than becoming 0 - see `CodexResetCreditCounts`, where unknown and zero drive
 * different verdicts.
 */
function parseResetCreditCounts(
	raw: WhamUsageResponse['rate_limit_reset_credits']
): CodexUsageSnapshot['resetCredits'] {
	if (!raw || typeof raw !== 'object') return undefined;
	const available = readCount(raw.available_count);
	if (available === undefined) return undefined;
	return { available, applicable: readCount(raw.applicable_available_count) };
}

function readCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseWindow(window: WhamUsageWindow | undefined): CodexUsageWindow | null {
	if (!window) return null;
	if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) {
		return null;
	}
	const resetsAt = parseResetAt(window.reset_at);
	if (!resetsAt) return null;
	const windowSeconds =
		typeof window.limit_window_seconds === 'number' &&
		Number.isFinite(window.limit_window_seconds) &&
		window.limit_window_seconds > 0
			? window.limit_window_seconds
			: undefined;
	return {
		percent: window.used_percent,
		resetsAt,
		...(windowSeconds === undefined ? {} : { windowSeconds }),
	};
}

/**
 * File the account's two rate-limit windows into the session and weekly
 * buckets, by DURATION rather than by which slot they arrived in.
 *
 * Slot position is not the answer: a `team` plan reports
 * `primary_window` = 5h and `secondary_window` = 7d, while a `prolite` plan
 * reports `primary_window` = 7d and no secondary at all. Mapping by position
 * therefore filed a weekly window as a five-hour session on every plan of the
 * second shape, and left `weekly` empty on an account whose only limit is
 * weekly - so a consumer waiting on a "session" reset waited up to a week
 * (#1596).
 *
 * A window that does not declare `limit_window_seconds` keeps the old
 * positional meaning, since that is all older responses give us to go on. Only
 * those may spill into the other bucket when their own is taken - a declared
 * length is the one fact we have, and moving a 30d window into the session
 * bucket to avoid losing it would render it as `Session (30d)`, which is the
 * exact mislabel this function exists to prevent. Two declared windows on the
 * same side of the boundary is not a shape any Codex plan reports today.
 */
function classifyUsageWindows(
	primaryRaw: WhamUsageWindow | undefined,
	secondaryRaw: WhamUsageWindow | undefined
): { session?: CodexUsageWindow; weekly?: CodexUsageWindow } {
	const slots: Array<{ window: CodexUsageWindow; slotBucket: 'session' | 'weekly' }> = [];
	const primary = parseWindow(primaryRaw);
	if (primary) slots.push({ window: primary, slotBucket: 'session' });
	const secondary = parseWindow(secondaryRaw);
	if (secondary) slots.push({ window: secondary, slotBucket: 'weekly' });

	const out: { session?: CodexUsageWindow; weekly?: CodexUsageWindow } = {};

	// A declared length decides its bucket outright, shortest first so the
	// shorter of a pair takes the session bucket. It never spills: a window is
	// filed where its length says it belongs, or not at all.
	const declared = slots
		.filter((slot) => slot.window.windowSeconds !== undefined)
		.sort((a, b) => (a.window.windowSeconds ?? 0) - (b.window.windowSeconds ?? 0));
	for (const slot of declared) {
		const seconds = slot.window.windowSeconds ?? 0;
		const bucket = seconds <= SESSION_WINDOW_MAX_SECONDS ? 'session' : 'weekly';
		if (!out[bucket]) out[bucket] = slot.window;
	}

	// An undeclared window is a guess either way, so it prefers its slot's
	// historical meaning and takes whichever bucket is still free otherwise.
	for (const slot of slots) {
		if (slot.window.windowSeconds !== undefined) continue;
		const other = slot.slotBucket === 'session' ? 'weekly' : 'session';
		if (!out[slot.slotBucket]) out[slot.slotBucket] = slot.window;
		else if (!out[other]) out[other] = slot.window;
	}

	return out;
}

function parseAdditionalLimits(
	limits: WhamUsageResponse['additional_rate_limits']
): CodexUsageSnapshot['additionalLimits'] {
	if (!Array.isArray(limits)) return [];
	const parsed: NonNullable<CodexUsageSnapshot['additionalLimits']> = [];
	for (const limit of limits) {
		const name =
			typeof limit.limit_name === 'string'
				? limit.limit_name
				: typeof limit.metered_feature === 'string'
					? limit.metered_feature
					: null;
		if (!name) continue;
		// A sublimit can carry both windows too, and the second one used to be
		// discarded outright. Each renders as its own row, so when a sublimit
		// yields two they are suffixed to keep the names distinct - the rows are
		// keyed by name, and two identical labels collapse into one.
		const windows = [
			{ window: parseWindow(limit.rate_limit?.primary_window), slot: 'session' as const },
			{ window: parseWindow(limit.rate_limit?.secondary_window), slot: 'weekly' as const },
		].filter((entry): entry is { window: CodexUsageWindow; slot: 'session' | 'weekly' } => {
			return entry.window !== null;
		});
		for (const { window, slot } of windows) {
			parsed.push({
				name: windows.length > 1 ? `${name} (${describeWindowLength(window, slot)})` : name,
				percent: window.percent,
				resetsAt: window.resetsAt,
				...(window.windowSeconds === undefined ? {} : { windowSeconds: window.windowSeconds }),
			});
		}
	}
	return parsed;
}

/**
 * Short label for a window's length, used only to keep two rows of the same
 * sublimit apart. A window that never declared its length falls back to the
 * slot word, so the two suffixes can never come out identical and silently
 * collapse the pair into one row.
 */
function describeWindowLength(window: CodexUsageWindow, slot: 'session' | 'weekly'): string {
	const seconds = window.windowSeconds;
	if (seconds === undefined) return slot;
	return humanizeDuration(seconds * 1000, { units: DURATION_LADDER_DAYS });
}

function parseResetAt(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const milliseconds = value > 10_000_000_000 ? value : value * 1000;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function reportCodexUsageFailure(codexHomeKey: string, reason: string): Promise<void> {
	await captureMessage('codex usage sample failed', 'warning', {
		codexHomeKey,
		reason,
	});
}
