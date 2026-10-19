/**
 * The app window's AI tab handlers and a tab window's owner run the SAME
 * per-tab actions (Tab Windows, D2): the handlers aim them at the active tab,
 * the owner's intent dispatcher at a popped tab. These tests pin the handler
 * half: each toggle, the star, and Mark as Unread go through the shared action
 * with the active target, and the chip close can name its agent.
 */

import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
	toggleAiTabReadOnlyMode: vi.fn(),
	toggleAiTabSaveToHistory: vi.fn(),
	cycleAiTabShowThinking: vi.fn(),
	toggleAiTabEnterToSend: vi.fn(),
	setAiTabStarred: vi.fn(),
	markAiTabUnread: vi.fn(),
}));

vi.mock('../../../../../renderer/services/aiTabActions', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../../renderer/services/aiTabActions')>();
	// Spies that still run the real action, so the store effect is real too.
	return {
		...actual,
		toggleAiTabReadOnlyMode: (...args: Parameters<typeof actual.toggleAiTabReadOnlyMode>) => {
			actions.toggleAiTabReadOnlyMode(...args);
			return actual.toggleAiTabReadOnlyMode(...args);
		},
		toggleAiTabSaveToHistory: (...args: Parameters<typeof actual.toggleAiTabSaveToHistory>) => {
			actions.toggleAiTabSaveToHistory(...args);
			return actual.toggleAiTabSaveToHistory(...args);
		},
		cycleAiTabShowThinking: (...args: Parameters<typeof actual.cycleAiTabShowThinking>) => {
			actions.cycleAiTabShowThinking(...args);
			return actual.cycleAiTabShowThinking(...args);
		},
		toggleAiTabEnterToSend: (...args: Parameters<typeof actual.toggleAiTabEnterToSend>) => {
			actions.toggleAiTabEnterToSend(...args);
			return actual.toggleAiTabEnterToSend(...args);
		},
		setAiTabStarred: (...args: Parameters<typeof actual.setAiTabStarred>) => {
			actions.setAiTabStarred(...args);
			return actual.setAiTabStarred(...args);
		},
		markAiTabUnread: (...args: Parameters<typeof actual.markAiTabUnread>) => {
			actions.markAiTabUnread(...args);
			return actual.markAiTabUnread(...args);
		},
	};
});

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({ endWizard: vi.fn(async () => null) }),
}));

import { useAITabHandlers } from '../../../../../renderer/hooks/tabs/internal/useAITabHandlers';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab, getSession, resetTabHandlerStores, setupSession } from './testUtils';

const ACTIVE = { sessionId: 'test-session', tabId: 'ai-1' };

describe('useAITabHandlers runs the shared per-tab actions', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1', agentSessionId: 'claude-1' }),
				createMockAITab({ id: 'ai-2' }),
			],
			activeTabId: 'ai-1',
		});
		Object.values(actions).forEach((fn) => fn.mockClear());
	});

	afterEach(() => cleanup());

	it.each([
		['handleToggleTabReadOnlyMode', 'toggleAiTabReadOnlyMode'],
		['handleToggleTabSaveToHistory', 'toggleAiTabSaveToHistory'],
		['handleToggleTabShowThinking', 'cycleAiTabShowThinking'],
		['handleToggleTabEnterToSend', 'toggleAiTabEnterToSend'],
	] as const)('%s runs %s on the active tab', (handler, action) => {
		const { result } = renderHook(() => useAITabHandlers());
		act(() => result.current[handler]());
		expect(actions[action]).toHaveBeenCalledWith(ACTIVE);
	});

	it('handleTabStar and handleTabMarkUnread run the shared actions on the named tab', () => {
		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabStar('ai-1', true);
			result.current.handleTabMarkUnread('ai-2');
		});
		expect(actions.setAiTabStarred).toHaveBeenCalledWith(ACTIVE, true);
		expect(actions.markAiTabUnread).toHaveBeenCalledWith({
			sessionId: 'test-session',
			tabId: 'ai-2',
		});
		expect(getSession().aiTabs.find((t) => t.id === 'ai-2')!.hasUnread).toBe(true);
	});

	it('performTabClose closes a tab of the agent it names, not of the active agent', () => {
		// Another agent is the active one, as when the owner closes a popped tab.
		useSessionStore.setState((s) => ({
			sessions: [
				...s.sessions,
				createMockSession({ id: 'other', aiTabs: [createMockAITab({ id: 'o-1' })] }),
			],
			activeSessionId: 'other',
		}));
		const { result } = renderHook(() => useAITabHandlers());

		act(() => result.current.performTabClose('ai-2', 'test-session'));

		const target = useSessionStore.getState().sessions.find((s) => s.id === 'test-session')!;
		const other = useSessionStore.getState().sessions.find((s) => s.id === 'other')!;
		expect(target.aiTabs.map((t) => t.id)).toEqual(['ai-1']);
		expect(other.aiTabs.map((t) => t.id)).toEqual(['o-1']);
	});
});
