// Source: src/__tests__/cli/commands/claude-canary.test.ts
// Source: src/__tests__/main/web-server/handlers/claudeCanaryHandler.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { claudeCanary } from '../../../cli/commands/claude-canary';
import { WebSocket } from 'ws';
import { WebSocketMessageHandler } from '../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../main/web-server/handlers/messageHandlers';
const getClaudeTuiCanary = vi.fn();
const sendCommand = vi.fn();
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: (action: (client: { sendCommand: typeof sendCommand }) => unknown) =>
		action({ sendCommand }),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../main/agents/claude-tui-canary', () => ({
	getClaudeTuiCanary: () => getClaudeTuiCanary(),
}));
describe('claude-canary', () => {
	const failed = {
		claudeVersion: '2.1.326',
		maestroVersion: '1.2.0',
		checkedAt: Date.now() - 60_000,
		durationMs: 4_000,
		configDir: '/Users/test/.claude-a',
		ok: false,
		error: 'startup_dialog_blocked',
		exitCode: 11,
		screen: 'A new gate\n\n❯ No, exit',
	};

	describe('claude-canary', () => {
		let log: MockInstance;
		let exit: MockInstance;

		beforeEach(() => {
			sendCommand.mockReset();
			log = vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
				throw new Error(`exit ${code}`);
			}) as never);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('reads the last result as JSON', async () => {
			sendCommand.mockResolvedValue({ success: true, last: failed });

			await claudeCanary({ json: true });

			expect(sendCommand).toHaveBeenCalledWith(
				{ type: 'claude_canary_status' },
				'claude_canary_status_result'
			);
			expect(JSON.parse(log.mock.calls[0][0])).toEqual({ success: true, last: failed });
		});

		it('prints what Claude Code showed on a failure, and exits 2', async () => {
			sendCommand.mockResolvedValue({ success: true, last: failed });

			await expect(claudeCanary({})).rejects.toThrow('exit 2');

			const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
			expect(printed).toContain('2.1.326');
			expect(printed).toContain('startup_dialog_blocked');
			expect(printed).toContain('❯ No, exit');
		});

		it('says how to run it when it never ran', async () => {
			sendCommand.mockResolvedValue({ success: true, last: null });
			await claudeCanary({});
			expect(log.mock.calls[0][0]).toContain('maestro-cli claude-canary --run');
		});

		it('--run runs it now with a long timeout and reports the new result', async () => {
			sendCommand.mockResolvedValue({
				success: true,
				outcome: {
					ran: true,
					result: { ...failed, ok: true, error: undefined, screen: undefined },
				},
			});

			await claudeCanary({ run: true, json: true });

			expect(sendCommand).toHaveBeenCalledWith(
				{ type: 'claude_canary_run' },
				'claude_canary_run_result',
				expect.any(Number)
			);
			expect(sendCommand.mock.calls[0][2]).toBeGreaterThanOrEqual(3 * 60 * 1000);
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ success: true, ran: true });
			expect(exit).not.toHaveBeenCalled();
		});

		it('--run exits 1 with the reason when the canary could not run', async () => {
			sendCommand.mockResolvedValue({
				success: true,
				outcome: { ran: false, reason: 'Claude Code is not installed.' },
			});

			await expect(claudeCanary({ run: true })).rejects.toThrow('exit 1');
			expect(log.mock.calls[0][0]).toContain('Claude Code is not installed.');
		});
	});
});
describe('claudeCanaryHandler', () => {
	function createMockClient(): WebClient {
		return {
			socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
			id: 'client-1',
			connectedAt: 0,
		};
	}

	function lastResponse(client: WebClient): Record<string, unknown> {
		const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
		return JSON.parse(calls[calls.length - 1][0] as string);
	}

	const flush = () => new Promise((resolve) => setImmediate(resolve));

	const LAST = {
		ok: false,
		claudeVersion: '2.1.326',
		maestroVersion: '1.1.1',
		configDir: '/Users/me/.claude',
		checkedAt: 1_700_000_000_000,
		error: 'startup_dialog_blocked',
		exitCode: 11,
	};

	describe('claude canary handlers', () => {
		let handler: WebSocketMessageHandler;
		let client: WebClient;

		beforeEach(() => {
			getClaudeTuiCanary.mockReset();
			handler = new WebSocketMessageHandler();
			client = createMockClient();
		});

		it('status relays the last result with the request id', () => {
			getClaudeTuiCanary.mockReturnValue({ getLastResult: () => LAST });
			handler.handleMessage(client, { type: 'claude_canary_status', requestId: 'r1' });
			expect(lastResponse(client)).toMatchObject({
				type: 'claude_canary_status_result',
				success: true,
				last: LAST,
				requestId: 'r1',
			});
		});

		it('status reports a null result when the canary has never run', () => {
			getClaudeTuiCanary.mockReturnValue({ getLastResult: () => undefined });
			handler.handleMessage(client, { type: 'claude_canary_status', requestId: 'r2' });
			expect(lastResponse(client)).toMatchObject({ success: true, last: null, requestId: 'r2' });
		});

		it('status fails with the request id when the canary is not running', () => {
			getClaudeTuiCanary.mockReturnValue(null);
			handler.handleMessage(client, { type: 'claude_canary_status', requestId: 'r3' });
			expect(lastResponse(client)).toMatchObject({
				type: 'claude_canary_status_result',
				success: false,
				error: 'The canary is not running',
				requestId: 'r3',
			});
		});

		it('run forces a check and relays its outcome', async () => {
			const outcome = { ran: true, result: LAST };
			const check = vi.fn().mockResolvedValue(outcome);
			getClaudeTuiCanary.mockReturnValue({ check });
			handler.handleMessage(client, { type: 'claude_canary_run', requestId: 'r4' });
			await flush();
			expect(check).toHaveBeenCalledWith({ force: true });
			expect(lastResponse(client)).toMatchObject({
				type: 'claude_canary_run_result',
				success: true,
				outcome,
				requestId: 'r4',
			});
		});

		it('run fails with the request id when the canary is not running', async () => {
			getClaudeTuiCanary.mockReturnValue(null);
			handler.handleMessage(client, { type: 'claude_canary_run', requestId: 'r5' });
			await flush();
			expect(lastResponse(client)).toMatchObject({
				type: 'claude_canary_run_result',
				success: false,
				error: 'The canary is not running',
				requestId: 'r5',
			});
		});
	});
});
