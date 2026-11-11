/**
 * @file dispatch-autorun.test.ts
 * @description `dispatch` run inside an Auto Run task: a dispatch that names no
 * tab goes to a new one, carries the run id so the run can track it, and the
 * reply says whether it is tracked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	UnsupportedCommandError: class UnsupportedCommandError extends Error {},
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
	getSessionById: vi.fn(() => undefined),
	readSettingValue: vi.fn(() => undefined),
	readLiveSessions: vi.fn(() => []),
	readGroups: vi.fn(() => []),
}));

import { applyAutoRunDispatchDefaults, runDispatch } from '../../../cli/commands/dispatch';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const AUTO_RUN_ENV = { MAESTRO_CALLER_AUTORUN_ID: 'autorun-1' };

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

describe('applyAutoRunDispatchDefaults', () => {
	it('sends a dispatch that names no destination to a new tab', () => {
		expect(applyAutoRunDispatchDefaults('worker', {}, AUTO_RUN_ENV)).toEqual({ newTab: true });
	});

	it('changes nothing outside an Auto Run', () => {
		expect(applyAutoRunDispatchDefaults('worker', {}, {})).toEqual({});
	});

	it.each([
		{ tab: 'tab-9' },
		{ queue: true },
		{ held: true },
		{ force: true },
		{ notifyOnComplete: 'someone' },
	])('keeps an explicit destination as typed: %o', (options) => {
		expect(applyAutoRunDispatchDefaults('worker', options, AUTO_RUN_ENV)).toEqual(options);
	});
});

describe('runDispatch inside an Auto Run task', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('MAESTRO_CALLER_AGENT_ID', 'manager');
		vi.stubEnv('MAESTRO_CALLER_AUTORUN_ID', 'autorun-1');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('opens a new tab, sends the run id, and reports the dispatch tracked', async () => {
		const captured = mockSend({ success: true, tabId: 'tab-new', callbackId: 'cb_1' });
		const result = await runDispatch('worker', 'build the parser', {});
		expect(captured[0]).toMatchObject({
			type: 'new_ai_tab_with_prompt',
			autoRunId: 'autorun-1',
			fromSessionId: 'manager',
		});
		expect(captured[0].notifyOnComplete).toBeUndefined();
		expect(result).toMatchObject({ success: true, tabId: 'tab-new', autoRunTracked: true });
	});

	it('reports untracked when the desktop armed nothing (the run is over)', async () => {
		mockSend({ success: true, tabId: 'tab-new' });
		const result = await runDispatch('worker', 'go', {});
		expect(result).toMatchObject({ success: true, autoRunTracked: false });
	});

	it('forwards --callback-timeout as the bound on the wait', async () => {
		const captured = mockSend({ success: true, tabId: 'tab-new', callbackId: 'cb_2' });
		await runDispatch('worker', 'go', { callbackTimeout: '7200' });
		expect(captured[0].callbackTimeout).toBe(7200);
	});

	it('still refuses --callback-prompt without --notify-on-complete', async () => {
		const result = await runDispatch('worker', 'go', { callbackPrompt: 'x' });
		expect(result).toMatchObject({ success: false, code: 'INVALID_OPTIONS' });
	});

	it('hands a --queue dispatch with no tab over untracked', async () => {
		const captured = mockSend({ success: true, tabId: 'tab-1', queued: false });
		const result = await runDispatch('worker', 'go', { queue: true });
		expect(captured[0].type).toBe('enqueue_command');
		expect(captured[0].autoRunId).toBeUndefined();
		expect(result).toMatchObject({ success: true, autoRunTracked: false });
	});

	it('lets an explicit --notify-on-complete win over the run', async () => {
		const captured = mockSend({ success: true, tabId: 'tab-new', callbackId: 'cb_3' });
		const result = await runDispatch('worker', 'go', {
			newTab: true,
			notifyOnComplete: 'orchestrator',
		});
		expect(captured[0].autoRunId).toBeUndefined();
		expect(captured[0].notifyOnComplete).toBe('orchestrator');
		expect(result.autoRunTracked).toBeUndefined();
	});
});
