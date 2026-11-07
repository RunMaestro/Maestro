/**
 * @file status-version.test.ts
 * @description `maestro-cli status` and `maestro-cli version` with no host, a
 * desktop, and a headless host.
 *
 * With nothing running they say what starts a host, and keep the first
 * sentence the other commands match on. A headless host is never called the
 * desktop app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CliServerInfo } from '../../../shared/cli-server-discovery';

vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<object>()),
	withMaestroClient: vi.fn(),
}));

import { formatError } from '../../../cli/output/formatter';
import { NOT_RUNNING_MESSAGE, status } from '../../../cli/commands/status';
import { version } from '../../../cli/commands/version';
import { readCliServerInfo, isCliServerRunning } from '../../../shared/cli-server-discovery';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const DESKTOP: CliServerInfo = { port: 4321, token: 't', pid: 77, startedAt: 1, version: '1.2.3' };
const HEADLESS: CliServerInfo = { ...DESKTOP, pid: 812, hostKind: 'headless', version: '9.9.9' };

class Exited extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

describe('status and version', () => {
	let logs: string[];
	let sendCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		logs = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
		vi.spyOn(console, 'error').mockImplementation((line: string) => void logs.push(line));
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Exited(code);
		}) as never);
		sendCommand = vi.fn(async (message: { type: string }) =>
			message.type === 'ping'
				? { type: 'pong' }
				: message.type === 'get_sessions'
					? { type: 'sessions_list', sessions: [{}, {}] }
					: { type: 'app_info', version: '1.2.3', commitHash: 'abc123' }
		);
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const run = async (command: () => Promise<void>): Promise<number | undefined> => {
		try {
			await command();
			return undefined;
		} catch (error) {
			if (error instanceof Exited) return error.code;
			throw error;
		}
	};

	describe('with nothing running', () => {
		beforeEach(() => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);
			vi.mocked(isCliServerRunning).mockReturnValue(false);
		});

		it('status keeps the sentence others match on and says how to start a headless host', async () => {
			expect(await run(status)).toBe(3);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toBe(formatError(NOT_RUNNING_MESSAGE));
			expect(logs[0]).toContain('maestro-cli host start');
		});

		it('version does the same, after its own version', async () => {
			expect(await run(() => version('2.0.0'))).toBe(3);
			expect(logs[0]).toBe('maestro-cli 2.0.0');
			expect(logs[1].startsWith('Maestro desktop app is not running')).toBe(true);
			expect(logs[1]).toContain('maestro-cli host start');
		});
	});

	describe('with a desktop', () => {
		beforeEach(() => {
			vi.mocked(readCliServerInfo).mockReturnValue(DESKTOP);
			vi.mocked(isCliServerRunning).mockReturnValue(true);
		});

		it('status reports it as before', async () => {
			expect(await run(status)).toBeUndefined();
			expect(logs).toEqual(['Maestro is running on port 4321 with 2 agents']);
		});

		it('version asks the app', async () => {
			expect(await run(() => version('2.0.0'))).toBeUndefined();
			expect(logs).toEqual(['maestro-cli   2.0.0', 'Maestro app   1.2.3 (abc123)']);
		});
	});

	describe('with a headless host', () => {
		beforeEach(() => {
			vi.mocked(readCliServerInfo).mockReturnValue(HEADLESS);
			vi.mocked(isCliServerRunning).mockReturnValue(true);
		});

		it('status names the headless host, not the desktop app', async () => {
			expect(await run(status)).toBeUndefined();
			expect(logs).toEqual([
				'The headless Maestro host (`maestro-cli host`, pid 812) is running on port 4321 with 2 agents',
			]);
		});

		it('status calls a dead headless host a crashed host, not a crashed app', async () => {
			vi.mocked(isCliServerRunning).mockReturnValue(false);
			expect(await run(status)).toBe(3);
			expect(logs[0]).toContain('discovery file is stale');
			expect(logs[0]).toContain('headless host');
			expect(logs[0]).not.toContain('app may have crashed');
		});

		it("version reads the host's own version instead of asking for an app it does not have", async () => {
			expect(await run(() => version('2.0.0'))).toBeUndefined();
			expect(logs).toEqual(['maestro-cli   2.0.0', 'Maestro host  9.9.9 (headless, pid 812)']);
			expect(sendCommand).not.toHaveBeenCalled();
		});

		it('version --json says which kind of host answered', async () => {
			expect(await run(() => version('2.0.0', { json: true }))).toBeUndefined();
			expect(JSON.parse(logs[0])).toEqual({
				cliVersion: '2.0.0',
				appRunning: false,
				hostKind: 'headless',
				hostVersion: '9.9.9',
				hostPid: 812,
			});
		});
	});
});
