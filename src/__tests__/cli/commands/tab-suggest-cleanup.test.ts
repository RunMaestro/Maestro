/**
 * @file tab-suggest-cleanup.test.ts
 * @description Tests for `maestro-cli tab suggest-cleanup`: it asks the desktop
 * over the WS bridge and sends nothing a caller could steer with, prints each
 * suggestion with the verb that applies it, and exits non-zero when the task
 * could not run. It is read-only, so there is no apply path to test.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { tabSuggestCleanup } from '../../../cli/commands/tab-suggest-cleanup';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { TabCleanupResult } from '../../../shared/tabCleanup';
import { formatError } from '../../../cli/output/formatter';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return captured;
}

const DAY = 24 * 60 * 60 * 1000;

const OK: TabCleanupResult = {
	success: true,
	considered: 12,
	protectedCount: 2,
	droppedCount: 1,
	truncated: false,
	producedBy: 'qwen3:latest on Ollama',
	suggestions: [
		{
			tabId: 'tab-1',
			agentId: 'agent-1',
			action: 'close',
			reason: 'Untouched for a month.',
			agentName: 'Backend',
			label: 'Fix login bug',
			kind: 'open',
			tabType: 'ai',
			lastActivityAt: Date.now() - 30 * DAY,
			messageCount: 4,
		},
		{
			tabId: 'tab-2',
			agentId: 'agent-2',
			action: 'snooze',
			reason: 'Paused and not finished.',
			agentName: 'Docs',
			label: 'Rewrite the guide',
			kind: 'open',
			tabType: 'ai',
			lastActivityAt: Date.now() - 9 * DAY,
			messageCount: 11,
		},
		{
			tabId: 'tab-3',
			agentId: 'agent-1',
			action: 'wake',
			reason: 'Its wake time has passed.',
			agentName: 'Backend',
			label: 'Migration plan',
			kind: 'snoozed',
			tabType: 'ai',
			snoozeId: 'snooze-9',
			lastActivityAt: Date.now() - 3 * DAY,
			messageCount: 2,
			wakeAt: Date.now() - DAY,
		},
	],
};

describe('tab suggest-cleanup command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('asks the desktop and sends nothing but the request type', async () => {
		const captured = mockSend({ success: true, result: OK });

		await tabSuggestCleanup({});

		expect(captured.payload).toEqual({ type: 'local_models_tab_cleanup' });
		expect(captured.responseType).toBe('local_models_tab_cleanup_result');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints each suggestion with its reason and the verb that applies it', async () => {
		mockSend({ success: true, result: OK });

		await tabSuggestCleanup({});

		const out = printed();
		expect(out).toContain('TAB CLEANUP');
		expect(out).toContain('3 suggestions');
		expect(out).toContain('12 tabs reviewed, 2 left out (busy, starred, or with a draft)');
		expect(out).toContain('Suggested by qwen3:latest on Ollama');
		expect(out).toContain('Fix login bug');
		expect(out).toContain('Untouched for a month.');
		expect(out).toContain('last active 4 weeks ago');
		expect(out).toContain('snoozed until ');
		expect(out).toContain('-> maestro-cli tab close tab-1');
		expect(out).toContain('-> maestro-cli snooze tab tab-2 <when> --agent agent-2');
		expect(out).toContain('-> maestro-cli snooze wake snooze-9');
		expect(out).toContain('Nothing was changed.');
	});

	it('says so when there is nothing to clean up, and still exits 0', async () => {
		mockSend({ success: true, result: { ...OK, suggestions: [] } });

		await tabSuggestCleanup({});

		expect(printed()).toContain('0 suggestions');
		expect(printed()).toContain('Nothing to clean up.');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('emits the whole result as JSON, with the apply command on each suggestion', async () => {
		mockSend({ success: true, result: OK });

		await tabSuggestCleanup({ json: true });

		const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(parsed).toMatchObject({ success: true, considered: 12, protectedCount: 2 });
		expect(parsed.suggestions.map((s: { apply: string }) => s.apply)).toEqual([
			'maestro-cli tab close tab-1',
			'maestro-cli snooze tab tab-2 <when> --agent agent-2',
			'maestro-cli snooze wake snooze-9',
		]);
		expect(parsed.suggestions[0]).toMatchObject({
			tabId: 'tab-1',
			agentId: 'agent-1',
			action: 'close',
			reason: 'Untouched for a month.',
		});
	});

	it('exits non-zero with the reason when the task is off', async () => {
		mockSend({
			success: true,
			result: {
				success: false,
				status: 'off',
				error: 'Tab cleanup suggestions is off. Assign it a local model or an endpoint.',
			},
		});

		await expect(tabSuggestCleanup({})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(
			formatError('Tab cleanup suggestions is off. Assign it a local model or an endpoint.')
		);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it('keeps the failure status in JSON output', async () => {
		mockSend({
			success: true,
			result: { success: false, status: 'unavailable', error: 'Ollama is not answering.' },
		});

		await expect(tabSuggestCleanup({ json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			status: 'unavailable',
			error: 'Ollama is not answering.',
		});
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('reports a failed round trip', async () => {
		mockSend({ success: false, error: 'Unknown message type' });

		await expect(tabSuggestCleanup({})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(formatError('Unknown message type'));
	});

	it('reports a desktop that is not running', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await expect(tabSuggestCleanup({})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(formatError('Maestro desktop app is not running'));
		expect(exitSpy).toHaveBeenCalled();
	});
});
