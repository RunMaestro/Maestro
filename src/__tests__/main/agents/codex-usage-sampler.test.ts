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
						primary_window: { used_percent: 12, reset_at: 1779550000 },
						secondary_window: { used_percent: 34, reset_at: 1779900000 },
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
			session: { percent: 12, resetsAt: '2026-05-23T15:26:40.000Z' },
			weekly: { percent: 34, resetsAt: '2026-05-27T16:40:00.000Z' },
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

	it('reports unexpected HTTP errors to Sentry (MAESTRO-RR)', async () => {
		await fs.writeFile(
			path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({ tokens: { access_token: 'redacted-token' } })
		);
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Server error', { status: 500 }));

		const snapshot = await sampleCodexUsage({ codexHome: TEST_ROOT });

		expect(snapshot.authState).toBe('error');
		expect(captureMessageMock).toHaveBeenCalledWith(
			'codex usage sample failed',
			'warning',
			expect.objectContaining({ reason: 'http 500' })
		);
	});
});
