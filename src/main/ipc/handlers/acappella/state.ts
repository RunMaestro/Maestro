/**
 * Shared mutable state across A Cappella IPC handler modules.
 *
 * Only fields read or written by two or more domain modules live here.
 * Single-domain state lives in the module that owns it.
 */

import type { VoiceAudioBridge } from '../../../acappella';
import type { VoiceProviderResolution } from '../../../acappella/providers/provider-registry';
import type { HandsFreeListener } from '../../../acappella/wake/hands-free';
import type { WakeDetector } from '../../../acappella/wake/wake-detector';
import type { WakeEnrollmentService } from '../../../acappella/wake/wake-enrollment-service';
import type { ClipCapture } from '../../../../shared/local-models/clip-capture';
import type { WakeTestEvent } from './shared';

export interface SharedACappellaState {
	/** Memoized provider key for `activePipeline` (providers + session disable). */
	activeProviderKey: string | null;
	/** Live resolved provider pipeline (providers + session disable). */
	activePipeline: VoiceProviderResolution | null;
	/** Audio host bridge (audio-host + providers + session + wake). */
	audioBridge: VoiceAudioBridge | null;
	/** Active wake-word tuning detector (wake + audio-host). */
	wakeTestDetector: WakeDetector | null;
	/** Wake phrase enrollment service (wake + audio-host). */
	wakeEnrollment: WakeEnrollmentService | null;
	/** Listeners on wake-test hits (wake + voice-control). */
	wakeTestTaps: Set<(event: WakeTestEvent) => void>;
	/** Always-on wake listener (wake + audio-host + providers). */
	handsFree: HandsFreeListener | null;
	/** Dictation microphone capture (audio-host + wake). */
	clipCapture: ClipCapture | null;
}

export const sharedState: SharedACappellaState = {
	activeProviderKey: null,
	activePipeline: null,
	audioBridge: null,
	wakeTestDetector: null,
	wakeEnrollment: null,
	wakeTestTaps: new Set(),
	handsFree: null,
	clipCapture: null,
};

export function clearActiveProviderKey(): void {
	sharedState.activeProviderKey = null;
}

export function disposeHandsFree(): void {
	void sharedState.handsFree?.dispose();
	sharedState.handsFree = null;
}

export function disposeWakeEnrollment(): void {
	void sharedState.wakeEnrollment?.dispose();
	sharedState.wakeEnrollment = null;
}

export function clearWakeTestTaps(): void {
	sharedState.wakeTestTaps.clear();
}

export function clearClipCapture(): void {
	sharedState.clipCapture = null;
}

export function disposeActivePipelineAndBridge(): void {
	// Fire and forget: this runs from `will-quit`, which is synchronous, and from
	// tests, which do not care how long a model file takes to close.
	void sharedState.activePipeline?.pipeline.dispose();
	sharedState.activePipeline = null;
	sharedState.audioBridge?.dispose();
	sharedState.audioBridge = null;
}
