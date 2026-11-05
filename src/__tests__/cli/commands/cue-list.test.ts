/**
 * @file cue-list.test.ts
 * @description Tests for `cue list`: the peer's answer is printed as ever, a
 * headless host that cannot answer for Cue leaves the list to each agent's
 * cue.yaml, and every other failure (an absent desktop, an old desktop build,
 * a timeout) is still reported rather than masked by a read from disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	readLiveSessions: vi.fn(() => [
		{ id: 'a1', name: 'One', toolType: 'claude-code', projectRoot: '/work/one' },
		{ id: 'a2', name: 'Two', toolType: 'codex', projectRoot: '/work/two' },
	]),
}));
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfigDetailed: vi.fn(),
}));

import { cueList, CUE_YAML_FALLBACK_NOTE } from '../../../cli/commands/cue-list';
import {
	CommandTimeoutError,
	UnsupportedCommandError,
	withMaestroClient,
} from '../../../cli/services/maestro-client';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import { ExitCode } from '../../../cli/exit-codes';
import { loadCueConfigDetailed } from '../../../main/cue/cue-yaml-loader';
import { resolveCliPath } from '../../../cli/utils/parse';

/** Each agent's cue.yaml, as the validating loader returns it. */
const configs: Record<string, unknown> = {
	'/work/one': {
		ok: true,
		warnings: [],
		config: {
			settings: {},
			subscriptions: [
				{ name: 'beat', event: 'time.heartbeat', prompt: 'p', interval_minutes: 5 },
				{ name: 'mine-only', event: 'file.changed', prompt: 'p', watch: 'src/**', agent_id: 'a1' },
				{ name: 'not-mine', event: 'file.changed', prompt: 'p', agent_id: 'zz', enabled: false },
			],
		},
	},
	'/work/two': { ok: false, reason: 'missing' },
};

function hostEchoes(type: string, peer: 'host' | 'old-desktop' = 'host'): void {
	vi.mocked(withMaestroClient).mockRejectedValue(
		new UnsupportedCommandError(type, peer === 'host' ? 'headless' : undefined)
	);
}

function printed(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((c) => String(c[0]))
		.join('\n');
}

describe('cue list', () => {
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		vi.mocked(loadCueConfigDetailed).mockImplementation(
			(projectRoot: string) => configs[projectRoot] as never
		);
	});

	it("prints the peer's answer and reads no cue.yaml (desktop app, or a host running Cue)", async () => {
		const subs = [
			{
				id: 'a1::beat::beat',
				name: 'beat',
				eventType: 'time.heartbeat',
				sessionId: 'a1',
				sessionName: 'One',
				enabled: true,
				triggerCount: 0,
			},
		];
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockResolvedValue({ type: 'cue_subscriptions', subscriptions: subs }),
			} as never)
		);

		await cueList({ json: true });

		expect(JSON.parse(printed())).toEqual(subs);
		expect(loadCueConfigDetailed).not.toHaveBeenCalled();
		expect(console.error).not.toHaveBeenCalled();
	});

	it("reads each agent's cue.yaml when a headless host cannot answer, as the engine lists an agent it is not running", async () => {
		hostEchoes('get_cue_subscriptions');

		await cueList({ json: true });

		const subs = JSON.parse(printed());
		expect(subs.map((s: { id: string }) => s.id)).toEqual([
			'a1::beat::beat',
			'a1::mine-only::mine-only',
		]);
		expect(subs[0]).toMatchObject({
			name: 'beat',
			eventType: 'time.heartbeat',
			schedule: 'every 5m',
			sessionId: 'a1',
			sessionName: 'One',
			enabled: true,
			triggerCount: 0,
		});
		expect(subs[1]).toMatchObject({ pattern: 'src/**' });
		// --json stays parseable: the note is for people only.
		expect(console.error).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says on stderr where a human-readable list came from', async () => {
		hostEchoes('get_cue_subscriptions');

		await cueList({});

		expect(printed()).toContain('Cue Subscriptions (2):');
		expect(console.error).toHaveBeenCalledWith(CUE_YAML_FALLBACK_NOTE);
	});

	it('does not read cue.yaml when an old desktop build echoes', async () => {
		hostEchoes('get_cue_subscriptions', 'old-desktop');

		await expect(cueList({})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('rebuild and restart'));
		expect(loadCueConfigDetailed).not.toHaveBeenCalled();
	});

	it('does not read cue.yaml on a timeout', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new CommandTimeoutError('cue_subscriptions'));

		await expect(cueList({ json: true })).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadCueConfigDetailed).not.toHaveBeenCalled();
	});

	it('reports an absent desktop app as before (exit 3)', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError('no-discovery-file'));

		await expect(cueList({})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.NotRunning);
		expect(loadCueConfigDetailed).not.toHaveBeenCalled();
	});

	describe('--data-dir', () => {
		let saved: string | undefined;
		let dir: string;

		beforeEach(() => {
			saved = process.env.MAESTRO_USER_DATA;
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-list-'));
		});

		afterEach(() => {
			if (saved === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = saved;
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('is applied before the host is looked for', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async () => {
				// Discovery, agents and cue.yaml all resolve from MAESTRO_USER_DATA.
				expect(process.env.MAESTRO_USER_DATA).toBe(resolveCliPath(dir));
				throw new UnsupportedCommandError('get_cue_subscriptions', 'headless');
			});

			await cueList({ dataDir: dir, json: true });

			expect(withMaestroClient).toHaveBeenCalledTimes(1);
			expect(JSON.parse(printed())).toHaveLength(2);
		});
	});
});
