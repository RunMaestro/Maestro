/**
 * Dictation - speech into whichever text box the user is in.
 *
 * One clip of speech is recorded by the main process and transcribed by the
 * `dictation` Local Models assignment (`window.maestro.localModels.dictation`);
 * this module is everything the renderer does around that: it sequences
 * start / stop / cancel, remembers WHICH text box the words belong to, and puts
 * the transcript there. No voice session is started and nothing is routed or
 * spoken back.
 *
 * Two ways in, one path:
 *
 *   - `<DictationButton>` beside a text box hands over that box's target.
 *   - the `dictate` shortcut resolves the target from the focused element
 *     ({@link focusedDictationTarget}).
 *
 * Both classify a press with `useDictationPress` (tap toggles, hold records
 * while held) and both end in {@link startDictation} / {@link stopDictation},
 * so a button and a key cannot disagree about what a dictation is.
 *
 * Rules this module holds:
 *
 *   - **One dictation at a time.** There is one microphone. A start while one
 *     is in flight is ignored; the main process refuses it as well.
 *   - **The target is fixed at start.** The transcript goes to the text box the
 *     dictation was started in, even if focus moved while the clip decoded.
 *   - **Words are never dropped silently.** A transcript whose text box is gone
 *     is shown in a toast rather than discarded.
 *   - **Every refusal says why.** The main process answers with a `code` and a
 *     sentence written for a person; that sentence is what the user reads.
 *
 * Module functions rather than a hook: the shortcut handler and the press
 * classifier both run outside any one component.
 */

import type {
	DictationInterruption,
	DictationResult,
	DictationStartResult,
} from '../../shared/local-models/dictation';
import { micSettingsLabel, micSettingsUrl } from '../../shared/acappella/mic-settings';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useDictationStore } from '../stores/dictationStore';
import { notifyToast } from '../stores/notificationStore';
import { dictationTargetForElement, type DictationTarget } from '../utils/dictationTargets';
import { getPlatform } from '../utils/platformUtils';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';

/** Raised by the keyboard handler when the `dictate` chord goes down. */
export const DICTATION_SHORTCUT_PRESS_EVENT = 'maestro:dictationShortcutPress';

const TOAST_TITLE = 'Dictation';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const registeredTargets = new Set<DictationTarget>();

/**
 * Register a text box that needs its own write path (a store-backed composer, a
 * CodeMirror editor). The shortcut then dictates into it through that path, and
 * the surface's own button lights up for a dictation the shortcut started.
 *
 * @returns Unregister.
 */
export function registerDictationTarget(target: DictationTarget): () => void {
	registeredTargets.add(target);
	return () => {
		registeredTargets.delete(target);
	};
}

/**
 * The target for `element`: a registered surface that contains it, otherwise
 * the generic one for a plain text box. Null when `element` is not something a
 * transcript can be typed into.
 */
export function resolveDictationTarget(element: Element | null): DictationTarget | null {
	if (!element) return null;
	for (const target of registeredTargets) {
		const owner = target.getElement();
		if (owner && (owner === element || owner.contains(element))) return target;
	}
	return dictationTargetForElement(element);
}

/** The target for whatever holds the caret right now. */
export function focusedDictationTarget(): DictationTarget | null {
	return resolveDictationTarget(document.activeElement);
}

/**
 * Tell the shortcut's press classifier the chord went down. One app-level
 * event, the same shape as `requestHeadingPalette`: the classifier lives in
 * `<DictationHost>`, several levels away from the keyboard handler.
 */
export function requestDictationShortcutPress(): void {
	window.dispatchEvent(new CustomEvent(DICTATION_SHORTCUT_PRESS_EVENT));
}

// ---------------------------------------------------------------------------
// Readiness refresh
// ---------------------------------------------------------------------------

let refreshAvailability: (() => void) | null = null;

/**
 * `<DictationHost>` supplies the readiness re-read. Called after a start the
 * main process refused for the task's sake, and after one it accepted while the
 * mirror said unavailable: either way the mirror is stale.
 *
 * @returns Unregister.
 */
