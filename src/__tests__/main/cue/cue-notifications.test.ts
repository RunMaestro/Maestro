// Source: src/__tests__/main/cue/cue-notify-bridge.test.ts
// Source: src/__tests__/main/cue/cue-notify-executor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type BrowserWindow } from 'electron';
import * as cueNotifyBridge from '../../../main/cue/cue-notify-bridge';
import { emitCueNotifyToast } from '../../../main/cue/cue-notify-bridge';
import { type CueEvent, type CueSubscription } from '../../../main/cue/cue-types';
import { type SessionInfo } from '../../../shared/types';
import { executeCueNotify } from '../../../main/cue/cue-notify-executor';
const broadcastBridgeEventMock = vi.fn();
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: (...args: unknown[]) => broadcastBridgeEventMock(...args),
}));
describe('cue-notify-bridge', () => {
	/** A live window: not destroyed, webContents present and not destroyed. */
	function aliveWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
		const send = vi.fn();
		const win = {
			isDestroyed: () => false,
			webContents: { isDestroyed: () => false, send },
		} as unknown as BrowserWindow;
		return { win, send };
	}

	/** A destroyed window: still an object, but no longer sendable. */
	function destroyedWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
		const send = vi.fn();
		const win = {
			isDestroyed: () => true,
			webContents: { isDestroyed: () => false, send },
		} as unknown as BrowserWindow;
		return { win, send };
	}

	const EXPECTED_PAYLOAD = {
		title: 'My Agent',
		message: 'standup time',
		color: 'theme',
		dismissible: false,
		sessionId: 'agent-1',
		clickAction: { kind: 'jump-session', sessionId: 'agent-1' },
	};

	describe('emitCueNotifyToast', () => {
		beforeEach(() => {
			broadcastBridgeEventMock.mockReset();
		});

		it('fans out to web-desktop bridge clients even when mainWindow is null', () => {
			const result = emitCueNotifyToast(null, {
				agentId: 'agent-1',
				title: 'My Agent',
				message: 'standup time',
			});
			// No desktop renderer to reach, but the bridge still delivers.
			expect(result).toBe(false);
			expect(broadcastBridgeEventMock).toHaveBeenCalledTimes(1);
			expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [
				EXPECTED_PAYLOAD,
			]);
		});

		it('fans out to the bridge even when the desktop window is destroyed', () => {
			const { win, send } = destroyedWindow();
			const result = emitCueNotifyToast(win, {
				agentId: 'agent-1',
				title: 'My Agent',
				message: 'standup time',
			});
			expect(result).toBe(false);
			expect(send).not.toHaveBeenCalled();
			expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [
				EXPECTED_PAYLOAD,
			]);
		});

		it('sends to both the desktop renderer and the bridge when the window is alive', () => {
			const { win, send } = aliveWindow();
			const result = emitCueNotifyToast(win, {
				agentId: 'agent-1',
				title: 'My Agent',
				message: 'standup time',
			});
			expect(result).toBe(true);
			expect(send).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledWith('remote:notifyToast', EXPECTED_PAYLOAD);
			expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [
				EXPECTED_PAYLOAD,
			]);
		});

		it('marks the toast sticky when sticky: true', () => {
			const { win, send } = aliveWindow();
			emitCueNotifyToast(win, {
				agentId: 'agent-1',
				title: 'Critical',
				message: 'attention required',
				sticky: true,
			});
			const payload = send.mock.calls[0][1] as { dismissible: boolean };
			expect(payload.dismissible).toBe(true);
		});

		it('passes through a caller-provided clickAction', () => {
			const { win, send } = aliveWindow();
			emitCueNotifyToast(win, {
				agentId: 'agent-1',
				title: 'My Agent',
				message: 'check PR',
				clickAction: { kind: 'open-url', url: 'https://example.com/pr/1' },
			});
			const payload = send.mock.calls[0][1] as { clickAction: unknown };
			expect(payload.clickAction).toEqual({ kind: 'open-url', url: 'https://example.com/pr/1' });
		});
	});
});
describe('cue-notify-executor', () => {
	const emitCueNotifyToastMock = vi.fn();

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
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			vi.spyOn(cueNotifyBridge, 'emitCueNotifyToast').mockImplementation(emitCueNotifyToastMock);
		});
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
});
