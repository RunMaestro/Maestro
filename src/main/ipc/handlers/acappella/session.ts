/**
 * Voice session lifecycle, floor control, utterance/listening/send-wait
 * controls, and window-close / feature-disable teardown for A Cappella.
 */

import { logger } from '../../../utils/logger';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import type {
	InterruptSource,
	VoiceOrigin,
	VoiceScope,
	VoiceWindowId,
	WakeSource,
} from '../../../../shared/acappella/protocol';
import {
	ACAPPELLA_DISABLED_ERROR,
	requireACappellaEnabled,
} from '../../../../shared/acappella/feature-flag';
import {
	clampSendWaitOverrideMs,
	resolveSendWait,
	type VoiceSendWait,
} from '../../../../shared/acappella/listen-mode';
import { DEFAULT_SEND_PHRASES } from '../../../../shared/acappella/voice-controls';
import { parseVoiceControlScope } from '../../../../shared/acappella/voice-control';
import {
	isQuickChatScope,
	QUICK_CHAT_VOICE_SCOPE,
} from '../../../../shared/acappella/quick-chat-scope';
import {
	ensureAcappellaAudioHostWindow,
	getACappellaTransport,
	getVoiceSessionService,
	type VoiceSessionSnapshot,
} from '../../../acappella';
import { readVoiceProviderSettings } from '../../../acappella/providers/provider-registry';
import { requestMicPermission } from '../../../acappella/permissions/mic-permission';
import { QUICK_CHAT_VOICE_UNAVAILABLE } from '../../../acappella/dispatch/quick-chat-dispatch';
import { VoiceControlRefusal } from '../../../acappella/voice-control-service';
import type { FloorControlSession } from '../../../acappella/audio/floor-control';
import { lastTurn, type TurnBreakdown } from '../../../acappella/telemetry/turn-metrics';
import { disposeACappellaAudioBridge, ensureAudioBridge } from './audio-host';
import { clearActiveSubstitutions, ensureService as ensureProviderService } from './providers';
import {
	handlerOpts,
	isRecord,
	LOG_CONTEXT,
	type ACappellaHandlerDependencies,
	type VoiceStartSessionResult,
} from './shared';
import { captureEnableFence, sharedState } from './state';
import { stopWakeTest } from './wake';

/**
 * The send wait the HUD picked, or null to use the stored default.
 *
 * In memory on purpose. Settings holds the default; this is the "just for now"
 * on top of it, so a wait stretched for one long dictation does not quietly
 * become the wait every later conversation gets. The HUD clears it when it is
 * closed, and a restart clears it regardless.
 */
let sendWaitOverrideMs: number | null = null;
let pendingVoiceStart: { owner: VoiceWindowId } | null = null;

/** Cancel any in-flight voice session start before it opens the microphone. */
export function cancelPendingVoiceStart(): void {
	pendingVoiceStart = null;
}

function idleVoiceSessionSnapshot(): VoiceSessionSnapshot {
	return (
		getVoiceSessionService()?.getSnapshot() ?? {
			sessionId: null,
			state: 'idle',
			scope: null,
			origin: { kind: 'local' },
			windowId: null,
			seq: 0,
			listenPaused: false,
			startedAt: null,
			providerIds: { stt: '', tts: '', brain: '' },
			lastDecision: null,
			lastDispatch: null,
		}
	);
}

export function resetSessionState(): void {
	cancelPendingVoiceStart();
	sendWaitOverrideMs = null;
	sharedState.voiceDisableGeneration += 1;
}

/** The send wait in force, and where it came from. */
export function readSendWait(deps: ACappellaHandlerDependencies): VoiceSendWait {
	return resolveSendWait(
		readVoiceProviderSettings(deps.settingsStore),
		sendWaitOverrideMs,
		DEFAULT_SEND_PHRASES
	);
}

/** An unrecognised scope is conductor scope; a malformed BOUND scope is not. */
export function parseScope(raw: unknown): VoiceScope {
	if (!isRecord(raw)) return { kind: 'conductor' };
	if (raw.kind === 'group-chat') {
		const scope = parseVoiceControlScope(raw);
		if (!scope) throw new Error('InvalidVoiceScope');
		return scope;
	}
	// Quick Chat carries no ids, so there is nothing about it to be malformed.
	if (raw.kind === 'quick-chat') return { ...QUICK_CHAT_VOICE_SCOPE };
	if (raw.kind !== 'agent' && raw.kind !== 'document') return { kind: 'conductor' };
	// Falling back to the conductor here would send a spoken instruction to
	// whichever agent happens to be active, which is the one outcome worse than
	// an error.
	if (typeof raw.sessionId !== 'string' || !raw.sessionId) {
		throw new Error('InvalidVoiceScope');
	}
	if (raw.kind === 'agent') {
		// A tab pin is Tab mode; anything that is not a non-empty string is Agent
		// mode rather than an error, because the agent binding itself is valid.
		return typeof raw.tabId === 'string' && raw.tabId
			? { kind: 'agent', sessionId: raw.sessionId, tabId: raw.tabId }
			: { kind: 'agent', sessionId: raw.sessionId };
	}
	// Same rule for the path: a document scope with no document would open a
	// session that names a file in the HUD and hands the agent nothing.
	if (typeof raw.path !== 'string' || !raw.path) {
		throw new Error('InvalidVoiceScope');
	}
	return { kind: 'document', sessionId: raw.sessionId, path: raw.path };
}

