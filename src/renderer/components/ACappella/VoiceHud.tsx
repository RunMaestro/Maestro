/**
 * VoiceHud - the one on-screen surface for an A Cappella voice session.
 *
 * Mounted once, app-wide (next to the other single-instance hosts in AppShell)
 * and gated on the `aCappella` Encore flag. It owns the `acappella:event`
 * subscription, so a second mount would project every protocol event twice. It
 * renders nothing until there is something to show: a live session, an error
 * worth reading, or the dev harness in a development build.
 *
 * **Minimize and close are different actions, and must stay that way.**
 * Minimize hides the widget and leaves the session running, handing the
 * indicator to `VoiceStatusIndicator` in the Left Bar header; close ENDS the
 * session. That pairing is the opposite of the media player's, and deliberately
 * so: there, sound is the evidence that something is still running, so hiding
 * the widget is safe. Here, silence is - a microphone with no visible surface is
 * one the user cannot see, so the button that hides the widget must leave an
 * indicator behind, and the button that looks like an exit must actually close
 * the floor.
 *
 * **Only Escape closes it.** Escape and the ESC pill are the one way the widget
 * leaves the screen. The talk button shuts the MICROPHONE and keeps the session;
 * a session that ends on its own (the idle timeout, the stop word) leaves the
 * widget where it was, showing a closed microphone one click from open. A
 * control row where one button quietly hangs up, or a panel that vanishes while
 * someone is reading it, is a surface people stop trusting.
 * In the browser build, blocking modals temporarily hide the in-app HUD.
 * Desktop widgets stay visible over other apps and Spaces.
 *
 * **Tab walks Tab / Agent / Conductor** while the widget is up, on top, and has
 * a live session to re-bind. The listener runs in the bubble phase and stands
 * down for a key something else already claimed, so a completion popup, a shell
 * line and an editor's indent all keep their Tab.
 *
 * Desktop geometry belongs to the shared floating-window controller. The
 * browser fallback uses `usePointerDrag` and the persisted voice UI position.
 * The originating app window publishes the projection and handles commands;
 * the floating window reuses this body without a second voice subscription.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Minus, MicOff } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Z_LAYERS } from '../../constants/zLayers';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useIsTopLayer } from '../../hooks/ui/useIsTopLayer';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import {
	VOICE_HUD_STATE_DESCRIPTIONS,
	VOICE_HUD_STATE_LABELS,
	voiceHudVisualState,
} from '../../../shared/acappella/hud-state';
import {
	clampVoiceHudPosition,
	defaultVoiceHudPosition,
	type VoiceHudPosition,
} from '../../../shared/acappella/ui-prefs';
import { DEFAULT_TTS_VOLUME } from '../../../shared/acappella/voice-controls';
import { VOICE_LISTEN_MODE_LABELS } from '../../../shared/acappella/listen-mode';
import type { MicIssue } from '../../../shared/acappella/protocol';
import { micSettingsLabel, micSettingsUrl } from '../../../shared/acappella/mic-settings';
import { getPlatform } from '../../utils/platformUtils';
import { selectVoiceRemoteDevice, useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { closeVoiceMic, openVoiceMic, toggleVoiceListenMode } from '../../services/voiceListening';
import { floatingWidgetsAvailable } from '../../utils/floatingWidgetMode';
import {
	onWidgetCommand,
	publishStoreState,
	sendWidgetCommand,
} from '../../utils/windowStoreMirror';
import {
	isVoiceWidgetCommand,
	type VoiceWidgetCommand,
	type VoiceWidgetState,
} from '../../../shared/floatingWidgets';
import type { VoiceSessionProjection } from '../../../shared/acappella/hud-state';
import { FloatingWidgetFrame } from '../../floatingWidget/FloatingWidgetFrame';
import { jumpToVoiceTab } from '../../hooks/voice/useVoiceAgentActions';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { EscCloseButton } from '../ui/EscCloseButton';
import { VoiceDevHarness } from './VoiceDevHarness';
import { VoiceHudControls } from './VoiceHudControls';
import { VoiceIndicator } from './VoiceIndicator';
import { VoiceTranscript } from './VoiceTranscript';
import { VoiceSetupRecovery } from './VoiceSetupRecovery';
import { VoiceHeldNotice } from './VoiceHeldNotice';
import { VoiceModeSwitch } from './VoiceModeSwitch';
import { VoiceWaitPicker } from './VoiceWaitPicker';
import { useVoiceModeSwitch } from './useVoiceModeSwitch';
import { useVoiceScope } from './useVoiceScope';
import { useVoiceScopeFollow } from './useVoiceScopeFollow';
import { useOwnsVoiceSession } from './useOwnsVoiceSession';
import { isDocumentScope } from '../../../shared/acappella/document-scope';
import { VoiceInputPicker } from './VoiceInputPicker';
import { useVoiceInputDevices } from './useVoiceInputDevices';
import { useVoiceSession } from './useVoiceSession';

export interface VoiceHudProps {
	theme: Theme;
	/** The A Cappella Encore flag. False renders nothing and subscribes to nothing. */
	enabled: boolean;
	/**
	 * Show the dev harness - the type-an-utterance box that drives a session
	 * without a microphone.
	 *
	 * Defaults to OFF, including in development, and opts in through
	 * {@link DEV_HARNESS_STORAGE_KEY}. It used to default to the development
	 * build, and because the harness is also a reason for the widget to render,
	 * every dev build opened a voice panel at startup that nobody had asked for -
	 * the one thing A Cappella must never do. A debugging tool is not a reason to
	 * put a microphone widget on screen.
	 */
	showDevHarness?: boolean;
	/** Replica body in the desktop widget window; never subscribes to voice events. */
	floatingWindow?: boolean;
	widgetState?: VoiceWidgetState;
}

