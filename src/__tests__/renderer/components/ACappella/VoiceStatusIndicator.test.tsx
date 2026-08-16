/**
 * VoiceStatusIndicator - the minimized HUD's home in the Left Bar header.
 *
 * The invariant worth a test file: a minimized voice session must be visible
 * somewhere, and a session that is NOT running must not be. Both halves matter.
 * An indicator that renders too eagerly claims an open microphone that is not
 * there; one that renders too rarely leaves a real one with no surface at all,
 * which is the whole reason minimize is allowed to hide the widget.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { VoiceStatusIndicator } from '../../../../renderer/components/ACappella';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { VoiceSessionState } from '../../../../shared/acappella/session-state';
import { mockTheme } from '../../../helpers/mockTheme';

function seed(
	options: {
		enabled?: boolean;
		state?: VoiceSessionState;
		minimized?: boolean;
		scope?: { kind: 'conductor' } | { kind: 'agent'; sessionId: string };
	} = {}
): void {
	useSettingsStore.setState((prev) => ({
		encoreFeatures: { ...prev.encoreFeatures, aCappella: options.enabled ?? true },
	}));
	useVoiceSessionStore.setState({
		sessionId: 'voice-1',
		state: options.state ?? 'listening',
		scope: options.scope ?? { kind: 'conductor' },
		roster: [
			{
				sessionId: 'agent-1',
				name: 'Backend',
				agentType: 'claude-code',
				cwd: '/repo',
				tabs: [],
			},
		],
	});
	useVoiceUiStore.setState({ minimized: options.minimized ?? true });
}

describe('VoiceStatusIndicator', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		useVoiceSessionStore.getState().reset();
		seed();
	});

	it('shows the bound scope while the HUD is minimized', () => {
		render(<VoiceStatusIndicator theme={mockTheme} />);
		expect(screen.getByTestId('voice-status-indicator').textContent).toContain('Conductor');
	});

	it('names the agent when the session is bound to one', () => {
		seed({ scope: { kind: 'agent', sessionId: 'agent-1' } });
		render(<VoiceStatusIndicator theme={mockTheme} />);
		expect(screen.getByTestId('voice-status-indicator').textContent).toContain('Backend');
	});

	it('stays out of the way while the HUD is on screen', () => {
		seed({ minimized: false });
		render(<VoiceStatusIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('voice-status-indicator')).toBeNull();
	});

	it('renders nothing when no session is running', () => {
		// The dangerous direction: a leftover pill implying an open microphone.
		seed({ state: 'idle' });
		render(<VoiceStatusIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('voice-status-indicator')).toBeNull();
	});

	it('renders nothing when the Encore Feature is off', () => {
		seed({ enabled: false });
		render(<VoiceStatusIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('voice-status-indicator')).toBeNull();
	});

	it('restores the HUD without touching the session', () => {
		render(<VoiceStatusIndicator theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('voice-status-indicator'));

		expect(useVoiceUiStore.getState().minimized).toBe(false);
		// The floor is untouched: this control shows a window, it does not speak.
		expect(useVoiceSessionStore.getState().state).toBe('listening');
	});

	it('keeps the glyph but drops the label in compact mode', () => {
		// The collapsed rail has no room for a name, and losing the glyph there
		// would make the narrow sidebar the one place a live microphone is silent.
		render(<VoiceStatusIndicator theme={mockTheme} compact />);
		const pill = screen.getByTestId('voice-status-indicator');
		expect(pill.textContent).not.toContain('Conductor');
		expect(pill.querySelector('svg')).toBeTruthy();
	});

	it('reports the live state to assistive tech, not just in colour', () => {
		seed({ state: 'speaking' });
		render(<VoiceStatusIndicator theme={mockTheme} />);
		expect(screen.getByTestId('voice-status-indicator').getAttribute('aria-label')).toContain(
			'Speaking'
		);
	});
});
