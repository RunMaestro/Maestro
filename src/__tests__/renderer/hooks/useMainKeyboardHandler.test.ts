import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useMainKeyboardHandler } from '../../../renderer/hooks';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { FONT_ZOOM_MAX, FONT_ZOOM_MIN } from '../../../shared/typography';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { groupChatOutputSearchKey } from '../../../renderer/utils/outputSearch';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import {
	clearDesktopAiTabSelections,
	consumeDesktopAiTabSelection,
} from '../../../renderer/utils/desktopTabSelectionSync';

// Cmd+Shift+J delegates to the shared tile action. Mocked so the test asserts the
// wiring rather than re-running the layout transform (covered in tileNewTab.test).
const { mockTileNewTabInSession } = vi.hoisted(() => ({ mockTileNewTabInSession: vi.fn() }));
vi.mock('../../../renderer/services/tileNewTabAction', () => ({
	tileNewTabInSession: (...args: unknown[]) => mockTileNewTabInSession(...args),
}));

/**
 * Creates a minimal mock context with all required handler functions.
 * The keyboard handler requires these functions to be present to avoid
 * "is not a function" errors when processing keyboard events.
 *
 * Active Session is resolved at event time via selectActiveSession(getState()).
 * Passing `activeSession` (or `sessions`) seeds useSessionStore; it is not
 * kept on the keyboardHandlerRef context object.
 */
function createMockContext(overrides: Record<string, unknown> = {}) {
	const { activeSession: activeSessionOverride, ...rest } = overrides;

	// Seed the store for event-time Session reads. Only sync when the test
	// explicitly provides `sessions` or `activeSession` so suites that
	// pre-seed the store (e.g. output-search Cmd+F) are not wiped.
	// When both are provided, merge activeSession into the matching list entry
	// so thin `sessions` arrays (used for length gates) do not wipe chrome fields
	// like inputMode that shortcuts read via selectActiveSession.
	if ('sessions' in rest) {
		const sessions = Array.isArray(rest.sessions) ? [...rest.sessions] : [];
		if (
			activeSessionOverride &&
			typeof activeSessionOverride === 'object' &&
			activeSessionOverride !== null
		) {
			const session = activeSessionOverride as { id: string };
			const idx = sessions.findIndex(
				(s) => s && typeof s === 'object' && (s as { id?: string }).id === session.id
			);
			if (idx >= 0) {
				sessions[idx] = { ...(sessions[idx] as object), ...session };
			} else {
				sessions.push(session);
			}
		}
		const activeSessionId =
			'activeSessionId' in rest
				? (rest.activeSessionId as string)
				: activeSessionOverride &&
					  typeof activeSessionOverride === 'object' &&
					  activeSessionOverride !== null &&
					  'id' in activeSessionOverride
					? String((activeSessionOverride as { id: string }).id)
					: undefined;
		useSessionStore.setState({
			sessions: sessions as never,
			...(activeSessionId !== undefined ? { activeSessionId } : {}),
		});
	} else if (
		activeSessionOverride &&
		typeof activeSessionOverride === 'object' &&
		activeSessionOverride !== null
	) {
		const session = activeSessionOverride as { id: string };
		useSessionStore.setState({
			sessions: [session] as never,
			activeSessionId: 'activeSessionId' in rest ? (rest.activeSessionId as string) : session.id,
		});
	} else if (activeSessionOverride === null) {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
	}

	return {
		hasOpenLayers: () => false,
		hasOpenModal: () => false,
		editingSessionId: null,
		editingGroupId: null,
		handleSidebarNavigation: vi.fn().mockReturnValue(false),
		handleEnterToActivate: vi.fn().mockReturnValue(false),
		handleTabNavigation: vi.fn().mockReturnValue(false),
		handleEscapeInMain: vi.fn().mockReturnValue(false),
		isShortcut: () => false,
		isTabShortcut: () => false,
		handleNewTab: vi.fn(),
		// Ctrl+Cmd pane family - reached (and called) whenever the active session has
		// a tiled group, so it must exist even for tests that only care about a
		// non-pane shortcut.
		isPaneShortcut: () => false,
		// Same reason: a shortcut that moves focus as part of its action calls this
		// on the way through, so it has to exist even for tests that only assert on
		// what the action changed. Missing, it throws inside the dispatched
		// listener - which jsdom turns into an uncaught exception rather than a
		// failure, so the test still reports pass while the rest of the handler
		// (the trackShortcut call) silently never runs.
		setActiveFocus: vi.fn(),
		sessions: [],
		activeSessionId: '',
		activeGroupChatId: null,
		...rest,
	};
}