/**
 * Opt in to the dev harness: `localStorage.setItem(key, 'true')`, then reload.
 *
 * localStorage rather than a build flag so it can be switched on in the window
 * that is misbehaving, and read once at mount so toggling it mid-session cannot
 * make a widget appear underneath the user.
 */
export const DEV_HARNESS_STORAGE_KEY = 'maestro.acappella.devHarness';

function devHarnessOptedIn(): boolean {
	try {
		return globalThis.localStorage?.getItem(DEV_HARNESS_STORAGE_KEY) === 'true';
	} catch {
		// A window with storage denied has not opted in to anything.
		return false;
	}
}

/** Widget width. Fixed: this is a status readout, not a document. */
const HUD_WIDTH = 340;

/** Height used for clamping before the widget has been measured. */
const HUD_FALLBACK_HEIGHT = 160;

/**
 * What a broken microphone says. Plain, specific, and free of alarm language: a
 * denied permission is a setting the user has not turned on yet, not a crash,
 * and dressing it in error red teaches people to ignore the colour that matters.
 */
const MIC_ISSUE_MESSAGES: Record<MicIssue, string> = {
	'permission-denied': 'Maestro does not have microphone access yet.',
	'no-device': 'No microphone was found.',
	'device-lost': 'The microphone was disconnected.',
	unavailable: 'Audio capture is unavailable on this system.',
};

function viewport() {
	return { width: window.innerWidth, height: window.innerHeight };
}

