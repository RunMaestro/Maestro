/**
 * @file cue-trigger.test.ts
 * @description Tests for the cue-trigger CLI command
 *
 * Tests the cue-trigger command's sourceAgentId handling:
 * - sourceAgentId is included in the WebSocket message payload
 * - sourceAgentId is included in JSON output when --json is set
 * - sourceAgentId is omitted from JSON output when not provided
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
// The real ownership check; only the lock read is faked.
vi.mock('../../../main/cue/cue-engine-lock', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/cue-engine-lock')>()),
	readCueEngineLock: vi.fn(() => null),
}));
vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(() => null),
}));
vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	submitCueTrigger: vi.fn(),
}));

import { cueTrigger } from '../../../cli/commands/cue-trigger';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readCueEngineLock } from '../../../main/cue/cue-engine-lock';
import { readCliServerInfo } from '../../../shared/cli-server-discovery';
import { submitCueTrigger } from '../../../cli/services/cue-trigger-inbox';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import {
	CommandTimeoutError,
	ConnectionClosedError,
} from '../../../shared/maestro-lib/client/bridge-connection';

describe('cueTrigger command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('sourceAgentId in WebSocket message', () => {
		it('should include sourceAgentId in the WebSocket command payload', async () => {
			let capturedMessage: Record<string, unknown> | undefined;
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>) => {
						capturedMessage = msg;
						return {
							type: 'trigger_cue_subscription_result',
							success: true,
							subscriptionName: 'my-sub',
						};
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', { sourceAgentId: 'agent-xyz-123' });

			expect(capturedMessage).toBeDefined();
			expect(capturedMessage!.type).toBe('trigger_cue_subscription');
			expect(capturedMessage!.subscriptionName).toBe('my-sub');
			expect(capturedMessage!.sourceAgentId).toBe('agent-xyz-123');
		});

		it('should include prompt alongside sourceAgentId in WebSocket payload', async () => {
			let capturedMessage: Record<string, unknown> | undefined;
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>) => {
						capturedMessage = msg;
						return {
							type: 'trigger_cue_subscription_result',
							success: true,
							subscriptionName: 'my-sub',
						};
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', { prompt: 'custom prompt', sourceAgentId: 'agent-abc' });

			expect(capturedMessage!.prompt).toBe('custom prompt');
			expect(capturedMessage!.sourceAgentId).toBe('agent-abc');
		});

		it('should send undefined sourceAgentId when not provided', async () => {
			let capturedMessage: Record<string, unknown> | undefined;
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>) => {
						capturedMessage = msg;
						return {
							type: 'trigger_cue_subscription_result',
							success: true,
							subscriptionName: 'my-sub',
						};
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', {});

			expect(capturedMessage!.sourceAgentId).toBeUndefined();
		});
	});

	describe('sourceAgentId in JSON output', () => {
		it('should include sourceAgentId in JSON output when --json and --source-agent-id are set', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'trigger_cue_subscription_result',
						success: true,
						subscriptionName: 'my-sub',
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', { json: true, sourceAgentId: 'agent-xyz-123' });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe('trigger_result');
			expect(output.success).toBe(true);
			expect(output.subscriptionName).toBe('my-sub');
			expect(output.sourceAgentId).toBe('agent-xyz-123');
		});

		it('should omit sourceAgentId from JSON output when not provided', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'trigger_cue_subscription_result',
						success: true,
						subscriptionName: 'my-sub',
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', { json: true });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).not.toHaveProperty('sourceAgentId');
		});

		it('should include sourceAgentId in error JSON output on failure', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'trigger_cue_subscription_result',
						success: false,
						subscriptionName: 'my-sub',
						error: 'Subscription not found',
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', { json: true, sourceAgentId: 'agent-abc' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.sourceAgentId).toBe('agent-abc');
			expect(output.error).toBe('Subscription not found');
		});
	});

	describe('non-JSON output', () => {
		it('should print success message without mentioning sourceAgentId', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'trigger_cue_subscription_result',
						success: true,
						subscriptionName: 'my-sub',
					}),
				};
				return fn(mockClient as any);
			});

			await cueTrigger('my-sub', { sourceAgentId: 'agent-xyz' });

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Triggered Cue subscription "my-sub"')
			);
		});
	});

	describe('error handling', () => {
		it('should handle connection errors with JSON output', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new Error('Maestro desktop app is not running')
			);

			await cueTrigger('my-sub', { json: true, sourceAgentId: 'agent-xyz' });

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.type).toBe('error');
			expect(output.error).toBe('Maestro desktop app is not running');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('beside a headless host that is not running Cue', () => {
		it('reports the reason the host gives, not "not found"', async () => {
			const refusal = "This host's Cue engine did not start: cue.db is locked";
			vi.mocked(withMaestroClient).mockImplementation(async (fn) =>
				fn({
					sendCommand: vi.fn().mockResolvedValue({ type: 'error', message: refusal }),
				} as any)
			);

			await cueTrigger('my-sub', { json: true });

			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ success: false, error: refusal }));
			expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining('not found'));
		});
	});

	// "Is the lock the host's own engine?" is answered by the lock token the host
	// publishes in cli-server.json. Every case below gives both sides the SAME
	// pid, as two containers sharing a data directory (both pid 1) or a reused
	// pid would, so only the token can tell them apart.
	describe('which engine is asked', () => {
		const standaloneLock = (pid: number, token?: string) =>
			({
				pid,
				mode: 'standalone',
				startedAt: '',
				heartbeatAt: '',
				...(token !== undefined ? { token } : {}),
			}) as ReturnType<typeof readCueEngineLock>;
		const hostAt = (pid: number, cueLockToken?: string) =>
			({
				pid,
				port: 1,
				token: 't',
				startedAt: 0,
				hostKind: 'headless',
				...(cueLockToken !== undefined ? { cueLockToken } : {}),
			}) as unknown as ReturnType<typeof readCliServerInfo>;
		const answeredBy = (reply: Record<string, unknown>) =>
			vi
				.mocked(withMaestroClient)
				.mockImplementation(async (fn) =>
					fn({ sendCommand: vi.fn().mockResolvedValue(reply) } as any)
				);
		const expectInbox = () => {
			expect(submitCueTrigger).toHaveBeenCalledTimes(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		};

		beforeEach(() => {
			vi.mocked(submitCueTrigger).mockResolvedValue({ success: true });
		});

		it('uses the trigger inbox for a standalone engine no host runs', async () => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'service'));

			await cueTrigger('my-sub', {});

			expectInbox();
		});

		it("uses the inbox when another container's engine holds the lock, though both are pid 1", async () => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'container-b'));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1, 'container-a'));

			await cueTrigger('my-sub', {});

			expectInbox();
		});

		it("is not captured by a killed host's cli-server.json whose pid a new engine reused", async () => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(7777, 'new-engine'));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(7777, 'killed-host'));

			await cueTrigger('my-sub', {});

			expectInbox();
		});

		it('uses the inbox beside a host that publishes no token (an older host)', async () => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'service'));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1));

			await cueTrigger('my-sub', {});

			expectInbox();
		});

		it('uses the inbox for a token-less lock (an older engine), whatever its pid', async () => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1, 'host'));

			await cueTrigger('my-sub', {});

			expectInbox();
		});

		// Found live: a drain stops the inbox, so the inbox route timed out with
		// "did not answer in time" while the host had a reason to give.
		it("asks the host when the lock is the host's own engine, so a drain's refusal reaches the caller", async () => {
			const refusal = 'This host is shutting down Cue: its runs in flight are finishing';
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'host'));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1, 'host'));
			answeredBy({ type: 'error', message: refusal });

			await cueTrigger('my-sub', {});

			expect(submitCueTrigger).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(refusal));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		// A caller in another container shares the data directory, reads the
		// matching token, and dials 127.0.0.1 in its own network namespace. The
		// request never left, so the inbox (which the host's engine also reads)
		// delivers it without any risk of running it twice.
		it.each([
			['refused', new MaestroNotRunningError('connect-failed', 'connect ECONNREFUSED')],
			['timed out', new MaestroNotRunningError('connect-timeout')],
		])(
			"uses the inbox when the host's connection is %s before anything was sent",
			async (_, connectError) => {
				vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'host'));
				vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1, 'host'));
				vi.mocked(withMaestroClient).mockRejectedValueOnce(connectError);

				await cueTrigger('my-sub', {});

				expect(withMaestroClient).toHaveBeenCalledTimes(1);
				expect(submitCueTrigger).toHaveBeenCalledTimes(1);
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					expect.stringContaining('Sent through the Cue trigger inbox')
				);
				expect(consoleSpy).toHaveBeenCalledWith('Triggered Cue subscription "my-sub"');
				expect(processExitSpy).not.toHaveBeenCalled();
			}
		);

		it('keeps --json output to the one result line when it falls back', async () => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'host'));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1, 'host'));
			vi.mocked(withMaestroClient).mockRejectedValueOnce(
				new MaestroNotRunningError('connect-failed', 'connect ECONNREFUSED')
			);

			await cueTrigger('my-sub', { json: true });

			expect(submitCueTrigger).toHaveBeenCalledTimes(1);
			expect(consoleErrorSpy).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				type: 'trigger_result',
				success: true,
			});
		});

		// Once the connection opened the request may have reached the host, so
		// the inbox could fire it a second time: the host's failure is the answer.
		it.each([
			['the reply times out', new CommandTimeoutError('trigger_cue_subscription_result')],
			['the socket drops', new ConnectionClosedError({ closedByCaller: false, code: 1006 })],
		])('reports the failure and never uses the inbox when %s', async (_, sendError) => {
			vi.mocked(readCueEngineLock).mockReturnValueOnce(standaloneLock(1, 'host'));
			vi.mocked(readCliServerInfo).mockReturnValueOnce(hostAt(1, 'host'));
			vi.mocked(withMaestroClient).mockRejectedValueOnce(sendError);

			await cueTrigger('my-sub', {});

			expect(submitCueTrigger).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: ${sendError.message}`);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});
