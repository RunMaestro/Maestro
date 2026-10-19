/**
 * Tests for services/aiTabActions: the per-tab settings and marks, addressed
 * by an explicit agent and tab.
 *
 * The app window's handlers run these on their active tab, and a tab window's
 * owner runs them on a popped tab (Tab Windows), which is never its active tab.
 * So the property under test is that each action lands on the tab it names,
 * and only there, whatever the active agent and tab are.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const persistTabStarred = vi.hoisted(() => vi.fn());
vi.mock('../../../renderer/utils/starredSessions', () => ({ persistTabStarred }));

import {
	cycleAiTabShowThinking,
	markAiTabUnread,
	setAiTabEffort,
	setAiTabModel,
	setAiTabPermissionMode,
	setAiTabShowThinking,
	setAiTabStarred,
	toggleAiTabEnterToSend,
	toggleAiTabReadOnlyMode,
	toggleAiTabSaveToHistory,
} from '../../../renderer/services/aiTabActions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { AITab, LogEntry } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const TARGET = { sessionId: 'agent-1', tabId: 'popped' };

const thinking: LogEntry = { id: 't', timestamp: 1, source: 'thinking', text: 'hmm' };
const answer: LogEntry = { id: 'a', timestamp: 2, source: 'stdout', text: 'done' };

/** The popped tab is the target; the active tab and the other agent must not change. */
function seed(popped: Partial<AITab> = {}) {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'agent-1',
				aiTabs: [
					createMockAITab({ id: 'popped', logs: [thinking, answer], ...popped }),
					createMockAITab({ id: 'home' }),
				],
				activeTabId: 'home',
			}),
			createMockSession({ id: 'agent-2', aiTabs: [createMockAITab({ id: 'popped-2' })] }),
		],
		activeSessionId: 'agent-2',
	});
}

function tab(id = 'popped'): AITab {
	return useSessionStore
		.getState()
		.sessions.find((s) => s.id === 'agent-1')!
		.aiTabs.find((t) => t.id === id)!;
}

beforeEach(() => {
	persistTabStarred.mockClear();
	seed();
});

describe('aiTabActions', () => {
	it('sets the permission mode on the named tab, keeping read-only in step', () => {
		expect(setAiTabPermissionMode(TARGET, 'readonly')).toBe(true);
		expect(tab()).toMatchObject({ permissionMode: 'readonly', readOnlyMode: true });
		expect(tab('home').permissionMode).toBeUndefined();
	});

	it('toggles read-only on the named tab', () => {
		toggleAiTabReadOnlyMode(TARGET);
		expect(tab()).toMatchObject({ readOnlyMode: true, permissionMode: 'readonly' });
		toggleAiTabReadOnlyMode(TARGET);
		expect(tab()).toMatchObject({ readOnlyMode: false, permissionMode: 'full' });
	});

	it('cycles and sets the thinking display; turning it off drops thinking logs', () => {
		cycleAiTabShowThinking(TARGET);
		expect(tab().showThinking).toBe('on');
		setAiTabShowThinking(TARGET, 'off');
		expect(tab().showThinking).toBe('off');
		expect(tab().logs).toEqual([answer]);
	});

	it('toggles Save to History and Enter-to-send (from the global default when unset)', () => {
		useSettingsStore.setState({ enterToSendAI: true });
		toggleAiTabSaveToHistory(TARGET);
		toggleAiTabEnterToSend(TARGET);
		expect(tab().saveToHistory).toBe(true);
		expect(tab().enterToSend).toBe(false);
	});

	it('sets and clears the model and effort overrides', () => {
		setAiTabModel(TARGET, 'opus');
		setAiTabEffort(TARGET, 'high');
		expect(tab()).toMatchObject({ customModel: 'opus', customEffort: 'high' });
		setAiTabModel(TARGET, '');
		setAiTabEffort(TARGET, undefined);
		expect(tab().customModel).toBeUndefined();
		expect(tab().customEffort).toBeUndefined();
	});

	it('marks the named tab unread', () => {
		markAiTabUnread(TARGET);
		expect(tab().hasUnread).toBe(true);
	});

	it('stars a tab with a provider session, saving the star with that session', () => {
		seed({ agentSessionId: 'claude-1' });
		expect(setAiTabStarred(TARGET, true)).toBe(true);
		expect(tab().starred).toBe(true);
		expect(persistTabStarred).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'agent-1' }),
			expect.objectContaining({ id: 'popped' }),
			true
		);
	});

	it('refuses to star a tab with no provider session yet', () => {
		expect(setAiTabStarred(TARGET, true)).toBe(false);
		expect(tab().starred).toBe(false);
		expect(persistTabStarred).not.toHaveBeenCalled();
	});

	it('writes nothing for a tab or agent that is gone', () => {
		const before = useSessionStore.getState().sessions;
		expect(setAiTabModel({ sessionId: 'agent-1', tabId: 'closed' }, 'opus')).toBe(false);
		expect(markAiTabUnread({ sessionId: 'gone', tabId: 'popped' })).toBe(false);
		expect(useSessionStore.getState().sessions).toBe(before);
	});
});
