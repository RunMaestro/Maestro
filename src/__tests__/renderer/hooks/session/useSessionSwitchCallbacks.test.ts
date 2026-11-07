import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationApi } from '../../../../main/preload/notifications';
import * as runtimeContext from '../../../../renderer/utils/runtimeContext';
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

const nativeIpc = vi.hoisted(() => ({
	invoke: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer: nativeIpc }));

const originalOnClickAction = window.maestro.notification.onClickAction;

describe('useSessionSwitchCallbacks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		nativeIpc.invoke.mockResolvedValue(undefined);
		window.maestro.notification.onClickAction = createNotificationApi().onClickAction;
		resetTabHandlerStores();
		clearDesktopAiTabSelections();
		if (!window.maestro.app.onDeepLink) {
			(window.maestro.app as any).onDeepLink = vi.fn();
		}
		vi.mocked(window.maestro.app.onDeepLink).mockReturnValue(() => {});
	});

	afterEach(() => {
		cleanup();
		window.maestro.notification.onClickAction = originalOnClickAction;
		vi.restoreAllMocks();
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

	it('passes a named native session owner and path into resume options', () => {
		setupSession();
		const { result, handleResumeSession } = renderCallbacks();
		act(() =>
			result.current.handleNamedSessionSelect('native', '/other/project', 'Owned', true, 'codex')
		);
		expect(handleResumeSession).toHaveBeenCalledWith(
			'native',
			[],
			'Owned',
			true,
			undefined,
			'/other/project',
			{ provider: 'codex' }
		);
	});

	it('keeps Lite toast navigation local without declaring host notification readiness', () => {
		vi.spyOn(runtimeContext, 'isWebDesktop').mockReturnValue(true);
		const sessionId = setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
			activeFileTabId: 'file-1',
			inputMode: 'terminal',
		});
		const { result, setActiveSessionId } = renderCallbacks();

		expect(nativeIpc.invoke.mock.calls.map(([channel]) => channel)).not.toContain(
			'notification:ready'
		);
		act(() => result.current.handleToastSessionClick(sessionId, 'ai-2'));
		expect(setActiveSessionId).toHaveBeenCalledWith(sessionId);
		expect(getSession()).toMatchObject({
			activeTabId: 'ai-2',
			activeFileTabId: null,
			inputMode: 'ai',
		});
	});

	it('still navigates the host renderer when a native notification is clicked', () => {
		vi.spyOn(runtimeContext, 'isWebDesktop').mockReturnValue(false);
		const sessionId = setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
			inputMode: 'terminal',
		});
		const { setActiveSessionId } = renderCallbacks();
		const listener = nativeIpc.on.mock.calls.find(
			([channel]) => channel === 'notification:clickAction'
		)?.[1];
		act(() => listener({}, { kind: 'jump-session', sessionId, tabId: 'ai-2' }));
		expect(setActiveSessionId).toHaveBeenCalledWith(sessionId);
		expect(getSession()).toMatchObject({ activeTabId: 'ai-2', inputMode: 'ai' });
	});

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

	it('handleCrossTabSearchJump leaves the Find bar alone for a semantic hit', () => {
		const sessionId = setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
		});
		const { result } = renderCallbacks();
		// The store outlives a test, and the text-hit test above opened this bar.
		useUIStore.setState({ outputSearchByKey: {} });

		// A semantic hit matched by meaning, so it carries no text to find.
		act(() => {
			result.current.handleCrossTabSearchJump({
				tabId: 'ai-2',
				logId: 'turn-7',
				query: '',
				regex: false,
			});
		});

		expect(getSession().activeTabId).toBe('ai-2');
		const ui = useUIStore.getState();
		expect(ui.outputSearchByKey[outputSearchKeyFor(sessionId, 'ai-2')]?.open ?? false).toBe(false);
		expect(ui.pendingLogJump).toEqual({ sessionId, tabId: 'ai-2', logId: 'turn-7' });
	});

	it('handleNamedSessionSelect resumes the session and focuses the input', () => {
		const { result, handleResumeSession } = renderCallbacks();

		act(() => {
			result.current.handleNamedSessionSelect('agent-session-1', '/repo', 'My Session', true);
		});

		expect(handleResumeSession).toHaveBeenCalledWith(
			'agent-session-1',
			[],
			'My Session',
			true,
			undefined,
			'/repo',
			{ provider: undefined }
		);
	});
});
