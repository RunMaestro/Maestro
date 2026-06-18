/**
 * Tests for the Cue → renderer notify bridge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const isWebContentsAvailableMock = vi.fn();
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => isWebContentsAvailableMock(win),
}));

import { emitCueNotifyToast } from '../../../main/cue/cue-notify-bridge';

function fakeWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
	const send = vi.fn();
	const win = { webContents: { send } } as unknown as BrowserWindow;
	return { win, send };
}

describe('emitCueNotifyToast', () => {
	beforeEach(() => {
		isWebContentsAvailableMock.mockReset().mockReturnValue(true);
	});

	it('returns false and skips send when mainWindow is null', () => {
		isWebContentsAvailableMock.mockReturnValue(false);
		const result = emitCueNotifyToast(null, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'standup time',
		});
		expect(result).toBe(false);
	});

	it('returns false when webContents is unavailable', () => {
		const { win, send } = fakeWindow();
		isWebContentsAvailableMock.mockReturnValue(false);
		const result = emitCueNotifyToast(win, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'standup time',
		});
		expect(result).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it('sends a remote:notifyToast payload with theme color and jump-session default', () => {
		const { win, send } = fakeWindow();
		const result = emitCueNotifyToast(win, {
			agentId: 'agent-1',
			title: 'My Agent',
			message: 'standup time',
		});
		expect(result).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith('remote:notifyToast', {
			title: 'My Agent',
			message: 'standup time',
			color: 'theme',
			dismissible: false,
			sessionId: 'agent-1',
			clickAction: { kind: 'jump-session', sessionId: 'agent-1' },
		});
	});

	it('marks the toast sticky when sticky: true', () => {
		const { win, send } = fakeWindow();
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
		const { win, send } = fakeWindow();
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
