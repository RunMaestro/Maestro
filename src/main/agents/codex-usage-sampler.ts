/**
 * Codex Usage Sampler
 *
 * Reads Codex CLI OAuth metadata from CODEX_HOME/auth.json and asks the
 * ChatGPT quota metadata endpoint for the account's active rate-limit windows.
 * This is intentionally isolated from the renderer so auth tokens never leave
 * the main process.
 */

import fs from 'fs/promises';
import path from 'path';

import type { CodexUsageSnapshot } from '../stores/codexUsageStore';
import { resolveCodexHomeKey } from '../stores/codexUsageStore';
import { captureMessage } from '../utils/sentry';

const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SampleCodexUsageOptions {
	codexHome: string;
	timeoutMs?: number;
}

interface CodexAuthFile {
	tokens?: {
		access_token?: string;
		account_id?: string;
		id_token?: string;
	};
}

interface WhamUsageWindow {
	used_percent?: unknown;
	reset_at?: unknown;
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
		};
	}>;
}

export async function sampleCodexUsage(opts: SampleCodexUsageOptions): Promise<CodexUsageSnapshot> {
	const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: opts.codexHome });
	const sampledAt = new Date().toISOString();
	const authPath = path.join(codexHomeKey, 'auth.json');

	let auth: CodexAuthFile;
	try {
		auth = JSON.parse(await fs.readFile(authPath, 'utf8')) as CodexAuthFile;
	} catch (err) {
		return {
			sampledAt,
			codexHomeKey,
			authState: 'missing_auth',
			error:
				err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'
					? `No auth.json at ${authPath}`
					: 'Failed to read Codex auth.json',
		};
	}

	const accessToken = auth.tokens?.access_token;
	const accountId = auth.tokens?.account_id;
	if (!accessToken) {
		return {
			sampledAt,
			codexHomeKey,
			authState: 'unauthenticated',
			email: extractEmailFromJwt(auth.tokens?.id_token),
			error: 'No access_token in auth.json. Run `codex login` for this CODEX_HOME.',
		};
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(CODEX_USAGE_ENDPOINT, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
				...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
			},
			signal: controller.signal,
		});
	} catch {
		clearTimeout(timeout);
		// A thrown fetch means the request never completed: the user is offline,
		// DNS/TLS failed, the endpoint is unreachable, or our own abort timeout
		// fired. All are expected, recoverable, user-environment conditions - not
		// Maestro bugs - so don't report them to Sentry. The UI still reflects the
		// failure via the returned `error` field. (MAESTRO-RR)
		return {
			sampledAt,
			codexHomeKey,
			authState: 'error',
			email: extractEmailFromJwt(auth.tokens?.id_token),
			error: 'Failed to request Codex quota metadata.',
		};
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		const status = response.status;
		// 401/403 just mean the CODEX_HOME isn't logged in - an expected,
		// recoverable state we surface to the UI as `unauthenticated`, not a
		// failure worth a Sentry breadcrumb. Only report genuinely unexpected
		// HTTP errors. Fixes MAESTRO-RR.
		if (status !== 401 && status !== 403) {
			void reportCodexUsageFailure(codexHomeKey, `http ${status}`);
		}
		return {
			sampledAt,
			codexHomeKey,
			authState: status === 401 || status === 403 ? 'unauthenticated' : 'error',
			email: extractEmailFromJwt(auth.tokens?.id_token),
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
			email: extractEmailFromJwt(auth.tokens?.id_token),
			error: 'Codex quota endpoint returned malformed JSON.',
		};
	}

	const rateLimit = body.rate_limit ?? {};
	const session = parseWindow(rateLimit.primary_window);
	const weekly = parseWindow(rateLimit.secondary_window);

	return {
		sampledAt,
		codexHomeKey,
		authState: 'authenticated',
		email:
			typeof body.email === 'string' && body.email.length > 0
				? body.email
				: extractEmailFromJwt(auth.tokens?.id_token),
		planType: typeof body.plan_type === 'string' ? body.plan_type : undefined,
		session: session ?? undefined,
		weekly: weekly ?? undefined,
		additionalLimits: parseAdditionalLimits(body.additional_rate_limits),
	};
}

function parseWindow(window: WhamUsageWindow | undefined): CodexUsageSnapshot['session'] | null {
	if (!window) return null;
	if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) {
		return null;
	}
	const resetsAt = parseResetAt(window.reset_at);
	if (!resetsAt) return null;
	return {
		percent: window.used_percent,
		resetsAt,
	};
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
		const window = parseWindow(limit.rate_limit?.primary_window);
		if (!name || !window) continue;
		parsed.push({ name, percent: window.percent, resetsAt: window.resetsAt });
	}
	return parsed;
}

function parseResetAt(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const milliseconds = value > 10_000_000_000 ? value : value * 1000;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractEmailFromJwt(idToken: string | undefined): string | undefined {
	if (!idToken) return undefined;
	try {
		const payload = idToken.split('.')[1];
		if (!payload) return undefined;
		const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
		const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as {
			email?: unknown;
		};
		return typeof decoded.email === 'string' ? decoded.email : undefined;
	} catch {
		return undefined;
	}
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
