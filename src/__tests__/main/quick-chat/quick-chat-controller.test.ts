/**
 * Quick Chat controller - the part a voice session bound to Quick Chat uses.
 *
 * `showForVoice` puts the window on screen and names it as the session's owner.
 * It refuses (null) when Quick Chat is turned off, so the caller refuses the
 * session instead of opening a microphone with nothing to show it.
 *
 * `onSnapshot` is how that session learns where a spoken message went: a
 * message is routed after `send` has returned, so its tab arrives in a later
 * snapshot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const windowState = vi.hoisted(() => ({ visible: false, id: null as string | null }));

vi.mock('electron', () => ({
	app: { focus: vi.fn() },
	ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/global-hotkey-manager', () => ({
	setNamedGlobalHotkey: vi.fn(() => true),
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => !!win,
}));
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: vi.fn(
		async (_win: unknown, _channel: string, options: { fallback: unknown }) => options.fallback
	),
}));
vi.mock('../../../main/quick-chat/quick-chat-window', () => ({
	closeQuickChatWindow: vi.fn(),
	getQuickChatWindow: vi.fn(() => null),
	getQuickChatWindowBounds: vi.fn(() => null),
	getQuickChatFontScale: vi.fn(() => 1),
	setQuickChatFontScale: vi.fn(),
	setQuickChatFullView: vi.fn(),
	getQuickChatWindowId: vi.fn(() => windowState.id),
	hideQuickChatWindow: vi.fn(() => {
		windowState.visible = false;
	}),
	isQuickChatWindowPinned: vi.fn(() => true),
	isQuickChatWindowVisible: vi.fn(() => windowState.visible),
	setQuickChatLayout: vi.fn(),
	setQuickChatWindowPinned: vi.fn(),
	setQuickChatWindowBounds: vi.fn(),
	// Creating the window is what gives it an id.
	showQuickChatWindow: vi.fn(() => {
		windowState.visible = true;
		windowState.id = 'quick-window';
	}),
	toggleQuickChatWindow: vi.fn(),
}));

import { ipcMain } from 'electron';
import { createQuickChatController } from '../../../main/quick-chat/quick-chat-controller';
import { showQuickChatWindow } from '../../../main/quick-chat/quick-chat-window';
import { requestFromRenderer } from '../../../main/web-server/callbacks/remoteRequest';
import { EMPTY_QUICK_CHAT_SNAPSHOT, type QuickChatSnapshot } from '../../../shared/quickChat';

function makeController(quickChatEnabled: boolean) {
	return createQuickChatController({
		settingsStore: {
			get: (key: string) =>
				key === 'encoreFeatures' ? { quickChat: quickChatEnabled } : undefined,
			onDidChange: vi.fn(),
		},
		windowDeps: {} as never,
		getMainWindow: () => ({ webContents: { send: vi.fn() } }) as never,
		getWindowForSession: () => null,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	windowState.visible = false;
	windowState.id = null;
});

describe('QuickChatController.showForVoice', () => {
	it('shows the window and names it as the owner of the session', () => {
		const controller = makeController(true);

		expect(controller.showForVoice()).toBe('quick-window');
		expect(showQuickChatWindow).toHaveBeenCalledTimes(1);
	});

	it('does not show a window that is already on screen: the press came from it', () => {
		// Showing again refocuses the composer, in the middle of a press.
		const controller = makeController(true);
		windowState.visible = true;
		windowState.id = 'quick-window';

		expect(controller.showForVoice()).toBe('quick-window');
		expect(showQuickChatWindow).not.toHaveBeenCalled();
	});

	it('refuses when Quick Chat is turned off, and opens no window', () => {
		const controller = makeController(false);

		expect(controller.showForVoice()).toBeNull();
		expect(showQuickChatWindow).not.toHaveBeenCalled();
	});
});

describe('QuickChatController.onSnapshot', () => {
	const snapshotWith = (tabId: string): QuickChatSnapshot => ({
		...EMPTY_QUICK_CHAT_SNAPSHOT,
		tabId,
	});

	/** The engine's push channel, as `init` registered it. */
	function enginePush(): (event: unknown, next: QuickChatSnapshot) => void {
		const call = vi
			.mocked(ipcMain.on)
			.mock.calls.find(([channel]) => channel === 'quickChat:snapshot');
		if (!call) throw new Error('quickChat:snapshot was not registered');
		return call[1] as never;
	}

	it("hears a command's result and the engine's later pushes", async () => {
		const controller = makeController(true);
		controller.init();
		const heard: Array<string | null> = [];
		controller.onSnapshot((snapshot) => heard.push(snapshot.tabId));

		vi.mocked(requestFromRenderer).mockResolvedValueOnce({
			ok: true,
			snapshot: snapshotWith('tab-sent'),
		});
		await controller.runCommand({ type: 'send', text: 'hello' });
		// The route of that message arrives on its own, after the command answered.
		enginePush()({}, snapshotWith('tab-routed'));

		expect(heard).toEqual(['tab-sent', 'tab-routed']);
		expect(controller.getStatus().snapshot.tabId).toBe('tab-routed');
	});

	it('stops telling a listener that stopped listening, even from inside its own call', () => {
		const controller = makeController(true);
		controller.init();
		const heard: Array<string | null> = [];
		const stop = controller.onSnapshot((snapshot) => {
			heard.push(snapshot.tabId);
			stop();
		});
		const other = vi.fn();
		controller.onSnapshot(other);

		enginePush()({}, snapshotWith('tab-1'));
		enginePush()({}, snapshotWith('tab-2'));

		expect(heard).toEqual(['tab-1']);
		// One listener leaving does not cost another its turn.
		expect(other).toHaveBeenCalledTimes(2);
	});
});
