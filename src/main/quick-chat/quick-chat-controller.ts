/**
 * Quick Chat controller - the main-process hub between the Quick Chat window,
 * the app renderer that runs the conversation (the "engine", see
 * useQuickChatEngine), the system-wide hotkey, and `maestro-cli quick-chat`.
 *
 * The window and the CLI call the same functions here, so a CLI action takes
 * exactly the path a click in the window does.
 */

import { app, ipcMain, type BrowserWindow } from 'electron';
import { isMacOS } from '../../shared/platformDetection';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_SETTINGS_KEY,
	resolveQuickChatSettings,
	type QuickChatCommand,
	type QuickChatCommandResult,
	type QuickChatLayout,
	type QuickChatSnapshot,
	type QuickChatStatus,
	type QuickChatWindowAction,
} from '../../shared/quickChat';
import { setNamedGlobalHotkey } from '../global-hotkey-manager';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import {
	closeQuickChatWindow,
	getQuickChatWindow,
	hideQuickChatWindow,
	isQuickChatWindowVisible,
	setQuickChatLayout,
	showQuickChatWindow,
	toggleQuickChatWindow,
	type QuickChatWindowDeps,
} from './quick-chat-window';

const HOTKEY_ID = 'quickChat';
/** A send can wait on a tab being created and a spawn starting; give it room. */
const COMMAND_TIMEOUT_MS = 10_000;

/** The slice of the settings store the controller reads. */
export interface QuickChatSettingsStore {
	get(key: string): unknown;
	onDidChange(key: string, callback: (value: unknown) => void): unknown;
}

export interface QuickChatControllerDeps {
	settingsStore: QuickChatSettingsStore;
	windowDeps: QuickChatWindowDeps;
	getMainWindow: () => BrowserWindow | null;
	/** The app window that owns an agent, or the main window when none does. */
	getWindowForSession: (sessionId: string) => BrowserWindow | null;
}

export interface QuickChatController {
	/** Register IPC handlers and the hotkey, and follow settings changes. Call once. */
	init(): void;
	runCommand(command: QuickChatCommand): Promise<QuickChatCommandResult>;
	windowAction(action: QuickChatWindowAction): QuickChatStatus;
	getStatus(): QuickChatStatus;
}

/** The app's one controller, for callers outside the DI graph (the CLI bridge). */
let activeController: QuickChatController | null = null;

export function getQuickChatController(): QuickChatController | null {
	return activeController;
}

export function createQuickChatController(deps: QuickChatControllerDeps): QuickChatController {
	const { settingsStore, windowDeps } = deps;
	let snapshot: QuickChatSnapshot = { ...EMPTY_QUICK_CHAT_SNAPSHOT };
	let hotkeyRegistered = false;

	const isEnabled = () => resolveEncoreFeatures(settingsStore.get('encoreFeatures')).quickChat;
	const readSettings = () => resolveQuickChatSettings(settingsStore.get(QUICK_CHAT_SETTINGS_KEY));

	const pushSnapshotToWindow = () => {
		const win = getQuickChatWindow();
		if (win && isWebContentsAvailable(win)) win.webContents.send('quickChat:snapshot', snapshot);
	};

	/** The app window whose renderer runs the conversation. */
	const resolveEngineWindow = (): BrowserWindow | null => {
		const agentId = readSettings().agentId || snapshot.agentId;
		return agentId ? deps.getWindowForSession(agentId) : deps.getMainWindow();
	};

	const getStatus = (): QuickChatStatus => ({
		enabled: isEnabled(),
		visible: isQuickChatWindowVisible(),
		hotkey: readSettings().hotkey,
		hotkeyRegistered,
		snapshot,
	});

	const runCommand = async (command: QuickChatCommand): Promise<QuickChatCommandResult> => {
		if (!isEnabled()) {
			return { ok: false, error: 'Quick Chat is turned off in Encore Features', snapshot };
		}
		const win = resolveEngineWindow();
		if (!win || !isWebContentsAvailable(win)) {
			return { ok: false, error: 'No Maestro window is available', snapshot };
		}
		const result = await requestFromRenderer<QuickChatCommandResult>(win, 'quickChat:command', {
			args: [command],
			timeoutMs: COMMAND_TIMEOUT_MS,
			fallback: { ok: false, error: 'Maestro did not answer', snapshot },
		});
		snapshot = result.snapshot;
		pushSnapshotToWindow();
		// "Open in Maestro" is a deliberate trip to the main window: put the
		// floating window away and bring the window showing the tab forward.
		if (command.type === 'reveal' && result.ok && !win.isDestroyed()) {
			hideQuickChatWindow();
			if (win.isMinimized()) win.restore();
			win.show();
			if (isMacOS()) app.focus({ steal: true });
			win.focus();
		}
		return result;
	};

	const windowAction = (action: QuickChatWindowAction): QuickChatStatus => {
		if (action === 'hide') {
			hideQuickChatWindow();
			return getStatus();
		}
		if (!isEnabled()) return getStatus();
		const wasVisible = isQuickChatWindowVisible();
		if (action === 'toggle') toggleQuickChatWindow(windowDeps);
		else showQuickChatWindow(windowDeps);
		// Coming on screen (toggle from hidden always shows): refresh the agent
		// list and pick up an agent changed in Settings.
		if (!wasVisible) void runCommand({ type: 'sync' });
		return getStatus();
	};

	const syncHotkey = () => {
		const keys = isEnabled() ? readSettings().hotkey : [];
		hotkeyRegistered = setNamedGlobalHotkey(HOTKEY_ID, keys, () => windowAction('toggle'));
		if (!hotkeyRegistered) {
			const main = deps.getMainWindow();
			// intentionally not bridged: window-specific
			if (main && isWebContentsAvailable(main)) {
				main.webContents.send('quickChat:hotkeyFailed', keys);
			}
		}
	};

	const init = () => {
		// The window asks: run a command, report its layout, or hide itself.
		ipcMain.handle('quickChat:command', (_event, command: QuickChatCommand) => runCommand(command));
		ipcMain.handle('quickChat:window', (_event, action: QuickChatWindowAction) =>
			windowAction(action)
		);
		ipcMain.handle('quickChat:getSnapshot', () => snapshot);
		ipcMain.on('quickChat:setLayout', (event, next: QuickChatLayout) => {
			if (event.sender !== getQuickChatWindow()?.webContents) return;
			setQuickChatLayout(next === 'expanded' ? 'expanded' : 'compact');
		});
		// The engine reports state as the conversation streams.
		ipcMain.on('quickChat:snapshot', (_event, next: QuickChatSnapshot) => {
			snapshot = next;
			pushSnapshotToWindow();
		});

		syncHotkey();
		settingsStore.onDidChange(QUICK_CHAT_SETTINGS_KEY, syncHotkey);
		settingsStore.onDidChange('encoreFeatures', () => {
			if (!isEnabled()) closeQuickChatWindow();
			syncHotkey();
		});
		logger.info('Quick Chat controller ready', 'QuickChat', { enabled: isEnabled() });
	};

	const controller: QuickChatController = { init, runCommand, windowAction, getStatus };
	activeController = controller;
	return controller;
}
