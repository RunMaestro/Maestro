/**
 * voiceDiagnosticsStore - a rolling record of what the voice pipeline actually
 * did, for when it did nothing visible.
 *
 * This exists because the failure mode A Cappella keeps producing is silence:
 * the HUD says "Listening", no words appear, and every layer looks fine from the
 * outside. Answering "where did it stop" needs the event stream, and the event
 * stream is gone the moment it is rendered.
 *
 * Two decisions worth keeping:
 *
 *   - **It records continuously, not while a panel is open.** You discover the
 *     problem by speaking, and you cannot speak and read a settings panel at the
 *     same time. A recorder that had to be armed first would only ever capture
 *     the second attempt.
 *   - **`audio-level` is counted, never stored.** It fires about twenty times a
 *     second; keeping each one would evict everything that explains anything
 *     within ten seconds. The count and the peak are what matter anyway - they
 *     answer "is the microphone producing signal at all", which is the first
 *     question - so they are folded into a running tally instead.
 */

import { create } from 'zustand';
import type { VoiceEvent } from '../../shared/acappella/protocol';

/** Enough to cover several turns, small enough to never be a memory question. */
export const VOICE_DIAGNOSTIC_LIMIT = 200;

export interface VoiceDiagnosticEntry {
	/** Monotonic within a boot, so entries are stable to key and to order. */
	id: number;
	ts: number;
	type: VoiceEvent['type'];
	/** One line about what this event carried. Never the whole payload. */
	detail: string;
}

interface VoiceDiagnosticsState {
	entries: VoiceDiagnosticEntry[];
	/** Audio frames seen since the last clear. Zero here means a dead microphone. */
	audioLevelCount: number;
	/** Loudest level seen, 0 to 1. Near zero with a high count means a muted device. */
	audioLevelPeak: number;
	/** Frames the detector considered speech. Zero with signal means a VAD problem. */
	speechFrames: number;
	record: (event: VoiceEvent) => void;
	clear: () => void;
}

/**
 * One line describing an event.
 *
 * Deliberately per-type rather than `JSON.stringify`: a dumped payload is
 * unreadable at a glance and carries transcript text into places it does not
 * need to go. What each line contains is the field that would explain a failure.
 */
function describe(event: VoiceEvent): string {
	switch (event.type) {
		case 'wake':
			return `source=${event.source} scope=${event.scope.kind}`;
		case 'listen-start':
			return `stt=${event.sttProviderId}`;
		case 'listen-stop':
			return `reason=${event.reason}`;
		case 'partial-transcript':
			return `"${event.text}"`;
		case 'final-transcript':
			return `"${event.text}" confidence=${event.confidence}`;
		case 'route-decision':
			return `target=${event.decision.target} brain=${event.brainProviderId} ${event.latencyMs}ms`;
		case 'dispatch':
			return `${event.agentName} action=${event.action} promptSent=${event.promptSent}`;
		case 'speak-start':
			return `tts=${event.ttsProviderId} sentences=${event.sentenceCount}`;
		case 'speak-end':
			return `reason=${event.reason}`;
		case 'session-error':
			return `${event.code}: ${event.message}`;
		case 'mic-state':
			return `capturing=${event.capturing} issue=${event.issue ?? 'none'}`;
		case 'provider-state':
			return event.slots.map((slot) => `${slot.role}=${slot.providerId}`).join(' ');
		default:
			return '';
	}
}

export const useVoiceDiagnosticsStore = create<VoiceDiagnosticsState>((set) => ({
	entries: [],
	audioLevelCount: 0,
	audioLevelPeak: 0,
	speechFrames: 0,

	record: (event) =>
		set((prev) => {
			// Tallied rather than stored: twenty a second would evict every event
			// that actually explains something.
			if (event.type === 'audio-level') {
				return {
					audioLevelCount: prev.audioLevelCount + 1,
					audioLevelPeak: Math.max(prev.audioLevelPeak, event.level),
					speechFrames: prev.speechFrames + (event.speech ? 1 : 0),
				};
			}

			const entry: VoiceDiagnosticEntry = {
				id: prev.entries.length ? prev.entries[prev.entries.length - 1].id + 1 : 1,
				ts: event.ts,
				type: event.type,
				detail: describe(event),
			};
			const entries = [...prev.entries, entry];
			return {
				entries:
					entries.length > VOICE_DIAGNOSTIC_LIMIT
						? entries.slice(entries.length - VOICE_DIAGNOSTIC_LIMIT)
						: entries,
			};
		}),

	clear: () => set({ entries: [], audioLevelCount: 0, audioLevelPeak: 0, speechFrames: 0 }),
}));