/** An IPC caller is a client by definition, so a bare request is a button press. */
function parseInterruptSource(raw: unknown): InterruptSource {
	return raw === 'voice' ? 'voice' : 'client-button';
}

/**
 * End the session if it belonged to a window that just went away.
 *
 * A session is shown by exactly one window, so closing that window would
 * otherwise leave an open microphone with no surface anywhere - the same
 * "something is listening and nobody can see it" failure the HUD's close button
 * exists to prevent, arrived at by a different route. Closing the window that
 * holds the floor is a clear enough intent to end the session.
 *
 * `hidden` is the same failure for a window that is put away instead of closed:
 * Quick Chat hides on Escape and stays alive, so a session bound to it would
 * otherwise keep listening behind a window nobody can see.
 *
 * A session with no window (null) is deliberately left alone: it is not this
 * window's to end, and the primary window still shows it.
 */
export async function stopVoiceSessionForWindow(
	windowId: string,
	cause: 'closed' | 'hidden' = 'closed'
): Promise<void> {
	if (pendingVoiceStart?.owner === windowId) cancelPendingVoiceStart();
	const service = getVoiceSessionService();
	if (!service || service.getSnapshot().windowId !== windowId) return;
	logger.info(`Voice session ended: its window (${windowId}) was ${cause}`, LOG_CONTEXT);
	await service.stopSession('shutdown');
}

/**
 * Wind everything down because the Encore Feature was switched off.
 *
 * The switch has to mean what it says. Before this existed, turning A Cappella
 * off released the microphone and closed the audio host, and left three things
 * running that a user would reasonably believe were gone: a live voice session, a
 * loaded inference pipeline holding native runtimes and model files open, and the
 * transport with its Bonjour advert and its connected phones.
 *
 * The pipeline is the one with a second consequence. The reclaim-disk button
 * lives on the Models page precisely so it can be pressed after the feature is
 * off, and on Windows `fs.rm` of a directory whose files are still mapped by a
 * loaded runtime fails outright. Dropping the pipeline here is what makes
 * reclaiming disk work rather than error.
 *
 * What it deliberately does NOT do is dispose the hotkey installation or the
 * transport object. Both are constructed once per process at handler
 * registration, so tearing them down would make switching the feature back on a
 * no-op until the next restart. The hotkeys release their combos through their
 * own settings watcher; the transport stands down and stays reusable.
 */
export async function shutdownACappellaForDisable(): Promise<void> {
	cancelPendingVoiceStart();
	sharedState.voiceDisableGeneration += 1;
	void sharedState.handsFree?.sync();
	// The advert and the phones go first. A device that still holds the floor
	// would otherwise be able to reopen the microphone during the teardown below.
	getACappellaTransport()?.standDown();
	await sharedState.wakeEnrollment?.stopRecording();
	await stopWakeTest();
	// `shutdown` rather than `user`: nobody pressed stop, and the distinction is
	// what the session's own telemetry and the History entry read.
	await getVoiceSessionService()?.stopSession('shutdown');
	// Order matters, and matches the audio host teardown in main/index.ts: the
	// bridge stops capture through a window it is about to lose.
	disposeACappellaAudioBridge();
	await sharedState.activePipeline?.pipeline.dispose();
	sharedState.activePipeline = null;
	// Cleared together. `activeProviderKey` is the memo of what `activePipeline`
	// was built from, so leaving it set would make the next start believe a
	// disposed pipeline still matches settings and reuse it.
	sharedState.activeProviderKey = null;
	clearActiveSubstitutions();
	// A "just for now" wait does not outlive the feature being switched off.
	sendWaitOverrideMs = null;
}