describe('useMainKeyboardHandler', () => {
	// Track event listeners for cleanup
	let addedListeners: { type: string; handler: EventListener }[] = [];
	let originalMaestro: unknown;
	const originalAddEventListener = window.addEventListener;
	const originalRemoveEventListener = window.removeEventListener;

	beforeEach(() => {
		addedListeners = [];
		clearDesktopAiTabSelections();
		// Hoisted module mocks survive across tests in this file, so a "did NOT
		// fire" assertion would otherwise read calls left by an earlier case.
		mockTileNewTabInSession.mockClear();
		originalMaestro = (window as any).maestro;
		const maestroObj = ((window as any).maestro ?? {}) as Record<string, unknown>;
		const processObj = ((maestroObj.process as Record<string, unknown> | undefined) ??
			{}) as Record<string, unknown>;
		(window as any).maestro = {
			...maestroObj,
			process: {
				...processObj,
				write: vi.fn(),
			},
		};
		window.addEventListener = vi.fn((type, handler) => {
			addedListeners.push({ type, handler: handler as EventListener });
			originalAddEventListener.call(window, type, handler as EventListener);
		});
		window.removeEventListener = vi.fn((type, handler) => {
			addedListeners = addedListeners.filter((l) => !(l.type === type && l.handler === handler));
			originalRemoveEventListener.call(window, type, handler as EventListener);
		});
		// Reset modal store so draft/wizard confirmation tests start clean
		useModalStore.getState().closeModal('confirm');
		useModalStore.getState().closeModal('promptComposer');
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
	});

	afterEach(() => {
		window.addEventListener = originalAddEventListener;
		window.removeEventListener = originalRemoveEventListener;
		(window as any).maestro = originalMaestro;
	});

	describe('hook initialization', () => {
		it('should return keyboardHandlerRef and showSessionJumpNumbers', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			expect(result.current.keyboardHandlerRef).toBeDefined();
			expect(result.current.keyboardHandlerRef.current).toBeNull();
			expect(result.current.showSessionJumpNumbers).toBe(false);
		});

		it('should attach keydown, keyup, and blur listeners', () => {
			renderHook(() => useMainKeyboardHandler());

			const listenerTypes = addedListeners.map((l) => l.type);
			expect(listenerTypes).toContain('keydown');
			expect(listenerTypes).toContain('keyup');
			expect(listenerTypes).toContain('blur');
		});

		it('should remove listeners on unmount', () => {
			const { unmount } = renderHook(() => useMainKeyboardHandler());
			unmount();

			// After unmount, window.removeEventListener should have been called
			expect(window.removeEventListener).toHaveBeenCalled();
		});
	});

	describe('browser refresh blocking', () => {
		it('should prevent Cmd+R', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			// Set up context with all required handlers
			result.current.keyboardHandlerRef.current = createMockContext();

			const event = new KeyboardEvent('keydown', {
				key: 'r',
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
		});

		it('should prevent Ctrl+R', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext();

			const event = new KeyboardEvent('keydown', {
				key: 'R',
				ctrlKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
		});
	});

	describe('Prompt Composer shortcut', () => {
		it('flushes the active group chat draft before opening the composer', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const flushGroupChatDraft = vi.fn(() => {
				expect(useModalStore.getState().isOpen('promptComposer')).toBe(false);
			});

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'openPromptComposer',
				activeSession: { id: 'session-1', inputMode: 'ai' },
				activeGroupChatId: 'group-chat-1',
				flushGroupChatDraft,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'p',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(flushGroupChatDraft).toHaveBeenCalledOnce();
			expect(useModalStore.getState().isOpen('promptComposer')).toBe(true);
		});
	});

	describe('refresh files, git, history', () => {
		it('runs the same refresh handler the palette entry uses', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockRefresh = vi.fn().mockResolvedValue(undefined);
			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (e: KeyboardEvent, actionId: string) =>
					actionId === 'refreshGitFileState' && e.altKey && e.metaKey && e.key === 'r',
				sessions: [{ id: 'test' }],
				handleQuickActionsRefreshGitFileState: mockRefresh,
			});

			const event = new KeyboardEvent('keydown', {
				key: 'r',
				altKey: true,
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(mockRefresh).toHaveBeenCalled();
			expect(preventDefaultSpy).toHaveBeenCalled();
		});
	});

	describe('showSessionJumpNumbers state', () => {
		it('should show badges when Alt+Cmd are pressed together', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			expect(result.current.showSessionJumpNumbers).toBe(false);

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Alt',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(true);
		});

		it('should hide badges when Alt is released', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			// First, show the badges
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Alt',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(true);

			// Release Alt key
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keyup', {
						key: 'Alt',
						altKey: false,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(false);
		});

		it('should hide badges when Cmd is released', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			// First, show the badges
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Alt',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(true);

			// Release Meta key
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keyup', {
						key: 'Meta',
						altKey: true,
						metaKey: false,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(false);
		});

		it('should hide badges on window blur', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			// First, show the badges
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Alt',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(true);

			// Blur window
			act(() => {
				window.dispatchEvent(new FocusEvent('blur'));
			});

			expect(result.current.showSessionJumpNumbers).toBe(false);
		});
	});

	describe('modal/layer interaction', () => {
		it('should skip shortcut handling when editing session name', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleSidebar = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				editingSessionId: 'session-123',
				isShortcut: () => true,
				setLeftSidebarOpen: mockToggleSidebar,
				sessions: [{ id: 'test' }],
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'b',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Should not have called any shortcut handlers
			expect(mockToggleSidebar).not.toHaveBeenCalled();
		});

		it('should skip shortcut handling when editing group name', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleSidebar = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				editingGroupId: 'group-123',
				isShortcut: () => true,
				setLeftSidebarOpen: mockToggleSidebar,
				sessions: [{ id: 'test' }],
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'b',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Should not have called any shortcut handlers
			expect(mockToggleSidebar).not.toHaveBeenCalled();
		});

		it('should allow Tab when layers are open for accessibility', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockTabNav = vi.fn().mockReturnValue(true);
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				handleTabNavigation: mockTabNav,
			});

			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
			});

			act(() => {
				window.dispatchEvent(event);
			});

			// Tab should be allowed through (early return, not handled by modal logic)
			// The event should NOT be prevented when Tab is pressed with layers open
		});

		it('keeps the Concerto keys live while a modal is open', () => {
			// The stage is a modal itself, so a toggle blocked by the modal guard
			// could only ever open it; cadenzas float above every modal, so stashing
			// them has to work from anywhere too.
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				encoreFeatures: { concerto: true },
				isShortcut: (e: KeyboardEvent, actionId: string) =>
					actionId === 'toggleConcerto' && e.altKey && e.code === 'KeyC',
			});

			expect(useModalStore.getState().isOpen('concertoStage')).toBe(false);

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true })
				);
			});

			expect(useModalStore.getState().isOpen('concertoStage')).toBe(true);
		});

		it('still blocks the Concerto keys when the Encore Feature is off', () => {
			useModalStore.getState().closeModal('concertoStage');
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				encoreFeatures: { concerto: false },
				isShortcut: (e: KeyboardEvent, actionId: string) =>
					actionId === 'toggleConcerto' && e.altKey && e.code === 'KeyC',
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true })
				);
			});

			expect(useModalStore.getState().isOpen('concertoStage')).toBe(false);
		});

		it('should allow layout shortcuts (Alt+Cmd+Arrow) when modals are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetLeftSidebar = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				isShortcut: (e: KeyboardEvent, actionId: string) => {
					if (actionId === 'toggleSidebar') {
						return e.altKey && e.metaKey && e.key === 'ArrowLeft';
					}
					return false;
				},
				sessions: [{ id: 'test' }],
				leftSidebarOpen: true,
				setLeftSidebarOpen: mockSetLeftSidebar,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'ArrowLeft',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Layout shortcuts should work even when modal is open
			expect(mockSetLeftSidebar).toHaveBeenCalled();
		});

		it('should allow next-unread when modals are open, at whatever key it is bound to', () => {
			// Resolved through the BINDING, not a hard-coded Alt+Cmd+ArrowDown: a
			// user who rebound next-unread got a shortcut that silently died the
			// moment any modal was open, including the Shortcuts pane itself.
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockGoToNextUnreadTab = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				isShortcut: (e: KeyboardEvent, actionId: string) =>
					actionId === 'nextUnreadTab' && e.shiftKey && e.metaKey && e.key === 'u',
				sessions: [{ id: 'test' }],
				goToNextUnreadTab: mockGoToNextUnreadTab,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'u',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockGoToNextUnreadTab).toHaveBeenCalled();
		});

		it('should allow tab management shortcuts (Cmd+T) when only overlays are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockHandleNewTab = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockInputRef = { current: { focus: vi.fn() } };
			const mockActiveSession = {
				id: 'test-session',
				name: 'Test',
				inputMode: 'ai',
				aiTabs: [],
				activeTabId: 'tab-1',
				unifiedTabOrder: [],
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (e.g., file preview)
				hasOpenModal: () => false, // But no true modal
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
				activeSessionId: 'test-session',
				activeSession: mockActiveSession,
				handleNewTab: mockHandleNewTab,
				setActiveFocus: mockSetActiveFocus,
				inputRef: mockInputRef,
				defaultSaveToHistory: true,
				defaultShowThinking: 'on',
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 't',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Cmd+T should create a new tab even when file preview overlay is open
			expect(mockHandleNewTab).toHaveBeenCalledOnce();
			expect(mockSetActiveFocus).toHaveBeenCalledWith('main');
		});

		it('should allow tab switcher shortcut (Alt+Cmd+T) when only overlays are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetTabSwitcherOpen = vi.fn();
			const mockActiveSession = {
				id: 'test-session',
				name: 'Test',
				inputMode: 'ai',
				aiTabs: [],
				activeTabId: 'tab-1',
				unifiedTabOrder: [],
			};
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (e.g., file preview)
				hasOpenModal: () => false, // But no true modal
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'tabSwitcher',
				activeSessionId: 'test-session',
				activeSession: mockActiveSession,
				setTabSwitcherOpen: mockSetTabSwitcherOpen,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 't', // Alt key changes the key on macOS, but we use code
						code: 'KeyT',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Alt+Cmd+T should open tab switcher even when file preview overlay is open
			expect(mockSetTabSwitcherOpen).toHaveBeenCalledWith(true);
		});

		it('should allow reopen closed tab shortcut (Cmd+Shift+T) when only overlays are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetSessions = vi.fn();
			const mockReopenUnifiedClosedTab = vi.fn().mockReturnValue({
				session: { id: 'test-session', unifiedClosedTabHistory: [] },
				type: 'file',
				tab: { id: 'restored-tab' },
			});
			const mockActiveSession = {
				id: 'test-session',
				name: 'Test',
				inputMode: 'ai',
				aiTabs: [],
				unifiedClosedTabHistory: [{ type: 'file', tab: { id: 'closed-tab' } }],
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (e.g., file preview)
				hasOpenModal: () => false, // But no true modal
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'reopenClosedTab',
				activeSessionId: 'test-session',
				activeSession: mockActiveSession,
				reopenUnifiedClosedTab: mockReopenUnifiedClosedTab,
				setSessions: mockSetSessions,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 't',
						shiftKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Cmd+Shift+T should reopen closed tab even when file preview overlay is open
			expect(mockReopenUnifiedClosedTab).toHaveBeenCalledWith(mockActiveSession);
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('should allow toggleMode shortcut (Cmd+J) when only overlays are open', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockHandleOpenTerminalTab = vi.fn();
			const mockActiveSession = {
				id: 'test-session',
				name: 'Test',
				inputMode: 'ai',
				aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }],
				activeTabId: 'tab-1',
				filePreviewTabs: [{ id: 'file-tab-1', path: '/test.ts' }],
				activeFileTabId: 'file-tab-1', // File preview is active
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (file preview)
				hasOpenModal: () => false, // But no true modal
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleMode',
				activeSessionId: 'test-session',
				activeSession: mockActiveSession,
				handleOpenTerminalTab: mockHandleOpenTerminalTab,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Cmd+J should open a new terminal tab even when file preview overlay is open
			expect(mockHandleOpenTerminalTab).toHaveBeenCalled();
		});

		it('tiles a new terminal below on tileTerminalBelow (Ctrl+Cmd+J)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockHandleOpenTerminalTab = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				isPaneShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'tileTerminalBelow',
				activeSessionId: 'test-session',
				activeSession: { id: 'test-session', name: 'Test', inputMode: 'ai', aiTabs: [] },
				handleOpenTerminalTab: mockHandleOpenTerminalTab,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						metaKey: true,
						ctrlKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockTileNewTabInSession).toHaveBeenCalledWith('test-session', 'terminal');
			// The tiled twin must not also run the plain "new terminal tab" path.
			expect(mockHandleOpenTerminalTab).not.toHaveBeenCalled();
		});

		it.each([
			['tileAiBelow', 'ai', 't'],
			['tileBrowserBelow', 'browser', 'b'],
			['tileFileBelow', 'file', 'f'],
		])('tiles a new %s tab on its Ctrl+Cmd chord', (shortcutId, kind, key) => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				isPaneShortcut: (_e: KeyboardEvent, actionId: string) => actionId === shortcutId,
				activeSessionId: 'test-session',
				activeSession: { id: 'test-session', name: 'Test', inputMode: 'ai', aiTabs: [] },
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key, metaKey: true, ctrlKey: true, bubbles: true })
				);
			});

			expect(mockTileNewTabInSession).toHaveBeenCalledWith('test-session', kind);
		});

		it('does not tile when only the general matcher would fire (plain Cmd+T)', () => {
			// The family lives on Ctrl+Cmd and is matched by isPaneShortcut. Routing
			// it through isShortcut instead would fire on a bare Cmd+T, because that
			// matcher folds Ctrl and Cmd into one modifier.
			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'tileAiBelow',
				isPaneShortcut: () => false,
				activeSessionId: 'test-session',
				activeSession: { id: 'test-session', name: 'Test', inputMode: 'ai', aiTabs: [] },
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true })
				);
			});

			expect(mockTileNewTabInSession).not.toHaveBeenCalled();
		});

		it('should allow tab cycle shortcut with brace characters when layers are open', () => {
			// On macOS, Shift+[ produces '{' and Shift+] produces '}'
			// The overlay guard must recognize brace characters as tab cycle shortcuts
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSession = {
				id: 'test-session',
				name: 'Test',
				inputMode: 'ai',
				aiTabs: [{ id: 'ai-tab-1', name: 'Tab 1', logs: [] }],
				activeTabId: 'ai-tab-1',
				filePreviewTabs: [{ id: 'file-tab-1', path: '/test.ts', name: 'test', extension: '.ts' }],
				activeFileTabId: 'file-tab-1',
				unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
			};
			const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
				session: { ...mockSession, activeFileTabId: null },
			});
			const mockSetSessions = vi.fn((updater: unknown) => {
				if (typeof updater === 'function') {
					(updater as (prev: unknown[]) => unknown[])([mockSession]);
				}
			});

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (file preview layer)
				hasOpenModal: () => false,
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
				activeSessionId: 'test-session',
				activeSession: mockSession,
				navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
				setSessions: mockSetSessions,
				showUnreadOnly: false,
			});

			// Dispatch with '}' (brace) key, as produced by Shift+] on macOS
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '}',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});

			// The brace character should be recognized as a tab cycle shortcut
			// and pass through the overlay guard
			expect(mockSetSessions).toHaveBeenCalled();
			expect(mockNavigateToNextUnifiedTab).toHaveBeenCalled();
		});

		it('should allow tab cycle shortcut with opening brace when layers are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSession = {
				id: 'test-session',
				name: 'Test',
				inputMode: 'ai',
				aiTabs: [{ id: 'ai-tab-1', name: 'Tab 1', logs: [] }],
				activeTabId: 'ai-tab-1',
				filePreviewTabs: [{ id: 'file-tab-1', path: '/test.ts', name: 'test', extension: '.ts' }],
				activeFileTabId: 'file-tab-1',
				unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
			};
			const mockNavigateToPrevUnifiedTab = vi.fn().mockReturnValue({
				session: { ...mockSession, activeFileTabId: null },
			});
			const mockSetSessions = vi.fn((updater: unknown) => {
				if (typeof updater === 'function') {
					(updater as (prev: unknown[]) => unknown[])([mockSession]);
				}
			});

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => false,
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
				activeSessionId: 'test-session',
				activeSession: mockSession,
				navigateToPrevUnifiedTab: mockNavigateToPrevUnifiedTab,
				setSessions: mockSetSessions,
				showUnreadOnly: false,
			});

			// Dispatch with '{' (brace) key, as produced by Shift+[ on macOS
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '{',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetSessions).toHaveBeenCalled();
			expect(mockNavigateToPrevUnifiedTab).toHaveBeenCalled();
		});
	});

	describe('session cycle preventDefault', () => {
		it('should call preventDefault on cyclePrev (Cmd+[)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockCycleSession = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'cyclePrev',
				cycleSession: mockCycleSession,
			});

			const event = new KeyboardEvent('keydown', {
				key: '[',
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(mockCycleSession).toHaveBeenCalledWith('prev');
		});

		it('should call preventDefault on cycleNext (Cmd+])', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockCycleSession = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'cycleNext',
				cycleSession: mockCycleSession,
			});

			const event = new KeyboardEvent('keydown', {
				key: ']',
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(mockCycleSession).toHaveBeenCalledWith('next');
		});
	});

	describe('navigation handlers delegation', () => {
		it('should delegate to handleSidebarNavigation', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSidebarNav = vi.fn().mockReturnValue(true);
			result.current.keyboardHandlerRef.current = createMockContext({
				handleSidebarNavigation: mockSidebarNav,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'ArrowDown',
						bubbles: true,
					})
				);
			});

			expect(mockSidebarNav).toHaveBeenCalled();
		});

		it('should delegate to handleEnterToActivate', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockEnterActivate = vi.fn().mockReturnValue(true);
			result.current.keyboardHandlerRef.current = createMockContext({
				handleEnterToActivate: mockEnterActivate,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Enter',
						bubbles: true,
					})
				);
			});

			expect(mockEnterActivate).toHaveBeenCalled();
		});
	});

	describe('session jump shortcuts', () => {
		it('should jump to session by number (Alt+Cmd+1)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetActiveSessionId = vi.fn();
			const mockSetLeftSidebarOpen = vi.fn();
			const visibleSessions = [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }];

			result.current.keyboardHandlerRef.current = createMockContext({
				visibleSessions,
				setActiveSessionId: mockSetActiveSessionId,
				leftSidebarOpen: true,
				setLeftSidebarOpen: mockSetLeftSidebarOpen,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '1',
						code: 'Digit1',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetActiveSessionId).toHaveBeenCalledWith('session-1');
		});

		it('should expand sidebar when jumping to session', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetActiveSessionId = vi.fn();
			const mockSetLeftSidebarOpen = vi.fn();
			const visibleSessions = [{ id: 'session-1' }];

			result.current.keyboardHandlerRef.current = createMockContext({
				visibleSessions,
				setActiveSessionId: mockSetActiveSessionId,
				leftSidebarOpen: false, // Sidebar is closed
				setLeftSidebarOpen: mockSetLeftSidebarOpen,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '1',
						code: 'Digit1',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetLeftSidebarOpen).toHaveBeenCalledWith(true);
		});

		it('should use 0 as 10th session', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetActiveSessionId = vi.fn();
			const visibleSessions = Array.from({ length: 10 }, (_, i) => ({
				id: `session-${i + 1}`,
			}));

			result.current.keyboardHandlerRef.current = createMockContext({
				visibleSessions,
				setActiveSessionId: mockSetActiveSessionId,
				leftSidebarOpen: true,
				setLeftSidebarOpen: vi.fn(),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '0',
						code: 'Digit0',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetActiveSessionId).toHaveBeenCalledWith('session-10');
		});
	});

	describe('wizard tab restrictions', () => {
		it('should allow toggleMode (Cmd+J) for wizard tabs to open a new terminal tab', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockHandleOpenTerminalTab = vi.fn();
			const wizardTab = {
				id: 'tab-1',
				name: 'Wizard',
				wizardState: { isActive: true },
				logs: [],
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleMode',
				activeSession: {
					id: 'session-1',
					aiTabs: [wizardTab],
					activeTabId: 'tab-1',
					inputMode: 'ai',
				},
				activeSessionId: 'session-1',
				handleOpenTerminalTab: mockHandleOpenTerminalTab,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Cmd+J opens a new terminal tab - safe in wizard tabs since it doesn't
			// touch the wizard tab's input/state.
			expect(mockHandleOpenTerminalTab).toHaveBeenCalled();
		});

		it('should allow toggleMode (Cmd+J) for regular tabs', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockHandleOpenTerminalTab = vi.fn();
			const regularTab = {
				id: 'tab-1',
				name: 'Regular Tab',
				logs: [],
				// No wizardState
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleMode',
				activeSession: {
					id: 'session-1',
					aiTabs: [regularTab],
					activeTabId: 'tab-1',
					inputMode: 'ai',
				},
				activeSessionId: 'session-1',
				handleOpenTerminalTab: mockHandleOpenTerminalTab,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// handleOpenTerminalTab SHOULD be called for regular tabs
			expect(mockHandleOpenTerminalTab).toHaveBeenCalled();
		});

		it('should allow toggleMode when wizardState exists but isActive is false', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockHandleOpenTerminalTab = vi.fn();
			const completedWizardTab = {
				id: 'tab-1',
				name: 'Completed Wizard',
				wizardState: { isActive: false }, // Wizard completed
				logs: [],
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleMode',
				activeSession: {
					id: 'session-1',
					aiTabs: [completedWizardTab],
					activeTabId: 'tab-1',
					inputMode: 'ai',
				},
				activeSessionId: 'session-1',
				handleOpenTerminalTab: mockHandleOpenTerminalTab,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// handleOpenTerminalTab SHOULD be called when wizard is not active
			expect(mockHandleOpenTerminalTab).toHaveBeenCalled();
		});
	});

	describe('unified tab shortcuts - file tab vs AI tab context', () => {
		/**
		 * Helper to create a session context with both AI tabs and file tabs.
		 * Uses unifiedTabOrder to establish combined ordering.
		 */
		function createUnifiedTabContext(overrides: Record<string, unknown> = {}) {
			const aiTab1 = { id: 'ai-tab-1', name: 'AI Tab 1', logs: [] };
			const aiTab2 = { id: 'ai-tab-2', name: 'AI Tab 2', logs: [] };
			const fileTab1 = {
				id: 'file-tab-1',
				path: '/test/file1.ts',
				name: 'file1',
				extension: '.ts',
			};
			const fileTab2 = {
				id: 'file-tab-2',
				path: '/test/file2.ts',
				name: 'file2',
				extension: '.ts',
			};

			return createMockContext({
				activeSession: {
					id: 'session-1',
					aiTabs: [aiTab1, aiTab2],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [fileTab1, fileTab2],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1', 'file-tab-1', 'ai-tab-2', 'file-tab-2'],
					unifiedClosedTabHistory: [],
					inputMode: 'ai',
				},
				activeSessionId: 'session-1',
				showUnreadOnly: false,
				...overrides,
			});
		}

		describe('Cmd+W (closeTab)', () => {
			it('should close file tab when a file tab is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({ type: 'file' });
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					setSessions: mockSetSessions,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [
							{ id: 'file-tab-1', path: '/test/file.ts', name: 'file', extension: '.ts' },
						],
						activeFileTabId: 'file-tab-1', // File tab is active
						unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockHandleCloseCurrentTab).toHaveBeenCalled();
			});

			it('should close AI tab when no file tab is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({
					type: 'ai',
					tabId: 'ai-tab-2',
					isWizardTab: false,
				});
				const mockPerformTabClose = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					performTabClose: mockPerformTabClose,
					activeSession: {
						id: 'session-1',
						aiTabs: [
							{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] },
							{ id: 'ai-tab-2', name: 'AI Tab 2', logs: [] },
						],
						activeTabId: 'ai-tab-2',
						filePreviewTabs: [],
						activeFileTabId: null, // No file tab active
						unifiedTabOrder: ['ai-tab-1', 'ai-tab-2'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockHandleCloseCurrentTab).toHaveBeenCalled();
				// Now uses performTabClose which adds to unifiedClosedTabHistory for Cmd+Shift+T
				expect(mockPerformTabClose).toHaveBeenCalledWith('ai-tab-2');
			});

			it('should show confirmation modal when tab has unsent draft', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({
					type: 'ai',
					tabId: 'ai-tab-2',
					isWizardTab: false,
					hasDraft: true,
				});
				const mockPerformTabClose = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					performTabClose: mockPerformTabClose,
					activeSession: {
						id: 'session-1',
						aiTabs: [
							{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] },
							{ id: 'ai-tab-2', name: 'AI Tab 2', logs: [] },
						],
						activeTabId: 'ai-tab-2',
						filePreviewTabs: [],
						activeFileTabId: null,
						unifiedTabOrder: ['ai-tab-1', 'ai-tab-2'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				// Should NOT close directly - should show confirmation modal
				expect(mockPerformTabClose).not.toHaveBeenCalled();
				expect(useModalStore.getState().isOpen('confirm')).toBe(true);
				const modal = useModalStore.getState().modals.get('confirm');
				expect((modal?.data as any)?.message).toContain('unsent draft');
			});

			it('should prevent closing when it is the last AI tab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({ type: 'prevented' });
				const mockPerformTabClose = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					performTabClose: mockPerformTabClose,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [],
						activeFileTabId: null,
						unifiedTabOrder: ['ai-tab-1'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				// performTabClose should NOT be called when it's the last AI tab
				expect(mockPerformTabClose).not.toHaveBeenCalled();
			});
		});

		describe('Cmd+Shift+[ and Cmd+Shift+] (tab cycling)', () => {
			it('records desktop selection intent when cycling onto an AI tab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const mockSession = {
					id: 'session-1',
					aiTabs: [
						{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] },
						{ id: 'ai-tab-2', name: 'AI Tab 2', logs: [] },
					],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1', 'ai-tab-2'],
					inputMode: 'ai',
				};
				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
					type: 'ai',
					id: 'ai-tab-2',
					session: { ...mockSession, activeTabId: 'ai-tab-2' },
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
					activeSession: mockSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: ']',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(consumeDesktopAiTabSelection('session-1', 'ai-tab-2')).toBe(true);
			});

			it('should navigate to next tab in unified order (Cmd+Shift+])', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [
						{ id: 'file-tab-1', path: '/test/file1.ts', name: 'file1', extension: '.ts' },
					],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
					inputMode: 'ai',
				};
				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
					session: { ...mockSession, activeFileTabId: 'file-tab-1' },
				});
				// setSessions invokes the updater so navigation runs inside it
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
					activeSession: mockSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: ']',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
				expect(mockNavigateToNextUnifiedTab).toHaveBeenCalledWith(mockSession, false);
			});

			it('should navigate to previous tab in unified order (Cmd+Shift+[)', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [
						{ id: 'file-tab-1', path: '/test/file1.ts', name: 'file1', extension: '.ts' },
					],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
					inputMode: 'ai',
				};
				const mockNavigateToPrevUnifiedTab = vi.fn().mockReturnValue({
					session: { ...mockSession, activeFileTabId: 'file-tab-1' },
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
					navigateToPrevUnifiedTab: mockNavigateToPrevUnifiedTab,
					setSessions: mockSetSessions,
					activeSession: mockSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '[',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
				expect(mockNavigateToPrevUnifiedTab).toHaveBeenCalledWith(mockSession, false);
			});

			it('should pass showUnreadOnly filter to navigation', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1'],
					inputMode: 'ai',
				};
				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1' },
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
					showUnreadOnly: true, // Filter is active
					activeSession: mockSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: ']',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockNavigateToNextUnifiedTab).toHaveBeenCalledWith(
					mockSession,
					true // showUnreadOnly passed
				);
			});

			it('should use current session from setSessions updater, not a stale snapshot (stale-state safety)', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const staleSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1'],
					inputMode: 'ai',
				};
				const freshSession = {
					...staleSession,
					activeFileTabId: 'file-tab-1', // Updated by a concurrent operation
				};
				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
					session: { ...freshSession, activeTabId: 'ai-tab-2' },
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						// The updater receives the FRESH sessions from the store
						(updater as (prev: unknown[]) => unknown[])([freshSession]);
					}
				});

				// Seed store with stale snapshot so event-time selectActiveSession passes
				// the outer gate; navigation must still read freshness from setSessions(prev).
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
					activeSession: staleSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: ']',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				// Navigation should use the FRESH session from the setSessions updater, not the seed
				expect(mockNavigateToNextUnifiedTab).toHaveBeenCalledWith(freshSession, false);
			});
		});

		describe('Cmd+1-9 (tab jumping by index)', () => {
			it('should jump to AI tab at index 0 with Cmd+1', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [
						{ id: 'file-tab-1', path: '/test/file1.ts', name: 'file1', extension: '.ts' },
					],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
					inputMode: 'ai',
				};
				const mockNavigateToUnifiedTabByIndex = vi.fn().mockReturnValue({
					session: { ...mockSession, activeTabId: 'ai-tab-1', activeFileTabId: null },
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab1',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
					activeSession: mockSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '1',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockNavigateToUnifiedTabByIndex).toHaveBeenCalledWith(
					mockSession,
					0, // index 0 for Cmd+1
					false // showUnreadOnly
				);
			});

			it('should jump to file tab at index 1 with Cmd+2', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSession = {
					id: 'session-1',
					aiTabs: [
						{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] },
						{ id: 'ai-tab-2', name: 'AI Tab 2', logs: [] },
					],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [
						{ id: 'file-tab-1', path: '/test/file1.ts', name: 'file1', extension: '.ts' },
					],
					activeFileTabId: null,
					unifiedTabOrder: ['ai-tab-1', 'file-tab-1', 'ai-tab-2'],
					inputMode: 'ai',
				};
				const mockNavigateToUnifiedTabByIndex = vi.fn().mockReturnValue({
					session: { ...mockSession, activeTabId: 'ai-tab-1', activeFileTabId: 'file-tab-1' },
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab2',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
					activeSession: mockSession,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '2',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockNavigateToUnifiedTabByIndex).toHaveBeenCalledWith(
					mockSession,
					1, // index 1 for Cmd+2
					false // showUnreadOnly
				);
			});

			it('forwards showUnreadOnly so Cmd+1 jumps to the Nth visible tab when filter is on', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					unifiedTabOrder: ['ai-tab-1'],
					inputMode: 'ai',
				};
				const mockNavigateToUnifiedTabByIndex = vi.fn().mockReturnValue({
					session: mockSession,
				});
				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab1',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
					activeSession: mockSession,
					showUnreadOnly: true,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '1',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockNavigateToUnifiedTabByIndex).toHaveBeenCalledWith(mockSession, 0, true);
			});
		});

		describe('Cmd+0 jumps to last tab, Cmd+Shift+0 resets font size', () => {
			it('should jump to last tab on Cmd+0', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				// Set font size to non-default to verify it does NOT reset
				useSettingsStore.setState({ fontSize: 20 });

				const mockNavigateToLastUnifiedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1' },
				});

				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					navigateToLastUnifiedTab: mockNavigateToLastUnifiedTab,
					setSessions: mockSetSessions,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '0',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				// Cmd+0 should trigger tab navigation, NOT reset font size
				expect(mockSetSessions).toHaveBeenCalled();
				expect(useSettingsStore.getState().fontSize).toBe(20);
			});

			it('should reset the font zoom on Cmd+Shift+0', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				// The shortcut resets the zoom multiplier, not the stored sizes.
				useSettingsStore.setState({ fontSize: 20, fontZoom: 1.5 });

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'fontSizeReset',
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: ')',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(useSettingsStore.getState().fontZoom).toBe(1);
				expect(useSettingsStore.getState().fontSize).toBe(20);
			});
		});

		describe('Cmd+Shift+T (reopen closed tab)', () => {
			it('should reopen from unified closed tab history', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockReopenUnifiedClosedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1' },
					tab: { id: 'reopened-tab' },
					wasFile: true,
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'reopenClosedTab',
					reopenUnifiedClosedTab: mockReopenUnifiedClosedTab,
					setSessions: mockSetSessions,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 't',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockReopenUnifiedClosedTab).toHaveBeenCalled();
				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('should not update sessions when no closed tab to reopen', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockReopenUnifiedClosedTab = vi.fn().mockReturnValue(null);
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'reopenClosedTab',
					reopenUnifiedClosedTab: mockReopenUnifiedClosedTab,
					setSessions: mockSetSessions,
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 't',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockReopenUnifiedClosedTab).toHaveBeenCalled();
				expect(mockSetSessions).not.toHaveBeenCalled();
			});
		});

		describe('tab shortcuts disabled in group chat', () => {
			it('should not execute tab shortcuts when group chat is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleNewTab = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					handleNewTab: mockHandleNewTab,
					activeGroupChatId: 'group-chat-123', // Group chat is active
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 't',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				// Tab shortcuts should be disabled in group chat mode
				expect(mockHandleNewTab).not.toHaveBeenCalled();
			});
		});

		describe('tab shortcuts in terminal mode', () => {
			it('Cmd+T creates a new AI tab even when in terminal mode', () => {
				vi.useFakeTimers();
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleNewTab = vi.fn();
				const mockSetActiveFocus = vi.fn();
				const mockFocus = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					handleNewTab: mockHandleNewTab,
					setActiveFocus: mockSetActiveFocus,
					inputRef: { current: { focus: mockFocus } },
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [],
						activeFileTabId: null,
						unifiedTabOrder: ['ai-tab-1'],
						inputMode: 'terminal',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 't',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				// Cmd+T should work regardless of inputMode
				expect(mockHandleNewTab).toHaveBeenCalledOnce();

				// setActiveFocus should switch focus to main
				expect(mockSetActiveFocus).toHaveBeenCalledWith('main');

				// Input should be focused after the render delay
				act(() => {
					vi.advanceTimersByTime(50);
				});
				expect(mockFocus).toHaveBeenCalled();

				vi.useRealTimers();
			});
		});

		describe('AI-tab metadata toggles gated to AI chat tabs', () => {
			it('Cmd+S toggles save-to-history when an AI chat tab is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) =>
						actionId === 'toggleSaveToHistory',
					setSessions: mockSetSessions,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [],
						activeFileTabId: null, // AI chat tab is active
						unifiedTabOrder: ['ai-tab-1'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('Cmd+S does NOT toggle save-to-history when a file tab is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) =>
						actionId === 'toggleSaveToHistory',
					setSessions: mockSetSessions,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [
							{ id: 'file-tab-1', path: '/test/file.ts', name: 'file', extension: '.ts' },
						],
						activeFileTabId: 'file-tab-1', // File tab is active - inputMode stays 'ai'
						unifiedTabOrder: ['ai-tab-1', 'file-tab-1'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })
					);
				});

				// The toggle must not mutate the (hidden) last-visited AI tab.
				expect(mockSetSessions).not.toHaveBeenCalled();
			});

			it('Cmd+S does NOT toggle save-to-history when a browser tab is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) =>
						actionId === 'toggleSaveToHistory',
					setSessions: mockSetSessions,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [],
						activeFileTabId: null,
						browserTabs: [{ id: 'browser-tab-1', url: 'https://example.com' }],
						activeBrowserTabId: 'browser-tab-1', // Browser tab is active
						unifiedTabOrder: ['ai-tab-1', 'browser-tab-1'],
						inputMode: 'ai',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })
					);
				});

				expect(mockSetSessions).not.toHaveBeenCalled();
			});
		});

		// Unified tab shortcuts in terminal mode - verifies that tab navigation and
		// management shortcuts work identically whether AI, file, or terminal tabs are active.
		// The keyboard handler uses a single unified block for all tab types; these tests
		// confirm terminal mode is NOT excluded. Prior regressions:
		// - commit e845532a7: Cmd+W stolen by macOS native menu { role: 'close' }
		// - inputMode === 'ai' guard excluded terminal tabs from all tab shortcuts
		describe('terminal tab shortcuts (unified)', () => {
			/**
			 * Helper to create a terminal-mode context.
			 * Uses the unified tab system: handleCloseCurrentTab returns { type: 'terminal', tabId },
			 * and navigation uses navigateToNextUnifiedTab / navigateToPrevUnifiedTab / etc.
			 */
			function createTerminalTabContext(overrides: Record<string, unknown> = {}) {
				return createMockContext({
					activeSession: {
						id: 'session-1',
						inputMode: 'terminal',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						terminalTabs: [
							{ id: 'term-1', name: 'Terminal 1' },
							{ id: 'term-2', name: 'Terminal 2' },
							{ id: 'term-3', name: 'Terminal 3' },
						],
						activeTerminalTabId: 'term-1',
					},
					activeSessionId: 'session-1',
					setSessions: vi.fn(),
					...overrides,
				});
			}

			it('Cmd+W closes the active terminal tab via unified handleCloseCurrentTab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseTerminalTab = vi.fn();
				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({
					type: 'terminal',
					tabId: 'term-1',
				});

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					handleCloseTerminalTab: mockHandleCloseTerminalTab,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockHandleCloseCurrentTab).toHaveBeenCalled();
				expect(mockHandleCloseTerminalTab).toHaveBeenCalledWith('term-1');
			});

			it('Cmd+W does NOT close when handleCloseCurrentTab returns prevented', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseTerminalTab = vi.fn();
				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({
					type: 'prevented',
				});

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					handleCloseTerminalTab: mockHandleCloseTerminalTab,
					activeSession: {
						id: 'session-1',
						inputMode: 'terminal',
						aiTabs: [],
						activeTabId: null,
						terminalTabs: [{ id: 'term-1', name: 'Terminal 1' }],
						activeTerminalTabId: 'term-1',
					},
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockHandleCloseTerminalTab).not.toHaveBeenCalled();
			});

			it('Cmd+Shift+] navigates to next tab via unified navigateToNextUnifiedTab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();
				const mockNavigateNext = vi.fn().mockReturnValue({
					session: { id: 'session-1', inputMode: 'terminal', activeTerminalTabId: 'term-2' },
				});

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					setSessions: mockSetSessions,
					navigateToNextUnifiedTab: mockNavigateNext,
					showUnreadOnly: false,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '}',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('Cmd+Shift+[ navigates to previous tab via unified navigateToPrevUnifiedTab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();
				const mockNavigatePrev = vi.fn().mockReturnValue({
					session: { id: 'session-1', inputMode: 'terminal', activeTerminalTabId: 'term-3' },
				});

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
					setSessions: mockSetSessions,
					navigateToPrevUnifiedTab: mockNavigatePrev,
					showUnreadOnly: false,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '{',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('Cmd+2 jumps to tab by index via unified navigateToUnifiedTabByIndex', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();
				const mockNavigateByIndex = vi.fn().mockReturnValue({
					session: { id: 'session-1', inputMode: 'terminal', activeTerminalTabId: 'term-2' },
				});

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab2',
					setSessions: mockSetSessions,
					navigateToUnifiedTabByIndex: mockNavigateByIndex,
					showUnreadOnly: false,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '2',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('Cmd+0 jumps to last tab via unified navigateToLastUnifiedTab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetSessions = vi.fn();
				const mockNavigateToLast = vi.fn().mockReturnValue({
					session: { id: 'session-1', inputMode: 'terminal', activeTerminalTabId: 'term-3' },
				});

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					setSessions: mockSetSessions,
					navigateToLastUnifiedTab: mockNavigateToLast,
					showUnreadOnly: false,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '0',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('tab shortcuts are disabled in group chat mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn();
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) =>
						actionId === 'closeTab' || actionId === 'nextTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					setSessions: mockSetSessions,
					activeGroupChatId: 'group-1',
					// The next/prev-tab chord is the one exception: it cycles the right
					// panel's tabs instead of doing nothing.
					setRightPanelOpen: vi.fn(),
					setGroupChatRightTab: vi.fn(),
					setActiveFocus: vi.fn(),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'w',
							metaKey: true,
							bubbles: true,
						})
					);
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '}',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				// Group chat mode blocks the entire unified tab shortcuts block
				expect(mockHandleCloseCurrentTab).not.toHaveBeenCalled();
				expect(mockSetSessions).not.toHaveBeenCalled();
			});

			it('Opt+Cmd+T opens tab switcher from terminal mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetTabSwitcherOpen = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'tabSwitcher',
					setTabSwitcherOpen: mockSetTabSwitcherOpen,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 't',
							metaKey: true,
							altKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetTabSwitcherOpen).toHaveBeenCalledWith(true);
			});

			it('Cmd+. focuses terminal in terminal mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockFocusActiveTerminal = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'focusInput',
					setActiveFocus: vi.fn(),
					mainPanelRef: { current: { focusActiveTerminal: mockFocusActiveTerminal } },
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: '.',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockFocusActiveTerminal).toHaveBeenCalled();
			});

			it('Cmd+K opens command palette in terminal mode (not clear terminal)', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockClearActiveTerminal = vi.fn();
				const mockSetQuickActionOpen = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'quickAction',
					sessions: [{ id: 'session-1' }],
					mainPanelRef: { current: { clearActiveTerminal: mockClearActiveTerminal } },
					setQuickActionOpen: mockSetQuickActionOpen,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'k',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetQuickActionOpen).toHaveBeenCalledWith(true, 'main');
				expect(mockClearActiveTerminal).not.toHaveBeenCalled();
			});

			it('Cmd+Shift+K clears terminal in terminal mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockClearActiveTerminal = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'clearTerminal',
					sessions: [{ id: 'session-1' }],
					mainPanelRef: { current: { clearActiveTerminal: mockClearActiveTerminal } },
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'k',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockClearActiveTerminal).toHaveBeenCalled();
			});

			it('Cmd+Shift+R opens rename modal for terminal tab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetRenameTabId = vi.fn();
				const mockSetRenameTabInitialName = vi.fn();
				const mockSetRenameTabModalOpen = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'renameTab',
					setRenameTabId: mockSetRenameTabId,
					setRenameTabInitialName: mockSetRenameTabInitialName,
					setRenameTabModalOpen: mockSetRenameTabModalOpen,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'R',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockSetRenameTabId).toHaveBeenCalledWith('term-1');
				expect(mockSetRenameTabInitialName).toHaveBeenCalledWith('Terminal 1');
				expect(mockSetRenameTabModalOpen).toHaveBeenCalledWith(true);
			});

			it('Cmd+U toggles unread filter from terminal mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockToggleUnreadFilter = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'filterUnreadTabs',
					toggleUnreadFilter: mockToggleUnreadFilter,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'u',
							metaKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockToggleUnreadFilter).toHaveBeenCalled();
			});

			it('Cmd+Shift+U toggles tab unread from terminal mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockToggleTabUnread = vi.fn();

				result.current.keyboardHandlerRef.current = createTerminalTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleTabUnread',
					toggleTabUnread: mockToggleTabUnread,
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				act(() => {
					window.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'u',
							metaKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockToggleTabUnread).toHaveBeenCalled();
			});
		});
	});

	// File preview tabs keep inputMode 'ai' but outrank the AI tab in render
	// precedence, so Cmd+Shift+R must rename the visible file tab rather than
	// the hidden AI tab behind it.
	describe('rename tab precedence (file preview tabs)', () => {
		function createFileTabRenameContext(overrides: Record<string, unknown> = {}) {
			return createMockContext({
				activeSession: {
					id: 'session-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [{ id: 'file-tab-1', path: '/test.ts', customName: 'My File' }],
					activeFileTabId: 'file-tab-1',
				},
				activeSessionId: 'session-1',
				setSessions: vi.fn(),
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'renameTab',
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				...overrides,
			});
		}

		function pressRenameShortcut() {
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'R',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});
		}

		it('Cmd+Shift+R renames the active file preview tab, not the AI tab behind it', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRenameTabId = vi.fn();
			const mockSetRenameTabInitialName = vi.fn();
			const mockSetRenameTabModalOpen = vi.fn();
			const mockGetActiveTab = vi.fn();

			result.current.keyboardHandlerRef.current = createFileTabRenameContext({
				setRenameTabId: mockSetRenameTabId,
				setRenameTabInitialName: mockSetRenameTabInitialName,
				setRenameTabModalOpen: mockSetRenameTabModalOpen,
				getActiveTab: mockGetActiveTab,
			});

			pressRenameShortcut();

			expect(mockSetRenameTabId).toHaveBeenCalledWith('file-tab-1');
			expect(mockSetRenameTabInitialName).toHaveBeenCalledWith('My File');
			expect(mockSetRenameTabModalOpen).toHaveBeenCalledWith(true);
			expect(mockGetActiveTab).not.toHaveBeenCalled();
		});

		it('seeds an empty initial name when the file tab has no custom name', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRenameTabInitialName = vi.fn();

			result.current.keyboardHandlerRef.current = createFileTabRenameContext({
				activeSession: {
					id: 'session-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [{ id: 'file-tab-1', path: '/test.ts' }],
					activeFileTabId: 'file-tab-1',
				},
				setRenameTabId: vi.fn(),
				setRenameTabInitialName: mockSetRenameTabInitialName,
				setRenameTabModalOpen: vi.fn(),
			});

			pressRenameShortcut();

			expect(mockSetRenameTabInitialName).toHaveBeenCalledWith('');
		});

		it('falls back to the AI tab when no file preview tab is active', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRenameTabId = vi.fn();
			const mockSetRenameTabInitialName = vi.fn();

			result.current.keyboardHandlerRef.current = createFileTabRenameContext({
				activeSession: {
					id: 'session-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					filePreviewTabs: [],
					activeFileTabId: null,
				},
				setRenameTabId: mockSetRenameTabId,
				setRenameTabInitialName: mockSetRenameTabInitialName,
				setRenameTabModalOpen: vi.fn(),
			});

			pressRenameShortcut();

			expect(mockSetRenameTabId).toHaveBeenCalledWith('ai-tab-1');
			expect(mockSetRenameTabInitialName).toHaveBeenCalledWith('AI Tab 1');
		});
	});

	// A tiled group takes over the panel, so a tab-scoped rename must follow the
	// group's FOCUSED PANE. Before this, Cmd+Shift+R renamed the AI tab hidden
	// behind the group, so renaming a Terminal tile silently did nothing visible.
	describe('rename tab precedence (tiled groups)', () => {
		function createTiledGroupRenameContext(overrides: Record<string, unknown> = {}) {
			return createMockContext({
				activeSession: {
					id: 'session-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					terminalTabs: [{ id: 'term-1', name: null }],
					filePreviewTabs: [],
					browserTabs: [],
					activeGroupId: 'group-1',
					tabGroups: [
						{
							id: 'group-1',
							name: 'Group: Terminal 1',
							focusedPaneId: 'leaf-term',
							layout: {
								kind: 'split',
								id: 'split-1',
								direction: 'row',
								sizes: [0.5, 0.5],
								children: [
									{ kind: 'leaf', id: 'leaf-ai', tab: { type: 'ai', id: 'ai-tab-1' } },
									{ kind: 'leaf', id: 'leaf-term', tab: { type: 'terminal', id: 'term-1' } },
								],
							},
						},
					],
				},
				activeSessionId: 'session-1',
				setSessions: vi.fn(),
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'renameTab',
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				...overrides,
			});
		}

		function pressRenameShortcut() {
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'R',
						metaKey: true,
						shiftKey: true,
						bubbles: true,
					})
				);
			});
		}

		it('Cmd+Shift+R renames the focused terminal pane, not the AI tab behind the group', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRenameTabId = vi.fn();
			const mockSetRenameTabInitialName = vi.fn();
			const mockSetRenameTabModalOpen = vi.fn();

			result.current.keyboardHandlerRef.current = createTiledGroupRenameContext({
				setRenameTabId: mockSetRenameTabId,
				setRenameTabInitialName: mockSetRenameTabInitialName,
				setRenameTabModalOpen: mockSetRenameTabModalOpen,
			});

			pressRenameShortcut();

			expect(mockSetRenameTabId).toHaveBeenCalledWith('term-1');
			// Unnamed terminal seeds empty, never the auto "Terminal 1" label.
			expect(mockSetRenameTabInitialName).toHaveBeenCalledWith('');
			expect(mockSetRenameTabModalOpen).toHaveBeenCalledWith(true);
		});

		it('does not open the modal when the focused pane references a dead tab', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRenameTabModalOpen = vi.fn();

			result.current.keyboardHandlerRef.current = createTiledGroupRenameContext({
				activeSession: {
					id: 'session-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					terminalTabs: [],
					activeGroupId: 'group-1',
					tabGroups: [
						{
							id: 'group-1',
							name: 'Group',
							focusedPaneId: 'leaf-term',
							layout: {
								kind: 'leaf',
								id: 'leaf-term',
								tab: { type: 'terminal', id: 'term-gone' },
							},
						},
					],
				},
				setRenameTabId: vi.fn(),
				setRenameTabInitialName: vi.fn(),
				setRenameTabModalOpen: mockSetRenameTabModalOpen,
			});

			pressRenameShortcut();

			expect(mockSetRenameTabModalOpen).not.toHaveBeenCalled();
		});
	});

	describe('Cmd+E markdown toggle (toggleMarkdownMode)', () => {
		it('should toggle chatRawTextMode when on AI tab with no file tab', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetChatRawTextMode = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'toggleMarkdownMode',
				chatRawTextMode: false,
				setChatRawTextMode: mockSetChatRawTextMode,
				activeFocus: 'main',
				activeRightTab: 'files',
				activeBatchRunState: null,
				activeSession: {
					id: 'session-1',
					activeFileTabId: null,
					inputMode: 'ai',
				},
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'e',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetChatRawTextMode).toHaveBeenCalledWith(true);
		});

		it('should toggle chatRawTextMode even when a file tab exists in the session', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetChatRawTextMode = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'toggleMarkdownMode',
				chatRawTextMode: true,
				setChatRawTextMode: mockSetChatRawTextMode,
				activeFocus: 'main',
				activeRightTab: 'files',
				activeBatchRunState: null,
				activeSession: {
					id: 'session-1',
					activeFileTabId: 'file-tab-1',
					filePreviewTabs: [{ id: 'file-tab-1', path: '/test.ts' }],
					inputMode: 'ai',
				},
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'e',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			// Should still toggle - FilePreview handles its own Cmd+E with stopPropagation
			// when focused, so if the event reaches the main handler, toggle chat mode
			expect(mockSetChatRawTextMode).toHaveBeenCalledWith(false);
		});

		it('should NOT toggle when in AutoRun panel', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetChatRawTextMode = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'toggleMarkdownMode',
				chatRawTextMode: false,
				setChatRawTextMode: mockSetChatRawTextMode,
				activeFocus: 'right',
				activeRightTab: 'autorun',
				activeBatchRunState: null,
				activeSession: {
					id: 'session-1',
					activeFileTabId: null,
					inputMode: 'ai',
				},
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'e',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetChatRawTextMode).not.toHaveBeenCalled();
		});

		it('should NOT toggle when Auto Run is locked (running without worktree)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetChatRawTextMode = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'toggleMarkdownMode',
				chatRawTextMode: false,
				setChatRawTextMode: mockSetChatRawTextMode,
				activeFocus: 'main',
				activeRightTab: 'files',
				activeBatchRunState: { isRunning: true, worktreeActive: false },
				activeSession: {
					id: 'session-1',
					activeFileTabId: null,
					inputMode: 'ai',
				},
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'e',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetChatRawTextMode).not.toHaveBeenCalled();
		});

		it('should toggle even when a modal layer is open (Cmd+E passes through modals)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetChatRawTextMode = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'toggleMarkdownMode',
				chatRawTextMode: false,
				setChatRawTextMode: mockSetChatRawTextMode,
				activeFocus: 'main',
				activeRightTab: 'files',
				activeBatchRunState: null,
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				activeSession: {
					id: 'session-1',
					activeFileTabId: null,
					inputMode: 'ai',
				},
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'e',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetChatRawTextMode).toHaveBeenCalledWith(true);
		});

		it('should toggle when only overlay layers are open (Cmd+E passes through overlays)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetChatRawTextMode = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'toggleMarkdownMode',
				chatRawTextMode: true,
				setChatRawTextMode: mockSetChatRawTextMode,
				activeFocus: 'main',
				activeRightTab: 'files',
				activeBatchRunState: null,
				hasOpenLayers: () => true,
				hasOpenModal: () => false,
				activeSession: {
					id: 'session-1',
					activeFileTabId: null,
					inputMode: 'ai',
				},
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'e',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetChatRawTextMode).toHaveBeenCalledWith(false);
		});
	});

	describe('font zoom shortcuts', () => {
		// Cmd+= / Cmd+- move `fontZoom`, a multiplier over every surface size,
		// rather than the interface size directly. Each surface now carries its
		// own size, and pushing the base around would compress those differences
		// on the way up and lose them at the clamp.
		beforeEach(() => {
			useSettingsStore.setState({ fontSize: 14, fontZoom: 1, terminalFontSize: 0 });
		});

		it('should increase font size with Cmd+=', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			const event = new KeyboardEvent('keydown', {
				key: '=',
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(useSettingsStore.getState().fontZoom).toBe(1.1);
			// The stored size is untouched, which is what makes the zoom
			// perfectly reversible.
			expect(useSettingsStore.getState().fontSize).toBe(14);
		});

		it('should increase font size with Cmd++', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '+',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(useSettingsStore.getState().fontZoom).toBe(1.1);
		});

		it('should decrease font size with Cmd+-', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			const event = new KeyboardEvent('keydown', {
				key: '-',
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(useSettingsStore.getState().fontZoom).toBe(0.9);
		});

		it('should keep the proportions between surfaces while zooming', () => {
			// The whole reason zoom is a multiplier: a user who set the terminal
			// smaller than the interface keeps that relationship.
			const { result } = renderHook(() => useMainKeyboardHandler());
			useSettingsStore.setState({ fontSize: 16, terminalFontSize: 12, fontZoom: 1 });

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true })
				);
			});

			const state = useSettingsStore.getState();
			expect(state.fontSize).toBe(16);
			expect(state.terminalFontSize).toBe(12);
			expect(state.fontZoom).toBeGreaterThan(1);
		});

		it('should reset the zoom with Cmd+Shift+0, keeping custom surface sizes', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			// Custom sizes are a Settings preference, not zoom state - wiping
			// them from a keystroke would be unrecoverable.
			useSettingsStore.setState({ fontSize: 20, terminalFontSize: 11, fontZoom: 1.5 });

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'fontSizeReset',
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			const event = new KeyboardEvent('keydown', {
				key: ')',
				metaKey: true,
				shiftKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(useSettingsStore.getState().fontZoom).toBe(1);
			expect(useSettingsStore.getState().fontSize).toBe(20);
			expect(useSettingsStore.getState().terminalFontSize).toBe(11);
		});

		it('should not exceed the maximum zoom', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			useSettingsStore.setState({ fontZoom: FONT_ZOOM_MAX });

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '=',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(useSettingsStore.getState().fontZoom).toBe(FONT_ZOOM_MAX);
		});

		it('should not go below the minimum zoom', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			useSettingsStore.setState({ fontZoom: FONT_ZOOM_MIN });

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '-',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(useSettingsStore.getState().fontZoom).toBe(FONT_ZOOM_MIN);
		});

		it('should work when a modal is open (zoom is a benign viewing preference)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '=',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(useSettingsStore.getState().fontZoom).toBe(1.1);
		});

		it('should not trigger with Alt modifier (avoids conflict with session jump)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			result.current.keyboardHandlerRef.current = createMockContext({
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '=',
						metaKey: true,
						altKey: true,
						bubbles: true,
					})
				);
			});

			// Font size should remain unchanged with Alt held
			expect(useSettingsStore.getState().fontSize).toBe(14);
		});
	});

	describe('filterUnreadAgents shortcut', () => {
		it('should toggle unread agents filter on Opt+U', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockToggle = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'filterUnreadAgents',
				toggleShowUnreadAgentsOnly: mockToggle,
				activeSessionId: 'test-session',
				activeSession: { id: 'test-session', name: 'Test', inputMode: 'ai' },
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'u',
						altKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockToggle).toHaveBeenCalled();
		});
	});

	describe('jumpToTerminal shortcut', () => {
		it('should navigate to closest terminal tab on Opt+Cmd+J', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetSessions = vi.fn();
			const mockSession = { id: 'test-session', name: 'Test', inputMode: 'ai' as const };
			const mockResult = {
				type: 'terminal',
				id: 'term-1',
				session: { ...mockSession, inputMode: 'terminal' as const },
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'jumpToTerminal',
				activeSessionId: 'test-session',
				activeSession: mockSession,
				activeGroupChatId: null,
				navigateToClosestTerminalTab: vi.fn().mockReturnValue(mockResult),
				setSessions: mockSetSessions,
				mainPanelRef: { current: { focusActiveTerminal: vi.fn() } },
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('should create a new terminal tab when no terminal tabs exist', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockHandleOpenTerminalTab = vi.fn();
			const mockSession = { id: 'test-session', name: 'Test', inputMode: 'ai' as const };

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'jumpToTerminal',
				activeSessionId: 'test-session',
				activeSession: mockSession,
				activeGroupChatId: null,
				navigateToClosestTerminalTab: vi.fn().mockReturnValue(null),
				setSessions: vi.fn(),
				handleOpenTerminalTab: mockHandleOpenTerminalTab,
				mainPanelRef: { current: { focusActiveTerminal: vi.fn() } },
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockHandleOpenTerminalTab).toHaveBeenCalled();
		});

		it('should not navigate in group chat mode', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockNavigate = vi.fn().mockReturnValue({ type: 'terminal', id: 'term-1', session: {} });

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'jumpToTerminal',
				activeSessionId: 'test-session',
				activeSession: { id: 'test-session', name: 'Test', inputMode: 'ai' },
				activeGroupChatId: 'group-1',
				navigateToClosestTerminalTab: mockNavigate,
				setSessions: vi.fn(),
				mainPanelRef: { current: { focusActiveTerminal: vi.fn() } },
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'j',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockNavigate).not.toHaveBeenCalled();
		});
	});

	describe('terminal search shortcut routing', () => {
		it('should open terminal search on Ctrl+F in terminal mode when event is not from xterm', () => {
			// Ctrl+F search is the Windows/Linux binding. On macOS the shortcut is
			// Cmd+F and a bare Ctrl+F is forwarded to xterm as a readline control
			// sequence, so this path only applies off-Mac. setup.ts defaults the
			// bridge platform to 'darwin'; override it for this case.
			(window as any).maestro = { ...(window as any).maestro, platform: 'linux' };
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockOpenTerminalSearch = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: null,
				mainPanelRef: { current: { openTerminalSearch: mockOpenTerminalSearch } },
				activeFocus: 'main',
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'f',
						ctrlKey: true,
						bubbles: true,
						cancelable: true,
					})
				);
			});

			expect(mockOpenTerminalSearch).toHaveBeenCalledTimes(1);
		});

		it('should open terminal search on Ctrl+F even when xterm has focus', () => {
			// xterm's attachCustomKeyEventHandler intercepts Cmd/Ctrl+F and re-dispatches
			// a synthetic event on window so the app-level shortcut still fires while the
			// terminal textarea retains focus. The handler must open search in this case.
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockOpenTerminalSearch = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: null,
				mainPanelRef: { current: { openTerminalSearch: mockOpenTerminalSearch } },
				activeFocus: 'main',
			});

			const xtermInput = document.createElement('textarea');
			xtermInput.className = 'xterm-helper-textarea';
			document.body.appendChild(xtermInput);
			xtermInput.focus();

			act(() => {
				xtermInput.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'f',
						ctrlKey: true,
						bubbles: true,
						cancelable: true,
					})
				);
			});

			expect(mockOpenTerminalSearch).toHaveBeenCalledTimes(1);
			xtermInput.remove();
		});
	});

	describe('terminal focus recovery does not intercept group chat input', () => {
		it('should not preventDefault on regular keystrokes in group chat even when session is in terminal mode', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockFocusActiveTerminal = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: 'group-1',
				mainPanelRef: { current: { focusActiveTerminal: mockFocusActiveTerminal } },
			});

			const event = new KeyboardEvent('keydown', {
				key: 'a',
				bubbles: true,
			});

			act(() => {
				window.dispatchEvent(event);
			});

			// Terminal focus recovery should NOT fire when group chat is active
			expect(mockFocusActiveTerminal).not.toHaveBeenCalled();
		});

		it('should not intercept Backspace in group chat when session is in terminal mode', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockFocusActiveTerminal = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: 'group-1',
				mainPanelRef: { current: { focusActiveTerminal: mockFocusActiveTerminal } },
			});

			const event = new KeyboardEvent('keydown', {
				key: 'Backspace',
				bubbles: true,
			});

			act(() => {
				window.dispatchEvent(event);
			});

			expect(mockFocusActiveTerminal).not.toHaveBeenCalled();
		});

		it('should not intercept Ctrl+key in group chat when session is in terminal mode (macOS)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockFocusActiveTerminal = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: 'group-1',
				mainPanelRef: { current: { focusActiveTerminal: mockFocusActiveTerminal } },
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'c',
						ctrlKey: true,
						bubbles: true,
					})
				);
			});

			// Ctrl handler should NOT fire when group chat is active
			expect(mockFocusActiveTerminal).not.toHaveBeenCalled();
		});
	});

	describe('terminal focus recovery forwards lost terminal keys', () => {
		it('should refocus and consume ArrowUp without synthesizing PTY sequences', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockFocusActiveTerminal = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: null,
				mainPanelRef: { current: { focusActiveTerminal: mockFocusActiveTerminal } },
			});

			const event = new KeyboardEvent('keydown', {
				key: 'ArrowUp',
				bubbles: true,
				cancelable: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(mockFocusActiveTerminal).toHaveBeenCalled();
			expect(preventDefaultSpy).toHaveBeenCalled();
			expect((window as any).maestro.process.write).not.toHaveBeenCalled();
		});

		it('should not forward keys when typing in an editable input', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockFocusActiveTerminal = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					name: 'Test',
					inputMode: 'terminal',
					activeTerminalTabId: 'term-1',
				},
				activeGroupChatId: null,
				mainPanelRef: { current: { focusActiveTerminal: mockFocusActiveTerminal } },
			});

			const input = document.createElement('input');
			document.body.appendChild(input);
			input.focus();
			const event = new KeyboardEvent('keydown', {
				key: 'ArrowUp',
				bubbles: true,
				cancelable: true,
			});

			act(() => {
				input.dispatchEvent(event);
			});

			expect(mockFocusActiveTerminal).not.toHaveBeenCalled();
			expect((window as any).maestro.process.write).not.toHaveBeenCalled();
			input.remove();
		});
	});

	describe('browser tab shortcut IPC forwarding', () => {
		it('dispatches a keydown event on the window when IPC shortcut arrives', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			renderHook(() => useMainKeyboardHandler());
			expect(ipcCallback).not.toBeNull();

			const dispatched: KeyboardEvent[] = [];
			const listener = (e: Event) => dispatched.push(e as KeyboardEvent);
			originalAddEventListener.call(window, 'keydown', listener);

			act(() => {
				ipcCallback!({
					key: ']',
					code: 'BracketRight',
					meta: true,
					control: false,
					alt: false,
					shift: true,
				});
			});

			originalRemoveEventListener.call(window, 'keydown', listener);

			const match = dispatched.find((e) => e.key === ']' && e.metaKey && e.shiftKey);
			expect(match).toBeDefined();
		});

		it('blurs the active webview element before dispatching', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			renderHook(() => useMainKeyboardHandler());

			// Create a fake WEBVIEW element and focus it.
			// jsdom needs tabIndex to make non-standard elements focusable.
			const fakeWebview = document.createElement('webview');
			fakeWebview.tabIndex = 0;
			const blurSpy = vi.spyOn(fakeWebview, 'blur');
			document.body.appendChild(fakeWebview);
			fakeWebview.focus();
			// Verify jsdom actually focused it
			expect(document.activeElement).toBe(fakeWebview);

			act(() => {
				ipcCallback!({
					key: '[',
					code: 'BracketLeft',
					meta: true,
					control: false,
					alt: false,
					shift: true,
				});
			});

			expect(blurSpy).toHaveBeenCalled();
			fakeWebview.remove();
		});

		it('unsubscribes from IPC on unmount', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			const { unmount } = renderHook(() => useMainKeyboardHandler());
			expect(ipcCallback).not.toBeNull();

			unmount();
			expect(ipcCallback).toBeNull();
		});

		it('routes forwarded Cmd+L to focusBrowserAddressBar without re-dispatching', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			const { result } = renderHook(() => useMainKeyboardHandler());
			const focusBrowserAddressBar = vi.fn();
			const openBrowserFind = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeSession: { id: 's1', activeBrowserTabId: 'b1' },
				isTabShortcut: (_e: unknown, id: string) => id === 'focusBrowserAddress',
				mainPanelRef: { current: { focusBrowserAddressBar, openBrowserFind } },
			});

			const dispatched: KeyboardEvent[] = [];
			const listener = (e: Event) => dispatched.push(e as KeyboardEvent);
			originalAddEventListener.call(window, 'keydown', listener);

			act(() => {
				ipcCallback!({
					key: 'l',
					code: 'KeyL',
					meta: true,
					control: false,
					alt: false,
					shift: false,
				});
			});

			originalRemoveEventListener.call(window, 'keydown', listener);

			expect(focusBrowserAddressBar).toHaveBeenCalledTimes(1);
			expect(openBrowserFind).not.toHaveBeenCalled();
			// Must NOT re-dispatch - that's what made the older implementation race
			// with the overlay guard.
			expect(dispatched.find((e) => e.key === 'l' && e.metaKey)).toBeUndefined();
		});

		it('routes forwarded Cmd+Left and Cmd+Right to browserBack/browserForward', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			const { result } = renderHook(() => useMainKeyboardHandler());
			const browserBack = vi.fn();
			const browserForward = vi.fn();
			const openBrowserFind = vi.fn();
			const focusBrowserAddressBar = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeSession: { id: 's1', activeBrowserTabId: 'b1' },
				isTabShortcut: () => false,
				mainPanelRef: {
					current: { focusBrowserAddressBar, openBrowserFind, browserBack, browserForward },
				},
			});

			act(() => {
				ipcCallback!({
					key: 'ArrowLeft',
					code: 'ArrowLeft',
					meta: true,
					control: false,
					alt: false,
					shift: false,
				});
			});
			act(() => {
				ipcCallback!({
					key: 'ArrowRight',
					code: 'ArrowRight',
					meta: true,
					control: false,
					alt: false,
					shift: false,
				});
			});

			expect(browserBack).toHaveBeenCalledTimes(1);
			expect(browserForward).toHaveBeenCalledTimes(1);
			expect(openBrowserFind).not.toHaveBeenCalled();
			expect(focusBrowserAddressBar).not.toHaveBeenCalled();
		});

		it('window Cmd+Left navigates browser back, but only when not in an input', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const browserBack = vi.fn();
			const browserForward = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeSessionId: 's1',
				activeSession: { id: 's1', activeBrowserTabId: 'b1' },
				activeGroupChatId: null,
				isTabShortcut: () => false,
				mainPanelRef: { current: { browserBack, browserForward } },
			});

			// Focused on body (not an editable element)
			act(() => {
				const event = new KeyboardEvent('keydown', {
					key: 'ArrowLeft',
					metaKey: true,
					bubbles: true,
					cancelable: true,
				});
				window.dispatchEvent(event);
			});
			expect(browserBack).toHaveBeenCalledTimes(1);

			// Now focus on an HTMLInputElement and re-fire - must NOT navigate
			// (preserves macOS line-navigation inside text inputs)
			const input = document.createElement('input');
			document.body.appendChild(input);
			input.focus();
			act(() => {
				const event = new KeyboardEvent('keydown', {
					key: 'ArrowLeft',
					metaKey: true,
					bubbles: true,
					cancelable: true,
				});
				input.dispatchEvent(event);
			});
			expect(browserBack).toHaveBeenCalledTimes(1);
			input.remove();

			// Cmd+Right while body has focus
			act(() => {
				const event = new KeyboardEvent('keydown', {
					key: 'ArrowRight',
					metaKey: true,
					bubbles: true,
					cancelable: true,
				});
				window.dispatchEvent(event);
			});
			expect(browserForward).toHaveBeenCalledTimes(1);
		});

		it('routes forwarded Cmd+F to openBrowserFind', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			const { result } = renderHook(() => useMainKeyboardHandler());
			const openBrowserFind = vi.fn();
			const focusBrowserAddressBar = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeSession: { id: 's1', activeBrowserTabId: 'b1' },
				isTabShortcut: () => false,
				mainPanelRef: { current: { focusBrowserAddressBar, openBrowserFind } },
			});

			const dispatched: KeyboardEvent[] = [];
			const listener = (e: Event) => dispatched.push(e as KeyboardEvent);
			originalAddEventListener.call(window, 'keydown', listener);

			act(() => {
				ipcCallback!({
					key: 'f',
					code: 'KeyF',
					meta: true,
					control: false,
					alt: false,
					shift: false,
				});
			});

			originalRemoveEventListener.call(window, 'keydown', listener);

			expect(openBrowserFind).toHaveBeenCalledTimes(1);
			expect(focusBrowserAddressBar).not.toHaveBeenCalled();
			expect(dispatched.find((e) => e.key === 'f' && e.metaKey)).toBeUndefined();
		});

		it('routes forwarded Cmd+Shift+, to handleNavBack without re-dispatching', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			const { result } = renderHook(() => useMainKeyboardHandler());
			const handleNavBack = vi.fn();
			const handleNavForward = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeSession: { id: 's1', activeBrowserTabId: 'b1' },
				isTabShortcut: () => false,
				isShortcut: (_e: unknown, id: string) => id === 'navBack',
				handleNavBack,
				handleNavForward,
			});

			const dispatched: KeyboardEvent[] = [];
			const listener = (e: Event) => dispatched.push(e as KeyboardEvent);
			originalAddEventListener.call(window, 'keydown', listener);

			act(() => {
				ipcCallback!({
					key: '<',
					code: 'Comma',
					meta: true,
					control: false,
					alt: false,
					shift: true,
				});
			});

			originalRemoveEventListener.call(window, 'keydown', listener);

			expect(handleNavBack).toHaveBeenCalledTimes(1);
			expect(handleNavForward).not.toHaveBeenCalled();
			expect(dispatched.find((e) => (e.key === '<' || e.key === ',') && e.metaKey)).toBeUndefined();
		});

		it('routes forwarded Cmd+Shift+. to handleNavForward without re-dispatching', () => {
			let ipcCallback: ((input: Record<string, unknown>) => void) | null = null;
			(window as any).maestro = {
				...(window as any).maestro,
				app: {
					...((window as any).maestro?.app ?? {}),
					onBrowserTabShortcutKey: (cb: (input: Record<string, unknown>) => void) => {
						ipcCallback = cb;
						return () => {
							ipcCallback = null;
						};
					},
				},
			};

			const { result } = renderHook(() => useMainKeyboardHandler());
			const handleNavBack = vi.fn();
			const handleNavForward = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeSession: { id: 's1', activeBrowserTabId: 'b1' },
				isTabShortcut: () => false,
				isShortcut: (_e: unknown, id: string) => id === 'navForward',
				handleNavBack,
				handleNavForward,
			});

			act(() => {
				ipcCallback!({
					key: '>',
					code: 'Period',
					meta: true,
					control: false,
					alt: false,
					shift: true,
				});
			});

			expect(handleNavForward).toHaveBeenCalledTimes(1);
			expect(handleNavBack).not.toHaveBeenCalled();
		});
	});

	describe('output search find bar (Cmd+F refocus)', () => {
		let searchInput: HTMLInputElement;

		// Output search is scoped per agent+AI-tab; pin an active agent so the
		// handler's isActiveOutputSearchOpen() resolves to this window's slot.
		const SEARCH_KEY = 'kbd-sess::kbd-tab';

		beforeEach(() => {
			useSessionStore.setState({
				sessions: [{ id: 'kbd-sess', activeTabId: 'kbd-tab' }],
				activeSessionId: 'kbd-sess',
			} as any);
			// Mount a stand-in for the find bar's input so the handler's
			// querySelector('[data-output-search-input]') focus target exists
			// (shared by AI TerminalOutput and group chat).
			const container = document.createElement('div');
			container.className = 'terminal-output';
			searchInput = document.createElement('input');
			searchInput.setAttribute('data-output-search-input', '');
			container.appendChild(searchInput);
			document.body.appendChild(container);
			searchInput.blur();
		});

		afterEach(() => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, false);
			searchInput.parentElement?.remove();
		});

		it('refocuses the find input on Cmd+F while output search is open', () => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, true);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext();

			const event = new KeyboardEvent('keydown', {
				key: 'f',
				metaKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(document.activeElement).toBe(searchInput);
		});

		it('does not steal Cmd+F back to Find when the Right Bar is focused', () => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, true);
			const setFileTreeFilterOpen = vi.fn();

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				// Find overlay is registered while the bar is open.
				hasOpenLayers: () => true,
				activeFocus: 'right',
				activeRightTab: 'files',
				fileTreeFilterOpen: false,
				setFileTreeFilterOpen,
				fileTreeFilterInputRef: { current: null },
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'f',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(document.activeElement).not.toBe(searchInput);
			expect(setFileTreeFilterOpen).toHaveBeenCalledWith(true);
		});

		it('does not steal Cmd+F back to Find when the Left Bar is focused', () => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, true);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				activeFocus: 'sidebar',
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'f',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(document.activeElement).not.toBe(searchInput);
		});

		it('does not steal Cmd+F focus when output search is closed', () => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, false);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext();

			const event = new KeyboardEvent('keydown', {
				key: 'f',
				metaKey: true,
				bubbles: true,
			});

			act(() => {
				window.dispatchEvent(event);
			});

			// The refocus path is gated on outputSearchOpen, so the find input
			// must not be focused when the bar is closed.
			expect(document.activeElement).not.toBe(searchInput);
		});

		it('ignores Cmd+Shift+F so it does not hijack other shortcuts', () => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, true);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext();

			const event = new KeyboardEvent('keydown', {
				key: 'f',
				metaKey: true,
				shiftKey: true,
				bubbles: true,
			});

			act(() => {
				window.dispatchEvent(event);
			});

			// Refocus is plain Cmd+F only; the shift variant must not be captured.
			expect(document.activeElement).not.toBe(searchInput);
		});
	});

	describe('agentSettings shortcut (Cmd+Opt+,)', () => {
		it('opens the moderator settings modal when a group chat is active', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const openModalSpy = vi
				.spyOn(useModalStore.getState(), 'openModal')
				.mockImplementation(() => {});
			const mockSetEditAgentSession = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'agentSettings',
				activeGroupChatId: 'group-1',
				activeSession: { id: 'session-1', name: 'Test' },
				setEditAgentSession: mockSetEditAgentSession,
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			const event = new KeyboardEvent('keydown', {
				key: ',',
				metaKey: true,
				altKey: true,
				bubbles: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			act(() => {
				window.dispatchEvent(event);
			});

			expect(openModalSpy).toHaveBeenCalledWith('editGroupChat', { groupChatId: 'group-1' });
			expect(mockSetEditAgentSession).not.toHaveBeenCalled();
			expect(preventDefaultSpy).toHaveBeenCalled();

			openModalSpy.mockRestore();
		});

		it('opens agent settings for the active session when no group chat is active', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const openModalSpy = vi
				.spyOn(useModalStore.getState(), 'openModal')
				.mockImplementation(() => {});
			const mockSetEditAgentSession = vi.fn();
			const activeSession = { id: 'session-1', name: 'Test' };

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'agentSettings',
				activeGroupChatId: null,
				activeSession,
				setEditAgentSession: mockSetEditAgentSession,
				recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: ',',
						metaKey: true,
						altKey: true,
						bubbles: true,
					})
				);
			});

			expect(mockSetEditAgentSession).toHaveBeenCalledWith(activeSession);
			expect(openModalSpy).not.toHaveBeenCalledWith('editGroupChat', expect.anything());

			openModalSpy.mockRestore();
		});
	});

	describe('searchAllTabs (cross-tab message search)', () => {
		/**
		 * The handler must resolve the agent from the store, NOT from
		 * `ctx.activeSession`. The multi-window work drops `activeSession` from the
		 * keyboard context, and a branch reading it there went silently dead: the
		 * guard was always falsy while preventDefault had already run, so the
		 * shortcut ate the keystroke with no visible effect. These tests pin the
		 * store-resolved behavior by omitting `activeSession` from the context.
		 */
		const dispatchOptCmdF = () =>
			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'ƒ', // macOS rewrites Alt+F
						code: 'KeyF',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

		it('opens cross-tab search using the store-resolved agent', () => {
			const handleOpenCrossTabSearch = vi.fn();
			useSessionStore.setState({
				sessions: [{ id: 's1', activeTabId: 't1', aiTabs: [{ id: 't1' }] }],
				activeSessionId: 's1',
			} as any);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				// Deliberately omitted: activeSession. The branch must not need it.
				activeSession: undefined,
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'searchAllTabs',
				handleOpenCrossTabSearch,
			});

			dispatchOptCmdF();
			expect(handleOpenCrossTabSearch).toHaveBeenCalledTimes(1);
		});

		it('does not fire in a group chat', () => {
			const handleOpenCrossTabSearch = vi.fn();
			useSessionStore.setState({
				sessions: [{ id: 's1', activeTabId: 't1', aiTabs: [{ id: 't1' }] }],
				activeSessionId: 's1',
			} as any);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: 'gc1',
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'searchAllTabs',
				handleOpenCrossTabSearch,
			});

			dispatchOptCmdF();
			expect(handleOpenCrossTabSearch).not.toHaveBeenCalled();
		});

		it('leaves the keystroke unconsumed when the agent has no AI tabs', () => {
			const handleOpenCrossTabSearch = vi.fn();
			useSessionStore.setState({
				sessions: [{ id: 's1', activeTabId: null, aiTabs: [] }],
				activeSessionId: 's1',
			} as any);

			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'searchAllTabs',
				handleOpenCrossTabSearch,
			});

			const evt = new KeyboardEvent('keydown', {
				key: 'ƒ',
				code: 'KeyF',
				altKey: true,
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});
			act(() => {
				window.dispatchEvent(evt);
			});

			expect(handleOpenCrossTabSearch).not.toHaveBeenCalled();
			// Must not silently swallow the key when it cannot act.
			expect(evt.defaultPrevented).toBe(false);
		});
	});

	describe('group chat Cmd+F vs Opt+Cmd+F', () => {
		const GROUP_ID = 'gc-find';
		const SEARCH_KEY = groupChatOutputSearchKey(GROUP_ID);

		afterEach(() => {
			useUIStore.getState().setOutputSearchOpen(SEARCH_KEY, false);
		});

		it('opens group Find on Cmd+F', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: GROUP_ID,
				activeFocus: 'main',
				isShortcut: () => false,
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'f',
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(useUIStore.getState().outputSearchByKey[SEARCH_KEY]?.open).toBe(true);
		});

		it('does not open group Find on Opt+Cmd+F', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: GROUP_ID,
				activeFocus: 'main',
				isShortcut: (_e: KeyboardEvent, id: string) => id === 'searchAllTabs',
				handleOpenCrossTabSearch: vi.fn(),
			});

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'f',
						code: 'KeyF',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(useUIStore.getState().outputSearchByKey[SEARCH_KEY]?.open).toBeFalsy();
		});
	});
});

