/**
 * Build and apply A Cappella voice events against the renderer's voice store.
 *
 * The store projects the main process's event stream, so a test drives it the
 * same way: one event at a time, with a rising `seq`. Call
 * `resetVoiceEventSeq()` in `beforeEach` beside `useVoiceSessionStore.reset()`.
 */

import { act } from '@testing-library/react';
import { useVoiceSessionStore } from '../../renderer/stores/voiceSessionStore';
import type { VoiceEvent } from '../../shared/acappella/protocol';

export const TEST_VOICE_SESSION_ID = 'voice-1';

let seq = 0;

export function resetVoiceEventSeq(): void {
	seq = 0;
}

export function voiceEvent<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>
): VoiceEvent {
	seq += 1;
	return {
		type,
		sessionId: TEST_VOICE_SESSION_ID,
		seq,
		ts: 1_700_000_000_000 + seq,
		...body,
	} as unknown as VoiceEvent;
}

export function applyVoiceEvents(...events: VoiceEvent[]): void {
	act(() => {
		for (const e of events) useVoiceSessionStore.getState().applyEvent(e);
	});
}
