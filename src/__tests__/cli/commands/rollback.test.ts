/**
 * @file rollback.test.ts
 * @description Tests for `maestro-cli rollback` - the CLI half of Check for
 * Updates -> Roll Back: list earlier releases, or download one.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { rollback } from '../../../cli/commands/rollback';
import { withMaestroClient } from '../../../cli/services/maestro-client';

interface Captured {
	payload?: Record<string, unknown>;
	responseType?: string;
	timeoutMs?: number;
}

function mockSend(result: Record<string, unknown>) {
	let captured: Captured = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation(
					(payload: Record<string, unknown>, responseType: string, timeoutMs?: number) => {
						captured = { payload, responseType, timeoutMs };
						return Promise.resolve(result);
					}
				),
		} as never)
	);
	return () => captured;
}

const release = (tag: string, name: string) => ({
	tag_name: tag,
	name,
	body: '',
	html_url: `https://github.com/RunMaestro/Maestro/releases/tag/${tag}`,
	published_at: '2026-11-12T03:31:08Z',
	prerelease: false,
});

describe('rollback command', () => {
	let logSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('lists earlier releases when no version is given, deferring the prerelease choice to the app', async () => {
		const sent = mockSend({
			success: true,
			currentVersion: '1.0.4',
			releases: [release('v1.0.3', 'v1.0.3 | Right on Cue'), release('v1.0.2', 'v1.0.2')],
		});

		await rollback(undefined, {});

		expect(sent().payload).toEqual({ type: 'list_rollback_targets' });
		expect(sent().responseType).toBe('list_rollback_targets_result');
		const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
		expect(output).toContain('Running v1.0.4');
		expect(output).toContain('v1.0.3');
		expect(output).toContain('Right on Cue');
		expect(output).toContain('v1.0.2');
	});

	it('passes --prerelease through and prints JSON', async () => {
		const sent = mockSend({
			success: true,
			currentVersion: '1.0.4',
			releases: [release('v1.0.3', 'v1.0.3 | Right on Cue')],
		});

		await rollback(undefined, { prerelease: true, json: true });

		expect(sent().payload).toEqual({ type: 'list_rollback_targets', includePrerelease: true });
		expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
			success: true,
			currentVersion: '1.0.4',
			releases: [
				{
					tag: 'v1.0.3',
					name: 'Right on Cue',
					publishedAt: '2026-11-12T03:31:08Z',
					prerelease: false,
					url: 'https://github.com/RunMaestro/Maestro/releases/tag/v1.0.3',
				},
			],
		});
	});

	it('downloads the named version with a long timeout', async () => {
		const sent = mockSend({ success: true, version: '1.0.3', currentVersion: '1.0.4' });

		await rollback(' 1.0.3 ', {});

		expect(sent().payload).toEqual({ type: 'rollback_update', version: '1.0.3' });
		expect(sent().responseType).toBe('rollback_update_result');
		expect(sent().timeoutMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
		expect(logSpy.mock.calls[0][0]).toContain('Downloaded v1.0.3');
	});

	it("fails with the app's reason when the download is refused", async () => {
		mockSend({ success: false, error: 'v1.1.0 is not an earlier release than the running v1.0.4' });

		await expect(rollback('1.1.0', { json: true })).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
			success: false,
			error: 'v1.1.0 is not an earlier release than the running v1.0.4',
		});
	});
});
