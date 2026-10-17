/**
 * VoiceTranscript - the scrollback.
 *
 * Three behaviours are the point of the component and are what these cover: a
 * partial settles into a final rather than piling up, the sentence currently
 * coming out of the speakers is the one highlighted, and a route chip is a
 * working address rather than a label.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { VoiceTranscript } from '../../../../renderer/components/ACappella/VoiceTranscript';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { mockTheme } from '../../../helpers/mockTheme';
import type { VoiceEvent } from '../../../../shared/acappella/protocol';
import type { Session } from '../../../../renderer/types';

const SESSION = 'voice-1';
let seq = 0;

function event<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>
): VoiceEvent {
	seq += 1;
	return {
		type,
		sessionId: SESSION,
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

/** jsdom has no layout; let the mocked ResizeObserver deliver its measurement. */
async function flushLayout(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function renderTranscript() {
	return render(<VoiceTranscript theme={mockTheme} />);
}

beforeEach(() => {
	seq = 0;
	vi.clearAllMocks();
	useVoiceSessionStore.getState().reset();
});

afterEach(() => {
	cleanup();
});

describe('VoiceTranscript partials', () => {
	it('shows a live hypothesis and drops it when the utterance settles', async () => {
		renderTranscript();
		apply(event('partial-transcript', { text: 'open the auth', stability: 0.4 }));
		expect(screen.getByTestId('voice-transcript-partial').textContent).toBe('open the auth');

		apply(event('final-transcript', { text: 'open the auth tab', confidence: 1 }));
		await flushLayout();

		expect(screen.queryByTestId('voice-transcript-partial')).toBeNull();
		// The settled line is in the scrollback exactly once - the partial was
		// replaced, not appended alongside.
		expect(screen.getAllByText('open the auth tab')).toHaveLength(1);
	});

	it('says so when nothing has been said', () => {
		renderTranscript();
		expect(screen.getByText('Nothing said yet.')).toBeTruthy();
	});
});

describe('VoiceTranscript spoken sentences', () => {
	function speakTwo(): void {
		apply(
			event('speak-start', { utteranceId: 'u1', sentenceCount: 2, ttsProviderId: 'mock-tts' }),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'The tests pass.' }),
			event('speak-sentence', { utteranceId: 'u1', index: 1, text: 'Nothing else changed.' })
		);
	}

	it('highlights the sentence being spoken, which is the newest one', () => {
		renderTranscript();
		speakTwo();

		const current = screen.getByTestId('voice-transcript-speaking');
		expect(current.textContent).toContain('Nothing else changed.');
		expect(current.getAttribute('aria-current')).toBe('true');
	});

	it('highlights nothing once the run ends, because nothing is being spoken', () => {
		renderTranscript();
		speakTwo();
		apply(event('speak-end', { utteranceId: 'u1', reason: 'complete' }));

		expect(screen.queryByTestId('voice-transcript-speaking')).toBeNull();
		expect(screen.getByTestId('voice-transcript-spoken').textContent).toContain('The tests pass.');
	});

	it('marks a cancelled run as cut off rather than complete', () => {
		renderTranscript();
		speakTwo();
		apply(event('speak-end', { utteranceId: 'u1', reason: 'cancelled' }));
		expect(screen.getByTestId('voice-transcript-spoken').textContent).toContain('(cut off)');
	});
});

describe('VoiceTranscript route chips', () => {
	const dispatch = () =>
		event('dispatch', {
			agentSessionId: 'agent-1',
			agentName: 'Backend',
			tabId: 'tab-7',
			tabName: 'Auth Refactor',
			action: 'created',
			promptSent: true,
		});

	it('says where the turn went, including what it did to the tab', async () => {
		renderTranscript();
		apply(dispatch());
		await flushLayout();

		const chip = screen.getByTestId('voice-route-chip');
		expect(chip.textContent).toContain('Backend / Auth Refactor');
		expect(chip.textContent).toContain('new tab');
	});

	it('jumps to the agent and tab when clicked', async () => {
		const session = { id: 'agent-1', name: 'Backend', aiTabs: [{ id: 'tab-7' }] } as Session;
		const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			updater([session]);
		});
		const setActiveSessionId = vi.fn();
		useSessionStore.setState({
			sessions: [session],
			setSessions,
			setActiveSessionId,
		} as never);

		renderTranscript();
		apply(dispatch());
		await flushLayout();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-route-chip'));
		});

		expect(setActiveSessionId).toHaveBeenCalledWith('agent-1');
		expect(setSessions).toHaveBeenCalled();
	});

	it('leaves the address on screen even when the agent is gone', async () => {
		useSessionStore.setState({ sessions: [] } as never);
		renderTranscript();
		apply(dispatch());
		await flushLayout();

		// The chip still names where the turn went. Hiding it would erase the one
		// record of a prompt that landed somewhere the user can no longer find.
		expect(screen.getByTestId('voice-route-chip').textContent).toContain('Backend');
	});

	it('puts a chip only on the line that narrates a dispatch', async () => {
		renderTranscript();
		apply(event('final-transcript', { text: 'refactor auth', confidence: 1 }), dispatch());
		await flushLayout();

		expect(screen.getAllByTestId('voice-route-chip')).toHaveLength(1);
		expect(screen.getAllByTestId('voice-transcript-entry').length).toBeGreaterThan(1);
	});
});
