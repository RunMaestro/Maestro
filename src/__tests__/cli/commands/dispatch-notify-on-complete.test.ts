/**
 * @file dispatch-notify-on-complete.test.ts
 * @description CLI validation + payload wiring for `dispatch --notify-on-complete`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	UnsupportedCommandError: class UnsupportedCommandError extends Error {},
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => (id === 'nope' ? undefined : id)),
	readSettingValue: vi.fn(() => undefined),
}));

import { runDispatch } from '../../../cli/commands/dispatch';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';

function mockSend(result: Record<string, unknown>) {
	const captured: Array<Record<string, unknown>> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action: (c: never) => unknown) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured.push(payload);
				return Promise.resolve(result);
			}),
		} as never)
	);
	return captured;
}

describe('dispatch --notify-on-complete', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => {
			if (id === 'nope') throw new Error(`Agent not found: ${id}`);
			return id;
		});
	});

	describe('validation', () => {
		it('requires an explicit target tab', async () => {
			const result = await runDispatch('target', 'go', { notifyOnComplete: 'caller' });
			expect(result.success).toBe(false);
			expect(result.code).toBe('INVALID_OPTIONS');
			expect(result.error).toContain('--new-tab or --tab');
		});

		it('rejects callback modifiers without --notify-on-complete', async () => {
			for (const options of [
				{ callbackTab: 'x' },
				{ callbackPrompt: 'x' },
				{ callbackTimeout: '60' },
			]) {
				const result = await runDispatch('target', 'go', { newTab: true, ...options });
				expect(result.success).toBe(false);
				expect(result.code).toBe('INVALID_OPTIONS');
				expect(result.error).toContain('require --notify-on-complete');
			}
		});

		it('rejects an unknown callback agent', async () => {
			const result = await runDispatch('target', 'go', {
				newTab: true,
				notifyOnComplete: 'nope',
			});
			expect(result.success).toBe(false);
			expect(result.code).toBe('AGENT_NOT_FOUND');
		});

		it('rejects a self-callback loop', async () => {
			const result = await runDispatch('target', 'go', {
				newTab: true,
				notifyOnComplete: 'target',
			});
			expect(result.success).toBe(false);
			expect(result.code).toBe('INVALID_OPTIONS');
			expect(result.error).toContain('cannot target the dispatch target itself');
		});

		it('allows waking another tab of the same agent', async () => {
			const captured = mockSend({ tabId: 'new-tab', callbackId: 'cb_1' });
			const result = await runDispatch('target', 'go', {
				newTab: true,
				notifyOnComplete: 'target',
				callbackTab: 'orchestrator-tab',
			});
			expect(result.success).toBe(true);
			expect(captured[0].callbackTab).toBe('orchestrator-tab');
		});

		it('rejects a non-numeric or non-positive timeout', async () => {
			for (const callbackTimeout of ['abc', '0', '-5']) {
				const result = await runDispatch('target', 'go', {
					newTab: true,
					notifyOnComplete: 'caller',
					callbackTimeout,
				});
				expect(result.success).toBe(false);
				expect(result.error).toContain('--callback-timeout');
			}
		});

		it('clamps the timeout to 24 hours', async () => {
			const captured = mockSend({ tabId: 'new-tab' });
			await runDispatch('target', 'go', {
				newTab: true,
				notifyOnComplete: 'caller',
				callbackTimeout: '999999',
			});
			expect(captured[0].callbackTimeout).toBe(86400);
		});
	});

	describe('payload wiring', () => {
		it('threads the callback fields into new_ai_tab_with_prompt', async () => {
			const captured = mockSend({ tabId: 'new-tab', callbackId: 'cb_7' });
			const result = await runDispatch('target', 'go', {
				newTab: true,
				notifyOnComplete: 'caller',
				callbackPrompt: 'custom {{DISPATCH_STATUS}}',
				callbackTimeout: '120',
			});
			expect(captured[0].type).toBe('new_ai_tab_with_prompt');
			expect(captured[0].notifyOnComplete).toBe('caller');
			expect(captured[0].callbackPrompt).toBe('custom {{DISPATCH_STATUS}}');
			expect(captured[0].callbackTimeout).toBe(120);
			expect(result.callbackId).toBe('cb_7');
			expect(result.notifyOnComplete).toBe('caller');
		});

		it('threads the callback fields into send_command for an existing tab', async () => {
			const captured = mockSend({ tabId: 'tab-1', callbackId: 'cb_8' });
			const result = await runDispatch('target', 'go', {
				tab: 'tab-1',
				notifyOnComplete: 'caller',
			});
			expect(captured[0].type).toBe('send_command');
			expect(captured[0].tabId).toBe('tab-1');
			expect(captured[0].notifyOnComplete).toBe('caller');
			expect(result.callbackId).toBe('cb_8');
		});

		it('threads the callback fields into enqueue_command with --queue', async () => {
			const captured = mockSend({ success: true, tabId: 'tab-1', callbackId: 'cb_9' });
			const result = await runDispatch('target', 'go', {
				tab: 'tab-1',
				queue: true,
				notifyOnComplete: 'caller',
			});
			expect(captured[0].type).toBe('enqueue_command');
			expect(captured[0].notifyOnComplete).toBe('caller');
			expect(result.callbackId).toBe('cb_9');
			expect(result.notifyOnComplete).toBe('caller');
		});

		it('fails with CALLBACK_NOT_ARMED when the desktop acks without a callbackId', async () => {
			// An older desktop build that ignores notifyOnComplete: the prompt lands
			// but nothing is armed, so claiming success would leave the caller
			// waiting forever for a wake-up nobody scheduled.
			mockSend({ tabId: 'tab-1' });
			const result = await runDispatch('target', 'go', {
				tab: 'tab-1',
				notifyOnComplete: 'caller',
			});
			expect(result.success).toBe(false);
			expect(result.code).toBe('CALLBACK_NOT_ARMED');
			expect(result.tabId).toBe('tab-1');
		});

		it('fails with CALLBACK_NOT_ARMED when a queued dispatch acks without a callbackId', async () => {
			mockSend({ success: true, tabId: 'tab-1' });
			const result = await runDispatch('target', 'go', {
				tab: 'tab-1',
				queue: true,
				notifyOnComplete: 'caller',
			});
			expect(result.success).toBe(false);
			expect(result.code).toBe('CALLBACK_NOT_ARMED');
			expect(result.tabId).toBe('tab-1');
		});

		it('omits callback fields entirely when the flag is absent', async () => {
			const captured = mockSend({ tabId: 'new-tab' });
			const result = await runDispatch('target', 'go', { newTab: true });
			expect(captured[0].notifyOnComplete).toBeUndefined();
			expect(result.callbackId).toBeUndefined();
			expect(result.notifyOnComplete).toBeUndefined();
		});
	});
});