/**
 * Cmd+Shift+E - "Edit Last Queued Message".
 *
 * The defect these cover: the handler used to read the session snapshot that
 * `ctx` captured during the last App render. The pencil on a queued row reads
 * live props, so whenever that snapshot lagged the store the shortcut reported
 * "no queued message" while a queued card was on screen and clickable. The
 * handler now reads the session store at keypress time.
 */
describe('useMainKeyboardHandler - editLastQueuedMessage', () => {
	const TAB_A = 'tab-a';
	const TAB_B = 'tab-b';

	function session(overrides: Record<string, unknown> = {}) {
		return {
			id: 'agent-1',
			name: 'Maestro',
			activeTabId: TAB_A,
			activeFileTabId: null,
			activeTerminalTabId: null,
			activeBrowserTabId: null,
			inputMode: 'ai',
			aiTabs: [{ id: TAB_A }, { id: TAB_B }],
			executionQueue: [],
			...overrides,
		} as any;
	}

	function queued(overrides: Record<string, unknown> = {}) {
		return {
			id: 'q1',
			timestamp: 1,
			tabId: TAB_A,
			type: 'message',
			text: 'still not fixed',
			...overrides,
		} as any;
	}

	function press(ctxOverrides: Record<string, unknown>) {
		// These tests turn on the ctx snapshot DISAGREEING with the store, which is
		// the defect being covered. `createMockContext` mirrors whatever
		// `activeSession` it is handed back into the session store, so capture what
		// the test seeded and restore it after the context is built - otherwise the
		// helper would quietly make the two agree again and the stale-snapshot case
		// could never fail.
		const seeded = useSessionStore.getState();
		const { result } = renderHook(() => useMainKeyboardHandler());
		result.current.keyboardHandlerRef.current = createMockContext({
			isShortcut: (_e: KeyboardEvent, id: string) => id === 'editLastQueuedMessage',
			...ctxOverrides,
		});
		useSessionStore.setState({
			sessions: seeded.sessions,
			activeSessionId: seeded.activeSessionId,
		} as never);
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'E', metaKey: true, shiftKey: true, bubbles: true })
			);
		});
	}

	beforeEach(() => {
		useUIStore.getState().setEditingQueuedItemId(null);
	});

	afterEach(() => {
		useUIStore.getState().setEditingQueuedItemId(null);
		useSessionStore.setState({ sessions: [], activeSessionId: null } as any);
	});

	it('opens the queued message even when the ctx snapshot is stale', () => {
		const item = queued();
		useSessionStore.setState({
			sessions: [session({ executionQueue: [item] })],
			activeSessionId: 'agent-1',
		} as any);

		// The snapshot ctx captured still shows an EMPTY queue - exactly the state
		// that used to make this report "No queued message to edit".
		press({ activeSession: session({ executionQueue: [] }) });

		expect(useUIStore.getState().editingQueuedItemId).toBe('q1');
	});

	it('falls back to a message queued on another tab and switches to it', () => {
		const item = queued({ id: 'q-other', tabId: TAB_B });
		useSessionStore.setState({
			sessions: [session({ executionQueue: [item] })],
			activeSessionId: 'agent-1',
		} as any);

		press({ activeSession: session({ executionQueue: [item] }) });

		expect(useUIStore.getState().editingQueuedItemId).toBe('q-other');
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.activeTabId).toBe(TAB_B);
	});

	it('prefers the message on the tab already on screen', () => {
		const onOther = queued({ id: 'q-other', tabId: TAB_B, timestamp: 2 });
		const onActive = queued({ id: 'q-active', tabId: TAB_A, timestamp: 1 });
		useSessionStore.setState({
			sessions: [session({ executionQueue: [onActive, onOther] })],
			activeSessionId: 'agent-1',
		} as any);

		press({ activeSession: session() });

		expect(useUIStore.getState().editingQueuedItemId).toBe('q-active');
	});

	it('does not open anything when only commands are queued', () => {
		useSessionStore.setState({
			sessions: [session({ executionQueue: [queued({ id: 'c1', type: 'command', text: '' })] })],
			activeSessionId: 'agent-1',
		} as any);

		press({ activeSession: session() });

		expect(useUIStore.getState().editingQueuedItemId).toBeNull();
	});

	it('still finds the message when its tab is no longer open', () => {
		// A missing tab must not collapse the result set to nothing - that is how
		// a filter turns into a false "nothing is queued".
		const item = queued({ id: 'q-orphan', tabId: 'tab-gone' });
		useSessionStore.setState({
			sessions: [session({ executionQueue: [item] })],
			activeSessionId: 'agent-1',
		} as any);

		press({ activeSession: session({ executionQueue: [item] }) });

		expect(useUIStore.getState().editingQueuedItemId).toBe('q-orphan');
	});
});

