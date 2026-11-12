import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const { captureMessageMock } = vi.hoisted(() => ({
	captureMessageMock: vi.fn(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
}));

import {
	consumeCodexResetCredit,
	fetchCodexResetCredits,
} from '../../../main/agents/codex-reset-credits';

const TEST_ROOT = path.join(process.cwd(), '.tmp-codex-reset-credits');

/** The shape the live endpoint actually returns, trimmed to what we parse. */
const LIVE_CREDIT = {
	id: 'RateLimitResetCredit_2bbb734c82088191a977cd8453f280cd',
	reset_type: 'codex_rate_limits',
	is_supported_by_plan: true,
	status: 'available',
	granted_at: '2026-09-04T05:41:42.552756Z',
	expires_at: '2026-10-04T05:41:42.552756Z',
	redeem_started_at: null,
	redeemed_at: null,
	profile_user_id: 'Codex Team',
	title: 'Full reset (Weekly + 5 hr)',
	description: "Thanks for using Codex! You've been granted one free rate limit reset.",
};

async function writeAuth(tokens: Record<string, unknown> = {}): Promise<void> {
	await fs.writeFile(
		path.join(TEST_ROOT, 'auth.json'),
		JSON.stringify({
			tokens: { access_token: 'redacted-token', account_id: 'account-123', ...tokens },
		})
	);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('codex-reset-credits', () => {
	beforeEach(async () => {
		await fs.rm(TEST_ROOT, { recursive: true, force: true });
		await fs.mkdir(TEST_ROOT, { recursive: true });
		captureMessageMock.mockReset().mockResolvedValue(undefined);
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await fs.rm(TEST_ROOT, { recursive: true, force: true });
	});

	describe('fetchCodexResetCredits (READ)', () => {
		it('never calls the endpoint for an account with no auth.json', async () => {
			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.ok).toBe(false);
			expect(result.error).toContain('No auth.json');
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it('parses the live payload into sanitized credits', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({
					credits: [LIVE_CREDIT],
					available_count: 2,
					immediate_reset_purchase_eligible: false,
				})
			);

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(globalThis.fetch).toHaveBeenCalledWith(
				'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: 'Bearer redacted-token',
						'ChatGPT-Account-Id': 'account-123',
					}),
				})
			);
			expect(result.ok).toBe(true);
			expect(result.detail).toMatchObject({
				available: 2,
				purchaseEligible: false,
			});
			expect(result.detail?.credits[0]).toEqual({
				id: LIVE_CREDIT.id,
				resetType: 'codex_rate_limits',
				supportedByPlan: true,
				status: 'available',
				grantedAt: LIVE_CREDIT.granted_at,
				expiresAt: LIVE_CREDIT.expires_at,
				title: LIVE_CREDIT.title,
				description: LIVE_CREDIT.description,
				grantedBy: 'Codex Team',
			});
		});

		// Unknown and zero are different answers, and only one of them justifies
		// calling a spend wasteful.
		it('leaves an absent applicable count undefined rather than zero', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({ credits: [LIVE_CREDIT], available_count: 1 })
			);

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.detail?.applicable).toBeUndefined();
		});

		it('carries the applicable count through when present', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({
					credits: [LIVE_CREDIT],
					available_count: 2,
					applicable_available_count: 0,
				})
			);

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.detail).toMatchObject({ available: 2, applicable: 0 });
		});

		// Without an id the credit can never be redeemed, so rendering it would
		// put a dead button in the list.
		it('drops a credit with no id', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({ credits: [{ status: 'available' }], available_count: 1 })
			);

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.detail?.credits).toEqual([]);
		});

		// Only an explicit `false` is a refusal; defaulting the other way hides
		// every credit on a response that simply omits the flag.
		it('treats an omitted plan-support flag as supported', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({ credits: [{ id: 'c1', status: 'available' }], available_count: 1 })
			);

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.detail?.credits[0]?.supportedByPlan).toBe(true);
		});

		it('reports a rejected token without a Sentry breadcrumb', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}, 401));

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.ok).toBe(false);
			expect(result.error).toContain('codex login');
			expect(captureMessageMock).not.toHaveBeenCalled();
		});

		it('reports an unexpected HTTP status to Sentry', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}, 418));

			await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(captureMessageMock).toHaveBeenCalledWith(
				'codex reset-credit read failed',
				'warning',
				expect.objectContaining({ status: 418 })
			);
		});

		it('resolves rather than throwing when the network is down', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ENOTFOUND'));

			const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });

			expect(result.ok).toBe(false);
			expect(result.error).toContain('Failed to reach');
		});
	});

	describe('consumeCodexResetCredit (WRITE)', () => {
		it('posts credit_id and redeem_request_id, and reports the reset', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({ code: 'ok', credit: LIVE_CREDIT, windows_reset: 2 })
			);

			const result = await consumeCodexResetCredit({
				codexHome: TEST_ROOT,
				creditId: 'credit-abc',
				idempotencyKey: 'stable-key',
			});

			const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
			expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
			expect((init as RequestInit).method).toBe('POST');
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				credit_id: 'credit-abc',
				redeem_request_id: 'stable-key',
			});
			expect(result).toMatchObject({ ok: true, windowsReset: 2 });
		});

		// The endpoint is REQUIRED to receive one and 400s without it, so a caller
		// that supplies none must still produce a valid request.
		it('mints an idempotency key when the caller supplies none', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ code: 'ok', windows_reset: 1 }));

			await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: 'credit-abc' });

			const body = JSON.parse(
				(vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string
			);
			expect(typeof body.redeem_request_id).toBe('string');
			expect(body.redeem_request_id.length).toBeGreaterThan(0);
		});

		// THE trap: the endpoint answers 200 for refusals, so `response.ok` alone
		// would report every failure as a success.
		it('treats a 200 with windows_reset 0 as a failure', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockResolvedValue(
				jsonResponse({ code: 'no_credit', credit: null, windows_reset: 0 })
			);

			const result = await consumeCodexResetCredit({
				codexHome: TEST_ROOT,
				creditId: 'credit-gone',
			});

			expect(result.ok).toBe(false);
			expect(result.windowsReset).toBe(0);
			expect(result.code).toBe('no_credit');
			expect(result.message).toContain('no longer available');
		});

		it('refuses an empty credit id without calling the endpoint', async () => {
			await writeAuth();

			const result = await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: '  ' });

			expect(result.ok).toBe(false);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it('refuses an account with no auth without calling the endpoint', async () => {
			const result = await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: 'c1' });

			expect(result.ok).toBe(false);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		// A thrown fetch leaves the spend UNDECIDED: the request may have landed,
		// so the message must not claim the credit was preserved.
		it('reports an undecided outcome when the request never completes', async () => {
			await writeAuth();
			vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNRESET'));

			const result = await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: 'c1' });

			expect(result.ok).toBe(false);
			expect(result.message).toContain('may or may not have been spent');
		});
	});
});
