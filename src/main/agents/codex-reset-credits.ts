/**
 * The two Codex reset-credit primitives: READ what the account holds, and WRITE
 * one back to reopen its usage windows.
 *
 * ChatGPT grants Codex accounts "Full reset" credits. Redeeming one reopens the
 * 5-hour and weekly windows immediately rather than at their scheduled reset.
 * The Codex CLI only exposes this inside its TUI, so Maestro wraps it the same
 * way it wraps login: the user stays in the app.
 *
 *   READ   GET  /backend-api/wham/rate-limit-reset-credits
 *          -> { credits: [...], available_count, total_earned_count, ... }
 *
 *   WRITE  POST /backend-api/wham/rate-limit-reset-credits/consume
 *          <- { credit_id, redeem_request_id }
 *          -> { code, credit, windows_reset }
 *
 * Both are auth-bearing, so they live in main and hand the renderer only the
 * sanitized shapes from `src/shared/codexResetCredits.ts`.
 *
 * Three things the wire format makes easy to get wrong:
 *
 *  1. **`redeem_request_id` is REQUIRED and it is the idempotency key.** The
 *     endpoint 400s without it. It is what makes a retried consume safe, so it
 *     must be stable across retries of ONE logical spend and different between
 *     two deliberate spends - never generated per HTTP attempt inside a retry
 *     loop, or a network hiccup costs two credits for one reset.
 *
 *  2. **Failure comes back as HTTP 200.** A bad or already-spent credit answers
 *     `200 {"code":"no_credit","credit":null,"windows_reset":0}`. Checking
 *     `response.ok` alone reports every failure as a success, so the real
 *     signal is `windows_reset > 0`.
 *
 *  3. **`windows_reset` is the only proof anything happened.** A credit is
 *     consumed against whatever windows are currently used; at low usage the
 *     API can accept the call and reset nothing. Callers must report that as a
 *     failed spend, because the user's credit is gone either way and telling
 *     them it worked is the one outcome they cannot check for themselves.
 */

import { randomUUID } from 'crypto';

import type {
	CodexResetCredit,
	CodexResetCreditConsumeResult,
	CodexResetCreditsDetail,
} from '../../shared/codexResetCredits';
import { asResetCreditStatus } from '../../shared/codexResetCredits';
import { resolveCodexHomeKey } from '../stores/codexUsageStore';
import { codexAuthHeaders, readCodexAuth } from './codex-auth';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { logger } from '../utils/logger';
import { captureMessage } from '../utils/sentry';

const LOG_CONTEXT = '[CodexResetCredits]';

const CREDITS_ENDPOINT = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CONSUME_ENDPOINT = `${CREDITS_ENDPOINT}/consume`;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Statuses that say nothing about Maestro. Mirrors `isExpectedQuotaStatus` in
 * the usage sampler: an un-logged-in account and a throttled or degraded
 * upstream are user-environment conditions we surface through the result, not
 * bugs worth a Sentry report.
 */
function isExpectedStatus(status: number): boolean {
	return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export interface CodexResetCreditsOptions {
	codexHome: string;
	timeoutMs?: number;
}

export interface CodexResetCreditsReadResult {
	ok: boolean;
	detail?: CodexResetCreditsDetail;
	/** Ready-to-render explanation when `ok` is false. */
	error?: string;
}

interface WhamCreditsResponse {
	credits?: unknown;
	available_count?: unknown;
	applicable_available_count?: unknown;
	immediate_reset_purchase_eligible?: unknown;
}

interface WhamConsumeResponse {
	code?: unknown;
	windows_reset?: unknown;
}

/**
 * READ: every reset credit this account holds.
 *
 * Resolves rather than throws on every outcome. The caller is an IPC handler
 * answering a panel that must render something for an account that is simply
 * not logged in, and an exception there reads as Maestro being broken rather
 * than as "this account has no credits to show".
 */
export async function fetchCodexResetCredits(
	opts: CodexResetCreditsOptions
): Promise<CodexResetCreditsReadResult> {
	const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: opts.codexHome });
	const auth = await readCodexAuth(codexHomeKey);
	if (!auth.ok) {
		return { ok: false, error: auth.error };
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(
			CREDITS_ENDPOINT,
			{ headers: codexAuthHeaders(auth) },
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
		);
	} catch {
		// Offline, DNS/TLS failure, unreachable endpoint, or our own abort. All
		// expected and recoverable - reported through the result, not to Sentry.
		return { ok: false, error: 'Failed to reach the Codex reset-credit endpoint.' };
	}

	if (!response.ok) {
		if (!isExpectedStatus(response.status)) {
			void captureMessage('codex reset-credit read failed', 'warning', {
				codexHomeKey,
				status: response.status,
			});
		}
		return {
			ok: false,
			error:
				response.status === 401 || response.status === 403
					? 'Codex auth token was rejected. Run `codex login` for this CODEX_HOME.'
					: `Codex reset-credit endpoint returned HTTP ${response.status}.`,
		};
	}

	let body: WhamCreditsResponse;
	try {
		body = (await response.json()) as WhamCreditsResponse;
	} catch {
		void captureMessage('codex reset-credit read returned malformed JSON', 'warning', {
			codexHomeKey,
		});
		return { ok: false, error: 'Codex reset-credit endpoint returned malformed JSON.' };
	}

	return { ok: true, detail: parseCreditsDetail(body) };
}

