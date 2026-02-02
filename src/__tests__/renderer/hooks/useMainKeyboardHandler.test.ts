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

		it('should allow tab management shortcuts (Cmd+T) when only overlays are open', () => {
			const { result } = renderHook(() => useMainKeyboardHandler());

			const mockSetSessions = vi.fn();
			const mockSetActiveFocus = vi.fn();
			const mockInputRef = { current: { focus: vi.fn() } };
			const mockActiveSession = {
				id: 'test-session',
				name: 'Test',
				aiTabs: [],
				activeTabId: 'tab-1',
				unifiedTabOrder: [],
			};

			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (e.g., file preview)
				hasOpenModal: () => false, // But no true modal
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'newTab',
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
			result.current.keyboardHandlerRef.current = createMockContext({
				hasOpenLayers: () => true, // Overlay is open (e.g., file preview)
				hasOpenModal: () => false, // But no true modal
				isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'tabSwitcher',
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

	describe('unified tab shortcuts - file tab vs AI tab context', () => {
		/**
		 * Helper to create a session context with both AI tabs and file tabs.
		 * Uses unifiedTabOrder to establish combined ordering.
		 */
		function createUnifiedTabContext(overrides: Record<string, unknown> = {}) {
			const aiTab1 = { id: 'ai-tab-1', name: 'AI Tab 1', logs: [] };
			const aiTab2 = { id: 'ai-tab-2', name: 'AI Tab 2', logs: [] };
			const fileTab1 = { id: 'file-tab-1', path: '/test/file1.ts', name: 'file1', extension: '.ts' };
			const fileTab2 = { id: 'file-tab-2', path: '/test/file2.ts', name: 'file2', extension: '.ts' };

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
						filePreviewTabs: [{ id: 'file-tab-1', path: '/test/file.ts', name: 'file', extension: '.ts' }],
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
				const mockCloseTab = vi.fn().mockReturnValue({ session: { id: 'session-1' } });
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					closeTab: mockCloseTab,
					setSessions: mockSetSessions,
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
				expect(mockCloseTab).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'session-1' }),
					'ai-tab-2',
					false,
					{ skipHistory: false }
				);
			});

			it('should prevent closing when it is the last AI tab', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockHandleCloseCurrentTab = vi.fn().mockReturnValue({ type: 'prevented' });
				const mockCloseTab = vi.fn();
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'closeTab',
					handleCloseCurrentTab: mockHandleCloseCurrentTab,
					closeTab: mockCloseTab,
					setSessions: mockSetSessions,
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

				// closeTab should NOT be called when it's the last AI tab
				expect(mockCloseTab).not.toHaveBeenCalled();
			});
		});

		describe('Cmd+Shift+[ and Cmd+Shift+] (tab cycling)', () => {
			it('should navigate to next tab in unified order (Cmd+Shift+])', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1', activeFileTabId: 'file-tab-1' },
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
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

				expect(mockNavigateToNextUnifiedTab).toHaveBeenCalled();
				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('should navigate to previous tab in unified order (Cmd+Shift+[)', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToPrevUnifiedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1', activeFileTabId: 'file-tab-2' },
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'prevTab',
					navigateToPrevUnifiedTab: mockNavigateToPrevUnifiedTab,
					setSessions: mockSetSessions,
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

				expect(mockNavigateToPrevUnifiedTab).toHaveBeenCalled();
				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('should pass showUnreadOnly filter to navigation', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToNextUnifiedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1' },
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'nextTab',
					navigateToNextUnifiedTab: mockNavigateToNextUnifiedTab,
					setSessions: mockSetSessions,
					showUnreadOnly: true, // Filter is active
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
					expect.anything(),
					true // showUnreadOnly passed
				);
			});
		});

		describe('Cmd+1-9 (tab jumping by index)', () => {
			it('should jump to AI tab at index 0 with Cmd+1', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToUnifiedTabByIndex = vi.fn().mockReturnValue({
					session: { id: 'session-1', activeTabId: 'ai-tab-1', activeFileTabId: null },
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab1',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
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
					expect.anything(),
					0 // index 0 for Cmd+1
				);
			});

			it('should jump to file tab at index 1 with Cmd+2', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToUnifiedTabByIndex = vi.fn().mockReturnValue({
					session: { id: 'session-1', activeTabId: 'ai-tab-1', activeFileTabId: 'file-tab-1' },
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToTab2',
					navigateToUnifiedTabByIndex: mockNavigateToUnifiedTabByIndex,
					setSessions: mockSetSessions,
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
					expect.anything(),
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
		});

		describe('Cmd+0 (jump to last tab)', () => {
			it('should jump to last tab in unified order', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToLastUnifiedTab = vi.fn().mockReturnValue({
					session: { id: 'session-1', activeFileTabId: 'file-tab-2' },
				});
				const mockSetSessions = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					navigateToLastUnifiedTab: mockNavigateToLastUnifiedTab,
					setSessions: mockSetSessions,
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

				expect(mockNavigateToLastUnifiedTab).toHaveBeenCalled();
				expect(mockSetSessions).toHaveBeenCalled();
			});

			it('should not execute when showUnreadOnly is active', () => {
				const { result } = renderHook(() => useMainKeyboardHandler());

				const mockNavigateToLastUnifiedTab = vi.fn();

				result.current.keyboardHandlerRef.current = createUnifiedTabContext({
					isTabShortcut: (_e: KeyboardEvent, actionId: string) => actionId === 'goToLastTab',
					navigateToLastUnifiedTab: mockNavigateToLastUnifiedTab,
					showUnreadOnly: true,
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

				// Should NOT be called when showUnreadOnly is active
				expect(mockNavigateToLastUnifiedTab).not.toHaveBeenCalled();
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
	});
});
