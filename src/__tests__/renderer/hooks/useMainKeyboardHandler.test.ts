import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useMainKeyboardHandler } from '../../../renderer/hooks';

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
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleInputMode = vi.fn();
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
		});

		it('should allow toggleMode when wizardState exists but isActive is false', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockToggleInputMode = vi.fn();
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
		});
	});
});