describe('useMainKeyboardHandler - openPromptComposer', () => {
	function press(ctxOverrides: Record<string, unknown>) {
		const { result } = renderHook(() => useMainKeyboardHandler());
		result.current.keyboardHandlerRef.current = createMockContext({
			isShortcut: (_e: KeyboardEvent, id: string) => id === 'openPromptComposer',
			recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
			...ctxOverrides,
		});
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true })
			);
		});
	}

	beforeEach(() => {
		useModalStore.setState({ modals: new Map() });
	});

	afterEach(() => {
		useModalStore.setState({ modals: new Map() });
	});

	it('opens the composer for an agent in AI mode', () => {
		press({ activeSession: { id: 'agent-1', inputMode: 'ai' } });

		expect(useModalStore.getState().isOpen('promptComposer')).toBe(true);
	});

	it('opens the composer in a group chat even when the last agent was in terminal mode', () => {
		// A room has no inputMode of its own - activeSession still points at the
		// agent selected before the room was opened, so gating on that alone made
		// the hotkey silently die in group chat.
		press({
			activeGroupChatId: 'chat-1',
			activeSession: { id: 'agent-1', inputMode: 'terminal' },
		});

		expect(useModalStore.getState().isOpen('promptComposer')).toBe(true);
	});

	it('stays closed for an agent in terminal mode with no room open', () => {
		press({ activeSession: { id: 'agent-1', inputMode: 'terminal' } });

		expect(useModalStore.getState().isOpen('promptComposer')).toBe(false);
	});
});

