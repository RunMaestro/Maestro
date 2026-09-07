/**
 * AgentVoiceIndicator - the Left Bar's voice glyphs.
 *
 * The invariant worth protecting: these COMPOSE with the status dot rather than
 * replacing it. An agent that is busy and holding the voice floor has to still
 * read as busy, because "is it working" is the question the colour answers and
 * the voice glyph answers a different one.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { AgentVoiceIndicator } from '../../../../renderer/components/SessionList/AgentVoiceIndicator';
import { getEnhancedStatusColor } from '../../../../renderer/components/SessionItem';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';
import type { VoiceEvent } from '../../../../shared/acappella/protocol';
import type { Session } from '../../../../renderer/types';

const AGENT = 'agent-1';
const VOICE_SESSION = 'voice-1';
let seq = 0;

function event<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>
): VoiceEvent {
	seq += 1;
	return {
		type,
		sessionId: VOICE_SESSION,
		seq,
		ts: 1_700_000_000_000 + seq,
		...body,
	} as unknown as VoiceEvent;
}

function apply(...events: VoiceEvent[]): void {
	act(() => {
		for (const e of events) useVoiceSessionStore.getState().applyEvent(e);
	});
}

function renderIndicator(sessionId = AGENT) {
	return render(<AgentVoiceIndicator sessionId={sessionId} theme={mockTheme} />);
}

/** Open a session bound to this agent. */
function holdFloor(sessionId = AGENT): void {
	apply(
		event('wake', { source: 'hotkey', scope: { kind: 'agent', sessionId } }),
		event('listen-start', {
			scope: { kind: 'agent', sessionId },
			sttProviderId: 'mock-stt',
		})
	);
}

beforeEach(() => {
	seq = 0;
	vi.clearAllMocks();
	useVoiceSessionStore.getState().reset();
	useVoiceUiStore.setState({ wakePhrases: {}, loaded: true });
	useSettingsStore.setState({ encoreFeatures: { aCappella: true } } as never);
});

afterEach(() => {
	cleanup();
});

describe('AgentVoiceIndicator gating', () => {
	it('renders nothing when the Encore Feature is off', () => {
		useSettingsStore.setState({ encoreFeatures: { aCappella: false } } as never);
		renderIndicator();
		holdFloor();
		expect(screen.queryByTestId('agent-voice-floor')).toBeNull();
	});

	it('renders nothing for an agent with no voice and no phrase', () => {
		const { container } = renderIndicator();
		expect(container.textContent).toBe('');
		expect(screen.queryByTestId('agent-voice-floor')).toBeNull();
		expect(screen.queryByTestId('agent-voice-wake-phrase')).toBeNull();
	});
});

describe('AgentVoiceIndicator states', () => {
	it('marks the agent holding the voice floor', () => {
		renderIndicator();
		holdFloor();
		expect(screen.getByTestId('agent-voice-floor')).toBeTruthy();
	});

	it('does not mark a different agent', () => {
		renderIndicator('agent-2');
		holdFloor(AGENT);
		expect(screen.queryByTestId('agent-voice-floor')).toBeNull();
	});

	it('marks the agent whose reply is being spoken, even without the floor', () => {
		// A Conductor session speaks replies from whichever agent it routed to.
		// That agent never holds the floor, and it is still the one talking.
		renderIndicator();
		apply(
			event('wake', { source: 'wake-word', scope: { kind: 'conductor' } }),
			event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' }),
			event('dispatch', {
				agentSessionId: AGENT,
				agentName: 'Backend',
				tabId: 'tab-1',
				action: 'focused',
				promptSent: true,
			}),
			event('speak-start', { utteranceId: 'u1', sentenceCount: 1, ttsProviderId: 'mock-tts' })
		);

		expect(screen.getByTestId('agent-voice-speaking')).toBeTruthy();
		expect(screen.queryByTestId('agent-voice-floor')).toBeNull();
	});

	it('badges an agent that has a wake phrase, so the mapping is discoverable', () => {
		useVoiceUiStore.setState({ wakePhrases: { [AGENT]: 'hey backend' }, loaded: true });
		renderIndicator();
		expect(screen.getByTestId('agent-voice-wake-phrase').getAttribute('aria-label')).toContain(
			'hey backend'
		);
	});
});

describe('AgentVoiceIndicator composes with the status colours', () => {
	const busy = { id: AGENT, state: 'busy', toolType: 'codex' } as unknown as Session;

	it('leaves the busy colour alone while the agent holds the floor', () => {
		// The voice glyph is additive. Nothing about it touches the status dot's
		// colour, its animation, or its label - which is the whole point of
		// rendering a separate element rather than recolouring the dot.
		const before = getEnhancedStatusColor(busy, mockTheme, false);
		renderIndicator();
		holdFloor();
		const after = getEnhancedStatusColor(busy, mockTheme, false);

		expect(after).toEqual(before);
		expect(after.color).toBe(mockTheme.colors.warning);
		expect(after.label).toBe('Thinking');
		expect(screen.getByTestId('agent-voice-floor')).toBeTruthy();
	});

	it('leaves an error colour alone while the agent is being spoken', () => {
		const errored = { id: AGENT, state: 'error', toolType: 'codex' } as unknown as Session;
		renderIndicator();
		apply(
			event('wake', { source: 'wake-word', scope: { kind: 'conductor' } }),
			event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' }),
			event('dispatch', {
				agentSessionId: AGENT,
				agentName: 'Backend',
				tabId: 'tab-1',
				action: 'focused',
				promptSent: true,
			}),
			event('speak-start', { utteranceId: 'u1', sentenceCount: 1, ttsProviderId: 'mock-tts' })
		);

		const status = getEnhancedStatusColor(errored, mockTheme, false);
		expect(status.color).toBe(mockTheme.colors.error);
		expect(screen.getByTestId('agent-voice-speaking')).toBeTruthy();
	});
});