export function VoiceHud({
	theme,
	enabled,
	showDevHarness,
	floatingWindow = false,
	widgetState,
}: VoiceHudProps) {
	const actions = useVoiceSession(enabled, floatingWindow);
	const relayCommand = useCallback(
		(command: VoiceWidgetCommand): boolean => {
			if (!floatingWindow) return false;
			sendWidgetCommand('acappella-voice', command);
			return true;
		},
		[floatingWindow]
	);

	const state = useVoiceSessionStore((s) => s.state);
	const documentSession = useVoiceSessionStore((s) => isDocumentScope(s.scope));
	const sendState = useVoiceSessionStore((s) => s.sendState);
	const forceSendAllowed = useSettingsStore((s) => s.forcedParallelExecution);
	const partial = useVoiceSessionStore((s) => s.partialTranscript);
	const speech = useVoiceSessionStore((s) => s.speech);
	const mic = useVoiceSessionStore((s) => s.mic);
	const error = useVoiceSessionStore((s) => s.error);
	const substitutions = useVoiceSessionStore((s) => s.substitutions);
	const sttHearsAudio = useVoiceSessionStore((s) => s.sttHearsAudio);
	const lostEvents = useVoiceSessionStore((s) => s.lostEvents);
	const dismissed = useVoiceSessionStore((s) => s.dismissed);
	const listenPaused = useVoiceSessionStore((s) => s.listenPaused);
	const surfaced = useVoiceSessionStore((s) => s.surfaced);
	/**
	 * The paired device holding the floor, or null for this machine's own
	 * microphone. Rendered next to the state so a Mac at home visibly reflects
	 * that a phone is the thing listening - a listening indicator over a shut
	 * local microphone is the one lie this widget must never tell.
	 */
	const remoteDevice = useVoiceSessionStore(selectVoiceRemoteDevice);
	const setDismissed = useVoiceSessionStore((s) => s.setDismissed);

	const loadPrefs = useVoiceUiStore((s) => s.load);
	const storedPosition = useVoiceUiStore((s) => s.hudPosition);
	const setHudPosition = useVoiceUiStore((s) => s.setHudPosition);
	const transcriptVisible = useVoiceUiStore((s) => s.transcriptVisible);
	const toggleTranscript = useVoiceUiStore((s) => s.toggleTranscript);
	const minimized = useVoiceUiStore((s) => s.minimized);
	const setMinimized = useVoiceUiStore((s) => s.setMinimized);
	const minimizeBehavior = useVoiceUiStore((s) => s.minimizeBehavior);
	const muted = useVoiceUiStore((s) => s.muted);
	const setMuted = useVoiceUiStore((s) => s.setMuted);
	const listenMode = useVoiceUiStore((s) => s.listenMode);
	const holdWhileBusy = useVoiceUiStore((s) => s.holdWhileBusy);
	const setHoldWhileBusy = useVoiceUiStore((s) => s.setHoldWhileBusy);
	const sendWait = useVoiceUiStore((s) => s.sendWait);
	const refreshSendWait = useVoiceUiStore((s) => s.refreshSendWait);
	const setSendWait = useVoiceUiStore((s) => s.setSendWait);
	const setSendPhrases = useVoiceUiStore((s) => s.setSendPhrases);
	const setTabCyclesMode = useVoiceUiStore((s) => s.setTabCyclesMode);
	const [waitPickerOpen, setWaitPickerOpen] = useState(false);

	const scope = useVoiceScope(theme);
	// `HTMLElement`, not `HTMLDivElement`: the collapsed form is a button, and the
	// clamp measures whichever one is currently mounted.
	const rootRef = useRef<HTMLElement | null>(null);
	// A callback ref, because the same ref is attached to a <div> in the expanded
	// form and a <button> in the collapsed one, and a typed RefObject can only be
	// one of those.
	const setRootRef = useCallback((el: HTMLElement | null) => {
		rootRef.current = el;
	}, []);
	const startDrag = usePointerDrag();

	// Read once, at mount: see DEV_HARNESS_STORAGE_KEY.
	const [harnessOptedIn] = useState(devHarnessOptedIn);
	const devHarness = showDevHarness ?? harnessOptedIn;
	// The explicit developer harness stays in the app where its request/reply controls live.
	const desktopAuthority = !floatingWindow && floatingWidgetsAvailable() && !devHarness;
	const externalWindow = floatingWindow || desktopAuthority;
	const active = isVoiceSessionActive(state);
	const visualState = voiceHudVisualState(state, listenPaused);
	// The one answer to "is the microphone open": a live session whose gate is
	// not shut. Never `active` alone, which stays true across a pause.
	const micOpen = active && !listenPaused;
	const modeSwitch = useVoiceModeSwitch();

	// Live geometry. Seeded from the remembered position, or parked bottom-right.
	const [position, setPosition] = useState<VoiceHudPosition | null>(null);
	const positionRef = useRef<VoiceHudPosition | null>(null);
	positionRef.current = position;

	useEffect(() => {
		if (!enabled || floatingWindow) return;
		void loadPrefs();
	}, [enabled, loadPrefs, floatingWindow]);

	const measuredSize = useCallback(
		() => ({
			width: HUD_WIDTH,
			height: rootRef.current?.offsetHeight || HUD_FALLBACK_HEIGHT,
		}),
		[]
	);

	// Adopt the stored position once it has loaded, pulled back on screen. A
	// position saved on a monitor that is no longer attached is the reason this
	// clamps rather than trusts.
	useEffect(() => {
		if (externalWindow) return;
		setPosition(
			storedPosition
				? clampVoiceHudPosition(storedPosition, measuredSize(), viewport())
				: defaultVoiceHudPosition(measuredSize(), viewport())
		);
	}, [measuredSize, storedPosition, enabled, externalWindow]);

	// A window resize can leave the widget partly or wholly off screen.
	useEventListener(
		'resize',
		() =>
			setPosition((prev) =>
				prev ? clampVoiceHudPosition(prev, measuredSize(), viewport()) : prev
			),
		{ enabled: !externalWindow }
	);

	const onDragHandle = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			const origin = positionRef.current;
			if (!origin) return;
			startDrag(
				event,
				(dx, dy) =>
					setPosition(
						clampVoiceHudPosition(
							{ top: origin.top + dy, left: origin.left + dx },
							measuredSize(),
							viewport()
						)
					),
				{
					// Header buttons still click: without this, pressing minimize would
					// start a drag and swallow the click.
					ignoreButtons: true,
					// Persist on release only, so a drag is one settings write instead of
					// one per pointer move.
					onEnd: () => {
						const next = positionRef.current;
						if (next) void setHudPosition(next);
					},
				}
			);
		},
		[measuredSize, setHudPosition, startDrag]
	);

	// Escape and the ESC pill do exactly the same thing, from one callback: end
	// the session, then hide. Stopping an already-idle session is a no-op in the
	// service, so closing the harness (idle, HUD open) works too. It is also the
	// ONLY thing that hides the widget, and it takes the "just for now" wait with
	// it, so the next conversation starts on the stored default.
	const handleClose = useCallback(() => {
		setWaitPickerOpen(false);
		if (relayCommand({ type: 'close' })) return;
		void actions.stop();
		setMinimized(false);
		setDismissed(true);
		setWaitPickerOpen(false);
		void setSendWait(null).catch(() => undefined);
	}, [actions, setDismissed, setMinimized, setSendWait, relayCommand]);

	// The other button. It does NOT touch the session, or the microphone.
	const handleMinimize = useCallback(() => {
		if (!relayCommand({ type: 'minimize' })) setMinimized(true);
	}, [setMinimized, relayCommand]);

	// The talk button. Both shut the microphone and keep the session; opening
	// resumes it, or starts one when the last one has ended. See
	// `services/voiceListening.ts` for why the two are queued behind each other.
	const handleOpenMic = useCallback(
		({ hold }: { hold: boolean }) => {
			if (!relayCommand({ type: 'open-mic', hold })) void openVoiceMic({ hold });
		},
		[relayCommand]
	);
	const handleCloseMic = useCallback(
		({ send }: { send: boolean }) => {
			if (!relayCommand({ type: 'close-mic', send })) void closeVoiceMic({ send });
		},
		[relayCommand]
	);

	const handleToggleListenMode = useCallback(() => {
		// The wait belongs to hands-free. Left open across the switch it would be a
		// picker for a timer push-to-talk never runs.
		setWaitPickerOpen(false);
		if (!relayCommand({ type: 'toggle-listen-mode' })) void toggleVoiceListenMode();
	}, [relayCommand]);

	const handlePickWait = useCallback(
		(waitMs: number | null) => {
			if (!relayCommand({ type: 'set-wait', waitMs }))
				void setSendWait(waitMs).catch(() => undefined);
		},
		[setSendWait, relayCommand]
	);

	const handleSetSendPhrases = useCallback(
		(phrases: string) => {
			if (!relayCommand({ type: 'set-send-phrases', phrases }))
				void setSendPhrases(phrases).catch(() => undefined);
		},
		[setSendPhrases, relayCommand]
	);

	const handleInterrupt = useCallback(() => {
		if (!relayCommand({ type: 'interrupt' })) void actions.interrupt();
	}, [actions, relayCommand]);

	/**
	 * Mute applies to the live output and is deliberately not persisted: a mute
	 * that survived a restart is a voice assistant that has silently stopped
	 * talking to you, with a button you have long forgotten pressing.
	 */
	const handleToggleMute = useCallback(() => {
		if (relayCommand({ type: 'toggle-mute' })) return;
		const next = !muted;
		setMuted(next);
		void window.maestro.voice.setVolume(next ? 0 : DEFAULT_TTS_VOLUME).catch(() => undefined);
	}, [muted, setMuted, relayCommand]);

	// Auto-idle: collapse when a turn finishes, expand the moment there is
	// something to show again. Never closes - see the header comment.
	useEffect(() => {
		if (floatingWindow || !enabled || minimizeBehavior !== 'auto-idle') return;
		if (visualState === 'idle-armed') setMinimized(true);
		else setMinimized(false);
	}, [minimizeBehavior, setMinimized, visualState, enabled, floatingWindow]);

	// A new session un-hides the widget. Otherwise a hotkey or a wake word would
	// open a microphone behind a HUD the user dismissed an hour ago.
	useEffect(() => {
		if (active && !documentSession && !floatingWindow) setDismissed(false);
	}, [active, documentSession, setDismissed, floatingWindow]);

	const micIssue = mic?.issue ?? null;
	const { hasOpenModal } = useLayerStack();

	/**
	 * Every reason the widget is on screen, in one place.
	 *
	 * One expression rather than two, because the render gate and the Escape
	 * layer had drifted: the layer was registered for `active || devHarness`
	 * while the widget also rendered for an error or a microphone problem, so the
	 * HUD showing a refusal drew an ESC pill that Escape did not actually reach.
	 * A widget that is visible is a widget Escape must close.
	 *
	 * The dev harness stays a reason, because opting into it IS a trigger: someone
	 * who set the storage key wants the box to type into. What changed is that it
	 * no longer opts itself in on every developer's behalf.
	 *
	 * `ownsSession` is what keeps a session opened in one window out of the
	 * others, and it gates every SESSION-derived reason: a live session, a
	 * refusal, and a microphone problem all describe one session, which belongs
	 * to one window. The dev harness is the only ungated reason, because it is
	 * per-window by construction - it is opted into in the window that wants it.
	 */
	const ownsSession = useOwnsVoiceSession();
	// Tab and Agent mode follow the user to another agent or tab. Here rather
	// than in the mode switch, which is only mounted while a session is live:
	// the HUD is the one voice surface that is always mounted.
	useVoiceScopeFollow(enabled && ownsSession && !documentSession && !floatingWindow);
	// Only while this window owns the surface: enumerating devices in every window
	// would have each one subscribing to a list none of them is showing.
	const localInputDevices = useVoiceInputDevices(enabled && ownsSession && !floatingWindow);
	const inputDevices =
		floatingWindow && widgetState
			? {
					...widgetState.inputDevices,
					select: async (deviceId: string) => {
						relayCommand({ type: 'set-input', deviceId });
					},
				}
			: localInputDevices;
	// `surfaced` is what keeps the widget up after its session ends: once a
	// session has been live here, only the close control takes the HUD away.
	const visible =
		enabled &&
		// Document chat owns its microphone and transcript inside the preview.
		!documentSession &&
		!dismissed &&
		// Temporarily yield to blocking dialogs without dismissing or stopping the
		// session. The shared stack excludes passive panels, including this HUD.
		(externalWindow || !hasOpenModal()) &&
		(devHarness || (ownsSession && (active || surfaced || !!error || !!micIssue)));

	// Read when the widget comes up rather than once at mount: the default behind
	// the wait chip is a setting, and it can change between two conversations.
	useEffect(() => {
		if (visible && !floatingWindow) void refreshSendWait().catch(() => undefined);
	}, [refreshSendWait, visible, floatingWindow]);
	// And again when the send panel opens: it edits the send phrase, which
	// Settings can also change while the widget is already up, and a field seeded
	// from a stale copy would write that copy back over the newer one.
	useEffect(() => {
		if (waitPickerOpen && !relayCommand({ type: 'refresh-send-wait' }))
			void refreshSendWait().catch(() => undefined);
	}, [refreshSendWait, waitPickerOpen, relayCommand]);

	// Tab walks Tab / Agent / Conductor. Only with a live session (the switch is
	// not drawn without one, and there is nothing to re-bind), only while the
	// widget is actually on screen, and only on top: a modal opened over the HUD
	// needs Tab for its own focus order.
	const isTopLayer = useIsTopLayer(MODAL_PRIORITIES.VOICE_HUD);
	const tabCyclesMode =
		visible && !minimized && active && !desktopAuthority && (floatingWindow || isTopLayer);
	useEffect(() => {
		if (floatingWindow) return;
		setTabCyclesMode(tabCyclesMode);
		return () => setTabCyclesMode(false);
	}, [setTabCyclesMode, tabCyclesMode, floatingWindow]);
	useEventListener(
		'keydown',
		(event) => {
			const key = event as KeyboardEvent;
			if (key.key !== 'Tab' || key.metaKey || key.ctrlKey || key.altKey) return;
			// Bubble phase on purpose: whatever uses Tab for itself (a completion
			// popup, a shell line, an editor's indent) has already said so.
			if (key.defaultPrevented) return;
			key.preventDefault();
			const direction = key.shiftKey ? -1 : 1;
			if (!relayCommand({ type: 'cycle-mode', direction })) modeSwitch.cycle(direction);
		},
		{ enabled: tabCyclesMode }
	);

	// Non-blocking: the HUD floats over the workspace while the user keeps typing,
	// so it takes neither focus nor the lower layers' clicks, and it never traps
	// focus. It still registers, so Escape reaches it before the surfaces beneath.
	//
	// `blocksAppShortcuts: false` is the one that is easy to miss, and omitting it
	// undoes all three above: the default is `true`, so merely SHOWING the HUD put
	// a shortcut-blocking layer on the stack and Cmd+K, agent switching, and the
	// file-tree keys went dead for as long as a voice session was open. A surface
	// that exists to be talked at must never take the keyboard away from the app
	// it is floating over.
	useModalLayer(MODAL_PRIORITIES.VOICE_HUD, 'Voice HUD', handleClose, {
		enabled: visible && !externalWindow,
		blocksLowerLayers: false,
		capturesFocus: false,
		blocksAppShortcuts: false,
		focusTrap: 'none',
	});

	// Only the originating app window publishes. The replica never owns protocol
	// subscriptions, scope following, persistence, or microphone enumeration.
	useEffect(() => {
		if (!enabled || !desktopAuthority || !ownsSession) return;
		const source = {
			getState(): VoiceWidgetState {
				const session = Object.fromEntries(
					Object.entries(useVoiceSessionStore.getState()).filter(
						([, value]) => typeof value !== 'function'
					)
				) as unknown as VoiceSessionProjection;
				const u = useVoiceUiStore.getState();
				return {
					session,
					ui: {
						transcriptVisible: u.transcriptVisible,
						hudPosition: u.hudPosition,
						minimizeBehavior: u.minimizeBehavior,
						listenMode: u.listenMode,
						holdWhileBusy: u.holdWhileBusy,
						defaultMode: u.defaultMode,
						loaded: u.loaded,
						minimized: u.minimized,
						muted: u.muted,
						holdThresholdMs: u.holdThresholdMs,
						sendWait: u.sendWait,
					},
					inputDevices: {
						devices: localInputDevices.devices,
						selectedId: localInputDevices.selectedId,
						loading: localInputDevices.loading,
					},
					forceSendAllowed,
				};
			},
			subscribe(listener: (state: VoiceWidgetState, previous: VoiceWidgetState) => void) {
				let previous = source.getState();
				const changed = () => {
					const next = source.getState();
					listener(next, previous);
					previous = next;
				};
				const voice = useVoiceSessionStore.subscribe(changed);
				const ui = useVoiceUiStore.subscribe(changed);
				return () => {
					voice();
					ui();
				};
			},
		};
		return publishStoreState('acappella-voice', source, (snapshot) => snapshot);
	}, [
		enabled,
		desktopAuthority,
		ownsSession,
		localInputDevices.devices,
		localInputDevices.selectedId,
		localInputDevices.loading,
		forceSendAllowed,
	]);

	const wasWindowAuthority = useRef(false);
	useEffect(() => {
		if (!enabled || !desktopAuthority) return;
		const api = window.maestro.floatingWidgets;
		if (!ownsSession) {
			// A Quick Chat session has its own controls. Hide our old HUD, but main
			// refuses this if another app window already published its new ownership.
			if (wasWindowAuthority.current) void api.hide('acappella-voice');
			wasWindowAuthority.current = false;
			return;
		}
		wasWindowAuthority.current = true;
		void (visible && !minimized ? api.show('acappella-voice') : api.hide('acappella-voice'));
	}, [enabled, desktopAuthority, ownsSession, visible, minimized]);

	useEffect(() => {
		if (!enabled || !desktopAuthority) return;
		return () => {
			if (wasWindowAuthority.current) void window.maestro.floatingWidgets.hide('acappella-voice');
		};
	}, [enabled, desktopAuthority]);

	useEffect(() => {
		if (!enabled || !desktopAuthority || !ownsSession) return;
		return onWidgetCommand<unknown>('acappella-voice', (command) => {
			if (!isVoiceWidgetCommand(command)) return;
			switch (command.type) {
				case 'close':
					handleClose();
					break;
				case 'minimize':
					handleMinimize();
					break;
				case 'open-mic':
					handleOpenMic(command);
					break;
				case 'close-mic':
					handleCloseMic(command);
					break;
				case 'interrupt':
					handleInterrupt();
					break;
				case 'toggle-mute':
					handleToggleMute();
					break;
				case 'toggle-transcript':
					void toggleTranscript();
					break;
				case 'toggle-listen-mode':
					handleToggleListenMode();
					break;
				case 'set-wait':
					handlePickWait(command.waitMs);
					break;
				case 'set-send-phrases':
					handleSetSendPhrases(command.phrases);
					break;
				case 'set-hold-while-busy':
					void setHoldWhileBusy(command.enabled);
					break;
				case 'set-force-send':
					void window.maestro.voice.setForceSend(command.enabled);
					break;
				case 'set-input':
					void localInputDevices.select(command.deviceId);
					break;
				case 'set-mode':
					modeSwitch.switchTo(command.mode);
					break;
				case 'cycle-mode':
					modeSwitch.cycle(command.direction);
					break;
				case 'send':
					void window.maestro.voice.endUtterance();
					break;
				case 'open-mic-settings':
					void window.maestro.voice.openMicSettings();
					break;
				case 'refresh-send-wait':
					void refreshSendWait().catch(() => undefined);
					break;
				case 'navigate':
					if (command.groupChatId)
						useGroupChatStore.getState().setActiveGroupChatId(command.groupChatId);
					else jumpToVoiceTab(command.agentSessionId, command.tabId);
					break;
			}
		});
	}, [
		enabled,
		desktopAuthority,
		ownsSession,
		handleClose,
		handleMinimize,
		handleOpenMic,
		handleCloseMic,
		handleInterrupt,
		handleToggleMute,
		toggleTranscript,
		handleToggleListenMode,
		handlePickWait,
		handleSetSendPhrases,
		setHoldWhileBusy,
		refreshSendWait,
		localInputDevices.select,
		modeSwitch.switchTo,
		modeSwitch.cycle,
	]);

	const warningText = useMemo(
		() => readableTextOn(theme.colors.warning, [theme.colors.bgSidebar]),
		[theme.colors.warning, theme.colors.bgSidebar]
	);
	const errorText = useMemo(
		() => readableTextOn(theme.colors.error, [theme.colors.bgSidebar]),
		[theme.colors.error, theme.colors.bgSidebar]
	);
	const onAccent = useMemo(
		() => readableTextOn(theme.colors.accentForeground, [theme.colors.accent]),
		[theme.colors.accentForeground, theme.colors.accent]
	);

	if (!visible || desktopAuthority) return null;

	const spoken = speech ? speech.sentences.length : 0;
	// While the reply is still being written the total is a lower bound, so the
	// delivered index legitimately runs past it - the live app read "1 of 0" on
	// the first sentence of a streamed answer. Show the larger of the two with a
	// "+" instead of printing a total that is not one.
	const speechProgress = speech
		? speech.streaming
			? `${spoken} of ${Math.max(spoken, speech.sentenceCount)}+`
			: `${spoken} of ${speech.sentenceCount}`
		: '';
	// The mic row says the same thing as an `audio-capture-failed` session error,
	// only in calmer words and with the button that fixes it. Showing both would
	// put the identical sentence on screen twice, one of them in red.
	const showError = error && !(micIssue && error.code === 'audio-capture-failed');

	const stateLabel = remoteDevice
		? `${VOICE_HUD_STATE_LABELS[visualState]} on ${remoteDevice}`
		: VOICE_HUD_STATE_LABELS[visualState];
	const placement = position ?? { top: 0, left: 0 };

	/*
	 * The live region lives outside the collapsed/expanded branch on purpose:
	 * minimizing must not stop a screen reader being told that the microphone
	 * just opened. `polite` rather than `assertive` because state changes are
	 * frequent and none of them are emergencies.
	 */
	const liveRegion = (
		<div
			data-testid="voice-hud-live-region"
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="sr-only"
		>
			{`${stateLabel}. ${VOICE_HUD_STATE_DESCRIPTIONS[visualState]} ${
				VOICE_LISTEN_MODE_LABELS[listenMode]
			}. Bound to ${scope.label}${scope.tabLabel ? `, tab ${scope.tabLabel}` : ''}.`}
		</div>
	);

	// Minimized: the widget leaves the workspace entirely and its indicator is
	// `VoiceStatusIndicator` in the Left Bar header, next to the media player's.
	// It used to collapse to a floating pill parked at the HUD's own position,
	// which is the one place a "get it out of the way" control must not leave
	// something - the pill sat over the same work the widget was covering. The
	// live region stays either way: minimizing must not stop a screen reader being
	// told that the microphone just opened.
	if (minimized) return liveRegion;

	const content = (
		<>
			{liveRegion}
			<div
				ref={setRootRef}
				data-testid="voice-hud"
				className={
					floatingWindow
						? 'relative flex-1 min-h-0 overflow-y-auto scrollbar-thin select-none'
						: 'fixed rounded-lg border shadow-xl select-none overflow-hidden'
				}
				style={{
					zIndex: Z_LAYERS.VOICE_HUD,
					top: floatingWindow ? undefined : placement.top,
					left: floatingWindow ? undefined : placement.left,
					width: floatingWindow ? '100%' : HUD_WIDTH,
					backgroundColor: theme.colors.bgSidebar,
					// Accent means a hot microphone, so it follows the gate, not the session.
					borderColor: micOpen ? theme.colors.accent : theme.colors.border,
					color: theme.colors.textMain,
					// Hidden until the first placement lands, so the widget does not flash
					// in the top-left corner on the frame before its position is known.
					visibility: floatingWindow || position ? undefined : 'hidden',
				}}
			>
				{/* Header: what it is bound to, what it is doing, and the two ways out.
				    It doubles as the drag handle. */}
				{!floatingWindow && (
					<div
						data-testid="voice-hud-header"
						className="flex items-center gap-2 px-3 py-2 border-b"
						style={{ borderColor: theme.colors.border, cursor: 'grab' }}
						onPointerDown={onDragHandle}
						title="Drag to move"
					>
						<VoiceIndicator
							theme={theme}
							state={visualState}
							deviceLabel={remoteDevice ?? (mic?.capturing ? mic.deviceLabel : null)}
						/>
						<div className="min-w-0 flex-1">
							{/* The scope is the prominent line, not the state: the state is
						    obvious from the indicator, and WHERE you are talking is not. */}
							<div
								data-testid="voice-hud-scope"
								className="text-xs font-bold truncate"
								style={{ color: scope.color }}
							>
								{scope.label}
								{scope.tabLabel && (
									<span className="font-normal opacity-80"> / {scope.tabLabel}</span>
								)}
							</div>
							<div className="text-2xs truncate" style={{ color: theme.colors.textDim }}>
								{stateLabel}
							</div>
						</div>
						{visualState === 'speaking' && speech && (
							<span
								data-testid="voice-hud-speech-progress"
								className="text-2xs px-1.5 py-0.5 rounded shrink-0"
								style={{ backgroundColor: theme.colors.accent, color: onAccent }}
							>
								{speechProgress}
							</span>
						)}
						<button
							type="button"
							data-testid="voice-hud-minimize"
							aria-label="Minimize the voice HUD (the session keeps running)"
							title="Minimize (the session keeps running)"
							onClick={handleMinimize}
							className="p-0.5 rounded shrink-0 hover:bg-white/10 focus:outline-none focus-visible:ring-2"
							style={{ color: theme.colors.textDim }}
						>
							<Minus className="w-3.5 h-3.5" />
						</button>
						<EscCloseButton
							theme={theme}
							onClose={handleClose}
							label="End voice session (Esc)"
							testId="voice-hud-close"
						/>
					</div>
				)}

				{/* Tab / Agent / Conductor: where the next sentence goes. Only while a
				    session is live, because a switch re-binds that session. */}
				{active && (
					<VoiceModeSwitch
						theme={theme}
						onChange={
							floatingWindow
								? (mode) => {
										relayCommand({ type: 'set-mode', mode });
									}
								: undefined
						}
					/>
				)}

				{/* Anything the user is running that they did not ask for. */}
				{substitutions.length > 0 && (
					<div
						data-testid="voice-hud-substitutions"
						className="px-3 py-1.5 text-2xs border-b"
						style={{ borderColor: theme.colors.border, color: warningText }}
					>
						{substitutions.map((sub) => (
							<div key={sub.role} className="truncate">
								{sub.message}
							</div>
						))}
					</div>
				)}

				{lostEvents && (
					<div
						data-testid="voice-hud-gap"
						className="px-3 py-1.5 text-2xs border-b"
						style={{ borderColor: theme.colors.border, color: warningText }}
					>
						Some voice events were lost; this transcript may be incomplete.
					</div>
				)}

				{micIssue && (
					<MicIssueNotice
						theme={theme}
						issue={micIssue}
						color={warningText}
						onOpenSettings={
							floatingWindow
								? () => {
										relayCommand({ type: 'open-mic-settings' });
									}
								: undefined
						}
					/>
				)}

				{showError && error && (
					<div
						data-testid="voice-hud-error"
						className="px-3 py-1.5 text-2xs border-b select-text"
						style={{ borderColor: theme.colors.border, color: errorText }}
					>
						{error.code === 'provider-unavailable' ? (
							<VoiceSetupRecovery
								theme={theme}
								fallback={error.message}
								onReady={async () => {
									if (!relayCommand({ type: 'open-mic', hold: false })) await openVoiceMic();
								}}
							/>
						) : (
							error.message
						)}
					</div>
				)}

				{/* The last thing heard, always visible. The full scrollback is behind
				    the transcript toggle; this one line is what stops the collapsed HUD
				    from being a widget with no content at all. */}
				{!transcriptVisible && (partial || spoken > 0) && (
					<div
						data-testid="voice-hud-latest"
						className="px-3 py-1.5 text-xs-plus leading-snug truncate select-text"
						style={{ color: partial ? theme.colors.textDim : theme.colors.textMain }}
					>
						{partial || speech?.sentences[speech.sentences.length - 1]}
					</div>
				)}

				{transcriptVisible && (
					<VoiceTranscript
						theme={theme}
						onNavigate={
							floatingWindow
								? (route) => {
										relayCommand({
											type: 'navigate',
											agentSessionId: route.agentSessionId,
											tabId: route.tabId,
											groupChatId: route.groupChatId,
										});
									}
								: undefined
						}
					/>
				)}

				{/* A finished sentence waiting on a send phrase. */}
				<VoiceHeldNotice
					theme={theme}
					onSend={
						floatingWindow
							? () => {
									relayCommand({ type: 'send' });
								}
							: undefined
					}
				/>

				{/* The one thing "Listening" cannot say for itself. The floor really is
				    open here - the state machine is not lying - but a text-in recogniser
				    opens no capture device, so nothing spoken can ever arrive. Said
				    plainly, and only when it is true. */}
				{active && sttHearsAudio === false && (
					<div
						data-testid="voice-hud-deaf"
						className="px-3 py-1.5 text-2xs border-b select-text"
						style={{ borderColor: theme.colors.border, color: warningText }}
					>
						This recogniser does not listen to the microphone - it takes typed input only, so
						speaking will not produce a transcript. Pick a speech-to-text provider in Settings &gt;
						Plugins &gt; A Cappella &gt; Voice Setup.
					</div>
				)}

				{/* The microphone in use, and the way to change it. In the HUD because
				    "nothing is being heard" is discovered HERE, mid-session, and sending
				    someone to Settings to find out which device is open is the gap that
				    made a silent session indistinguishable from a wrong input. Writes
				    the same persisted setting Voice Setup does, and stays usable while
				    listening: the swap lands on the next capture, never mid-utterance. */}
				<div className="px-3 pb-1.5">
					<VoiceInputPicker theme={theme} devices={inputDevices} compact />
					<div className="flex items-center justify-between gap-2 pt-2 text-xs">
						<span>Hold while busy</span>
						<ToggleSwitch
							theme={theme}
							checked={holdWhileBusy}
							ariaLabel="Hold while busy"
							onChange={(value) => {
								if (!relayCommand({ type: 'set-hold-while-busy', enabled: value }))
									void setHoldWhileBusy(value);
							}}
						/>
					</div>
				</div>

				{/* The send panel (wait slider and send phrase), opened from the chip in
				    the row below it. Hands-free only: in push-to-talk the release is
				    the send. */}
				{waitPickerOpen && sendWait && listenMode === 'hands-free' && (
					<VoiceWaitPicker
						theme={theme}
						sendWait={sendWait}
						onPick={handlePickWait}
						onSetPhrases={handleSetSendPhrases}
					/>
				)}

				{sendState.pending.length > 0 && (
					<div
						role="status"
						data-testid="voice-hud-pending-send"
						className="px-3 py-2 text-xs border-t select-text"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<div style={{ color: theme.colors.accent }}>Session is busy, send is pending.</div>
						<div style={{ color: theme.colors.textDim }}>Feel free to keep adding to it.</div>
						<div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap">
							{sendState.pending.map((item) => item.text).join('\n\n')}
						</div>
					</div>
				)}
				<div
					className="flex items-center justify-between gap-2 px-3 py-1.5 border-t text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<div>
						<div style={{ color: theme.colors.textMain }}>Force Send</div>
						<div className="text-2xs">
							{!forceSendAllowed
								? 'Enable forced parallel execution in Settings.'
								: sendState.forceSend
									? 'Send beside other tabs. A busy target waits.'
									: 'Wait until the session is free.'}
						</div>
					</div>
					<ToggleSwitch
						theme={theme}
						size="sm"
						ariaLabel="Force Send voice requests"
						checked={forceSendAllowed && sendState.forceSend}
						disabled={!active || !forceSendAllowed}
						onChange={(value) => {
							if (!relayCommand({ type: 'set-force-send', enabled: value }))
								void window.maestro.voice.setForceSend(value);
						}}
					/>
				</div>

				<VoiceHudControls
					theme={theme}
					state={visualState}
					micOpen={micOpen}
					listenMode={listenMode}
					sendWait={sendWait}
					waitPickerOpen={waitPickerOpen}
					transcriptVisible={transcriptVisible}
					muted={muted}
					onOpenMic={handleOpenMic}
					onCloseMic={handleCloseMic}
					onToggleListenMode={handleToggleListenMode}
					onToggleWaitPicker={() => setWaitPickerOpen((open) => !open)}
					onInterrupt={handleInterrupt}
					onToggleTranscript={() => {
						if (!relayCommand({ type: 'toggle-transcript' })) void toggleTranscript();
					}}
					onToggleMute={handleToggleMute}
				/>

				{devHarness && <VoiceDevHarness theme={theme} actions={actions} />}
			</div>
		</>
	);
	return floatingWindow ? (
		<FloatingWidgetFrame
			theme={theme}
			icon={
				<VoiceIndicator
					theme={theme}
					state={visualState}
					deviceLabel={remoteDevice ?? (mic?.capturing ? mic.deviceLabel : null)}
				/>
			}
			title={`${scope.label}${scope.tabLabel ? ` / ${scope.tabLabel}` : ''}`}
			subtitle={stateLabel}
			onClose={handleClose}
			closeLabel="End voice session (Esc)"
			actions={
				<>
					{visualState === 'speaking' && speech && (
						<span
							data-testid="voice-hud-speech-progress"
							className="text-2xs px-1.5 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.accent, color: onAccent }}
						>
							{speechProgress}
						</span>
					)}
					<button
						type="button"
						aria-label="Minimize the voice HUD (the session keeps running)"
						onClick={handleMinimize}
						style={{ color: theme.colors.textDim }}
					>
						<Minus className="w-3.5 h-3.5" />
					</button>
				</>
			}
		>
			{content}
		</FloatingWidgetFrame>
	) : (
		content
	);
}

