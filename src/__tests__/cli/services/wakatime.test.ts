/**
 * @file wakatime.test.ts
 * @description Tests for CLI-side WakaTime heartbeats.
 *
 * CLI-spawned agents (batch, `send`, playbooks) never reach the desktop's
 * ProcessManager listener, so these heartbeats are the only record of that
 * time. The rules that matter here: stay silent when WakaTime is off, tag the
 * run as CLI-origin automation, and never let a telemetry failure escape into
 * the agent run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendHeartbeat = vi.fn(async () => {});

vi.mock('../../../main/wakatime-manager', () => ({
	WakaTimeManager: class {
		constructor(
			public store: unknown,
			public version: string
		) {}
		sendHeartbeat = sendHeartbeat;
	},
}));

const readSettings = vi.fn();
vi.mock('../../../cli/services/storage', () => ({
	readSettings: () => readSettings(),
}));

import {
	buildCliWakaTimeHeartbeat,
	resetCliWakaTimeForTests,
} from '../../../cli/services/wakatime';

describe('CLI WakaTime heartbeats', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCliWakaTimeForTests();
		readSettings.mockReturnValue({ wakatimeEnabled: true, wakatimeApiKey: 'k' });
	});

	it('returns undefined when WakaTime is disabled so callers skip the work', () => {
		readSettings.mockReturnValue({ wakatimeEnabled: false });
		expect(buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).toBeUndefined();
	});

	it('defaults wakatimeEnabled to false when the key is absent', () => {
		readSettings.mockReturnValue({});
		expect(buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).toBeUndefined();
	});

	it('tags heartbeats as cli-origin unattended automation', () => {
		const beat = buildCliWakaTimeHeartbeat('cli:/home/u/proj', '/home/u/proj', false);
		beat?.();

		expect(sendHeartbeat).toHaveBeenCalledWith('cli:/home/u/proj', 'proj', '/home/u/proj', {
			source: 'auto',
			isRemote: false,
			origin: 'cli',
		});
	});

	it('derives the project name from the cwd basename', () => {
		buildCliWakaTimeHeartbeat('cli:/a/b/my-repo', '/a/b/my-repo', false)?.();
		expect(sendHeartbeat).toHaveBeenCalledWith(
			expect.anything(),
			'my-repo',
			expect.anything(),
			expect.anything()
		);
	});

	it('propagates isRemote so the manager skips local git/manifest probing', () => {
		buildCliWakaTimeHeartbeat('cli:/remote/path', '/remote/path', true)?.();
		expect(sendHeartbeat).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ isRemote: true })
		);
	});

	it('swallows heartbeat rejections - telemetry must not fail the agent run', async () => {
		sendHeartbeat.mockRejectedValueOnce(new Error('wakatime-cli exploded'));
		const beat = buildCliWakaTimeHeartbeat('cli:/x', '/x', false);

		expect(() => beat?.()).not.toThrow();
		// Flush the rejection; an unhandled one would fail the run.
		await Promise.resolve();
	});

	it('survives unreadable settings instead of breaking agent spawning', () => {
		readSettings.mockImplementation(() => {
			throw new Error('corrupt settings file');
		});
		expect(() => buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).not.toThrow();
		expect(buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).toBeUndefined();
	});

	it('reuses one manager across runs so the debounce is shared', () => {
		const a = buildCliWakaTimeHeartbeat('cli:/x', '/x', false);
		const b = buildCliWakaTimeHeartbeat('cli:/y', '/y', false);
		a?.();
		b?.();
		// Both beats land on the same mocked manager instance.
		expect(sendHeartbeat).toHaveBeenCalledTimes(2);
	});
});
