import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => ({
	info: { port: 7001, token: 't', pid: 1, startedAt: 0 } as unknown,
	running: true,
}));
vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: () => discovery.info,
	isCliServerRunning: () => discovery.running,
}));

const sendCommand = vi.hoisted(() => vi.fn());
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: async (run: (client: { sendCommand: typeof sendCommand }) => Promise<void>) =>
		run({ sendCommand }),
}));

import { status } from '../../../cli/commands/status';

describe('maestro-cli status', () => {
	let lines: string[];

	beforeEach(() => {
		lines = [];
		discovery.info = { port: 7001, token: 't', pid: 1, startedAt: 0 };
		discovery.running = true;
		sendCommand.mockReset();
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			lines.push(line);
		});
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const answers = (appInfo: unknown) =>
		sendCommand.mockImplementation(async (message: { type: string }) => {
			if (message.type === 'ping') return { type: 'pong' };
			if (message.type === 'get_sessions') return { type: 'sessions_list', sessions: [{}, {}] };
			if (message.type === 'get_app_info') {
				if (appInfo instanceof Error) throw appInfo;
				return appInfo;
			}
			throw new Error(`unexpected ${message.type}`);
		});

	it('names the agent state mode when the desktop hosts the library runtime (DG14)', async () => {
		answers({ type: 'app_info', runtimeHosting: true });
		await status();
		expect(lines).toEqual([
			'Maestro is running on port 7001 with 2 agents',
			'Agent state: library runtime (main)',
		]);
	});

	it('prints nothing extra for the standard mode', async () => {
		answers({ type: 'app_info', runtimeHosting: false });
		await status();
		expect(lines).toEqual(['Maestro is running on port 7001 with 2 agents']);
	});

	it('does not fail a healthy status when an older app cannot answer the mode', async () => {
		answers(new Error('timed out'));
		await status();
		expect(lines).toEqual(['Maestro is running on port 7001 with 2 agents']);
	});

	it('still reports an app that is not running', async () => {
		discovery.running = false;
		await expect(status()).rejects.toThrow('exit');
		expect(lines[0]).toContain('stale');
	});
});