export interface ConsumeCodexResetCreditOptions extends CodexResetCreditsOptions {
	/** The `credit_id` to redeem. */
	creditId: string;
	/**
	 * Stable per logical spend. Supply one when a caller may retry so the retry
	 * cannot double-spend; omitted, a fresh one is minted for this single call.
	 */
	idempotencyKey?: string;
}

/**
 * WRITE: redeem one credit, reopening the account's consumed usage windows.
 *
 * Irreversible and finite, so every caller path to this function is either an
 * explicit user action or an explicitly enabled per-agent automation. It is
 * deliberately NOT wired into any ambient refresh, sweep, or retry default.
 */
export async function consumeCodexResetCredit(
	opts: ConsumeCodexResetCreditOptions
): Promise<CodexResetCreditConsumeResult> {
	const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: opts.codexHome });
	if (!opts.creditId.trim()) {
		return { ok: false, windowsReset: 0, message: 'No reset credit was selected.' };
	}

	const auth = await readCodexAuth(codexHomeKey);
	if (!auth.ok) {
		return { ok: false, windowsReset: 0, message: auth.error };
	}

	// One key per logical spend. A caller that retries passes its own so the
	// second attempt redeems the same grant rather than a second one.
	const redeemRequestId = opts.idempotencyKey?.trim() || randomUUID();

	let response: Response;
	try {
		response = await fetchWithTimeout(
			CONSUME_ENDPOINT,
			{
				method: 'POST',
				headers: codexAuthHeaders(auth, { 'Content-Type': 'application/json' }),
				body: JSON.stringify({ credit_id: opts.creditId, redeem_request_id: redeemRequestId }),
			},
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
		);
	} catch {
		// A thrown fetch leaves the spend UNDECIDED: the request may have landed.
		// Say so rather than claiming failure, and keep the idempotency key in the
		// message so a retry can reuse it instead of risking a second credit.
		return {
			ok: false,
			windowsReset: 0,
			message: 'Could not reach Codex to redeem the credit. It may or may not have been spent.',
		};
	}

	if (!response.ok) {
		if (!isExpectedStatus(response.status)) {
			void captureMessage('codex reset-credit consume failed', 'warning', {
				codexHomeKey,
				status: response.status,
			});
		}
		return {
			ok: false,
			windowsReset: 0,
			message:
				response.status === 401 || response.status === 403
					? 'Codex auth token was rejected. Run `codex login` for this CODEX_HOME.'
					: `Codex reset-credit redemption returned HTTP ${response.status}.`,
		};
	}

	let body: WhamConsumeResponse;
	try {
		body = (await response.json()) as WhamConsumeResponse;
	} catch {
		return {
			ok: false,
			windowsReset: 0,
			message: 'Codex returned an unreadable response to the redemption.',
		};
	}

	// The endpoint answers 200 for refusals too, so the count is the verdict.
	const windowsReset = typeof body.windows_reset === 'number' ? body.windows_reset : 0;
	const code = typeof body.code === 'string' ? body.code : undefined;

	if (windowsReset > 0) {
		logger.info('Redeemed Codex reset credit', LOG_CONTEXT, { codexHomeKey, windowsReset });
		return { ok: true, windowsReset, code };
	}

	logger.warn('Codex reset credit redeemed nothing', LOG_CONTEXT, { codexHomeKey, code });
	return {
		ok: false,
		windowsReset: 0,
		code,
		message: describeConsumeFailure(code),
	};
}

/** Name the refusal in the user's terms rather than echoing the API's code. */
function describeConsumeFailure(code: string | undefined): string {
	switch (code) {
		case 'no_credit':
			return 'That reset credit is no longer available. It may have already been redeemed or expired.';
		case undefined:
			return 'Codex redeemed no usage windows.';
		default:
			return `Codex declined the redemption (${code}).`;
	}
}

function parseCreditsDetail(body: WhamCreditsResponse): CodexResetCreditsDetail {
	const rawCredits = Array.isArray(body.credits) ? body.credits : [];
	const credits: CodexResetCredit[] = [];
	for (const entry of rawCredits) {
		const parsed = parseCredit(entry);
		if (parsed) credits.push(parsed);
	}

	return {
		credits,
		available: readCount(body.available_count) ?? credits.length,
		// Deliberately left `undefined` when absent rather than defaulted to 0:
		// see `CodexResetCreditCounts` - unknown and zero mean different things
		// and only one of them justifies calling a spend wasteful.
		applicable: readCount(body.applicable_available_count),
		purchaseEligible:
			typeof body.immediate_reset_purchase_eligible === 'boolean'
				? body.immediate_reset_purchase_eligible
				: undefined,
	};
}

function parseCredit(entry: unknown): CodexResetCredit | null {
	if (!entry || typeof entry !== 'object') return null;
	const record = entry as Record<string, unknown>;
	const id = typeof record.id === 'string' ? record.id : '';
	// Without an id the credit can never be redeemed, so rendering it would put
	// a dead button in the list.
	if (!id) return null;

	return {
		id,
		resetType: readString(record.reset_type),
		// Absent means the plan supports it: only an explicit `false` from the
		// API is a refusal, and defaulting the other way hides every credit on a
		// response that simply omits the flag.
		supportedByPlan: record.is_supported_by_plan !== false,
		status: asResetCreditStatus(record.status),
		grantedAt: readString(record.granted_at),
		expiresAt: readString(record.expires_at),
		title: readString(record.title),
		description: readString(record.description),
		grantedBy: readString(record.profile_user_id),
	};
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
