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

import { cueTrigger } from '../../../cli/commands/cue-trigger';
import { withMaestroClient } from '../../../cli/services/maestro-client';

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
});
