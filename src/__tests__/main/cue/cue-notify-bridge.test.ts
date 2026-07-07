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

// Mock the bridge fan-out leaf so we can assert web-desktop clients receive the
// toast. The bridge always fires regardless of desktop-window liveness, which is
// exactly the parity guarantee this migration adds.
const broadcastBridgeEventMock = vi.fn();
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: (...args: unknown[]) => broadcastBridgeEventMock(...args),
}));

import { emitCueNotifyToast } from '../../../main/cue/cue-notify-bridge';

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
		expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [EXPECTED_PAYLOAD]);
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
		expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [EXPECTED_PAYLOAD]);
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
		expect(broadcastBridgeEventMock).toHaveBeenCalledWith('remote:notifyToast', [EXPECTED_PAYLOAD]);
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
