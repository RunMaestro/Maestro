/**
 * Shared constants, types, and small stateless helpers for A Cappella IPC handlers.
 */

import type { BrowserWindow, WebContents } from 'electron';

import type { CreateHandlerOptions } from '../../../utils/ipcHandler';
import type { SafeSendFn } from '../../../utils/safe-send';
import type { ProcessLivenessProbe } from '../../../utils/agent-busy';
import {
	ACAPPELLA_AUDIO_COMMAND_CHANNEL,
	type AudioHostCommand,
} from '../../../../shared/acappella/audio-host';
import { requireACappellaEnabled } from '../../../../shared/acappella/feature-flag';
import type { VoiceScope, VoiceWindowId } from '../../../../shared/acappella/protocol';
import type { VoiceSessionView } from '../../../../shared/acappella/voice-control';
import type {
	AgentOutputSource,
	AudioHostWindowDeps,
	VoiceSessionSnapshot,
} from '../../../acappella';
import type { VoiceProviderSubstitution } from '../../../acappella/providers/provider-registry';
import { getAcappellaAudioHostWindow } from '../../../acappella';
import type { QuickChatVoiceHost } from '../../../acappella/dispatch/quick-chat-dispatch';

export const LOG_CONTEXT = '[ACappella]';

/** The push channel every protocol event goes out on. */
export const ACAPPELLA_EVENT_CHANNEL = 'acappella:event';

/**
 * The wake-word tuning channel.
 *
 * Deliberately NOT a protocol event: the Test button in Settings runs the local
 * detector with no session behind it, and inventing a voice session id so a
 * settings panel can light up a dot would put a fake session in every client's
 * event stream.
 */
export const ACAPPELLA_WAKE_TEST_CHANNEL = 'acappella:wake-test';

/**
 * Push channel for the microphone list.
 *
 * Its own channel rather than a protocol event: the list exists with no session
 * running (a settings panel has to draw the picker before anyone has spoken),
 * and inventing a voice session id so Settings can populate a dropdown would put
 * a fake session in every client's event stream.
 */
export const ACAPPELLA_INPUT_DEVICES_CHANNEL = 'acappella:input-devices';

/**
 * The wake phrase enrollment channel: recording progress, microphone level, and
 * training progress for a phrase the user is teaching the wake word. Events are
 * `WakeEnrollmentEvent` from `shared/acappella/wake-enrollment`.
 */
export const ACAPPELLA_WAKE_ENROLLMENT_CHANNEL = 'acappella:wake-enrollment';

/** What the wake-word tuning affordance pushes while it is running. */
export interface WakeTestEvent {
	phraseId: string;
	phrase: string;
	score: number;
	at: number;
}

/**
 * What starting a wake-word tuning run returns. A refusal carries the sentence
 * to show, because "nothing lit up" is otherwise indistinguishable between a
 * quiet phrase, a missing runtime, and a phrase no detector was trained for.
 */
export type WakeTestStartResult = { started: true } | { started: false; reason: string };

/**
 * What a start returns: the session snapshot plus anything the user needs to be
 * told about the trio they are actually running. Substitutions travel with the
 * start rather than only being logged - a silent downgrade to the mock tier is
 * exactly the failure the registry exists to prevent.
 */
export interface VoiceStartSessionResult {
	snapshot: VoiceSessionSnapshot;
	substitutions: VoiceProviderSubstitution[];
}

