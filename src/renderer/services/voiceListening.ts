/**
 * voiceListening - open and shut the voice microphone without ending the session.
 *
 * The HUD's talk button has two personalities, picked with its hand button:
 *
 *   - **Hands-free**: a click opens the microphone and it stays open; another
 *     click shuts it. The session, the transcript and the binding all survive.
 *   - **Push-to-talk**: the microphone is open exactly while the button is held,
 *     and letting go sends what was said.
 *
 * Both are the same two calls with a modifier each (`voice.setListening`), and
 * both have the same wrinkle: there may be no session to gate. A session ends on
 * its own (the idle timeout, the stop word) while the HUD stays on screen, so
 * "open the microphone" has to mean "resume it, or start a session and then
 * open it". That decision lives here, once, rather than in each surface.
 *
 * **Every call goes through ONE queue.** A press and its release arrive as two
 * independent events, and the press may have to start a whole session first. Run
 * unordered, a quick tap's release reaches main before the session its press is
 * still starting, finds nothing to shut, and the microphone the press then opens
 * stays open with no button holding it. The queue is at module scope because the
 * callers are effects and event handlers that re-run: a rebuilt queue forgets
 * the press still in flight.
 */

import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { nextVoiceListenMode, type VoiceListenMode } from '../../shared/acappella/listen-mode';
import type { VoiceScope } from '../../shared/acappella/protocol';
import { isVoiceSessionActive } from '../../shared/acappella/session-state';
import { isSameVoiceScope } from '../../shared/acappella/voice-mode';
import { notifyToast } from '../stores/notificationStore';
import { beginVoiceSession, useVoiceSessionStore } from '../stores/voiceSessionStore';
import { useVoiceUiStore } from '../stores/voiceUiStore';

const queue = createKeyedWriteQueue();

/** One key: there is one microphone, so there is one order. */
const MIC_KEY = 'voice-mic';

/**
 * Say why a session did not start.
 *
 * A refusal here is expected and specific - the capability gate names a missing
 * model, or the microphone was denied - and it reaches the user as a toast
 * rather than as silence, because the control they pressed otherwise appears to
 * do nothing at all.
 */
export function notifyVoiceStartFailed(error: unknown): void {
	notifyToast({
		color: 'orange',
		title: 'Voice session could not start',
		message: error instanceof Error ? error.message : String(error),
	});
}

export interface OpenVoiceMicOptions {
	/**
	 * Push-to-talk press. The release, not a pause, ends the thought, so nothing
	 * is sent while the button is down.
	 */
	hold?: boolean;
	/**
	 * The binding this microphone belongs to, for a surface that talks to ONE
	 * thing (the Quick Chat window). Only a live session already on it is
	 * resumed; a session bound anywhere else is replaced by a new one on this
	 * scope, because opening this microphone must never send the next sentence
	 * to whatever the last session happened to be about. Omitted, the HUD's
	 * rule applies: resume what is live, else restart on the last scope.
	 */
	scope?: VoiceScope;
	/** Surface launch: honor the configured listening mode on a fresh session. */
	honorListenMode?: boolean;
	/**
	 * Told why a session did not start. Defaults to the toast, which a window
	 * with no toast surface replaces with its own.
	 */
	onError?: (error: unknown) => void;
}

/** Open the microphone: resume a live session, or start one. */
export function openVoiceMic(options: OpenVoiceMicOptions = {}): Promise<void> {
	const hold = options.hold === true;
	return queue.enqueue(MIC_KEY, async () => {
		try {
			// Read inside the queue, not at the press: a press queued behind a start
			// must see the session that start opened.
			const live = useVoiceSessionStore.getState();
			const resumable =
				!options.scope ||
				(isVoiceSessionActive(live.state) && isSameVoiceScope(live.scope, options.scope));
			if (options.honorListenMode && resumable && isVoiceSessionActive(live.state)) return;
			if (resumable && (await window.maestro.voice.setListening({ listening: true, hold }))) {
				return;
			}
			// Nothing live to resume. Restart in the mode the last session ended in,
			// so a user who switched to Tab mode is not quietly dropped back to the
			// Conductor by a session that timed out in between.
			const scope = options.scope ?? live.scope ?? undefined;
			await beginVoiceSession(scope, { open: !options.honorListenMode });
			// A fresh session opens its microphone itself; what it does not know is
			// that a button is holding it.
			if (hold) await window.maestro.voice.setListening({ listening: true, hold: true });
		} catch (error) {
			(options.onError ?? notifyVoiceStartFailed)(error);
		}
	});
}

/**
 * Shut the microphone and keep the session.
 *
 * @param options.send Push-to-talk release: what was said goes now. Without it
 *                     a half-said thought is dropped, which is what switching
 *                     the microphone off mid-sentence means.
 */
export function closeVoiceMic(
	options: {
		send?: boolean;
		/** Limit a panel's release or close to its own conversation. */
		scope?: VoiceScope;
		/** End the session after any pending microphone start has finished. */
		endSession?: boolean;
	} = {}
): Promise<void> {
	const send = options.send === true;
	return queue.enqueue(MIC_KEY, async () => {
		if (options.scope && !isSameVoiceScope(useVoiceSessionStore.getState().scope, options.scope)) {
			return;
		}
		if (options.endSession) {
			await window.maestro.voice.stop().catch(() => undefined);
			return;
		}
		// False (no session) is fine: a microphone with no session is already shut.
		await window.maestro.voice.setListening({ listening: false, send }).catch(() => undefined);
	});
}

/**
 * Switch between hands-free and push-to-talk, and make a live microphone agree.
 *
 * Remembering the mode is half of it. The other half is the device: switching
 * to push-to-talk with the microphone open would leave it open with no button
 * down, and switching back to hands-free would leave a live session deaf until
 * the next click. Neither starts a session - picking a mode is not asking to
 * talk.
 */
export async function setVoiceListenMode(mode: VoiceListenMode): Promise<void> {
	await useVoiceUiStore.getState().setListenMode(mode);
	if (!isVoiceSessionActive(useVoiceSessionStore.getState().state)) return;
	await queue.enqueue(MIC_KEY, async () => {
		await window.maestro.voice
			.setListening({ listening: mode === 'hands-free' })
			.catch(() => undefined);
	});
}

/** Flip to the other listen mode. What the HUD's hand button does. */
export function toggleVoiceListenMode(): Promise<void> {
	return setVoiceListenMode(nextVoiceListenMode(useVoiceUiStore.getState().listenMode));
}
