/**
 * Tests for cue-notify-executor.
 *
 * Verifies that an `action: notify` subscription emits the toast via the
 * bridge and returns a synthesized `completed` CueRunResult - including when
 * the bridge can't deliver (so the terminal-status pipeline still runs and
 * `time.once` self-destruct fires).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';

const emitCueNotifyToastMock = vi.fn();
vi.mock('../../../main/cue/cue-notify-bridge', () => ({
	emitCueNotifyToast: (...args: unknown[]) => emitCueNotifyToastMock(...args),
}));

import { executeCueNotify } from '../../../main/cue/cue-notify-executor';

function createSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Standup Bot',
		toolType: 'claude-code',
		cwd: '/tmp/project',
		projectRoot: '/tmp/project',
	};
}

function createSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'standup-reminder',
		event: 'time.once',
		enabled: true,
		prompt: 'fallback prompt',
		action: 'notify',
		agent_id: 'session-1',
		notify: { message: 'Standup in 5 minutes' },
		...overrides,
	};
}

function createEvent(): CueEvent {
	return {
		id: 'event-1',
		type: 'time.once',
		timestamp: '2026-05-22T15:00:00.000Z',
		triggerName: 'time.once',
		payload: {},
	};
}

function fakeWindow(): BrowserWindow {
	return { webContents: { send: vi.fn() } } as unknown as BrowserWindow;
}

describe('executeCueNotify', () => {
	beforeEach(() => {
		emitCueNotifyToastMock.mockReset().mockReturnValue(true);
	});

	it('returns a completed CueRunResult with the message as stdout', async () => {
		const result = await executeCueNotify({
			runId: 'run-1',
			session: createSession(),
			subscription: createSubscription(),
			event: createEvent(),
			agentId: 'session-1',
			message: 'Standup in 5 minutes',
			title: 'Standup Bot',
			mainWindow: fakeWindow(),
			onLog: vi.fn(),
		});

		expect(result.status).toBe('completed');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('Standup in 5 minutes');
		expect(result.stderr).toBe('');
		expect(result.runId).toBe('run-1');
		expect(result.sessionId).toBe('session-1');
		expect(result.subscriptionName).toBe('standup-reminder');
	});

	it('passes agentId, title, message, and sticky to the notify bridge', async () => {
		const win = fakeWindow();
		await executeCueNotify({
			runId: 'run-2',
			session: createSession(),
			subscription: createSubscription(),
			event: createEvent(),
			agentId: 'session-1',
			message: 'Standup in 5 minutes',
			sticky: true,
			title: 'Standup Bot',
			mainWindow: win,
			onLog: vi.fn(),
		});

		expect(emitCueNotifyToastMock).toHaveBeenCalledTimes(1);
		const [winArg, params] = emitCueNotifyToastMock.mock.calls[0];
		expect(winArg).toBe(win);
		expect(params).toEqual({
			agentId: 'session-1',
			title: 'Standup Bot',
			message: 'Standup in 5 minutes',
			sticky: true,
			clickAction: undefined,
		});
	});

	it('forwards a caller-provided clickAction override', async () => {
		await executeCueNotify({
			runId: 'run-3',
			session: createSession(),
			subscription: createSubscription(),
			event: createEvent(),
			agentId: 'session-1',
			message: 'Review PR',
			title: 'PR Bot',
			clickAction: { kind: 'open-url', url: 'https://example.com/pr/1' },
			mainWindow: fakeWindow(),
			onLog: vi.fn(),
		});

		const [, params] = emitCueNotifyToastMock.mock.calls[0];
		expect(params.clickAction).toEqual({ kind: 'open-url', url: 'https://example.com/pr/1' });
	});

	it("still returns completed when the bridge can't deliver, but records the drop in stderr", async () => {
		emitCueNotifyToastMock.mockReturnValue(false);
		const result = await executeCueNotify({
			runId: 'run-4',
			session: createSession(),
			subscription: createSubscription(),
			event: createEvent(),
			agentId: 'session-1',
			message: 'Headless boot toast',
			title: 'Standup Bot',
			mainWindow: null,
			onLog: vi.fn(),
		});

		// Returning `completed` is intentional: terminal-status drives
		// time.once self-destruct, and notify is advisory - failing the run
		// here would leave one-shot reminders stuck in cue.yaml forever.
		expect(result.status).toBe('completed');
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('mainWindow unavailable');
	});

	it('logs the dispatch with subscription name and agent id', async () => {
		const onLog = vi.fn();
		await executeCueNotify({
			runId: 'run-5',
			session: createSession(),
			subscription: createSubscription(),
			event: createEvent(),
			agentId: 'session-1',
			message: 'Test',
			title: 'Standup Bot',
			mainWindow: fakeWindow(),
			onLog,
		});

		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('standup-reminder'));
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('session-1'));
	});
});