export interface ACappellaHandlerDependencies {
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
		/**
		 * Persist a setting. Optional for the same reason `onDidChange` is: tests
		 * pass a plain object. Without it the microphone choice cannot be saved, and
		 * `acappella:set-input-device` says so rather than reporting a success that
		 * would be forgotten on the next read.
		 */
		set?: (key: string, value: unknown) => void;
		/**
		 * Live setting changes. Optional because tests pass a plain object; without
		 * it the voice hotkeys bind once at startup and do not follow a rebind.
		 */
		onDidChange?: (key: string, callback: (value: unknown) => void) => void;
	};
	/** The window the dispatch executor talks to. Main has no tab authority. */
	getMainWindow: () => BrowserWindow | null;
	/**
	 * The window that OWNS an agent, for multi-window dispatch.
	 *
	 * Agent ownership is per window while `activeSessionId` is global, so
	 * dispatching to whichever window is "main" would activate an agent that
	 * window does not own - the documented way to make a window render "No
	 * agents". Absent in tests and in any single-window host, where the main
	 * window is the right answer by construction.
	 */
	getWindowForSession?: (agentSessionId: string) => BrowserWindow | null;
	/**
	 * Which window's HUD a session started from THIS trigger belongs to.
	 *
	 * `sender` is the IPC sender for a click (composer microphone, palette, Left
	 * Bar menu); it is absent for a trigger that has no window behind it - a
	 * global hotkey, a wake word, a paired phone - and the implementation then
	 * answers with the focused window.
	 *
	 * Every main -> renderer push is broadcast to all windows, so without this the
	 * same HUD rendered in every window at once and one microphone looked like
	 * several. Absent in tests and in any single-window host, where null means the
	 * primary window shows it, which is the only window there is.
	 */
	resolveVoiceWindowId?: (sender?: WebContents | null) => VoiceWindowId;
	/**
	 * Quick Chat, for a session bound to it: its window is the session's surface
	 * and its `send` delivers each turn. A getter because the controller is built
	 * after these handlers are registered. Absent in tests and in a host with no
	 * Quick Chat, where a Quick Chat session is refused by name.
	 */
	getQuickChat?: () => QuickChatVoiceHost | null;
	/** Broadcasts to every window and to the web-desktop bridge. */
	safeSend: SafeSendFn;
	/**
	 * What the hidden audio host window needs to load the renderer bundle. Absent
	 * only in tests, which never want a real `BrowserWindow`; when it is absent
	 * the session runs without audio I/O rather than failing to start.
	 */
	audioHostDeps?: AudioHostWindowDeps;
	/**
	 * The agent the user is looking at, for the `voiceCurrentAgent` hotkey. Absent
	 * in tests and in any host with no session store, where the agent hotkey
	 * refuses with a reason rather than binding a session to a guessed agent.
	 */
	getFocusedAgentSessionId?: () => string | null;
	/**
	 * The process manager, as an event source for the agent-output tap.
	 *
	 * This is what makes a spoken reply arrive while the agent is still writing:
	 * the tap rides the SAME `data` / `query-complete` / `agent-error` events the
	 * desktop transcript rides. Absent in tests and before the manager is
	 * constructed, in which case the session falls back to waiting for a whole
	 * reply through `submitAgentReply`.
	 */
	getProcessManager?: () => (AgentOutputSource & Partial<ProcessLivenessProbe>) | null;
	/** The agent type behind a session id, for the tap's stream-json parsing. */
	getAgentType?: (agentSessionId: string) => string | undefined;
	/**
	 * The running web server, for the paired-device transport.
	 *
	 * Its security token and port are what a phone needs to reach the signaling
	 * socket, so a QR code cannot be produced without it. Absent in tests and
	 * before the user has ever switched the web interface on, in which case
	 * pairing reports that there is nothing to pair to rather than inventing a
	 * port.
	 */
	getWebServer?: () => { getSecurityToken: () => string; getPort: () => number | null } | null;
	/**
	 * The scope behind a hotkey/remote-button press when no explicit scope was
	 * passed. Defaults to `{ kind: 'conductor' }`.
	 */
	getDefaultScope?: () => VoiceScope;
}

export const handlerOpts = (
	operation: string
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Encore gate. See `src/shared/acappella/feature-flag.ts`. */
export const requireEnabled = requireACappellaEnabled;

/** Push one command to the hidden audio host. A window that is not open is a no-op. */
export function sendAudioHostCommand(command: AudioHostCommand): void {
	const win = getAcappellaAudioHostWindow();
	if (!win || win.webContents.isDestroyed()) return;
	win.webContents.send(ACAPPELLA_AUDIO_COMMAND_CHANNEL, command);
}

/** The snapshot fields a caller outside the app is shown. */
export function toVoiceSessionView(snapshot: VoiceSessionSnapshot | null): VoiceSessionView | null {
	if (!snapshot) return null;
	return {
		sessionId: snapshot.sessionId,
		state: snapshot.state,
		scope: snapshot.scope,
		origin: snapshot.origin,
		windowId: snapshot.windowId,
		listenPaused: snapshot.listenPaused,
		startedAt: snapshot.startedAt,
		providerIds: snapshot.providerIds,
	};
}
