/**
 * Where the voice floor glyph sits, per mode.
 *
 *   - Tab mode: on the pinned tab AND its agent.
 *   - Agent mode: on the agent only.
 *   - Conductor mode: beside the wordmark, and on no agent or tab.
 *
 * The tab's "last prompt landed here" marker is a different fact and keeps its
 * own glyph; it must not read as holding the floor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentVoiceIndicator } from '../../../../renderer/components/SessionList/AgentVoiceIndicator';
import { TabVoiceIndicator } from '../../../../renderer/components/TabBar/TabVoiceIndicator';
import { ConductorVoiceIndicator } from '../../../../renderer/components/ACappella/ConductorVoiceIndicator';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';
import { applyVoiceEvents, resetVoiceEventSeq, voiceEvent } from '../../../helpers/voiceEvents';
import type { VoiceScope } from '../../../../shared/acappella/protocol';

const AGENT = 'agent-1';
const TAB = 'tab-1';

function renderAll() {
	return render(
		<>
			<ConductorVoiceIndicator theme={mockTheme} />
			<AgentVoiceIndicator sessionId={AGENT} theme={mockTheme} />
			<TabVoiceIndicator tabId={TAB} theme={mockTheme} />
			<TabVoiceIndicator tabId="tab-2" theme={mockTheme} />
		</>
	);
}

function open(scope: VoiceScope): void {
	applyVoiceEvents(
		voiceEvent('wake', { source: 'hotkey', scope }),
		voiceEvent('listen-start', { scope, sttProviderId: 'mock-stt' })
	);
}

beforeEach(() => {
	resetVoiceEventSeq();
	useVoiceSessionStore.getState().reset();
	useVoiceUiStore.setState({ wakePhrases: {}, loaded: true });
	useSettingsStore.setState({ encoreFeatures: { aCappella: true } } as never);
});

afterEach(() => {
	cleanup();
});

describe('voice floor glyph placement', () => {
	it('Tab mode marks the pinned tab and its agent, not the wordmark', () => {
		renderAll();
		open({ kind: 'agent', sessionId: AGENT, tabId: TAB });

		expect(screen.getByTestId('agent-voice-floor')).toBeTruthy();
		expect(screen.getAllByTestId('tab-voice-floor')).toHaveLength(1);
		expect(screen.queryByTestId('conductor-voice-floor')).toBeNull();
	});

	it('Agent mode marks the agent and no tab', () => {
		renderAll();
		open({ kind: 'agent', sessionId: AGENT });

		expect(screen.getByTestId('agent-voice-floor')).toBeTruthy();
		expect(screen.queryByTestId('tab-voice-floor')).toBeNull();
		expect(screen.queryByTestId('conductor-voice-floor')).toBeNull();
	});

	it('Conductor mode moves the glyph to the wordmark', () => {
		renderAll();
		open({ kind: 'conductor' });

		expect(screen.getByTestId('conductor-voice-floor')).toBeTruthy();
		expect(screen.queryByTestId('agent-voice-floor')).toBeNull();
		expect(screen.queryByTestId('tab-voice-floor')).toBeNull();
	});

	it('Conductor mode still marks the tab the last prompt landed in, as a landing', () => {
		renderAll();
		open({ kind: 'conductor' });
		applyVoiceEvents(
			voiceEvent('dispatch', {
				agentSessionId: AGENT,
				agentName: 'Backend',
				tabId: TAB,
				action: 'focused',
				promptSent: true,
			})
		);

		expect(screen.getByTestId('tab-voice-indicator')).toBeTruthy();
		expect(screen.queryByTestId('tab-voice-floor')).toBeNull();
	});

	it('moves the floor glyph when a live session changes mode and clears it when stopped', () => {
		renderAll();
		open({ kind: 'agent', sessionId: AGENT, tabId: TAB });
		expect(screen.getByTestId('tab-voice-floor')).toBeTruthy();

		applyVoiceEvents(voiceEvent('scope-change', { scope: { kind: 'conductor' } }));
		expect(screen.getByTestId('conductor-voice-floor')).toBeTruthy();
		expect(screen.queryByTestId('agent-voice-floor')).toBeNull();
		expect(screen.queryByTestId('tab-voice-floor')).toBeNull();

		applyVoiceEvents(
			voiceEvent('stop-word', { phrase: 'stop', source: 'voice' }),
			voiceEvent('listen-stop', { reason: 'stopped' })
		);
		expect(screen.queryByTestId('conductor-voice-floor')).toBeNull();
	});

	it('draws nothing with no live session', () => {
		const { container } = renderAll();
		expect(container.textContent).toBe('');
		expect(container.querySelector('[data-testid]')).toBeNull();
	});

	it('draws nothing when the Encore Feature is off', () => {
		useSettingsStore.setState({ encoreFeatures: { aCappella: false } } as never);
		const { container } = renderAll();
		open({ kind: 'conductor' });
		expect(container.querySelector('[data-testid]')).toBeNull();
	});
});
