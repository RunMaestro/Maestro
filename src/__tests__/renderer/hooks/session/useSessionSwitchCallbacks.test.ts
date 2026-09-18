import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionSwitchCallbacks } from '../../../../renderer/hooks/session/useSessionSwitchCallbacks';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { outputSearchKeyFor } from '../../../../renderer/utils/outputSearch';
import {
	clearDesktopAiTabSelections,
	consumeDesktopAiTabSelection,
} from '../../../../renderer/utils/desktopTabSelectionSync';
import {
	createMockAITab,
	createMockFileTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from '../tabs/internal/testUtils';

describe('useSessionSwitchCallbacks', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		clearDesktopAiTabSelections();
		if (!window.maestro.app.onDeepLink) {
			(window.maestro.app as any).onDeepLink = vi.fn();
		}
		vi.mocked(window.maestro.app.onDeepLink).mockReturnValue(() => {});
	});

	afterEach(() => {
		cleanup();
	});

	function renderCallbacks() {
		const setActiveSessionId = vi.fn();
		const handleResumeSession = vi.fn().mockResolvedValue(true);
		const handleFileClick = vi.fn();
		const inputRef = { current: null };
		const { result } = renderHook(() =>
			useSessionSwitchCallbacks({
				setActiveSessionId,
				handleResumeSession,
				inputRef,
				handleFileClick,
			})
		);
		return { result, setActiveSessionId, handleResumeSession, handleFileClick };
	}

	it('handleToastSessionClick focuses the target AI tab and clears other view state', () => {
		const sessionId = setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
			activeFileTabId: 'some-file-tab',
			inputMode: 'terminal',
		});
		const { result, setActiveSessionId } = renderCallbacks();

		act(() => {
			result.current.handleToastSessionClick(sessionId, 'ai-2');
		});

		expect(setActiveSessionId).toHaveBeenCalledWith(sessionId);
		const session = getSession();
		expect(session.activeTabId).toBe('ai-2');
		expect(session.activeFileTabId).toBeNull();
		expect(session.activeTerminalTabId).toBeNull();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.inputMode).toBe('ai');
	});

	it('handleUtilityTabSelect lands on the requested AI tab, clearing non-AI view state', () => {
		const sessionId = setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
			activeTerminalTabId: 'term-1',
			inputMode: 'terminal',
		});
		const { result } = renderCallbacks();

		act(() => {
			result.current.handleUtilityTabSelect('ai-2');
		});

		const session = getSession();
		expect(session.activeTabId).toBe('ai-2');
		expect(session.activeTerminalTabId).toBeNull();
		expect(session.inputMode).toBe('ai');
		expect(consumeDesktopAiTabSelection(sessionId, 'ai-2')).toBe(true);
	});

	it('handleUtilityFileTabSelect sets the file tab active and switches out of terminal mode', () => {
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			filePreviewTabs: [fileTab],
			activeTerminalTabId: 'term-1',
			inputMode: 'terminal',
		});
		const { result } = renderCallbacks();

		act(() => {
			result.current.handleUtilityFileTabSelect('file-1');
		});

		const session = getSession();
		expect(session.activeFileTabId).toBe('file-1');
		expect(session.activeTerminalTabId).toBeNull();
		expect(session.inputMode).toBe('ai');
		// activeTabId is left as-is so returning to AI tabs lands where the user was
		expect(session.activeTabId).toBe('ai-1');
	});

	it('handleCrossTabSearchJump focuses the tab and seeds the output search state', () => {
		const sessionId = setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
		});
		const { result } = renderCallbacks();

		act(() => {
			result.current.handleCrossTabSearchJump({
				tabId: 'ai-2',
				logId: 'log-42',
				query: 'needle',
				regex: false,
			});
		});

		const session = getSession();
		expect(session.activeTabId).toBe('ai-2');
		expect(consumeDesktopAiTabSelection(sessionId, 'ai-2')).toBe(true);

		const searchKey = outputSearchKeyFor(sessionId, 'ai-2');
		const ui = useUIStore.getState();
		expect(ui.outputSearchByKey[searchKey]).toMatchObject({
			query: 'needle',
			regex: false,
			open: true,
		});
		expect(ui.pendingLogJump).toEqual({ sessionId, tabId: 'ai-2', logId: 'log-42' });
	});

	it('handleNamedSessionSelect resumes the session and focuses the input', () => {
		const { result, handleResumeSession } = renderCallbacks();

		act(() => {
			result.current.handleNamedSessionSelect('agent-session-1', '/repo', 'My Session', true);
		});

		expect(handleResumeSession).toHaveBeenCalledWith('agent-session-1', [], 'My Session', true);
	});
});