// ============================================================================
// Group chat Right Bar: Cmd+Shift+[ / Cmd+Shift+]
// ============================================================================

/**
 * A group chat has no AI tabs, so the tab-cycling chord is dead there. It walks
 * the Right Bar's two panels instead - the only two views a room has.
 */
describe('group chat right panel cycling', () => {
	const pressTabCycle = (shortcutId: 'nextTab' | 'prevTab', overrides: Record<string, unknown>) => {
		// The store is what the app itself reads back to persist the choice, so it
		// has to agree with the context object the handler is gated on.
		useGroupChatStore.setState({
			activeGroupChatId: (overrides.activeGroupChatId as string | null) ?? null,
		} as never);
		const { result } = renderHook(() => useMainKeyboardHandler());
		result.current.keyboardHandlerRef.current = createMockContext({
			isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === shortcutId,
			activeSessionId: 'agent-1',
			activeSession: { id: 'agent-1', name: 'Agent', inputMode: 'ai' },
			...overrides,
		});

		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: shortcutId === 'nextTab' ? ']' : '[',
					metaKey: true,
					shiftKey: true,
					bubbles: true,
					cancelable: true,
				})
			);
		});
	};

	beforeEach(() => {
		useGroupChatStore.setState({ groupChatRightTab: 'participants' } as never);
		useUIStore.setState({ rightPanelOpen: true } as never);
	});

	it('switches Participants -> History on Cmd+Shift+]', () => {
		pressTabCycle('nextTab', { activeGroupChatId: 'chat-1' });

		expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
	});

	it('switches back on Cmd+Shift+[ - two panels, so either direction flips', () => {
		useGroupChatStore.setState({ groupChatRightTab: 'history' } as never);

		pressTabCycle('prevTab', { activeGroupChatId: 'chat-1' });

		expect(useGroupChatStore.getState().groupChatRightTab).toBe('participants');
	});

	it('remembers the panel for that chat', () => {
		pressTabCycle('nextTab', { activeGroupChatId: 'chat-1' });

		expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatRightTab:chat-1', 'history');
	});

	it('moves focus with the panel, so it answers the arrows straight away', () => {
		const setActiveFocus = vi.fn();

		pressTabCycle('nextTab', { activeGroupChatId: 'chat-1', setActiveFocus });

		expect(setActiveFocus).toHaveBeenCalledWith('right');
	});

	it('opens the Right Bar when it is closed - a hidden switch reads as a dead key', () => {
		useUIStore.setState({ rightPanelOpen: false } as never);

		pressTabCycle('nextTab', { activeGroupChatId: 'chat-1' });

		expect(useUIStore.getState().rightPanelOpen).toBe(true);
		expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
	});

	it('leaves the chord to the agent tabs when no room is open', () => {
		const navigateToNextUnifiedTab = vi.fn().mockReturnValue(null);

		pressTabCycle('nextTab', {
			activeGroupChatId: null,
			setSessions: vi.fn((updater: unknown) =>
				typeof updater === 'function'
					? (updater as (p: unknown[]) => unknown)([{ id: 'agent-1' }])
					: undefined
			),
			navigateToNextUnifiedTab,
		});

		expect(navigateToNextUnifiedTab).toHaveBeenCalled();
		expect(useGroupChatStore.getState().groupChatRightTab).toBe('participants');
	});
});