export function setDictationAvailabilityRefresher(refresh: () => void): () => void {
	refreshAvailability = refresh;
	return () => {
		if (refreshAvailability === refresh) refreshAvailability = null;
	};
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Bumped by every transition a pending await must not survive: a stop or a
 * cancel while the microphone is opening, a cancel while a clip decodes.
 */
let generation = 0;
let interruptionListenerInstalled = false;

function reset(): void {
	useDictationStore.setState({ phase: 'idle', target: null });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A recording that ends on its own (the device was lost, the length cap) is
 * stopped like any other, so what was captured is still transcribed. The stop
 * result carries the reason.
 */
function ensureInterruptionListener(): void {
	if (interruptionListenerInstalled) return;
	interruptionListenerInstalled = true;
	window.maestro.localModels.dictation.onInterrupted(() => {
		if (useDictationStore.getState().phase === 'recording') void stopDictation();
	});
}

/** Start dictating into `target`. Ignored while a dictation is in flight. */
export async function startDictation(target: DictationTarget): Promise<void> {
	const store = useDictationStore.getState();
	if (store.phase !== 'idle') return;

	ensureInterruptionListener();
	const mine = ++generation;
	const mirroredUnavailable = store.availability.state !== 'ready';
	useDictationStore.setState({ phase: 'starting', target });

	let result: DictationStartResult;
	try {
		result = await window.maestro.localModels.dictation.start();
	} catch (error) {
		if (generation !== mine) return;
		reset();
		notifyToast({ color: 'red', title: TOAST_TITLE, message: errorMessage(error) });
		return;
	}
	// Stopped or cancelled while the microphone was opening. Main was already
	// told; its answer to this start is the cancellation itself.
	if (generation !== mine) return;

	if (!result.started) {
		reset();
		reportRefusal(result);
		return;
	}
	if (mirroredUnavailable) refreshAvailability?.();
	useDictationStore.setState({ phase: 'recording' });
}

/**
 * Stop the dictation and put its transcript in the text box it was started in.
 * A stop that arrives before the microphone opened cancels the start: nothing
 * was recorded.
 */
export async function stopDictation(): Promise<void> {
	const { phase, target } = useDictationStore.getState();
	if (phase === 'starting') {
		await cancelDictation();
		return;
	}
	if (phase !== 'recording') return;

	const mine = ++generation;
	useDictationStore.setState({ phase: 'transcribing' });

	let result: DictationResult;
	try {
		result = await window.maestro.localModels.dictation.stop();
	} catch (error) {
		if (generation !== mine) return;
		reset();
		notifyToast({ color: 'red', title: TOAST_TITLE, message: errorMessage(error) });
		return;
	}
	if (generation !== mine) return;

	reset();
	deliver(result, target);
}

/** Discard the dictation: a recording, a start still opening, a clip decoding. */
export async function cancelDictation(): Promise<void> {
	if (useDictationStore.getState().phase === 'idle') return;
	generation += 1;
	reset();
	await window.maestro.localModels.dictation.cancel();
}

/** The tap: start into `target` when idle, stop when recording. */
export function toggleDictation(target: DictationTarget | null): void {
	const { phase } = useDictationStore.getState();
	if (phase === 'recording') {
		void stopDictation();
		return;
	}
	if (phase !== 'idle') return;
	if (!target) {
		notifyCenterFlash({
			message: 'Nowhere to dictate',
			detail: 'Click into a text box first.',
			color: 'yellow',
		});
		return;
	}
	void startDictation(target);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function reportInterruption(interruption: DictationInterruption): void {
	notifyToast({
		color: 'yellow',
		title: 'Dictation stopped early',
		message: interruption.message,
	});
}

function deliver(result: DictationResult, target: DictationTarget | null): void {
	switch (result.status) {
		case 'ok': {
			const text = result.text.trim();
			if (text === '') {
				if (result.interruption) reportInterruption(result.interruption);
				else notifyCenterFlash({ message: 'No speech heard', color: 'yellow' });
				return;
			}
			if (!target || !target.insert(text)) {
				// The text box closed while the clip decoded. The words are the
				// user's; show them rather than drop them.
				notifyToast({
					color: 'yellow',
					title: 'Dictation: the text box is gone',
					message: text,
					dismissible: true,
				});
			}
			if (result.interruption) reportInterruption(result.interruption);
			return;
		}
		case 'off':
			refreshAvailability?.();
			notifyToast({
				color: 'yellow',
				title: TOAST_TITLE,
				message: `Dictation was switched off while recording. Assign it a model in ${taskAssignmentLocation('dictation')}.`,
			});
			return;
		case 'unavailable':
			refreshAvailability?.();
			notifyToast({ color: 'red', title: TOAST_TITLE, message: result.reason });
			return;
		case 'cancelled':
		case 'idle':
			return;
	}
}

function reportRefusal(result: Extract<DictationStartResult, { started: false }>): void {
	switch (result.code) {
		case 'cancelled':
			return;
		case 'task-off':
		case 'task-unavailable':
			refreshAvailability?.();
			notifyToast({ color: 'yellow', title: TOAST_TITLE, message: result.message });
			return;
		case 'busy':
		case 'voice-session-active':
			notifyToast({ color: 'yellow', title: TOAST_TITLE, message: result.message });
			return;
		case 'permission-denied': {
			// The one refusal the OS settings pane can fix, so it is the one that
			// offers to open it: the same channel the voice HUD's notice uses.
			const platform = getPlatform();
			const canOpenSettings = micSettingsUrl(platform) !== null;
			notifyToast({
				color: 'red',
				title: 'Microphone access denied',
				message: canOpenSettings
					? `${result.message} Click to ${micSettingsLabel(platform).toLowerCase()}.`
					: result.message,
				dismissible: true,
				...(canOpenSettings ? { onClick: () => void window.maestro.voice.openMicSettings() } : {}),
			});
			return;
		}
		default:
			notifyToast({ color: 'red', title: TOAST_TITLE, message: result.message });
	}
}

/** Tests only: forget every registration and pending transition. */
export function __resetDictationService(): void {
	registeredTargets.clear();
	refreshAvailability = null;
	generation = 0;
	interruptionListenerInstalled = false;
}
