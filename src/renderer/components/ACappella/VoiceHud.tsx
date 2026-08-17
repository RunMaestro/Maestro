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
 * The widget is draggable and remembers where it was put, through
 * `usePointerDrag` (the same gesture the Concerto surfaces use) and the `ui`
 * section of the A Cappella settings blob.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Minus, MicOff } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
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
import type { MicIssue } from '../../../shared/acappella/protocol';
import { micSettingsLabel, micSettingsUrl } from '../../../shared/acappella/mic-settings';
import { getPlatform } from '../../utils/platformUtils';
import { selectVoiceRemoteDevice, useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import { EscCloseButton } from '../ui/EscCloseButton';
import { VoiceDevHarness } from './VoiceDevHarness';
import { VoiceHudControls } from './VoiceHudControls';
import { VoiceIndicator } from './VoiceIndicator';
import { VoiceTranscript } from './VoiceTranscript';
import { useVoiceScope } from './useVoiceScope';
import { useOwnsVoiceSession } from './useOwnsVoiceSession';
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

export function VoiceHud({ theme, enabled, showDevHarness }: VoiceHudProps) {
	const actions = useVoiceSession(enabled);

	const state = useVoiceSessionStore((s) => s.state);
	const partial = useVoiceSessionStore((s) => s.partialTranscript);
	const speech = useVoiceSessionStore((s) => s.speech);
	const mic = useVoiceSessionStore((s) => s.mic);
	const error = useVoiceSessionStore((s) => s.error);
	const substitutions = useVoiceSessionStore((s) => s.substitutions);
	const lostEvents = useVoiceSessionStore((s) => s.lostEvents);
	const dismissed = useVoiceSessionStore((s) => s.dismissed);
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
	const holdThresholdMs = useVoiceUiStore((s) => s.holdThresholdMs);

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
	const active = isVoiceSessionActive(state);
	const visualState = voiceHudVisualState(state);

	// Live geometry. Seeded from the remembered position, or parked bottom-right.
	const [position, setPosition] = useState<VoiceHudPosition | null>(null);
	const positionRef = useRef<VoiceHudPosition | null>(null);
	positionRef.current = position;

	useEffect(() => {
		if (!enabled) return;
		void loadPrefs();
	}, [enabled, loadPrefs]);

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
		setPosition(
			storedPosition
				? clampVoiceHudPosition(storedPosition, measuredSize(), viewport())
				: defaultVoiceHudPosition(measuredSize(), viewport())
		);
	}, [measuredSize, storedPosition]);

	// A window resize can leave the widget partly or wholly off screen.
	useEventListener('resize', () =>
		setPosition((prev) => (prev ? clampVoiceHudPosition(prev, measuredSize(), viewport()) : prev))
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
	// service, so closing the harness (idle, HUD open) works too.
	const handleClose = useCallback(() => {
		void actions.stop();
		setMinimized(false);
		setDismissed(true);
	}, [actions, setDismissed, setMinimized]);

	// The other button. It does NOT touch the session.
	const handleMinimize = useCallback(() => setMinimized(true), [setMinimized]);

	const handleStart = useCallback(() => {
		void actions.start();
	}, [actions]);

	const handleStop = useCallback(() => {
		void actions.stop();
	}, [actions]);

	const handleInterrupt = useCallback(() => {
		void actions.interrupt();
	}, [actions]);

	/**
	 * Mute applies to the live output and is deliberately not persisted: a mute
	 * that survived a restart is a voice assistant that has silently stopped
	 * talking to you, with a button you have long forgotten pressing.
	 */
	const handleToggleMute = useCallback(() => {
		const next = !muted;
		setMuted(next);
		void window.maestro.voice.setVolume(next ? 0 : DEFAULT_TTS_VOLUME).catch(() => undefined);
	}, [muted, setMuted]);

	// Auto-idle: collapse when a turn finishes, expand the moment there is
	// something to show again. Never closes - see the header comment.
	useEffect(() => {
		if (minimizeBehavior !== 'auto-idle') return;
		if (visualState === 'idle-armed') setMinimized(true);
		else setMinimized(false);
	}, [minimizeBehavior, setMinimized, visualState]);

	// A new session un-hides the widget. Otherwise a hotkey or a wake word would
	// open a microphone behind a HUD the user dismissed an hour ago.
	useEffect(() => {
		if (active) setDismissed(false);
	}, [active, setDismissed]);

	const micIssue = mic?.issue ?? null;

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
	const visible =
		enabled && !dismissed && (devHarness || (ownsSession && (active || !!error || !!micIssue)));

	// Non-blocking: the HUD floats over the workspace while the user keeps typing,
	// so it takes neither focus nor the lower layers' clicks, and it never traps
	// focus. It still registers, so Escape reaches it before the surfaces beneath.
	useModalLayer(MODAL_PRIORITIES.VOICE_HUD, 'Voice HUD', handleClose, {
		enabled: visible,
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
	});

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

	if (!visible) return null;

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
			{`${stateLabel}. ${VOICE_HUD_STATE_DESCRIPTIONS[visualState]} Bound to ${scope.label}${
				scope.tabLabel ? `, tab ${scope.tabLabel}` : ''
			}.`}
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

	return (
		<>
			{liveRegion}
			<div
				ref={setRootRef}
				data-testid="voice-hud"
				className="fixed z-[90000] rounded-lg border shadow-xl select-none overflow-hidden"
				style={{
					top: placement.top,
					left: placement.left,
					width: HUD_WIDTH,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: active ? theme.colors.accent : theme.colors.border,
					color: theme.colors.textMain,
					// Hidden until the first placement lands, so the widget does not flash
					// in the top-left corner on the frame before its position is known.
					visibility: position ? undefined : 'hidden',
				}}
			>
				{/* Header: what it is bound to, what it is doing, and the two ways out.
				    It doubles as the drag handle. */}
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
						<div className="text-[10px] truncate" style={{ color: theme.colors.textDim }}>
							{stateLabel}
						</div>
					</div>
					{visualState === 'speaking' && speech && (
						<span
							data-testid="voice-hud-speech-progress"
							className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
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

				{/* Anything the user is running that they did not ask for. */}
				{substitutions.length > 0 && (
					<div
						data-testid="voice-hud-substitutions"
						className="px-3 py-1.5 text-[10px] border-b"
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
						className="px-3 py-1.5 text-[10px] border-b"
						style={{ borderColor: theme.colors.border, color: warningText }}
					>
						Some voice events were lost; this transcript may be incomplete.
					</div>
				)}

				{micIssue && <MicIssueNotice theme={theme} issue={micIssue} color={warningText} />}

				{showError && error && (
					<div
						data-testid="voice-hud-error"
						className="px-3 py-1.5 text-[10px] border-b select-text"
						style={{ borderColor: theme.colors.border, color: errorText }}
					>
						{error.message}
					</div>
				)}

				{/* The last thing heard, always visible. The full scrollback is behind
				    the transcript toggle; this one line is what stops the collapsed HUD
				    from being a widget with no content at all. */}
				{!transcriptVisible && (partial || spoken > 0) && (
					<div
						data-testid="voice-hud-latest"
						className="px-3 py-1.5 text-[11px] leading-snug truncate select-text"
						style={{ color: partial ? theme.colors.textDim : theme.colors.textMain }}
					>
						{partial || speech?.sentences[speech.sentences.length - 1]}
					</div>
				)}

				{transcriptVisible && <VoiceTranscript theme={theme} />}

				<VoiceHudControls
					theme={theme}
					state={visualState}
					active={active}
					transcriptVisible={transcriptVisible}
					muted={muted}
					holdThresholdMs={holdThresholdMs}
					onStart={handleStart}
					onStop={handleStop}
					onInterrupt={handleInterrupt}
					onToggleTranscript={() => void toggleTranscript()}
					onToggleMute={handleToggleMute}
				/>

				{devHarness && <VoiceDevHarness theme={theme} actions={actions} />}
			</div>
		</>
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
function MicIssueNotice({ theme, issue, color }: { theme: Theme; issue: MicIssue; color: string }) {
	const platform = getPlatform();
	const settingsUrl = issue === 'permission-denied' ? micSettingsUrl(platform) : null;

	const openSettings = useCallback(() => {
		void window.maestro.voice.openMicSettings();
	}, []);

	return (
		<div
			data-testid="voice-hud-mic"
			className="flex items-center gap-2 px-3 py-1.5 text-[10px] border-b"
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
					className="shrink-0 px-1.5 py-0.5 rounded border text-[10px] hover:opacity-80 focus:outline-none focus-visible:ring-2"
					style={{ borderColor: theme.colors.border, color }}
				>
					{micSettingsLabel(platform)}
				</button>
			)}
		</div>
	);
}

export default VoiceHud;
