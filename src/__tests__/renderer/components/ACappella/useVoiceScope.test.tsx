/**
 * @file useVoiceScope.test.tsx
 *
 * The scope line answers "where is the next sentence going". Each binding has
 * its own name for that, and a binding that names no agent (the Conductor,
 * Quick Chat) must not be read as one another.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVoiceScope } from '../../../../renderer/components/ACappella/useVoiceScope';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import type { DispatchEvent, RosterAgent, VoiceScope } from '../../../../shared/acappella/protocol';
import { mockTheme } from '../../../helpers/mockTheme';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-1',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo',
		tabs: [{ id: 'tab-1', name: 'Migrations', lastActiveAt: null }],
	},
];

function dispatchTo(agentSessionId: string, tabId: string, tabName: string): DispatchEvent {
	return {
		type: 'dispatch',
		sessionId: 'voice-1',
		seq: 1,
		ts: 0,
		agentSessionId,
		agentName: 'Backend',
		tabId,
		tabName,
		action: 'focused',
		promptSent: true,
	};
}

function scopeDisplay(scope: VoiceScope | null, lastDispatch: DispatchEvent | null = null) {
	useVoiceSessionStore.setState({ scope, roster: ROSTER, lastDispatch });
	return renderHook(() => useVoiceScope(mockTheme)).result.current;
}

describe('useVoiceScope', () => {
	it('names a Group Chat room without claiming an agent binding', () => {
		const display = scopeDisplay({ kind: 'group-chat', groupChatId: 'room', name: 'Review' });
		expect(display.label).toBe('Review');
		expect(display.agentSessionId).toBeNull();
	});

	beforeEach(() => {
		useVoiceSessionStore.setState({ scope: null, roster: [], lastDispatch: null });
	});

	it('names the Conductor when the session is bound to no agent', () => {
		const display = scopeDisplay({ kind: 'conductor' });
		expect(display.label).toBe('Conductor');
		expect(display.agentSessionId).toBeNull();
		expect(display.tabLabel).toBeNull();
	});

	it('names the agent, and the pinned tab in Tab mode', () => {
		expect(scopeDisplay({ kind: 'agent', sessionId: 'agent-1' }).label).toBe('Backend');

		const tab = scopeDisplay({ kind: 'agent', sessionId: 'agent-1', tabId: 'tab-1' });
		expect(tab.label).toBe('Backend');
		expect(tab.tabLabel).toBe('Migrations');
		expect(tab.tabId).toBe('tab-1');
	});

	it('names a Quick Chat session after Quick Chat, not after the Conductor', () => {
		// It carries no agent id, so an agent-id test alone would read it as unbound.
		const display = scopeDisplay({ kind: 'quick-chat' });
		expect(display.label).toBe('Quick Chat');
		expect(display.agentSessionId).toBeNull();
		expect(display.tabLabel).toBeNull();
		expect(display.tabId).toBeNull();
	});

	it('shows the tab a Quick Chat turn landed in once one was delivered', () => {
		const display = scopeDisplay({ kind: 'quick-chat' }, dispatchTo('agent-1', 'tab-9', 'Quick'));
		expect(display.label).toBe('Quick Chat');
		expect(display.tabLabel).toBe('Quick');
		expect(display.tabId).toBe('tab-9');
	});
});