/**
 * The microphone is not going to work, said calmly.
 *
 * Only `permission-denied` gets the button, because it is the only issue the OS
 * settings pane can fix: sending someone to a privacy checkbox to solve an
 * unplugged microphone wastes their time and their trust in the next button. On
 * a platform with no deep link (Linux) the sentence carries the instruction
 * instead, since a button that opens nothing is worse than no button at all.
 */
function MicIssueNotice({
	theme,
	issue,
	color,
	onOpenSettings,
}: {
	theme: Theme;
	issue: MicIssue;
	color: string;
	onOpenSettings?: () => void;
}) {
	const platform = getPlatform();
	const settingsUrl = issue === 'permission-denied' ? micSettingsUrl(platform) : null;

	const openSettings = useCallback(() => {
		if (onOpenSettings) onOpenSettings();
		else void window.maestro.voice.openMicSettings();
	}, [onOpenSettings]);

	return (
		<div
			data-testid="voice-hud-mic"
			className="flex items-center gap-2 px-3 py-1.5 text-2xs border-b"
			style={{ borderColor: theme.colors.border, color }}
		>
			<MicOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
			<span className="flex-1 select-text">
				{MIC_ISSUE_MESSAGES[issue]}
				{issue === 'permission-denied' && !settingsUrl
					? ' Allow it for Maestro in your system settings.'
					: ''}
			</span>
			{settingsUrl && (
				<button
					type="button"
					data-testid="voice-hud-mic-settings"
					onClick={openSettings}
					className="shrink-0 px-1.5 py-0.5 rounded border text-2xs hover:opacity-80 focus:outline-none focus-visible:ring-2"
					style={{ borderColor: theme.colors.border, color }}
				>
					{micSettingsLabel(platform)}
				</button>
			)}
		</div>
	);
}

export default VoiceHud;
