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

describe('useMainKeyboardHandler', () => {
	// Track event listeners for cleanup
	let addedListeners: { type: string; handler: EventListener }[] = [];
	let originalMaestro: unknown;
	const originalAddEventListener = window.addEventListener;
	const originalRemoveEventListener = window.removeEventListener;

	beforeEach(() => {
		addedListeners = [];
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

				// Should NOT close directly — should show confirmation modal
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

		describe('tab shortcuts in terminal mode', () => {
			it('Cmd+T creates a new AI tab even when in terminal mode', () => {
				vi.useFakeTimers();
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockCreateTab = vi.fn().mockReturnValue({
					session: { id: 'session-1', aiTabs: [], activeTabId: 'new-tab' },
				});
				const mockSetSessions = vi.fn();
				const mockSetActiveFocus = vi.fn();
				const mockFocus = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
					createTab: mockCreateTab,
					setSessions: mockSetSessions,
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
				expect(mockCreateTab).toHaveBeenCalled();

				// setSessions should be called with the new session including inputMode: 'ai'
				expect(mockSetSessions).toHaveBeenCalledTimes(1);
				const updater = mockSetSessions.mock.calls[0][0];
				const prev = [
					{
						id: 'session-1',
						aiTabs: [{ id: 'ai-tab-1', name: 'AI Tab 1', logs: [] }],
						inputMode: 'terminal',
					},
				];
				const updated = updater(prev);
				expect(updated[0].inputMode).toBe('ai');

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

		// Unified tab shortcuts in terminal mode — verifies that tab navigation and
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

			it('Alt+Shift+U toggles tab unread from terminal mode', () => {
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
							altKey: true,
							shiftKey: true,
							bubbles: true,
						})
					);
				});

				expect(mockToggleTabUnread).toHaveBeenCalled();
			});
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

	describe('filterUnreadAgents shortcut', () => {
		it('should toggle unread agents filter on Cmd+Shift+U', () => {
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
						metaKey: true,
						shiftKey: true,
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
	});
});
