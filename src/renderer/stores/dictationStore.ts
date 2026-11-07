/**
 * dictationStore - what the one dictation in this window is doing.
 *
 * Dictation records speech into a text box with no voice session behind it (see
 * `src/renderer/services/dictation.ts`, which owns every transition; nothing
 * else writes this store). There is one microphone, so there is one recording,
 * and every surface that draws a dictation control reads the same record: the
 * button in the box being dictated into shows "recording", the others show
 * that the microphone is taken.
 *
 * `availability` is the `dictation` Local Models task's readiness as the main
 * process resolved it, mirrored here by `<DictationHost>` so a dozen buttons do
 * not each ask main the same question.
 */

import { create } from 'zustand';

import type { DictationTarget } from '../utils/dictationTargets';

/**
 *   - `idle`         - nothing is recording.
 *   - `starting`     - the microphone is being opened.
 *   - `recording`    - audio is being captured.
 *   - `transcribing` - the microphone is closed and the clip is being decoded.
 */
export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

/**
 * Whether dictation is offered at all.
 *
 *   - `hidden`      - the task is off (the default), or this client has no
 *                     microphone to record through. No control is drawn.
 *   - `unavailable` - a source is assigned but cannot run. The control is drawn
 *                     dimmed, with `reason` as its tooltip.
 *   - `ready`       - the assigned source should answer.
 */
export type DictationAvailability =
	| { state: 'hidden' }
	| { state: 'unavailable'; reason: string }
	| { state: 'ready'; source: string | null };

export interface DictationState {
	phase: DictationPhase;
	/** The text box the current dictation writes into. Null while idle. */
	target: DictationTarget | null;
	availability: DictationAvailability;
}

export const useDictationStore = create<DictationState>(() => ({
	phase: 'idle',
	target: null,
	availability: { state: 'hidden' },
}));

/** Tests only: back to a fresh window. */
export function resetDictationStore(): void {
	useDictationStore.setState({ phase: 'idle', target: null, availability: { state: 'hidden' } });
}
