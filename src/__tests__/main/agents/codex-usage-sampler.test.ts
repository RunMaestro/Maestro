import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const { captureMessageMock } = vi.hoisted(() => ({
	captureMessageMock: vi.fn(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
}));

import { sampleCodexUsage } from '../../../main/agents/codex-usage-sampler';

const TEST_ROOT = path.join(process.cwd(), '.tmp-codex-usage-sampler');

async function writeAuth(): Promise<void> {
	await fs.writeFile(
		path.join(TEST_ROOT, 'auth.json'),
		JSON.stringify({ tokens: { access_token: 'redacted-token' } })
	);
}

function respondWith(body: unknown): void {
	vi.mocked(globalThis.fetch).mockResolvedValue({
		ok: true,
		status: 200,
		json: vi.fn().mockResolvedValue(body),
	} as unknown as Response);
}

describe('codex-usage-sampler', () => {
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

	it('returns a missing_auth snapshot when auth.json is absent', async () => {
		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot).toMatchObject({
			codexHomeKey: TEST_ROOT,
			authState: 'missing_auth',
		});
		expect(snapshot.error).toContain('No auth.json');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('maps wham usage windows into a sanitized Codex snapshot', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({
				tokens: {
					access_token: 'redacted-token',
					account_id: 'account-123',
				},
			})
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					email: 'codex@example.com',
					plan_type: 'pro',
					rate_limit: {
						primary_window: {
							used_percent: 12,
							reset_at: 1779550000,
							limit_window_seconds: 18000,
						},
						secondary_window: {
							used_percent: 34,
							reset_at: 1779900000,
							limit_window_seconds: 604800,
						},
					},
					additional_rate_limits: [
						{
							limit_name: 'gpt-5.3-codex',
							rate_limit: {
								primary_window: { used_percent: 5, reset_at: 1779560000 },
							},
						},
					],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://chatgpt.com/backend-api/wham/usage',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer redacted-token',
					'ChatGPT-Account-Id': 'account-123',
				}),
			})
		);
		expect(snapshot).toMatchObject({
			codexHomeKey: TEST_ROOT,
			authState: 'authenticated',
			email: 'codex@example.com',
			planType: 'pro',
			session: { percent: 12, resetsAt: '2026-05-23T15:26:40.000Z', windowSeconds: 18000 },
			weekly: { percent: 34, resetsAt: '2026-05-27T16:40:00.000Z', windowSeconds: 604800 },
			additionalLimits: [
				{
					name: 'gpt-5.3-codex',
					percent: 5,
					resetsAt: '2026-05-23T18:13:20.000Z',
				},
			],
		});
	});

	it('drops non-finite usage percentages from quota windows', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({
				tokens: {
					access_token: 'redacted-token',
				},
			})
		);
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue({
				email: 'codex@example.com',
				rate_limit: {
					primary_window: { used_percent: Number.NaN, reset_at: 1779550000 },
					secondary_window: { used_percent: Number.POSITIVE_INFINITY, reset_at: 1779900000 },
				},
				additional_rate_limits: [
					{
						limit_name: 'bad-window',
						rate_limit: {
							primary_window: { used_percent: Number.NaN, reset_at: 1779560000 },
						},
					},
				],
			}),
		} as unknown as Response);

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('authenticated');
		expect(snapshot.session).toBeUndefined();
		expect(snapshot.weekly).toBeUndefined();
		expect(snapshot.additionalLimits).toEqual([]);
	});

	it('files a weekly primary_window as weekly, not as a 5h session (#1596)', async () => {
		// A `prolite` plan reports its ONLY window - a weekly one - in
		// `primary_window`, which the old positional map filed as a 5h session
		// while reporting no weekly limit at all.
		await writeAuth();
		respondWith({
			plan_type: 'prolite',
			rate_limit: {
				primary_window: {
					used_percent: 25,
					reset_at: 1779900000,
					limit_window_seconds: 604800,
				},
				secondary_window: null,
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.session).toBeUndefined();
		expect(snapshot.weekly).toEqual({
			percent: 25,
			resetsAt: '2026-05-27T16:40:00.000Z',
			windowSeconds: 604800,
		});
	});

	it('files windows by duration even when the slots arrive reversed', async () => {
		await writeAuth();
		respondWith({
			rate_limit: {
				primary_window: { used_percent: 40, reset_at: 1779900000, limit_window_seconds: 604800 },
				secondary_window: { used_percent: 10, reset_at: 1779550000, limit_window_seconds: 18000 },
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.session?.percent).toBe(10);
		expect(snapshot.weekly?.percent).toBe(40);
	});

	it('falls back to slot position when no window declares its length', async () => {
		// Older responses omit `limit_window_seconds` entirely; those keep the
		// original positional meaning rather than being dropped.
		await writeAuth();
		respondWith({
			rate_limit: {
				primary_window: { used_percent: 12, reset_at: 1779550000 },
				secondary_window: { used_percent: 34, reset_at: 1779900000 },
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.session?.percent).toBe(12);
		expect(snapshot.session?.windowSeconds).toBeUndefined();
		expect(snapshot.weekly?.percent).toBe(34);
	});

	it('keeps both windows of a sublimit under distinct names', async () => {
		await writeAuth();
		respondWith({
			rate_limit: {},
			additional_rate_limits: [
				{
					limit_name: 'gpt-5.3-codex',
					rate_limit: {
						primary_window: {
							used_percent: 5,
							reset_at: 1779560000,
							limit_window_seconds: 18000,
						},
						secondary_window: {
							used_percent: 60,
							reset_at: 1779900000,
							limit_window_seconds: 604800,
						},
					},
				},
			],
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.additionalLimits).toEqual([
			{
				name: 'gpt-5.3-codex (5h)',
				percent: 5,
				resetsAt: '2026-05-23T18:13:20.000Z',
				windowSeconds: 18000,
			},
			{
				name: 'gpt-5.3-codex (7d)',
				percent: 60,
				resetsAt: '2026-05-27T16:40:00.000Z',
				windowSeconds: 604800,
			},
		]);
	});

	it('leaves a single-window sublimit name unsuffixed', async () => {
		await writeAuth();
		respondWith({
			rate_limit: {},
			additional_rate_limits: [
				{
					metered_feature: 'sora',
					rate_limit: {
						primary_window: { used_percent: 7, reset_at: 1779560000 },
					},
				},
			],
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.additionalLimits).toEqual([
			{ name: 'sora', percent: 7, resetsAt: '2026-05-23T18:13:20.000Z' },
		]);
	});

	it('never files a long window as a session, even when the weekly bucket is taken', async () => {
		// Two declared windows on the same side of the boundary is not a shape
		// any Codex plan reports, but if it ever appears the longer one must not
		// spill into the session bucket and render as `Session (30d)` - that is
		// the exact mislabel this classification exists to prevent.
		await writeAuth();
		respondWith({
			rate_limit: {
				primary_window: { used_percent: 40, reset_at: 1779900000, limit_window_seconds: 604800 },
				secondary_window: {
					used_percent: 70,
					reset_at: 1779900000,
					limit_window_seconds: 2592000,
				},
			},
		});

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.weekly?.percent).toBe(40);
		expect(snapshot.session).toBeUndefined();
	});

	it('treats HTTP 401 as unauthenticated without reporting to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'expired-token' } })
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('unauthenticated');
		expect(captureMessageMock).not.toHaveBeenCalled();
	});

	it('does not report network request failures to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'redacted-token' } })
		);
		// A thrown fetch (offline, DNS/TLS failure, unreachable endpoint, or our
		// own abort timeout) is the dominant MAESTRO-RR cause - an expected,
		// recoverable user-environment condition, not a Sentry-worthy crash.
		vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('fetch failed'));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('error');
		expect(snapshot.error).toContain('Failed to request Codex quota metadata');
		expect(captureMessageMock).not.toHaveBeenCalled();
	});

	it.each([408, 429, 500, 502, 503, 504])(
		'does not report a throttled or degraded upstream (HTTP %i) to Sentry (MAESTRO-RR)',
		async (status) => {
			await fs.writeFile(
				path.join(TEST_ROOT, 'auth.json'),
				JSON.stringify({ tokens: { access_token: 'redacted-token' } })
			);
			// The sampler runs on a timer, so one ChatGPT outage would otherwise
			// report once per tick per install - the dominant MAESTRO-RR volume.
			vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Upstream error', { status }));

			const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

			expect(snapshot.authState).toBe('error');
			expect(captureMessageMock).not.toHaveBeenCalled();
		}
	);

	it('reports unexpected HTTP errors to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'redacted-token' } })
		);
		// A 400 implies we sent a malformed request - that would be our bug.
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Bad request', { status: 400 }));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('error');
		expect(captureMessageMock).toHaveBeenCalledWith(
			'codex usage sample failed',
			'warning',
			expect.objectContaining({ reason: 'http 400' })
		);
	});

	// The reset-credit counts ride the usage payload, so the sampler is where
	// they enter the app. `applicable` is the one that must survive the trip
	// unchanged: absent means UNKNOWN, and coercing it to 0 here would tell
	// every surface downstream that the account's credits are all useless.
	describe('reset credit counts', () => {
		async function sampleWithBody(body: Record<string, unknown>) {
			await fs.writeFile(
				path.join(TEST_ROOT, 'auth.json'),
				JSON.stringify({ tokens: { access_token: 'redacted-token' } })
			);
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(body),
			} as unknown as Response);
			return sampleCodexUsage({ codexHome: TEST_ROOT });
		}

		it('carries both counts through when the payload reports them', async () => {
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 },
			});

			expect(snapshot.resetCredits).toEqual({ available: 2, applicable: 1 });
		});

		it('keeps an applicable count of zero distinct from an absent one', async () => {
			// The live shape that motivated the split: the account owns credits and
			// none of them would do anything right now.
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
			});

			expect(snapshot.resetCredits).toEqual({ available: 2, applicable: 0 });
		});

		it('leaves an omitted applicable count undefined rather than zero', async () => {
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 3 },
			});

			expect(snapshot.resetCredits?.available).toBe(3);
			expect(snapshot.resetCredits?.applicable).toBeUndefined();
			expect(snapshot.resetCredits).not.toHaveProperty('applicable', 0);
		});

		it('reports nothing at all when the payload omits the block', async () => {
			const snapshot = await sampleWithBody({ email: 'codex@example.com' });

			expect(snapshot.resetCredits).toBeUndefined();
		});

		it('ignores a malformed available count', async () => {
			const snapshot = await sampleWithBody({
				rate_limit_reset_credits: { available_count: 'two', applicable_available_count: 1 },
			});

			expect(snapshot.resetCredits).toBeUndefined();
		});
	});
});
