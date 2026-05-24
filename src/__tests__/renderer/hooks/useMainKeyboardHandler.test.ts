import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useMainKeyboardHandler } from '../../../renderer/hooks';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useModalStore } from '../../../renderer/stores/modalStore';

/**
 * Creates a minimal mock context with all required handler functions.
 * The keyboard handler requires these functions to be present to avoid
 * "is not a function" errors when processing keyboard events.
 */
function createMockContext(overrides: Record<string, unknown> = {}) {
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
		sessions: [],
		activeSession: null,
		activeSessionId: null,
		activeGroupChatId: null,
		...overrides,
	};
}

function dispatchKeydown(init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', {
		key: 'x',
		bubbles: true,
		...init,
	});
	const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

	act(() => {
		window.dispatchEvent(event);
	});

	return { event, preventDefaultSpy };
}

describe('useMainKeyboardHandler', () => {
	// Track event listeners for cleanup
	let addedListeners: { type: string; handler: EventListener }[] = [];
	const originalAddEventListener = window.addEventListener;
	const originalRemoveEventListener = window.removeEventListener;

	beforeEach(() => {
		addedListeners = [];
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
	});

	afterEach(() => {
		window.addEventListener = originalAddEventListener;
		window.removeEventListener = originalRemoveEventListener;
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

		it('should show badges when Alt+Ctrl are pressed together', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Control',
						altKey: true,
						ctrlKey: true,
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

		it('should keep badges visible while both modifiers remain pressed', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

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

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keyup', {
						key: 'x',
						altKey: true,
						metaKey: true,
						bubbles: true,
					})
				);
			});

			expect(result.current.showSessionJumpNumbers).toBe(true);
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

		it('should allow tab management shortcuts (Cmd+T) when only overlays are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetSessions = vi.fn();
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
				createTab: vi.fn().mockReturnValue({
					session: { ...mockActiveSession, aiTabs: [{ id: 'new-tab' }] },
				}),
				setSessions: mockSetSessions,
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
			expect(mockSetSessions).toHaveBeenCalled();
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

			const mockToggleInputMode = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockFocus = vi.fn();
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
				toggleInputMode: mockToggleInputMode,
				setActiveFocus: mockSetActiveFocus,
				inputRef: { current: { focus: mockFocus } },
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

			// Cmd+J should toggle mode even when file preview overlay is open
			expect(mockToggleInputMode).toHaveBeenCalled();
			// Should auto-focus the input after toggling
			expect(mockSetActiveFocus).toHaveBeenCalledWith('main');
			vi.advanceTimersByTime(50);
			expect(mockFocus).toHaveBeenCalled();
			vi.useRealTimers();
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

		it('should block tab management shortcuts while a true modal is open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetSessions = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
				activeSessionId: 'test-session',
				activeSession: {
					id: 'test-session',
					inputMode: 'ai',
					aiTabs: [],
					activeTabId: 'tab-1',
					unifiedTabOrder: [],
				},
				createTab: vi.fn(),
				setSessions: mockSetSessions,
			});

			dispatchKeydown({ key: 't', metaKey: true });

			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('should block unrelated shortcuts while only an overlay is open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetShortcutsHelpOpen = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => false,
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'help',
				setShortcutsHelpOpen: mockSetShortcutsHelpOpen,
			});

			dispatchKeydown({ key: 'k', metaKey: true });

			expect(mockSetShortcutsHelpOpen).not.toHaveBeenCalled();
		});

		it('should allow system utility shortcuts while a true modal is open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetProcessMonitorOpen = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => true,
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'processMonitor',
				setProcessMonitorOpen: mockSetProcessMonitorOpen,
			});

			dispatchKeydown({ key: 'π', code: 'KeyP', altKey: true, metaKey: true });

			expect(mockSetProcessMonitorOpen).toHaveBeenCalledWith(true);
		});

		it('should allow right panel shortcuts while only an overlay is open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRightPanelOpen = vi.fn();
			const mockHandleSetActiveRightTab = vi.fn();
			const mockSetActiveFocus = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true,
				hasOpenModal: () => false,
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToFiles',
				setRightPanelOpen: mockSetRightPanelOpen,
				handleSetActiveRightTab: mockHandleSetActiveRightTab,
				setActiveFocus: mockSetActiveFocus,
			});

			dispatchKeydown({ key: 'f', metaKey: true, shiftKey: true });

			expect(mockSetRightPanelOpen).toHaveBeenCalledWith(true);
			expect(mockHandleSetActiveRightTab).toHaveBeenCalledWith('files');
			expect(mockSetActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should allow Ctrl-key variants through layer shortcut gates', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const mockSetSessions = vi.fn();
			const mockSetRightPanelOpen = vi.fn();
			const mockHandleSetActiveRightTab = vi.fn();
			const mockSetChatRawTextMode = vi.fn();
			const mockSetUsageDashboardOpen = vi.fn();
			const mockSetActiveSessionId = vi.fn();
			const mockSetTabSwitcherOpen = vi.fn();
			const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({ type: 'file' });
			const mockScrollTo = vi.fn();
			const scrollContainer = document.createElement('div');
			const logsEnd = document.createElement('div');
			scrollContainer.scrollTo = mockScrollTo;
			scrollContainer.append(logsEnd);

			const activeSession = {
				id: 'session-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [{ id: 'tab-1', logs: [] }],
			};

			const cases = [
				{
					init: { key: ']', ctrlKey: true, shiftKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => false,
						isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
						activeSessionId: 'session-1',
						activeSession,
						setSessions: mockSetSessions,
						navigateToNextUnifiedTab: vi.fn().mockReturnValue({ session: activeSession }),
					},
					assert: () => expect(mockSetSessions).toHaveBeenCalled(),
				},
				{
					init: { key: 'ArrowRight', altKey: true, ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => true,
						isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleRightPanel',
						setRightPanelOpen: mockSetRightPanelOpen,
					},
					assert: () => expect(mockSetRightPanelOpen).toHaveBeenCalled(),
				},
				{
					init: { key: 'h', ctrlKey: true, shiftKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => false,
						isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToHistory',
						setRightPanelOpen: mockSetRightPanelOpen,
						handleSetActiveRightTab: mockHandleSetActiveRightTab,
						setActiveFocus: vi.fn(),
					},
					assert: () => expect(mockHandleSetActiveRightTab).toHaveBeenCalledWith('history'),
				},
				{
					init: { key: 'j', ctrlKey: true, shiftKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => true,
						isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'jumpToBottom',
						logsEndRef: { current: logsEnd },
					},
					assert: () => expect(mockScrollTo).toHaveBeenCalled(),
				},
				{
					init: { key: 'e', ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => true,
						isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleMarkdownMode',
						activeFocus: 'main',
						activeRightTab: 'files',
						activeBatchRunState: null,
						chatRawTextMode: false,
						setChatRawTextMode: mockSetChatRawTextMode,
					},
					assert: () => expect(mockSetChatRawTextMode).toHaveBeenCalledWith(true),
				},
				{
					init: { key: '¨', code: 'KeyU', altKey: true, ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => true,
						isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'usageDashboard',
						setUsageDashboardOpen: mockSetUsageDashboardOpen,
					},
					assert: () => expect(mockSetUsageDashboardOpen).toHaveBeenCalledWith(true),
				},
				{
					init: { key: '3', code: 'Digit3', altKey: true, ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => true,
						visibleSessions: [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
						setActiveSessionId: mockSetActiveSessionId,
						leftSidebarOpen: true,
						setLeftSidebarOpen: vi.fn(),
					},
					assert: () => expect(mockSetActiveSessionId).toHaveBeenCalledWith('three'),
				},
				{
					init: { key: 'w', ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => false,
						isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
						activeSessionId: 'session-1',
						activeSession,
						handleCloseCurrentTab: mockHandleCloseCurrentTab,
					},
					assert: () => expect(mockHandleCloseCurrentTab).toHaveBeenCalled(),
				},
				{
					init: { key: '†', code: 'KeyT', altKey: true, ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => false,
						isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'tabSwitcher',
						activeSessionId: 'session-1',
						activeSession,
						setTabSwitcherOpen: mockSetTabSwitcherOpen,
					},
					assert: () => expect(mockSetTabSwitcherOpen).toHaveBeenCalledWith(true),
				},
				{
					init: { key: '=', ctrlKey: true },
					context: {
						hasOpenLayers: () => true,
						hasOpenModal: () => true,
						recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
					},
					assert: () => expect(useSettingsStore.getState().fontSize).toBe(16),
				},
			];

			try {
				for (const testCase of cases) {
					vi.clearAllMocks();
					useSettingsStore.setState({ fontSize: 14 });
					result.current.keyboardHandlerRef.current = createMockContext(testCase.context);
					dispatchKeydown(testCase.init);
					testCase.assert();
				}
			} finally {
				scrollContainer.remove();
			}
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

	describe('general shortcut branches', () => {
		it('should report keyboard mastery level ups after handled shortcuts', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRightPanelOpen = vi.fn();
			const mockRecordShortcutUsage = vi.fn().mockReturnValue({ newLevel: 3 });
			const mockLevelUp = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleRightPanel',
				setRightPanelOpen: mockSetRightPanelOpen,
				recordShortcutUsage: mockRecordShortcutUsage,
				onKeyboardMasteryLevelUp: mockLevelUp,
			});

			dispatchKeydown({ key: 'p', metaKey: true });

			expect(mockSetRightPanelOpen).toHaveBeenCalled();
			expect(mockRecordShortcutUsage).toHaveBeenCalledWith('toggleRightPanel');
			expect(mockLevelUp).toHaveBeenCalledWith(3);
		});

		it('should toggle the right panel without keyboard mastery callbacks', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRightPanelOpen = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleRightPanel',
				setRightPanelOpen: mockSetRightPanelOpen,
			});

			dispatchKeydown({ key: 'p', metaKey: true });

			expect(mockSetRightPanelOpen).toHaveBeenCalled();
			const updater = mockSetRightPanelOpen.mock.calls[0][0] as (previous: boolean) => boolean;
			expect(updater(false)).toBe(true);
			expect(updater(true)).toBe(false);
		});

		it('should not collapse an empty-state sidebar but should reopen it', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetLeftSidebarOpen = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleSidebar',
				sessions: [],
				leftSidebarOpen: true,
				setLeftSidebarOpen: mockSetLeftSidebarOpen,
			});

			dispatchKeydown({ key: 'b', metaKey: true });

			expect(mockSetLeftSidebarOpen).not.toHaveBeenCalled();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleSidebar',
				sessions: [],
				leftSidebarOpen: false,
				setLeftSidebarOpen: mockSetLeftSidebarOpen,
			});

			dispatchKeydown({ key: 'b', metaKey: true });

			expect(mockSetLeftSidebarOpen).toHaveBeenCalledTimes(1);
			const updater = mockSetLeftSidebarOpen.mock.calls[0][0] as (previous: boolean) => boolean;
			expect(updater(false)).toBe(true);
		});

		it('should keep prerequisite-gated shortcuts closed when context is missing', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const cases = [
				{
					actionId: 'quickAction',
					overrides: {
						sessions: [],
						setQuickActionOpen: vi.fn(),
						setQuickActionInitialMode: vi.fn(),
					},
					getBlockedSpy: (ctx: Record<string, unknown>) => ctx.setQuickActionOpen,
				},
				{
					actionId: 'moveToGroup',
					overrides: {
						activeSession: null,
						setQuickActionOpen: vi.fn(),
						setQuickActionInitialMode: vi.fn(),
					},
					getBlockedSpy: (ctx: Record<string, unknown>) => ctx.setQuickActionOpen,
				},
				{
					actionId: 'agentSettings',
					overrides: { activeSession: null, setEditAgentSession: vi.fn() },
					getBlockedSpy: (ctx: Record<string, unknown>) => ctx.setEditAgentSession,
				},
				{
					actionId: 'viewGitLog',
					overrides: {
						activeSession: { id: 'session-1', isGitRepo: false },
						setGitLogOpen: vi.fn(),
					},
					getBlockedSpy: (ctx: Record<string, unknown>) => ctx.setGitLogOpen,
				},
				{
					actionId: 'agentSessions',
					overrides: {
						hasActiveSessionCapability: vi.fn().mockReturnValue(false),
						setAgentSessionsOpen: vi.fn(),
					},
					getBlockedSpy: (ctx: Record<string, unknown>) => ctx.setAgentSessionsOpen,
				},
				{
					actionId: 'directorNotes',
					overrides: {
						encoreFeatures: { directorNotes: false },
						setDirectorNotesOpen: vi.fn(),
					},
					getBlockedSpy: (ctx: Record<string, unknown>) => ctx.setDirectorNotesOpen,
				},
			];

			for (const testCase of cases) {
				const context = createMockContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === testCase.actionId,
					...testCase.overrides,
				});
				result.current.keyboardHandlerRef.current = context;

				dispatchKeydown({ key: 'x', metaKey: true });

				expect(testCase.getBlockedSpy(context) as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
			}
		});

		it('should leave guarded shortcuts inactive when optional prerequisites are missing', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const cases = [
				{
					actionId: 'killInstance',
					overrides: {
						activeGroupChatId: null,
						activeSessionId: null,
						deleteGroupChatWithConfirmation: vi.fn(),
						deleteSession: vi.fn(),
					},
					spies: ['deleteGroupChatWithConfirmation', 'deleteSession'],
				},
				{
					actionId: 'fuzzyFileSearch',
					overrides: { activeSession: null, setFuzzyFileSearchOpen: vi.fn() },
					spies: ['setFuzzyFileSearchOpen'],
				},
				{
					actionId: 'toggleBookmark',
					overrides: { activeSession: null, toggleBookmark: vi.fn() },
					spies: ['toggleBookmark'],
				},
				{
					actionId: 'openPromptComposer',
					overrides: {
						activeSession: { id: 'session-1', inputMode: 'terminal' },
						setPromptComposerOpen: vi.fn(),
					},
					spies: ['setPromptComposerOpen'],
				},
			];

			for (const testCase of cases) {
				const context = createMockContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === testCase.actionId,
					...testCase.overrides,
				});
				result.current.keyboardHandlerRef.current = context;

				dispatchKeydown({ key: 'x', metaKey: true });

				for (const spyName of testCase.spies) {
					expect(context[spyName] as ReturnType<typeof vi.fn>, spyName).not.toHaveBeenCalled();
				}
			}
		});

		it('should invoke primary action shortcuts with expected handlers and payloads', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const activeSession = { id: 'session-1', inputMode: 'ai' };
			const cases: Array<{
				name: string;
				actionId: string;
				overrides: Record<string, unknown>;
				assert: (context: Record<string, unknown>) => void;
			}> = [
				{
					name: 'new instance',
					actionId: 'newInstance',
					overrides: { addNewSession: vi.fn() },
					assert: (context) =>
						expect(
							context.addNewSession as ReturnType<typeof vi.fn>,
							'new instance'
						).toHaveBeenCalled(),
				},
				{
					name: 'new group chat',
					actionId: 'newGroupChat',
					overrides: { setShowNewGroupChatModal: vi.fn() },
					assert: (context) =>
						expect(
							context.setShowNewGroupChatModal as ReturnType<typeof vi.fn>,
							'new group chat'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'kill active group chat',
					actionId: 'killInstance',
					overrides: { activeGroupChatId: 'group-1', deleteGroupChatWithConfirmation: vi.fn() },
					assert: (context) =>
						expect(
							context.deleteGroupChatWithConfirmation as ReturnType<typeof vi.fn>,
							'kill active group chat'
						).toHaveBeenCalledWith('group-1'),
				},
				{
					name: 'kill active session',
					actionId: 'killInstance',
					overrides: { activeSessionId: 'session-1', deleteSession: vi.fn() },
					assert: (context) =>
						expect(
							context.deleteSession as ReturnType<typeof vi.fn>,
							'kill active session'
						).toHaveBeenCalledWith('session-1'),
				},
				{
					name: 'move to group',
					actionId: 'moveToGroup',
					overrides: {
						activeSession,
						setQuickActionInitialMode: vi.fn(),
						setQuickActionOpen: vi.fn(),
					},
					assert: (context) => {
						expect(
							context.setQuickActionInitialMode as ReturnType<typeof vi.fn>,
							'move to group mode'
						).toHaveBeenCalledWith('move-to-group');
						expect(
							context.setQuickActionOpen as ReturnType<typeof vi.fn>,
							'move to group modal'
						).toHaveBeenCalledWith(true);
					},
				},
				{
					name: 'navigation back',
					actionId: 'navBack',
					overrides: { handleNavBack: vi.fn() },
					assert: (context) =>
						expect(
							context.handleNavBack as ReturnType<typeof vi.fn>,
							'navigation back'
						).toHaveBeenCalled(),
				},
				{
					name: 'navigation forward',
					actionId: 'navForward',
					overrides: { handleNavForward: vi.fn() },
					assert: (context) =>
						expect(
							context.handleNavForward as ReturnType<typeof vi.fn>,
							'navigation forward'
						).toHaveBeenCalled(),
				},
				{
					name: 'quick action main mode',
					actionId: 'quickAction',
					overrides: {
						sessions: [activeSession],
						setQuickActionInitialMode: vi.fn(),
						setQuickActionOpen: vi.fn(),
					},
					assert: (context) => {
						expect(
							context.setQuickActionInitialMode as ReturnType<typeof vi.fn>,
							'quick action mode'
						).toHaveBeenCalledWith('main');
						expect(
							context.setQuickActionOpen as ReturnType<typeof vi.fn>,
							'quick action modal'
						).toHaveBeenCalledWith(true);
					},
				},
				{
					name: 'help',
					actionId: 'help',
					overrides: { setShortcutsHelpOpen: vi.fn() },
					assert: (context) =>
						expect(
							context.setShortcutsHelpOpen as ReturnType<typeof vi.fn>,
							'help'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'settings',
					actionId: 'settings',
					overrides: { setSettingsModalOpen: vi.fn(), setSettingsTab: vi.fn() },
					assert: (context) => {
						expect(
							context.setSettingsModalOpen as ReturnType<typeof vi.fn>,
							'settings modal'
						).toHaveBeenCalledWith(true);
						expect(
							context.setSettingsTab as ReturnType<typeof vi.fn>,
							'settings tab'
						).toHaveBeenCalledWith('general');
					},
				},
				{
					name: 'agent settings',
					actionId: 'agentSettings',
					overrides: { activeSession, setEditAgentSession: vi.fn() },
					assert: (context) =>
						expect(
							context.setEditAgentSession as ReturnType<typeof vi.fn>,
							'agent settings'
						).toHaveBeenCalledWith(activeSession),
				},
				{
					name: 'Auto Run tab',
					actionId: 'goToAutoRun',
					overrides: {
						setRightPanelOpen: vi.fn(),
						handleSetActiveRightTab: vi.fn(),
						setActiveFocus: vi.fn(),
					},
					assert: (context) => {
						expect(
							context.setRightPanelOpen as ReturnType<typeof vi.fn>,
							'Auto Run panel'
						).toHaveBeenCalledWith(true);
						expect(
							context.handleSetActiveRightTab as ReturnType<typeof vi.fn>,
							'Auto Run tab'
						).toHaveBeenCalledWith('autorun');
						expect(
							context.setActiveFocus as ReturnType<typeof vi.fn>,
							'Auto Run focus'
						).toHaveBeenCalledWith('right');
					},
				},
				{
					name: 'fuzzy file search',
					actionId: 'fuzzyFileSearch',
					overrides: { activeSession, setFuzzyFileSearchOpen: vi.fn() },
					assert: (context) =>
						expect(
							context.setFuzzyFileSearchOpen as ReturnType<typeof vi.fn>,
							'fuzzy file search'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'bookmark',
					actionId: 'toggleBookmark',
					overrides: { activeSession, toggleBookmark: vi.fn() },
					assert: (context) =>
						expect(
							context.toggleBookmark as ReturnType<typeof vi.fn>,
							'bookmark'
						).toHaveBeenCalledWith('session-1'),
				},
				{
					name: 'tab star',
					actionId: 'toggleTabStar',
					overrides: { toggleTabStar: vi.fn() },
					assert: (context) =>
						expect(
							context.toggleTabStar as ReturnType<typeof vi.fn>,
							'tab star'
						).toHaveBeenCalled(),
				},
				{
					name: 'prompt composer',
					actionId: 'openPromptComposer',
					overrides: { activeSession, setPromptComposerOpen: vi.fn() },
					assert: (context) =>
						expect(
							context.setPromptComposerOpen as ReturnType<typeof vi.fn>,
							'prompt composer'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'wizard',
					actionId: 'openWizard',
					overrides: { openWizardModal: vi.fn() },
					assert: (context) =>
						expect(
							context.openWizardModal as ReturnType<typeof vi.fn>,
							'wizard'
						).toHaveBeenCalled(),
				},
				{
					name: 'git diff',
					actionId: 'viewGitDiff',
					overrides: { handleViewGitDiff: vi.fn() },
					assert: (context) =>
						expect(
							context.handleViewGitDiff as ReturnType<typeof vi.fn>,
							'git diff'
						).toHaveBeenCalled(),
				},
				{
					name: 'system logs',
					actionId: 'systemLogs',
					overrides: { setLogViewerOpen: vi.fn() },
					assert: (context) =>
						expect(
							context.setLogViewerOpen as ReturnType<typeof vi.fn>,
							'system logs'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'usage dashboard',
					actionId: 'usageDashboard',
					overrides: { setUsageDashboardOpen: vi.fn() },
					assert: (context) =>
						expect(
							context.setUsageDashboardOpen as ReturnType<typeof vi.fn>,
							'usage dashboard'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'Symphony',
					actionId: 'openSymphony',
					overrides: { setSymphonyModalOpen: vi.fn() },
					assert: (context) =>
						expect(
							context.setSymphonyModalOpen as ReturnType<typeof vi.fn>,
							'Symphony'
						).toHaveBeenCalledWith(true),
				},
				{
					name: 'auto-scroll',
					actionId: 'toggleAutoScroll',
					overrides: { autoScrollAiMode: true, setAutoScrollAiMode: vi.fn() },
					assert: (context) =>
						expect(
							context.setAutoScrollAiMode as ReturnType<typeof vi.fn>,
							'auto-scroll'
						).toHaveBeenCalledWith(false),
				},
			];

			for (const testCase of cases) {
				const context = createMockContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === testCase.actionId,
					...testCase.overrides,
				});
				result.current.keyboardHandlerRef.current = context;

				dispatchKeydown({ key: 'x', metaKey: true });

				testCase.assert(context);
			}
		});

		it('should route Files and History shortcuts to group chat right-bar tabs', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRightPanelOpen = vi.fn();
			const mockSetGroupChatRightTab = vi.fn();
			const mockHandleSetActiveRightTab = vi.fn();
			const mockSetActiveFocus = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: 'group-1',
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToFiles',
				setRightPanelOpen: mockSetRightPanelOpen,
				setGroupChatRightTab: mockSetGroupChatRightTab,
				handleSetActiveRightTab: mockHandleSetActiveRightTab,
				setActiveFocus: mockSetActiveFocus,
			});

			dispatchKeydown({ key: 'f', metaKey: true, shiftKey: true });

			expect(mockSetRightPanelOpen).toHaveBeenCalledWith(true);
			expect(mockSetGroupChatRightTab).toHaveBeenCalledWith('participants');
			expect(mockHandleSetActiveRightTab).not.toHaveBeenCalled();
			expect(mockSetActiveFocus).toHaveBeenCalledWith('right');

			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: 'group-1',
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToHistory',
				setRightPanelOpen: mockSetRightPanelOpen,
				setGroupChatRightTab: mockSetGroupChatRightTab,
				handleSetActiveRightTab: mockHandleSetActiveRightTab,
				setActiveFocus: mockSetActiveFocus,
			});

			dispatchKeydown({ key: 'h', metaKey: true, shiftKey: true });

			expect(mockSetGroupChatRightTab).toHaveBeenCalledWith('history');
			expect(mockHandleSetActiveRightTab).not.toHaveBeenCalled();
		});

		it('should route History shortcut to the normal right panel outside group chat', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetRightPanelOpen = vi.fn();
			const mockSetGroupChatRightTab = vi.fn();
			const mockHandleSetActiveRightTab = vi.fn();
			const mockSetActiveFocus = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: null,
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToHistory',
				setRightPanelOpen: mockSetRightPanelOpen,
				setGroupChatRightTab: mockSetGroupChatRightTab,
				handleSetActiveRightTab: mockHandleSetActiveRightTab,
				setActiveFocus: mockSetActiveFocus,
			});

			dispatchKeydown({ key: 'h', metaKey: true, shiftKey: true });

			expect(mockSetRightPanelOpen).toHaveBeenCalledWith(true);
			expect(mockHandleSetActiveRightTab).toHaveBeenCalledWith('history');
			expect(mockSetGroupChatRightTab).not.toHaveBeenCalled();
			expect(mockSetActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should open staged image carousels from session or group chat images only when images exist', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const sessionImages = [{ id: 'session-image-1' }, { id: 'session-image-2' }];
			const groupImages = [{ id: 'group-image-1' }];
			const mockHandleSetLightboxImage = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'openImageCarousel',
				stagedImages: sessionImages,
				groupChatStagedImages: groupImages,
				handleSetLightboxImage: mockHandleSetLightboxImage,
			});

			dispatchKeydown({ key: 'i', metaKey: true });

			expect(mockHandleSetLightboxImage).toHaveBeenCalledWith(
				sessionImages[0],
				sessionImages,
				'staged'
			);

			result.current.keyboardHandlerRef.current = createMockContext({
				activeGroupChatId: 'group-1',
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'openImageCarousel',
				stagedImages: sessionImages,
				groupChatStagedImages: groupImages,
				handleSetLightboxImage: mockHandleSetLightboxImage,
			});

			dispatchKeydown({ key: 'i', metaKey: true });

			expect(mockHandleSetLightboxImage).toHaveBeenLastCalledWith(
				groupImages[0],
				groupImages,
				'staged'
			);

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'openImageCarousel',
				stagedImages: [],
				handleSetLightboxImage: mockHandleSetLightboxImage,
			});

			dispatchKeydown({ key: 'i', metaKey: true });

			expect(mockHandleSetLightboxImage).toHaveBeenCalledTimes(2);
		});

		it('should move focus from a focused input back to terminal output', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const input = document.createElement('input');
			const terminalOutput = document.createElement('div');
			terminalOutput.tabIndex = -1;
			document.body.append(input, terminalOutput);

			const mockBlur = vi.spyOn(input, 'blur');
			const mockTerminalFocus = vi.spyOn(terminalOutput, 'focus');

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'focusInput',
				inputRef: { current: input },
				terminalOutputRef: { current: terminalOutput },
			});

			input.focus();
			dispatchKeydown({ key: 'i', metaKey: true });

			expect(mockBlur).toHaveBeenCalled();
			expect(mockTerminalFocus).toHaveBeenCalled();

			input.remove();
			terminalOutput.remove();
		});

		it('should focus the group chat input when a group chat is active', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());
			const groupInput = document.createElement('textarea');
			document.body.append(groupInput);

			const mockSetActiveFocus = vi.fn();
			const mockFocus = vi.spyOn(groupInput, 'focus');

			try {
				result.current.keyboardHandlerRef.current = createMockContext({
					activeGroupChatId: 'group-1',
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'focusInput',
					groupChatInputRef: { current: groupInput },
					inputRef: { current: null },
					terminalOutputRef: { current: null },
					setActiveFocus: mockSetActiveFocus,
				});

				dispatchKeydown({ key: 'i', metaKey: true });
				vi.advanceTimersByTime(0);

				expect(mockSetActiveFocus).toHaveBeenCalledWith('main');
				expect(mockFocus).toHaveBeenCalled();
			} finally {
				groupInput.remove();
				vi.useRealTimers();
			}
		});

		it('should expand and focus the sidebar when focusSidebar runs from a collapsed state', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());
			const sidebar = document.createElement('aside');
			sidebar.tabIndex = -1;
			document.body.append(sidebar);

			const mockSetLeftSidebarOpen = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockFocus = vi.spyOn(sidebar, 'focus');

			try {
				result.current.keyboardHandlerRef.current = createMockContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'focusSidebar',
					leftSidebarOpen: false,
					setLeftSidebarOpen: mockSetLeftSidebarOpen,
					setActiveFocus: mockSetActiveFocus,
					sidebarContainerRef: { current: sidebar },
				});

				dispatchKeydown({ key: 's', metaKey: true });
				vi.advanceTimersByTime(0);

				expect(mockSetLeftSidebarOpen).toHaveBeenCalledWith(true);
				expect(mockSetActiveFocus).toHaveBeenCalledWith('sidebar');
				expect(mockFocus).toHaveBeenCalled();
			} finally {
				sidebar.remove();
				vi.useRealTimers();
			}
		});

		it('should focus the sidebar without reopening it when already expanded', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());
			const sidebar = document.createElement('aside');
			sidebar.tabIndex = -1;
			document.body.append(sidebar);

			const mockSetLeftSidebarOpen = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockFocus = vi.spyOn(sidebar, 'focus');

			try {
				result.current.keyboardHandlerRef.current = createMockContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'focusSidebar',
					leftSidebarOpen: true,
					setLeftSidebarOpen: mockSetLeftSidebarOpen,
					setActiveFocus: mockSetActiveFocus,
					sidebarContainerRef: { current: sidebar },
				});

				dispatchKeydown({ key: 's', metaKey: true });
				vi.advanceTimersByTime(0);

				expect(mockSetLeftSidebarOpen).not.toHaveBeenCalled();
				expect(mockSetActiveFocus).toHaveBeenCalledWith('sidebar');
				expect(mockFocus).toHaveBeenCalled();
			} finally {
				sidebar.remove();
				vi.useRealTimers();
			}
		});

		it('should open git log, agent sessions, and director notes when prerequisites pass', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetGitLogOpen = vi.fn();
			const mockSetActiveAgentSessionId = vi.fn();
			const mockSetAgentSessionsOpen = vi.fn();
			const mockSetDirectorNotesOpen = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'viewGitLog',
				activeSession: { id: 'session-1', isGitRepo: true },
				setGitLogOpen: mockSetGitLogOpen,
			});

			dispatchKeydown({ key: 'g', metaKey: true });

			expect(mockSetGitLogOpen).toHaveBeenCalledWith(true);

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'agentSessions',
				hasActiveSessionCapability: vi.fn().mockReturnValue(true),
				setActiveAgentSessionId: mockSetActiveAgentSessionId,
				setAgentSessionsOpen: mockSetAgentSessionsOpen,
			});

			dispatchKeydown({ key: 'a', metaKey: true });

			expect(mockSetActiveAgentSessionId).toHaveBeenCalledWith(null);
			expect(mockSetAgentSessionsOpen).toHaveBeenCalledWith(true);

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'directorNotes',
				encoreFeatures: { directorNotes: true },
				setDirectorNotesOpen: mockSetDirectorNotesOpen,
			});

			dispatchKeydown({ key: 'd', metaKey: true });

			expect(mockSetDirectorNotesOpen).toHaveBeenCalledWith(true);
		});

		it('should scroll the current output container to the bottom', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const scrollContainer = document.createElement('div');
			const logsEnd = document.createElement('div');
			scrollContainer.append(logsEnd);
			document.body.append(scrollContainer);
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 240 });
			const mockScrollTo = vi.fn();
			scrollContainer.scrollTo = mockScrollTo;

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'jumpToBottom',
				logsEndRef: { current: logsEnd },
			});

			dispatchKeydown({ key: 'j', metaKey: true, shiftKey: true });

			expect(mockScrollTo).toHaveBeenCalledWith({ top: 240, behavior: 'instant' });

			scrollContainer.remove();
		});

		it('should tolerate jumpToBottom when the log anchor has no scroll container', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const logsEnd = document.createElement('div');

			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'jumpToBottom',
				logsEndRef: { current: logsEnd },
			});

			expect(() => dispatchKeydown({ key: 'j', metaKey: true, shiftKey: true })).not.toThrow();
		});

		it('should toggle Auto Run expanded state through the right panel ref', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleAutoRunExpanded = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleAutoRunExpanded',
				rightPanelRef: { current: { toggleAutoRunExpanded: mockToggleAutoRunExpanded } },
			});

			dispatchKeydown({ key: 'e', metaKey: true, altKey: true });

			expect(mockToggleAutoRunExpanded).toHaveBeenCalled();
		});

		it('should track contextual Cmd+F shortcuts for files, sidebar, history, and output search', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockRecordShortcutUsage = vi.fn().mockReturnValue({ newLevel: null });
			const mockSetFileTreeFilterOpen = vi.fn();

			result.current.keyboardHandlerRef.current = createMockContext({
				activeFocus: 'right',
				activeRightTab: 'files',
				setFileTreeFilterOpen: mockSetFileTreeFilterOpen,
				recordShortcutUsage: mockRecordShortcutUsage,
			});

			dispatchKeydown({ key: 'f', metaKey: true });

			expect(mockSetFileTreeFilterOpen).toHaveBeenCalledWith(true);
			expect(mockRecordShortcutUsage).toHaveBeenCalledWith('filterFiles');

			const contexts = [
				{ activeFocus: 'sidebar', shortcutId: 'filterSessions' },
				{ activeFocus: 'right', activeRightTab: 'history', shortcutId: 'filterHistory' },
				{ activeFocus: 'main', shortcutId: 'searchOutput' },
			];

			for (const context of contexts) {
				result.current.keyboardHandlerRef.current = createMockContext({
					...context,
					recordShortcutUsage: mockRecordShortcutUsage,
				});

				dispatchKeydown({ key: 'f', metaKey: true });

				expect(mockRecordShortcutUsage).toHaveBeenCalledWith(context.shortcutId);
			}
		});

		it('should ignore contextual Cmd+F when the focus context is not searchable', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockRecordShortcutUsage = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeFocus: 'right',
				activeRightTab: 'autorun',
				setFileTreeFilterOpen: vi.fn(),
				recordShortcutUsage: mockRecordShortcutUsage,
			});

			dispatchKeydown({ key: 'f', metaKey: true });

			expect(mockRecordShortcutUsage).not.toHaveBeenCalled();
		});

		it('should track contextual Ctrl+F shortcuts', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockRecordShortcutUsage = vi.fn().mockReturnValue({ newLevel: null });
			const mockSetFileTreeFilterOpen = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				activeFocus: 'right',
				activeRightTab: 'files',
				setFileTreeFilterOpen: mockSetFileTreeFilterOpen,
				recordShortcutUsage: mockRecordShortcutUsage,
			});

			dispatchKeydown({ key: 'f', ctrlKey: true });

			expect(mockSetFileTreeFilterOpen).toHaveBeenCalledWith(true);
			expect(mockRecordShortcutUsage).toHaveBeenCalledWith('filterFiles');
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

		it('should delegate to handleTabNavigation', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockTabNavigation = vi.fn().mockReturnValue(true);
			result.current.keyboardHandlerRef.current = createMockContext({
				handleTabNavigation: mockTabNavigation,
			});

			dispatchKeydown({ key: 'Tab' });

			expect(mockTabNavigation).toHaveBeenCalled();
		});

		it('should delegate to handleEscapeInMain', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockEscapeInMain = vi.fn().mockReturnValue(true);
			result.current.keyboardHandlerRef.current = createMockContext({
				handleEscapeInMain: mockEscapeInMain,
			});

			dispatchKeydown({ key: 'Escape' });

			expect(mockEscapeInMain).toHaveBeenCalled();
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

		it('should ignore session jump numbers outside the visible session range', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetActiveSessionId = vi.fn();
			result.current.keyboardHandlerRef.current = createMockContext({
				visibleSessions: [{ id: 'session-1' }],
				setActiveSessionId: mockSetActiveSessionId,
				leftSidebarOpen: true,
				setLeftSidebarOpen: vi.fn(),
			});

			dispatchKeydown({ key: '2', code: 'Digit2', altKey: true, metaKey: true });

			expect(mockSetActiveSessionId).not.toHaveBeenCalled();
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
		it('should disable toggleMode (Cmd+J) for wizard tabs', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleInputMode = vi.fn();
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
				toggleInputMode: mockToggleInputMode,
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

			// toggleInputMode should NOT be called for wizard tabs
			expect(mockToggleInputMode).not.toHaveBeenCalled();
		});

		it('should allow toggleMode (Cmd+J) for regular tabs', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleInputMode = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockFocus = vi.fn();
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
				toggleInputMode: mockToggleInputMode,
				setActiveFocus: mockSetActiveFocus,
				inputRef: { current: { focus: mockFocus } },
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

			// toggleInputMode SHOULD be called for regular tabs
			expect(mockToggleInputMode).toHaveBeenCalled();
			// Should auto-focus the input after toggling
			expect(mockSetActiveFocus).toHaveBeenCalledWith('main');
			vi.advanceTimersByTime(50);
			expect(mockFocus).toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('should allow toggleMode when wizardState exists but isActive is false', () => {
			vi.useFakeTimers();
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleInputMode = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockFocus = vi.fn();
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
				toggleInputMode: mockToggleInputMode,
				setActiveFocus: mockSetActiveFocus,
				inputRef: { current: { focus: mockFocus } },
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

			// toggleInputMode SHOULD be called when wizard is not active
			expect(mockToggleInputMode).toHaveBeenCalled();
			// Should auto-focus the input after toggling
			expect(mockSetActiveFocus).toHaveBeenCalledWith('main');
			vi.advanceTimersByTime(50);
			expect(mockFocus).toHaveBeenCalled();
			vi.useRealTimers();
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

				// Should NOT close directly — should show confirmation modal
				expect(mockPerformTabClose).not.toHaveBeenCalled();
				expect(useModalStore.getState().isOpen('confirm')).toBe(true);
				const modal = useModalStore.getState().modals.get('confirm');
				expect((modal?.data as any)?.message).toContain('unsent draft');

				act(() => {
					(modal?.data as any)?.onConfirm();
				});

				expect(mockPerformTabClose).toHaveBeenCalledWith('ai-tab-2');
			});

			it('should show confirmation modal for active wizard tabs and close after confirmation', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({
					type: 'ai',
					tabId: 'wizard-tab',
					isWizardTab: true,
				});
				const mockPerformTabClose = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					performTabClose: mockPerformTabClose,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'wizard-tab', name: 'Wizard', logs: [] }],
						activeTabId: 'wizard-tab',
						filePreviewTabs: [],
						activeFileTabId: null,
						unifiedTabOrder: ['wizard-tab'],
						inputMode: 'ai',
					},
				});

				dispatchKeydown({ key: 'w', metaKey: true });

				expect(mockPerformTabClose).not.toHaveBeenCalled();
				expect(useModalStore.getState().isOpen('confirm')).toBe(true);
				const modal = useModalStore.getState().modals.get('confirm');
				expect((modal?.data as any)?.message).toContain('Close this wizard');

				act(() => {
					(modal?.data as any)?.onConfirm();
				});

				expect(mockPerformTabClose).toHaveBeenCalledWith('wizard-tab');
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

			it('should use current session from store, not stale ref (stale-state safety)', () => {
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

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
					activeSession: staleSession, // Stale session in the ref
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

				// Navigation should use the FRESH session from the store, not the stale ref
				expect(mockNavigateToNextUnifiedTab).toHaveBeenCalledWith(freshSession, false);
			});

			it('should keep sessions unchanged when tab cycling has no current session or result', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const otherSession = { ...activeSession, id: 'session-2' };
				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue(null);
				const mockNavigateToPrevUnifiedTab = vi.fn().mockReturnValue(null);
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					activeSession,
					activeSessionId: 'missing-session',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: ']', metaKey: true, shiftKey: true });
				let updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([otherSession])).toEqual([otherSession]);
				expect(mockNavigateToNextUnifiedTab).not.toHaveBeenCalled();

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					activeSession,
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: ']', metaKey: true, shiftKey: true });
				updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([activeSession])).toEqual([activeSession]);
				expect(mockNavigateToNextUnifiedTab).toHaveBeenCalledWith(activeSession, false);

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
					activeSession,
					activeSessionId: 'missing-session',
					navigateToPrevUnifiedTab: mockNavigateToPrevUnifiedTab,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '[', metaKey: true, shiftKey: true });
				updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([otherSession])).toEqual([otherSession]);
				expect(mockNavigateToPrevUnifiedTab).not.toHaveBeenCalled();

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
					activeSession,
					navigateToPrevUnifiedTab: mockNavigateToPrevUnifiedTab,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '[', metaKey: true, shiftKey: true });
				updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([activeSession])).toEqual([activeSession]);
				expect(mockNavigateToPrevUnifiedTab).toHaveBeenCalledWith(activeSession, false);
			});

			it('should preserve inactive sessions while applying tab navigation results', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const inactiveSession = {
					id: 'session-2',
					aiTabs: [{ id: 'other-tab', name: 'Other', logs: [] }],
					activeTabId: 'other-tab',
					inputMode: 'ai',
				};
				const activeSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const nextSession = { ...activeSession, activeTabId: 'ai-tab-2' };
				const previousSession = { ...activeSession, activeTabId: 'ai-tab-0' };
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					activeSession,
					navigateToNextUnifiedTab: vi.fn().mockReturnValue({ session: nextSession }),
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: ']', metaKey: true, shiftKey: true });
				let updatedSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					inactiveSession,
					activeSession,
				]);
				expect(updatedSessions).toEqual([inactiveSession, nextSession]);

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
					activeSession,
					navigateToPrevUnifiedTab: vi.fn().mockReturnValue({ session: previousSession }),
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '[', metaKey: true, shiftKey: true });
				updatedSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					inactiveSession,
					activeSession,
				]);
				expect(updatedSessions).toEqual([inactiveSession, previousSession]);
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
					0 // index 0 for Cmd+1
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
					1 // index 1 for Cmd+2
				);
			});

			it('should not execute tab jump when showUnreadOnly is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToUnifiedTabByIndex = vi.fn();
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab1',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
					showUnreadOnly: true, // Filter is active - disables Cmd+1-9
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

				// Should NOT be called when showUnreadOnly is active
				expect(mockNavigateToUnifiedTabByIndex).not.toHaveBeenCalled();
			});

			it('should keep sessions unchanged when tab index navigation has no current session or result', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const otherSession = { ...activeSession, id: 'session-2' };
				const mockNavigateToUnifiedTabByIndex = vi.fn().mockReturnValue(null);
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab1',
					activeSession,
					activeSessionId: 'missing-session',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '1', metaKey: true });
				let updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([otherSession])).toEqual([otherSession]);
				expect(mockNavigateToUnifiedTabByIndex).not.toHaveBeenCalled();

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab1',
					activeSession,
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '1', metaKey: true });
				updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([activeSession])).toEqual([activeSession]);
				expect(mockNavigateToUnifiedTabByIndex).toHaveBeenCalledWith(activeSession, 0);
			});

			it('should preserve inactive sessions while applying tab index navigation results', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const inactiveSession = {
					id: 'session-2',
					aiTabs: [{ id: 'other-tab', name: 'Other', logs: [] }],
					activeTabId: 'other-tab',
					inputMode: 'ai',
				};
				const activeSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const indexedSession = { ...activeSession, activeTabId: 'ai-tab-3' };
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab3',
					activeSession,
					navigateToUnifiedTabByIndex: vi.fn().mockReturnValue({ session: indexedSession }),
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '3', metaKey: true });
				const updatedSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					inactiveSession,
					activeSession,
				]);

				expect(updatedSessions).toEqual([inactiveSession, indexedSession]);
			});
		});

		describe('Cmd+0 jumps to last tab, Cmd+Shift+0 resets font size', () => {
			it('should jump to last tab on Cmd+0', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				// Set font size to non-default to verify it does NOT reset
				useSettingsStore.setState({ fontSize: 20 });

				const mockSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const mockNavigateToLastUnifiedTab = vi.fn().mockReturnValue({
					session: { ...mockSession, activeTabId: 'ai-tab-2' },
				});

				const mockSetSessions = vi.fn((updater: unknown) => {
					if (typeof updater === 'function') {
						(updater as (prev: unknown[]) => unknown[])([mockSession]);
					}
				});

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					navigateToLastUnifiedTab: mockNavigateToLastUnifiedTab,
					setSessions: mockSetSessions,
					activeSession: mockSession,
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

			it('should reset font size on Cmd+Shift+0', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				// Set font size to non-default
				useSettingsStore.setState({ fontSize: 20 });

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

				// Cmd+Shift+0 should reset font size
				expect(useSettingsStore.getState().fontSize).toBe(14);
			});

			it('should keep sessions unchanged when last-tab navigation has no current session or result', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const otherSession = { ...activeSession, id: 'session-2' };
				const mockNavigateToLastUnifiedTab = vi.fn().mockReturnValue(null);
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					activeSession,
					activeSessionId: 'missing-session',
					navigateToLastUnifiedTab: mockNavigateToLastUnifiedTab,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '0', metaKey: true });
				let updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([otherSession])).toEqual([otherSession]);
				expect(mockNavigateToLastUnifiedTab).not.toHaveBeenCalled();

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					activeSession,
					navigateToLastUnifiedTab: mockNavigateToLastUnifiedTab,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '0', metaKey: true });
				updater = mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[];
				expect(updater([activeSession])).toEqual([activeSession]);
				expect(mockNavigateToLastUnifiedTab).toHaveBeenCalledWith(activeSession);
			});

			it('should preserve inactive sessions while applying last-tab navigation results', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const inactiveSession = {
					id: 'session-2',
					aiTabs: [{ id: 'other-tab', name: 'Other', logs: [] }],
					activeTabId: 'other-tab',
					inputMode: 'ai',
				};
				const activeSession = {
					id: 'session-1',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
				};
				const lastSession = { ...activeSession, activeTabId: 'last-tab' };
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					activeSession,
					navigateToLastUnifiedTab: vi.fn().mockReturnValue({ session: lastSession }),
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: '0', metaKey: true });
				const updatedSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					inactiveSession,
					activeSession,
				]);

				expect(updatedSessions).toEqual([inactiveSession, lastSession]);
			});
		});

		describe('Cmd+Shift+T (reopen closed tab)', () => {
			it('should reopen from unified closed tab history', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const activeSession = {
					id: 'session-1',
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
				};
				const inactiveSession = {
					id: 'session-2',
					activeTabId: 'other-tab',
					inputMode: 'ai',
					aiTabs: [{ id: 'other-tab', name: 'Other', logs: [] }],
				};
				const reopenedSession = {
					...activeSession,
					activeTabId: 'reopened-tab',
				};
				const mockReopenUnifiedClosedTab = vi.fn().mockReturnValue({
					session: reopenedSession,
					tab: { id: 'reopened-tab' },
					wasFile: true,
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'reopenClosedTab',
					reopenUnifiedClosedTab: mockReopenUnifiedClosedTab,
					setSessions: mockSetSessions,
					activeSession,
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
				const updatedSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeSession,
					inactiveSession,
				]);
				expect(updatedSessions).toEqual([reopenedSession, inactiveSession]);
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

		describe('tab management utility shortcuts', () => {
			it('should create a new tab and replace only the active session', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
				};
				const inactiveSession = {
					id: 'session-2',
					activeTabId: 'other-tab',
					inputMode: 'ai',
					aiTabs: [{ id: 'other-tab', name: 'Other', logs: [] }],
				};
				const nextSession = {
					...activeSession,
					activeTabId: 'ai-tab-2',
					aiTabs: [...activeSession.aiTabs, { id: 'ai-tab-2', name: 'AI Tab 2', logs: [] }],
				};
				const mockCreateTab = vi.fn().mockReturnValue({ session: nextSession });
				const mockSetSessions = vi.fn();
				const mockSetActiveFocus = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					activeSession,
					createTab: mockCreateTab,
					setSessions: mockSetSessions,
					setActiveFocus: mockSetActiveFocus,
					inputRef: { current: null },
					defaultSaveToHistory: false,
					defaultShowThinking: 'sticky',
				});

				dispatchKeydown({ key: 't', metaKey: true });

				expect(mockCreateTab).toHaveBeenCalledWith(activeSession, {
					saveToHistory: false,
					showThinking: 'sticky',
				});
				const updatedSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeSession,
					inactiveSession,
				]);
				expect(updatedSessions).toEqual([nextSession, inactiveSession]);
				expect(mockSetActiveFocus).toHaveBeenCalledWith('main');
			});

			it('should not update sessions when new tab creation returns no result', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
					aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
				};
				const mockCreateTab = vi.fn().mockReturnValue(null);
				const mockSetSessions = vi.fn();
				const mockSetActiveFocus = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					activeSession,
					createTab: mockCreateTab,
					setSessions: mockSetSessions,
					setActiveFocus: mockSetActiveFocus,
					inputRef: { current: null },
					defaultSaveToHistory: true,
					defaultShowThinking: 'on',
				});

				dispatchKeydown({ key: 't', metaKey: true });

				expect(mockCreateTab).toHaveBeenCalled();
				expect(mockSetSessions).not.toHaveBeenCalled();
				expect(mockSetActiveFocus).not.toHaveBeenCalled();
			});

			it('should run bulk close shortcuts only when their guards allow it', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					aiTabs: [
						{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] },
						{ id: 'ai-tab-2', name: 'AI Tab 2', logs: [] },
						{ id: 'ai-tab-3', name: 'AI Tab 3', logs: [] },
					],
					activeTabId: 'ai-tab-2',
					inputMode: 'ai',
				};

				const cases = [
					{
						actionId: 'closeAllTabs',
						handlerName: 'handleCloseAllTabs',
						handler: vi.fn(),
						session: activeSession,
						expectedCalls: 1,
					},
					{
						actionId: 'closeOtherTabs',
						handlerName: 'handleCloseOtherTabs',
						handler: vi.fn(),
						session: activeSession,
						expectedCalls: 1,
					},
					{
						actionId: 'closeOtherTabs',
						handlerName: 'handleCloseOtherTabs',
						handler: vi.fn(),
						session: {
							...activeSession,
							aiTabs: [activeSession.aiTabs[0]],
							activeTabId: 'ai-tab-1',
						},
						expectedCalls: 0,
					},
					{
						actionId: 'closeTabsLeft',
						handlerName: 'handleCloseTabsLeft',
						handler: vi.fn(),
						session: activeSession,
						expectedCalls: 1,
					},
					{
						actionId: 'closeTabsLeft',
						handlerName: 'handleCloseTabsLeft',
						handler: vi.fn(),
						session: { ...activeSession, activeTabId: 'ai-tab-1' },
						expectedCalls: 0,
					},
					{
						actionId: 'closeTabsRight',
						handlerName: 'handleCloseTabsRight',
						handler: vi.fn(),
						session: activeSession,
						expectedCalls: 1,
					},
					{
						actionId: 'closeTabsRight',
						handlerName: 'handleCloseTabsRight',
						handler: vi.fn(),
						session: { ...activeSession, activeTabId: 'ai-tab-3' },
						expectedCalls: 0,
					},
				];

				for (const testCase of cases) {
					result.current.keyboardHandlerRef.current = createUnifiedTabContext({
						isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === testCase.actionId,
						activeSession: testCase.session,
						[testCase.handlerName]: testCase.handler,
					});

					dispatchKeydown({ key: 'w', metaKey: true, shiftKey: true });

					expect(testCase.handler, testCase.actionId).toHaveBeenCalledTimes(testCase.expectedCalls);
				}
			});

			it('should only open rename modal for tabs backed by an agent session', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockSetRenameTabId = vi.fn();
				const mockSetRenameTabInitialName = vi.fn();
				const mockSetRenameTabModalOpen = vi.fn();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'renameTab',
					getActiveTab: vi.fn().mockReturnValue({
						id: 'ai-tab-1',
						name: 'Current Tab',
						agentSessionId: 'provider-session-1',
					}),
					setRenameTabId: mockSetRenameTabId,
					setRenameTabInitialName: mockSetRenameTabInitialName,
					setRenameTabModalOpen: mockSetRenameTabModalOpen,
				});

				dispatchKeydown({ key: 'r', metaKey: true, shiftKey: true });

				expect(mockSetRenameTabId).toHaveBeenCalledWith('ai-tab-1');
				expect(mockSetRenameTabInitialName).toHaveBeenCalledWith('Current Tab');
				expect(mockSetRenameTabModalOpen).toHaveBeenCalledWith(true);

				mockSetRenameTabId.mockClear();
				mockSetRenameTabInitialName.mockClear();
				mockSetRenameTabModalOpen.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'renameTab',
					getActiveTab: vi.fn().mockReturnValue({ id: 'ai-tab-2', title: 'Unsaved Tab' }),
					setRenameTabId: mockSetRenameTabId,
					setRenameTabInitialName: mockSetRenameTabInitialName,
					setRenameTabModalOpen: mockSetRenameTabModalOpen,
				});

				dispatchKeydown({ key: 'r', metaKey: true, shiftKey: true });

				expect(mockSetRenameTabId).not.toHaveBeenCalled();
				expect(mockSetRenameTabInitialName).not.toHaveBeenCalled();
				expect(mockSetRenameTabModalOpen).not.toHaveBeenCalled();
			});

			it('should toggle read-only and save-to-history flags on the active AI tab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const activeSession = {
					id: 'session-1',
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
					aiTabs: [
						{ id: 'ai-tab-1', readOnlyMode: false, saveToHistory: true },
						{ id: 'ai-tab-2', readOnlyMode: false, saveToHistory: true },
					],
				};
				const otherSession = {
					id: 'session-2',
					activeTabId: 'other-tab',
					aiTabs: [{ id: 'other-tab', readOnlyMode: false, saveToHistory: true }],
				};
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleReadOnlyMode',
					activeSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 'r', metaKey: true, altKey: true });
				const readOnlyResult = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeSession,
					otherSession,
				]);

				expect(readOnlyResult[0].aiTabs[0].readOnlyMode).toBe(true);
				expect(readOnlyResult[0].aiTabs[1].readOnlyMode).toBe(false);
				expect(readOnlyResult[1]).toBe(otherSession);

				mockSetSessions.mockClear();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) =>
						actionId === 'toggleSaveToHistory',
					activeSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 'h', metaKey: true, altKey: true });
				const saveToHistoryResult = (
					mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[]
				)([activeSession, otherSession]);

				expect(saveToHistoryResult[0].aiTabs[0].saveToHistory).toBe(false);
				expect(saveToHistoryResult[0].aiTabs[1].saveToHistory).toBe(true);
				expect(saveToHistoryResult[1]).toBe(otherSession);
			});

			it('should cycle regular thinking mode and clear thinking logs when turning it off', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const mockSetSessions = vi.fn();
				const activeSession = {
					id: 'session-1',
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
					aiTabs: [
						{
							id: 'ai-tab-1',
							showThinking: 'sticky',
							logs: [
								{ id: 'log-1', source: 'thinking' },
								{ id: 'log-2', source: 'tool' },
								{ id: 'log-3', source: 'assistant' },
							],
						},
					],
				};

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleShowThinking',
					activeSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 't', metaKey: true, altKey: true });
				const resultSession = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeSession,
				])[0];

				expect(resultSession.aiTabs[0].showThinking).toBe('off');
				expect(resultSession.aiTabs[0].logs).toEqual([{ id: 'log-3', source: 'assistant' }]);
			});

			it('should cycle thinking from missing or on states while preserving other sessions and tabs', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const mockSetSessions = vi.fn();
				const inactiveSession = {
					id: 'session-2',
					activeTabId: 'other-tab',
					inputMode: 'ai',
					aiTabs: [{ id: 'other-tab', showThinking: 'off', logs: [] }],
				};
				const activeSession = {
					id: 'session-1',
					activeTabId: 'ai-tab-1',
					inputMode: 'ai',
					aiTabs: [
						{ id: 'ai-tab-1', logs: [{ id: 'log-1', source: 'assistant' }] },
						{ id: 'ai-tab-2', showThinking: 'off', logs: [] },
					],
				};

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleShowThinking',
					activeSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 't', metaKey: true, altKey: true });
				let resultSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					inactiveSession,
					activeSession,
				]);

				expect(resultSessions[0]).toBe(inactiveSession);
				expect(resultSessions[1].aiTabs[0].showThinking).toBe('on');
				expect(resultSessions[1].aiTabs[1]).toBe(activeSession.aiTabs[1]);

				mockSetSessions.mockClear();
				const activeOnSession = {
					...activeSession,
					aiTabs: [{ id: 'ai-tab-1', showThinking: 'on', logs: [] }],
				};
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleShowThinking',
					activeSession: activeOnSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 't', metaKey: true, altKey: true });
				resultSessions = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeOnSession,
				]);

				expect(resultSessions[0].aiTabs[0].showThinking).toBe('sticky');
			});

			it('should toggle wizard thinking and clear thinking content when enabling it', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const mockSetSessions = vi.fn();
				const activeSession = {
					id: 'session-1',
					activeTabId: 'wizard-tab',
					inputMode: 'ai',
					aiTabs: [
						{
							id: 'wizard-tab',
							wizardState: {
								isActive: true,
								showWizardThinking: false,
								thinkingContent: 'old thinking',
							},
						},
					],
				};

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleShowThinking',
					activeSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 't', metaKey: true, altKey: true });
				const resultSession = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeSession,
				])[0];

				expect(resultSession.aiTabs[0].wizardState.showWizardThinking).toBe(true);
				expect(resultSession.aiTabs[0].wizardState.thinkingContent).toBe('');
			});

			it('should retain wizard thinking content when turning wizard thinking off', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());
				const mockSetSessions = vi.fn();
				const activeSession = {
					id: 'session-1',
					activeTabId: 'wizard-tab',
					inputMode: 'ai',
					aiTabs: [
						{
							id: 'wizard-tab',
							wizardState: {
								isActive: true,
								showWizardThinking: true,
								thinkingContent: 'visible thinking',
							},
						},
					],
				};

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleShowThinking',
					activeSession,
					setSessions: mockSetSessions,
				});

				dispatchKeydown({ key: 't', metaKey: true, altKey: true });
				const resultSession = (mockSetSessions.mock.calls[0][0] as (sessions: any[]) => any[])([
					activeSession,
				])[0];

				expect(resultSession.aiTabs[0].wizardState.showWizardThinking).toBe(false);
				expect(resultSession.aiTabs[0].wizardState.thinkingContent).toBe('visible thinking');
			});

			it('should run unread filter and tab unread shortcuts', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockToggleUnreadFilter = vi.fn();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'filterUnreadTabs',
					toggleUnreadFilter: mockToggleUnreadFilter,
				});

				dispatchKeydown({ key: 'u', metaKey: true, altKey: true });

				expect(mockToggleUnreadFilter).toHaveBeenCalled();

				const mockToggleTabUnread = vi.fn();
				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'toggleTabUnread',
					toggleTabUnread: mockToggleTabUnread,
				});

				dispatchKeydown({ key: 'u', metaKey: true, shiftKey: true });

				expect(mockToggleTabUnread).toHaveBeenCalled();
			});
		});

		describe('tab shortcuts disabled in group chat', () => {
			it('should not execute tab shortcuts when group chat is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockCreateTab = vi.fn();
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					createTab: mockCreateTab,
					setSessions: mockSetSessions,
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
				expect(mockCreateTab).not.toHaveBeenCalled();
			});
		});

		describe('tab shortcuts disabled in terminal mode', () => {
			it('should not execute tab shortcuts when in terminal/shell mode', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockCreateTab = vi.fn();
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					createTab: mockCreateTab,
					setSessions: mockSetSessions,
					activeSession: {
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						activeTabId: 'ai-tab-1',
						filePreviewTabs: [],
						activeFileTabId: null,
						unifiedTabOrder: ['ai-tab-1'],
						inputMode: 'terminal', // Terminal mode - tabs not applicable
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

				// Tab shortcuts should be disabled in terminal mode
				expect(mockCreateTab).not.toHaveBeenCalled();
			});
		});

		// NOTE: Terminal tab keyboard shortcuts are not implemented.
		// Tab shortcuts (Cmd+W, Cmd+Shift+[/], Cmd+1-9, Cmd+0) are gated behind
		// inputMode === 'ai' in useMainKeyboardHandler.ts (line 531) and use the
		// unified tab system (navigateToNextUnifiedTab, etc.) — there are no
		// separate terminal-specific handlers (handleCloseTerminalTab,
		// handleSelectTerminalTab). Tests for phantom terminal tab shortcuts
		// were removed as they tested non-existent functionality.
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

	describe('font size shortcuts', () => {
		beforeEach(() => {
			// Reset font size to default before each test
			useSettingsStore.setState({ fontSize: 14 });
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
			expect(useSettingsStore.getState().fontSize).toBe(16);
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

			expect(useSettingsStore.getState().fontSize).toBe(16);
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
			expect(useSettingsStore.getState().fontSize).toBe(12);
		});

		it('should reset font size to default (14) with Cmd+Shift+0', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			// Set font size to something other than default
			useSettingsStore.setState({ fontSize: 20 });

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
			expect(useSettingsStore.getState().fontSize).toBe(14);
		});

		it('should leave default font size unchanged on reset shortcut', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());
			const setFontSizeSpy = vi.spyOn(useSettingsStore.getState(), 'setFontSize');

			try {
				result.current.keyboardHandlerRef.current = createMockContext({
					isShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'fontSizeReset',
					recordShortcutUsage: vi.fn().mockReturnValue({ newLevel: null }),
				});

				dispatchKeydown({ key: ')', metaKey: true, shiftKey: true });

				expect(useSettingsStore.getState().fontSize).toBe(14);
				expect(setFontSizeSpy).not.toHaveBeenCalled();
			} finally {
				setFontSizeSpy.mockRestore();
			}
		});

		it('should not exceed maximum font size (24)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			useSettingsStore.setState({ fontSize: 24 });

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

			expect(useSettingsStore.getState().fontSize).toBe(24);
		});

		it('should not go below minimum font size (10)', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			useSettingsStore.setState({ fontSize: 10 });

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

			expect(useSettingsStore.getState().fontSize).toBe(10);
		});

		it('should work when modal is open (font size is a benign viewing preference)', () => {
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

			expect(useSettingsStore.getState().fontSize).toBe(16);
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
});