/**
 * Switching between full-window destination surfaces by hotkey.
 *
 * The modal guard blocks most shortcuts while a modal is up. It used to consult
 * a hardcoded chord test (Alt+Cmd plus l/p/u/s), which allowlisted exactly
 * three destinations - so Director's Notes -> Usage Dashboard worked and the
 * way back did nothing.
 */
describe('useMainKeyboardHandler - destination surface switching', () => {
	const originalAddEventListener = window.addEventListener;
	const originalRemoveEventListener = window.removeEventListener;

	afterEach(() => {
		window.addEventListener = originalAddEventListener;
		window.removeEventListener = originalRemoveEventListener;
	});

	/** Bind `shortcutId` to `chord` and press it, with or without a modal up. */
	function pressShortcut(
		shortcutId: string,
		chord: KeyboardEventInit,
		extra: Record<string, unknown> = {},
		modalOpen = true
	) {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const matches = (e: KeyboardEvent) =>
			!!e.metaKey === !!chord.metaKey &&
			!!e.shiftKey === !!chord.shiftKey &&
			!!e.altKey === !!chord.altKey &&
			e.key === chord.key;

		result.current.keyboardHandlerRef.current = createMockContext({
			hasOpenLayers: () => modalOpen,
			hasOpenModal: () => modalOpen,
			isShortcut: (e: KeyboardEvent, actionId: string) => actionId === shortcutId && matches(e),
			encoreFeatures: { usageStats: true, directorNotes: true, symphony: true, maestroCue: true },
			sessions: [{ id: 'test' }],
			...extra,
		});

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { ...chord, bubbles: true }));
		});
	}

	it("opens Director's Notes from an open modal (the direction that was dead)", () => {
		const setDirectorNotesOpen = vi.fn();
		pressShortcut(
			'directorNotes',
			{ key: 'o', metaKey: true, shiftKey: true },
			{ setDirectorNotesOpen }
		);

		expect(setDirectorNotesOpen).toHaveBeenCalledWith(true);
	});

	it('still opens the Usage Dashboard from an open modal', () => {
		const setUsageDashboardOpen = vi.fn();
		pressShortcut(
			'usageDashboard',
			{ key: 'u', metaKey: true, altKey: true },
			{ setUsageDashboardOpen }
		);

		expect(setUsageDashboardOpen).toHaveBeenCalledWith(true);
	});

	it('opens Symphony from an open modal', () => {
		const setSymphonyModalOpen = vi.fn();
		pressShortcut(
			'openSymphony',
			{ key: 'y', metaKey: true, altKey: true },
			{ setSymphonyModalOpen }
		);

		expect(setSymphonyModalOpen).toHaveBeenCalledWith(true);
	});

	it('opens Maestro Cue from an open modal', () => {
		const setCueModalOpen = vi.fn();
		pressShortcut('openCue', { key: 'q', altKey: true }, { setCueModalOpen });

		expect(setCueModalOpen).toHaveBeenCalledWith(true);
	});

	it('honors a REBOUND destination shortcut', () => {
		// The old chord test could only ever recognize the factory keys, so
		// rebinding a surface silently removed it from the guard.
		const setDirectorNotesOpen = vi.fn();
		pressShortcut('directorNotes', { key: 'F9' }, { setDirectorNotesOpen });

		expect(setDirectorNotesOpen).toHaveBeenCalledWith(true);
	});

	it('still blocks a non-destination shortcut while a modal is open', () => {
		const chord = { key: 'b', metaKey: true, shiftKey: true };

		// Positive control: with nothing open, the same press reaches its branch.
		// Without this the assertion below would pass even if the chord never
		// matched anything.
		const reachedWithNoModal = vi.fn();
		pressShortcut(
			'openBatchRunner',
			chord,
			{ handleOpenBatchRunner: reachedWithNoModal, activeSession: { id: 'test' } },
			false
		);
		expect(reachedWithNoModal).toHaveBeenCalled();

		const blockedWithModal = vi.fn();
		pressShortcut('openBatchRunner', chord, {
			handleOpenBatchRunner: blockedWithModal,
			activeSession: { id: 'test' },
		});
		expect(blockedWithModal).not.toHaveBeenCalled();
	});
});
