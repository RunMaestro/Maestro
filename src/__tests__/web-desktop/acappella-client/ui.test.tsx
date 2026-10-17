/**
 * The reference client's rendering, which is where three of the easiest
 * conformance items to get wrong actually live: the roster is replaced rather
 * than merged, a route correction rewrites one row rather than appending a
 * second, and a late sentence from a cancelled speech run is dropped.
 *
 * A `.tsx` extension with no JSX in it, because the jsdom project matches every
 * `.tsx` in `src/` and this suite needs a document.
 */

import { describe, expect, it } from 'vitest';

import type { RosterAgent, VoiceEvent, VoiceScope } from '../../../shared/acappella/protocol';
import {
	createTranscript,
	micPillText,
	renderWheel,
	sameScope,
} from '../../../web-desktop/acappella-client/ui';
import type { ClientState } from '../../../web-desktop/acappella-client/client';

function agent(sessionId: string, name: string): RosterAgent {
	return { sessionId, name, agentType: 'claude-code', cwd: '/tmp', tabs: [] };
}

function event(partial: Partial<VoiceEvent> & { type: VoiceEvent['type'] }): VoiceEvent {
	return { sessionId: 'voice-1', seq: 1, ts: 0, ...partial } as VoiceEvent;
}

function baseState(patch: Partial<ClientState> = {}): ClientState {
	return {
		phase: 'connected',
		message: '',
		deviceId: 'device-1',
		protocolVersion: 1,
		floor: { holder: null, isSelf: false },
		sending: false,
		desktopVersion: null,
		quality: null,
		transcriptSuspect: false,
		canRetry: true,
		...patch,
	};
}

describe('project wheel', () => {
	it('replaces the roster wholesale rather than merging it (C-24)', () => {
		const container = document.createElement('div');
		const conductor: VoiceScope = { kind: 'conductor' };

		renderWheel(container, [agent('a', 'Alpha'), agent('b', 'Beta')], conductor, () => {});
		expect(container.textContent).toContain('Alpha');

		// Beta was closed on the desktop. The next snapshot simply does not have it,
		// and a merge here is how a phone offers to talk to something gone.
		renderWheel(container, [agent('a', 'Alpha')], conductor, () => {});
		expect(container.textContent).toContain('Alpha');
		expect(container.textContent).not.toContain('Beta');
	});

	it('always offers the conductor, selected by default', () => {
		const container = document.createElement('div');
		renderWheel(container, [], { kind: 'conductor' }, () => {});
		const first = container.querySelector('button');
		expect(first?.textContent).toContain('Conductor');
		expect(first?.getAttribute('aria-pressed')).toBe('true');
	});

	it('compares agent scopes by session id', () => {
		expect(sameScope({ kind: 'agent', sessionId: 'a' }, { kind: 'agent', sessionId: 'a' })).toBe(
			true
		);
		expect(sameScope({ kind: 'agent', sessionId: 'a' }, { kind: 'agent', sessionId: 'b' })).toBe(
			false
		);
		expect(sameScope({ kind: 'conductor' }, { kind: 'agent', sessionId: 'a' })).toBe(false);
	});
});

describe('microphone pill (C-50)', () => {
	it('distinguishes sending from a connected but closed microphone', () => {
		expect(micPillText(baseState({ sending: true }))).toBe('Sending');
		expect(micPillText(baseState({ sending: false }))).toBe('Mic off');
		expect(micPillText(baseState({ phase: 'idle' }))).toBe('Not connected');
	});
});

describe('transcript', () => {
	it('replaces the in-flight user row on each partial rather than appending', () => {
		const container = document.createElement('div');
		const transcript = createTranscript(container);

		transcript.apply(event({ type: 'partial-transcript', text: 'open the', stability: 0.2 }));
		transcript.apply(
			event({ type: 'partial-transcript', text: 'open the auth tab', stability: 0.8 })
		);
		transcript.apply(
			event({ type: 'final-transcript', text: 'open the auth tab', confidence: 0.9 })
		);

		const rows = container.querySelectorAll('.row-user');
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('open the auth tab');
	});

	it('rewrites a caption in place on a route correction (C-25)', () => {
		const container = document.createElement('div');
		const transcript = createTranscript(container);

		transcript.apply(event({ type: 'final-transcript', text: 'ship it', confidence: 1 }));
		transcript.apply(
			event({
				type: 'dispatch',
				agentSessionId: 'a',
				agentName: 'Alpha',
				tabId: 't1',
				action: 'focused',
				promptSent: true,
			})
		);
		transcript.apply(
			event({
				type: 'route-correction',
				fromAgentSessionId: 'a',
				fromTabId: 't1',
				agentSessionId: 'b',
				agentName: 'Beta',
				tabId: 't2',
				action: 'focused',
				promptSent: true,
				source: 'client-button',
			})
		);

		// One row, one caption, and the caption is the corrected one.
		expect(container.querySelectorAll('.row-user')).toHaveLength(1);
		const captions = container.querySelectorAll('.row-caption');
		expect(captions).toHaveLength(1);
		expect(captions[0].textContent).toContain('Beta');
	});

	it('drops sentences from a run that is no longer current (C-27)', () => {
		const container = document.createElement('div');
		const transcript = createTranscript(container);

		transcript.apply(
			event({
				type: 'speak-start',
				utteranceId: 'u1',
				sentenceCount: 2,
				ttsProviderId: 'piper',
				streaming: true,
			})
		);
		transcript.apply(
			event({
				type: 'agent-reply',
				agentSessionId: 'a',
				tabId: 't',
				text: 'Done.',
				spokenText: 'Done.',
			})
		);
		// Index 5 with a sentenceCount of 2 is normal while streaming: the count is a
		// lower bound and must never be clamped. C-26.
		transcript.apply(event({ type: 'speak-sentence', utteranceId: 'u1', index: 5, text: 'five' }));
		expect(container.querySelector('.row-caption')?.textContent).toBe('sentence 6');

		// A sentence from a cancelled earlier run, arriving late.
		transcript.apply(event({ type: 'speak-sentence', utteranceId: 'u0', index: 0, text: 'stale' }));
		expect(container.querySelector('.row-caption')?.textContent).toBe('sentence 6');
	});

	it('shows the egress statement verbatim (C-30)', () => {
		const container = document.createElement('div');
		const transcript = createTranscript(container);
		transcript.apply(
			event({
				type: 'provider-state',
				pipeline: 'cascade',
				slots: [],
				egressStatement: 'Your voice stays on this machine.',
				audioLeavesMachine: false,
			})
		);
		expect(container.textContent).toContain('Your voice stays on this machine.');
	});

	it('ignores an event type it does not know (C-23)', () => {
		const container = document.createElement('div');
		const transcript = createTranscript(container);
		expect(() =>
			transcript.apply(event({ type: 'something-new' as VoiceEvent['type'] }))
		).not.toThrow();
		expect(container.childElementCount).toBe(0);
	});
});