export function createSessionHandlers(deps: ACappellaHandlerDependencies) {
	const ensureService = () => ensureProviderService(deps, { ensureAudioBridge, readSendWait });

	/**
	 * Put the Quick Chat window on screen and return its id, the owner of a
	 * session bound to Quick Chat. A session whose only surface cannot be shown
	 * is refused, never opened in some other window: the HUD's mode switch there
	 * would offer a re-binding this session does not allow.
	 */
	const claimQuickChatWindow = (): string => {
		const windowId = deps.getQuickChat?.()?.showForVoice() ?? null;
		if (!windowId) throw new VoiceControlRefusal(QUICK_CHAT_VOICE_UNAVAILABLE);
		return windowId;
	};
	/** The window that shows a session on `scope`: Quick Chat's own, or `fallback`. */
	const ownerWindowFor = (scope: VoiceScope, fallback: VoiceWindowId): VoiceWindowId =>
		isQuickChatScope(scope) ? claimQuickChatWindow() : fallback;

	const startSession = async (
		rawScope: unknown,
		windowId: VoiceWindowId,
		paused: boolean,
		source: WakeSource = 'client-button',
		origin?: VoiceOrigin
	): Promise<VoiceStartSessionResult> => {
		requireACappellaEnabled(deps.settingsStore);
		const stillEnabled = captureEnableFence(deps.settingsStore);
		const assertStillEnabled = (): void => {
			requireACappellaEnabled(deps.settingsStore);
			if (!stillEnabled()) throw new Error(ACAPPELLA_DISABLED_ERROR);
		};
		const scope = parseScope(rawScope);
		// A Quick Chat session is shown by the Quick Chat window and by no other,
		// whoever asked for it (the window's own microphone, or `maestro-cli voice
		// start --quick-chat` with no window behind it). Claimed before the
		// microphone is asked for, so a refusal costs the user no permission prompt.
		const owner = ownerWindowFor(scope, windowId);
		const attempt = { owner };
		pendingVoiceStart = attempt;
		const stillRequested = (): boolean => pendingVoiceStart === attempt && stillEnabled();
		const cancelledResult = (): VoiceStartSessionResult => ({
			snapshot: idleVoiceSessionSnapshot(),
			substitutions: [],
		});
		// The microphone is asked for HERE and nowhere earlier. Not at app
		// launch, not when the Encore Feature is switched on: a first run that
		// prompts for the microphone for a feature nobody turned on spends trust
		// the app has not earned. This is the first moment the user has asked for
		// something that genuinely needs a device.
		//
		// The result is not branched on. A refusal belongs to the capability
		// gate, which names the microphone as its own blocking slot with its own
		// recovery; throwing a second, differently-worded error from here would
		// give the same problem two voices.
		try {
			await requestMicPermission();
			assertStillEnabled();
			if (pendingVoiceStart !== attempt) return cancelledResult();
			const { service, substitutions } = await ensureService();
			assertStillEnabled();
			if (pendingVoiceStart !== attempt) return cancelledResult();
			// First start is what pays for the audio host: enabling the Encore
			// Feature opens no device and builds no second renderer.
			if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			const snapshot = await service.startSession({
				scope,
				source,
				origin,
				windowId: owner,
				paused,
				stillRequested,
			});
			assertStillEnabled();
			if (pendingVoiceStart !== attempt) return cancelledResult();
			return { snapshot, substitutions };
		} finally {
			if (pendingVoiceStart === attempt) pendingVoiceStart = null;
		}
	};
	const wrappedStart = withIpcErrorLogging(handlerOpts('startSession'), startSession);

	const wrappedStop = withIpcErrorLogging(handlerOpts('stopSession'), async (): Promise<void> => {
		cancelPendingVoiceStart();
		await getVoiceSessionService()?.stopSession('user');
	});

	const wrappedSubmitUtterance = withIpcErrorLogging(
		handlerOpts('submitUtterance'),
		// Returns false when the session cannot take an utterance right now, so a
		// stray Send in the dev harness is a no-op rather than a thrown error.
		async (text: unknown): Promise<boolean> => {
			if (typeof text !== 'string') throw new Error('InvalidUtterance');
			return getVoiceSessionService()?.submitUtterance(text) ?? false;
		}
	);

	const wrappedInterrupt = withIpcErrorLogging(
		handlerOpts('interrupt'),
		// Barge-in: cancels speech and KEEPS the floor. Distinct from the stop word
		// on purpose - talking over the assistant must not hang up on it.
		async (source: unknown): Promise<boolean> =>
			getVoiceSessionService()?.interrupt(parseInterruptSource(source)) ?? false
	);

	const wrappedStopWord = withIpcErrorLogging(
		handlerOpts('stopWord'),
		async (payload: unknown): Promise<void> => {
			const body = isRecord(payload) ? payload : {};
			const phrase = typeof body.phrase === 'string' ? body.phrase : undefined;
			await getVoiceSessionService()?.hardStop(parseInterruptSource(body.source), phrase);
		}
	);

	const wrappedSubmitAgentReply = withIpcErrorLogging(
		handlerOpts('submitAgentReply'),
		// The reply seam. Phase 05 wires real agent output straight into the
		// service in-process; until then this is how anything outside main gets a
		// session past `dispatching`, which is what makes the dev harness able to
		// demonstrate speech, barge-in, and the difference between the two.
		async (payload: unknown): Promise<boolean> => {
			if (!isRecord(payload)) throw new Error('InvalidAgentReply');
			const { agentSessionId, tabId, text } = payload;
			if (
				typeof agentSessionId !== 'string' ||
				!agentSessionId ||
				typeof tabId !== 'string' ||
				!tabId ||
				typeof text !== 'string'
			) {
				throw new Error('InvalidAgentReply');
			}
			return (
				(await getVoiceSessionService()?.submitAgentReply({ agentSessionId, tabId, text })) ?? false
			);
		}
	);

	const wrappedLastTurn = withIpcErrorLogging(
		handlerOpts('lastTurn'),
		async (): Promise<TurnBreakdown | null> => lastTurn()
	);

	const wrappedGetState = withIpcErrorLogging(
		handlerOpts('getState'),
		// Null means the service has never been built, so no provider is resolved
		// yet. Synthesising an idle snapshot here would have to name provider ids
		// that nothing has resolved, and reporting a requested-but-unavailable
		// provider as running is the substitution lie in a different costume.
		async (): Promise<VoiceSessionSnapshot | null> =>
			getVoiceSessionService()?.getSnapshot() ?? null
	);

	// Tab / Agent / Conductor, switched mid-session from the HUD. Returns false
	// when there is no live session to re-bind.
	const setScope = (rawScope: unknown): boolean =>
		getVoiceSessionService()?.setScope(parseScope(rawScope)) ?? false;

	// "Send now": end the held utterance and dispatch it. The same two-part
	// gesture as releasing the push-to-talk key: flush the recogniser so the tail
	// of the sentence is decoded, and settle the composer on it.
	const sendNow = (): void => {
		sharedState.audioBridge?.endUtterance();
		getVoiceSessionService()?.endUtteranceNow();
	};

	// Open or shut the microphone without ending the session: the HUD's hands-free
	// toggle, and both ends of its push-to-talk hold. Returns false when there is
	// no live session to gate, which is how the HUD knows to start one instead.
	const setListening = (payload: unknown): boolean => {
		const { listening, hold, send } = (payload ?? {}) as Record<string, unknown>;
		if (typeof listening !== 'boolean') throw new Error('InvalidListening');
		const service = getVoiceSessionService();
		if (!service) return false;
		// The release half of push-to-talk is the same two-part gesture as
		// `end-utterance`: flush the recogniser so the tail of the sentence is
		// decoded, then settle the composer on it. Flushed BEFORE the gate shuts,
		// while the audio it needs is still the audio the recogniser holds.
		if (!listening && send === true) sharedState.audioBridge?.endUtterance();
		return service.setListening(listening, { hold: hold === true, send: send === true });
	};

	// The HUD's quick wait picker. Null (or anything malformed) returns to the
	// stored default. Applies from the next fragment: the composer reads it live.
	const setSendWait = (waitMs: unknown): VoiceSendWait => {
		sendWaitOverrideMs = clampSendWaitOverrideMs(waitMs);
		return readSendWait(deps);
	};

	// The floor's view of the session. Narrow by construction: the hotkeys can
	// open, close, and interrupt, and nothing else.
	const floorSession: FloorControlSession = {
		getState: () => getVoiceSessionService()?.getState() ?? 'idle',
		startSession: async ({ scope, source, origin }) =>
			// No IPC sender to resolve: a global hotkey, a wake word, and a paired
			// phone all arrive with no window behind them, so the HUD belongs to
			// the window the user is looking at.
			(await startSession(scope, deps.resolveVoiceWindowId?.() ?? null, false, source, origin))
				.snapshot,
		stopSession: async (reason) => {
			cancelPendingVoiceStart();
			await getVoiceSessionService()?.stopSession(reason);
		},
		interrupt: (source) => getVoiceSessionService()?.interrupt(source) ?? false,
	};

	return {
		ensureService,
		startSession,
		setScope,
		sendNow,
		setListening,
		setSendWait,
		floorSession,
		wrappedStart,
		wrappedStop,
		wrappedSubmitUtterance,
		wrappedInterrupt,
		wrappedStopWord,
		wrappedSubmitAgentReply,
		wrappedLastTurn,
		wrappedGetState,
	};
}
