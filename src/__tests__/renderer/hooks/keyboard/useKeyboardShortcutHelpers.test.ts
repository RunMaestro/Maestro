/**
 * Tests for useKeyboardShortcutHelpers hook.
 *
 * This hook provides utility functions for matching keyboard events against
 * configured shortcuts. Critical for cross-platform keyboard support:
 * - On macOS: Cmd key (metaKey) is the primary modifier
 * - On Windows/Linux: Ctrl key (ctrlKey) is the primary modifier
 *
 * The hook treats Meta and Ctrl as equivalent, enabling shortcuts defined
 * with 'Meta' to work with both Cmd (macOS) and Ctrl (Windows/Linux).
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcutHelpers } from '../../../../renderer/hooks/keyboard/useKeyboardShortcutHelpers';
import type { Shortcut } from '../../../../renderer/types';

/**
 * Helper to create a mock KeyboardEvent with specified properties.
 * Handles the readonly nature of KeyboardEvent properties.
 */
function createKeyboardEvent(options: {
	key: string;
	code?: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}): KeyboardEvent {
	return {
		key: options.key,
		code: options.code || `Key${options.key.toUpperCase()}`,
		metaKey: options.metaKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		altKey: options.altKey ?? false,
		shiftKey: options.shiftKey ?? false,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as KeyboardEvent;
}

describe('useKeyboardShortcutHelpers', () => {
	describe('Cross-platform keyboard shortcut support (Ctrl vs Cmd)', () => {
		describe('Meta key equivalence', () => {
			const shortcuts: Record<string, Shortcut> = {
				quickAction: { id: 'quickAction', label: 'Quick Actions', keys: ['Meta', 'k'] },
				settings: { id: 'settings', label: 'Open Settings', keys: ['Meta', ','] },
				newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
			};

			it('should match Meta+K shortcut when Cmd key is pressed (macOS)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'k', metaKey: true });
				expect(result.current.isShortcut(event, 'quickAction')).toBe(true);
			});

			it('should match Meta+K shortcut when Ctrl key is pressed (Windows/Linux)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'k', ctrlKey: true });
				expect(result.current.isShortcut(event, 'quickAction')).toBe(true);
			});

			it('should match Meta+, shortcut when Cmd key is pressed (macOS)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: ',', metaKey: true });
				expect(result.current.isShortcut(event, 'settings')).toBe(true);
			});

			it('should match Meta+, shortcut when Ctrl key is pressed (Windows/Linux)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: ',', ctrlKey: true });
				expect(result.current.isShortcut(event, 'settings')).toBe(true);
			});

			it('should match Meta+T shortcut when Cmd key is pressed (macOS)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 't', metaKey: true });
				expect(result.current.isShortcut(event, 'newTab')).toBe(true);
			});

			it('should match Meta+T shortcut when Ctrl key is pressed (Windows/Linux)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 't', ctrlKey: true });
				expect(result.current.isShortcut(event, 'newTab')).toBe(true);
			});

			it('should NOT match when neither Cmd nor Ctrl is pressed', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'k' });
				expect(result.current.isShortcut(event, 'quickAction')).toBe(false);
			});

			it('should match when both Cmd and Ctrl are pressed simultaneously', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				// Edge case: both modifiers pressed
				const event = createKeyboardEvent({ key: 'k', metaKey: true, ctrlKey: true });
				expect(result.current.isShortcut(event, 'quickAction')).toBe(true);
			});
		});

		describe('Shortcuts with Shift modifier', () => {
			const shortcuts: Record<string, Shortcut> = {
				prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Meta', 'Shift', '['] },
				nextTab: { id: 'nextTab', label: 'Next Tab', keys: ['Meta', 'Shift', ']'] },
				goToFiles: { id: 'goToFiles', label: 'Go to Files', keys: ['Meta', 'Shift', 'f'] },
			};

			it('should match Cmd+Shift+[ on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: '[', metaKey: true, shiftKey: true });
				expect(result.current.isShortcut(event, 'prevTab')).toBe(true);
			});

			it('should match Ctrl+Shift+[ on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: '[', ctrlKey: true, shiftKey: true });
				expect(result.current.isShortcut(event, 'prevTab')).toBe(true);
			});

			it('should match Cmd+Shift+] on macOS (even when Shift produces })', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				// On US keyboard, Shift+] produces }
				const event = createKeyboardEvent({ key: '}', metaKey: true, shiftKey: true });
				expect(result.current.isShortcut(event, 'nextTab')).toBe(true);
			});

			it('should match Ctrl+Shift+] on Windows/Linux (even when Shift produces })', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: '}', ctrlKey: true, shiftKey: true });
				expect(result.current.isShortcut(event, 'nextTab')).toBe(true);
			});

			it('should match Cmd+Shift+F on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'F', metaKey: true, shiftKey: true });
				expect(result.current.isShortcut(event, 'goToFiles')).toBe(true);
			});

			it('should match Ctrl+Shift+F on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'F', ctrlKey: true, shiftKey: true });
				expect(result.current.isShortcut(event, 'goToFiles')).toBe(true);
			});

			it('should NOT match when Shift is missing', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'f', metaKey: true });
				expect(result.current.isShortcut(event, 'goToFiles')).toBe(false);
			});
		});

		describe('Shortcuts with Alt modifier', () => {
			const shortcuts: Record<string, Shortcut> = {
				toggleSidebar: {
					id: 'toggleSidebar',
					label: 'Toggle Left Panel',
					keys: ['Alt', 'Meta', 'ArrowLeft'],
				},
				usageDashboard: {
					id: 'usageDashboard',
					label: 'Usage Dashboard',
					keys: ['Alt', 'Meta', 'u'],
				},
				systemLogs: { id: 'systemLogs', label: 'System Log Viewer', keys: ['Alt', 'Meta', 'l'] },
			};

			it('should match Alt+Cmd+ArrowLeft on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({
					key: 'ArrowLeft',
					code: 'ArrowLeft',
					altKey: true,
					metaKey: true,
				});
				expect(result.current.isShortcut(event, 'toggleSidebar')).toBe(true);
			});

			it('should match Alt+Ctrl+ArrowLeft on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({
					key: 'ArrowLeft',
					code: 'ArrowLeft',
					altKey: true,
					ctrlKey: true,
				});
				expect(result.current.isShortcut(event, 'toggleSidebar')).toBe(true);
			});

			it('should match Alt+Cmd+U on macOS (using e.code for Alt key issues)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				// On macOS, Alt+U might produce 'ü' instead of 'u'
				// The hook uses e.code to handle this
				const event = createKeyboardEvent({
					key: 'ü', // What macOS might produce with Alt+U
					code: 'KeyU',
					altKey: true,
					metaKey: true,
				});
				expect(result.current.isShortcut(event, 'usageDashboard')).toBe(true);
			});

			it('should match Alt+Ctrl+U on Windows (no special character issues)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({
					key: 'u',
					code: 'KeyU',
					altKey: true,
					ctrlKey: true,
				});
				expect(result.current.isShortcut(event, 'usageDashboard')).toBe(true);
			});

			it('should match Alt+Cmd+L on macOS (using e.code for Alt key issues)', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				// On macOS, Alt+L might produce '¬' instead of 'l'
				const event = createKeyboardEvent({
					key: '¬',
					code: 'KeyL',
					altKey: true,
					metaKey: true,
				});
				expect(result.current.isShortcut(event, 'systemLogs')).toBe(true);
			});

			it('should match Alt+Ctrl+L on Windows', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({
					key: 'l',
					code: 'KeyL',
					altKey: true,
					ctrlKey: true,
				});
				expect(result.current.isShortcut(event, 'systemLogs')).toBe(true);
			});

			it('should NOT match when Alt is missing', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'u', metaKey: true });
				expect(result.current.isShortcut(event, 'usageDashboard')).toBe(false);
			});
		});

		describe('Shortcuts with Ctrl in definition (explicit)', () => {
			const shortcuts: Record<string, Shortcut> = {
				// Some shortcuts might explicitly use 'Ctrl' instead of 'Meta'
				explicitCtrl: { id: 'explicitCtrl', label: 'Explicit Ctrl', keys: ['Ctrl', 'x'] },
			};

			it('should match explicit Ctrl shortcut with Cmd on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'x', metaKey: true });
				expect(result.current.isShortcut(event, 'explicitCtrl')).toBe(true);
			});

			it('should match explicit Ctrl shortcut with Ctrl on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'x', ctrlKey: true });
				expect(result.current.isShortcut(event, 'explicitCtrl')).toBe(true);
			});
		});

		describe('Tab shortcuts cross-platform support', () => {
			const tabShortcuts: Record<string, Shortcut> = {
				newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
				closeTab: { id: 'closeTab', label: 'Close Tab', keys: ['Meta', 'w'] },
				prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Meta', 'Shift', '['] },
				nextTab: { id: 'nextTab', label: 'Next Tab', keys: ['Meta', 'Shift', ']'] },
			};

			it('should match Cmd+T for new tab on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts })
				);

				const event = createKeyboardEvent({ key: 't', metaKey: true });
				expect(result.current.isTabShortcut(event, 'newTab')).toBe(true);
			});

			it('should match Ctrl+T for new tab on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts })
				);

				const event = createKeyboardEvent({ key: 't', ctrlKey: true });
				expect(result.current.isTabShortcut(event, 'newTab')).toBe(true);
			});

			it('should match Cmd+W for close tab on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts })
				);

				const event = createKeyboardEvent({ key: 'w', metaKey: true });
				expect(result.current.isTabShortcut(event, 'closeTab')).toBe(true);
			});

			it('should match Ctrl+W for close tab on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts })
				);

				const event = createKeyboardEvent({ key: 'w', ctrlKey: true });
				expect(result.current.isTabShortcut(event, 'closeTab')).toBe(true);
			});

			it('should match Cmd+Shift+[ for prev tab on macOS', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts })
				);

				const event = createKeyboardEvent({ key: '{', metaKey: true, shiftKey: true });
				expect(result.current.isTabShortcut(event, 'prevTab')).toBe(true);
			});

			it('should match Ctrl+Shift+[ for prev tab on Windows/Linux', () => {
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts })
				);

				const event = createKeyboardEvent({ key: '{', ctrlKey: true, shiftKey: true });
				expect(result.current.isTabShortcut(event, 'prevTab')).toBe(true);
			});

			it('should fall back to global shortcuts if tab shortcut not defined', () => {
				const shortcuts: Record<string, Shortcut> = {
					fallbackAction: { id: 'fallbackAction', label: 'Fallback', keys: ['Meta', 'f'] },
				};
				const { result } = renderHook(() =>
					useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
				);

				const event = createKeyboardEvent({ key: 'f', metaKey: true });
				expect(result.current.isTabShortcut(event, 'fallbackAction')).toBe(true);
			});
		});
	});

	describe('Arrow key shortcuts', () => {
		const shortcuts: Record<string, Shortcut> = {
			toggleSidebar: {
				id: 'toggleSidebar',
				label: 'Toggle Left Panel',
				keys: ['Alt', 'Meta', 'ArrowLeft'],
			},
			toggleRightPanel: {
				id: 'toggleRightPanel',
				label: 'Toggle Right Panel',
				keys: ['Alt', 'Meta', 'ArrowRight'],
			},
			navUp: { id: 'navUp', label: 'Navigate Up', keys: ['Meta', 'ArrowUp'] },
			navDown: { id: 'navDown', label: 'Navigate Down', keys: ['Meta', 'ArrowDown'] },
		};

		it('should match ArrowLeft with Cmd on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'ArrowLeft',
				altKey: true,
				metaKey: true,
			});
			expect(result.current.isShortcut(event, 'toggleSidebar')).toBe(true);
		});

		it('should match ArrowLeft with Ctrl on Windows', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'ArrowLeft',
				altKey: true,
				ctrlKey: true,
			});
			expect(result.current.isShortcut(event, 'toggleSidebar')).toBe(true);
		});

		it('should match ArrowUp with Cmd on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'ArrowUp',
				metaKey: true,
			});
			expect(result.current.isShortcut(event, 'navUp')).toBe(true);
		});

		it('should match ArrowUp with Ctrl on Windows', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'ArrowUp',
				ctrlKey: true,
			});
			expect(result.current.isShortcut(event, 'navUp')).toBe(true);
		});

		it('should match ArrowDown with Cmd on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'ArrowDown',
				metaKey: true,
			});
			expect(result.current.isShortcut(event, 'navDown')).toBe(true);
		});

		it('should match ArrowDown with Ctrl on Windows', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'ArrowDown',
				ctrlKey: true,
			});
			expect(result.current.isShortcut(event, 'navDown')).toBe(true);
		});
	});

	describe('Backspace shortcut', () => {
		const shortcuts: Record<string, Shortcut> = {
			killInstance: { id: 'killInstance', label: 'Remove', keys: ['Meta', 'Shift', 'Backspace'] },
		};

		it('should match Cmd+Shift+Backspace on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'Backspace',
				metaKey: true,
				shiftKey: true,
			});
			expect(result.current.isShortcut(event, 'killInstance')).toBe(true);
		});

		it('should match Ctrl+Shift+Backspace on Windows/Linux', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({
				key: 'Backspace',
				ctrlKey: true,
				shiftKey: true,
			});
			expect(result.current.isShortcut(event, 'killInstance')).toBe(true);
		});
	});

	describe('Number key shortcuts', () => {
		const shortcuts: Record<string, Shortcut> = {
			goToTab1: { id: 'goToTab1', label: 'Go to Tab 1', keys: ['Meta', '1'] },
			goToAutoRun: { id: 'goToAutoRun', label: 'Go to Auto Run Tab', keys: ['Meta', 'Shift', '1'] },
		};

		it('should match Cmd+1 on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: '1', metaKey: true });
			expect(result.current.isShortcut(event, 'goToTab1')).toBe(true);
		});

		it('should match Ctrl+1 on Windows/Linux', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: '1', ctrlKey: true });
			expect(result.current.isShortcut(event, 'goToTab1')).toBe(true);
		});

		it('should match Cmd+Shift+1 on macOS (even when producing !)', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			// Shift+1 produces '!' on US keyboard
			const event = createKeyboardEvent({ key: '!', metaKey: true, shiftKey: true });
			expect(result.current.isShortcut(event, 'goToAutoRun')).toBe(true);
		});

		it('should match Ctrl+Shift+1 on Windows/Linux (even when producing !)', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			// Shift+1 produces '!' on US keyboard
			const event = createKeyboardEvent({ key: '!', ctrlKey: true, shiftKey: true });
			expect(result.current.isShortcut(event, 'goToAutoRun')).toBe(true);
		});
	});

	describe('Slash key shortcut (help)', () => {
		const shortcuts: Record<string, Shortcut> = {
			help: { id: 'help', label: 'Show Shortcuts', keys: ['Meta', '/'] },
		};

		it('should match Cmd+/ on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: '/', metaKey: true });
			expect(result.current.isShortcut(event, 'help')).toBe(true);
		});

		it('should match Ctrl+/ on Windows/Linux', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: '/', ctrlKey: true });
			expect(result.current.isShortcut(event, 'help')).toBe(true);
		});
	});

	describe('Case insensitivity', () => {
		const shortcuts: Record<string, Shortcut> = {
			test: { id: 'test', label: 'Test', keys: ['Meta', 'k'] },
		};

		it('should match lowercase key', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: 'k', metaKey: true });
			expect(result.current.isShortcut(event, 'test')).toBe(true);
		});

		it('should match uppercase key', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: 'K', metaKey: true });
			expect(result.current.isShortcut(event, 'test')).toBe(true);
		});
	});

	describe('Non-existent shortcuts', () => {
		const shortcuts: Record<string, Shortcut> = {
			existing: { id: 'existing', label: 'Existing', keys: ['Meta', 'e'] },
		};

		it('should return false for non-existent action ID', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: 'x', metaKey: true });
			expect(result.current.isShortcut(event, 'nonExistent')).toBe(false);
		});

		it('should return false for non-existent tab shortcut action ID', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts: {}, tabShortcuts: {} })
			);

			const event = createKeyboardEvent({ key: 'x', metaKey: true });
			expect(result.current.isTabShortcut(event, 'nonExistent')).toBe(false);
		});
	});

	describe('Complete shortcut set verification (from shortcuts.ts)', () => {
		// Test a representative sample of actual shortcuts from the app
		const appShortcuts: Record<string, Shortcut> = {
			toggleSidebar: {
				id: 'toggleSidebar',
				label: 'Toggle Left Panel',
				keys: ['Alt', 'Meta', 'ArrowLeft'],
			},
			toggleRightPanel: {
				id: 'toggleRightPanel',
				label: 'Toggle Right Panel',
				keys: ['Alt', 'Meta', 'ArrowRight'],
			},
			cyclePrev: { id: 'cyclePrev', label: 'Previous Agent', keys: ['Meta', '['] },
			cycleNext: { id: 'cycleNext', label: 'Next Agent', keys: ['Meta', ']'] },
			newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Meta', 'n'] },
			killInstance: { id: 'killInstance', label: 'Remove', keys: ['Meta', 'Shift', 'Backspace'] },
			toggleMode: { id: 'toggleMode', label: 'Switch AI/Shell Mode', keys: ['Meta', 'j'] },
			quickAction: { id: 'quickAction', label: 'Quick Actions', keys: ['Meta', 'k'] },
			help: { id: 'help', label: 'Show Shortcuts', keys: ['Meta', '/'] },
			settings: { id: 'settings', label: 'Open Settings', keys: ['Meta', ','] },
			usageDashboard: {
				id: 'usageDashboard',
				label: 'Usage Dashboard',
				keys: ['Alt', 'Meta', 'u'],
			},
		};

		it('all app shortcuts should work with Ctrl on Windows/Linux', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts: appShortcuts, tabShortcuts: {} })
			);

			// Test each shortcut works with Ctrl instead of Cmd
			const testCases = [
				{ actionId: 'cyclePrev', key: '[', ctrlKey: true },
				{ actionId: 'cycleNext', key: ']', ctrlKey: true },
				{ actionId: 'newInstance', key: 'n', ctrlKey: true },
				{ actionId: 'toggleMode', key: 'j', ctrlKey: true },
				{ actionId: 'quickAction', key: 'k', ctrlKey: true },
				{ actionId: 'help', key: '/', ctrlKey: true },
				{ actionId: 'settings', key: ',', ctrlKey: true },
			];

			for (const { actionId, key, ctrlKey } of testCases) {
				const event = createKeyboardEvent({ key, ctrlKey });
				expect(result.current.isShortcut(event, actionId)).toBe(true);
			}
		});

		it('all app shortcuts should work with Cmd on macOS', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts: appShortcuts, tabShortcuts: {} })
			);

			// Test each shortcut works with Cmd
			const testCases = [
				{ actionId: 'cyclePrev', key: '[', metaKey: true },
				{ actionId: 'cycleNext', key: ']', metaKey: true },
				{ actionId: 'newInstance', key: 'n', metaKey: true },
				{ actionId: 'toggleMode', key: 'j', metaKey: true },
				{ actionId: 'quickAction', key: 'k', metaKey: true },
				{ actionId: 'help', key: '/', metaKey: true },
				{ actionId: 'settings', key: ',', metaKey: true },
			];

			for (const { actionId, key, metaKey } of testCases) {
				const event = createKeyboardEvent({ key, metaKey });
				expect(result.current.isShortcut(event, actionId)).toBe(true);
			}
		});

		it('Alt+Meta shortcuts should work with Alt+Ctrl on Windows', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts: appShortcuts, tabShortcuts: {} })
			);

			// Alt+Ctrl+ArrowLeft should work for toggleSidebar
			const event = createKeyboardEvent({
				key: 'ArrowLeft',
				code: 'ArrowLeft',
				altKey: true,
				ctrlKey: true,
			});
			expect(result.current.isShortcut(event, 'toggleSidebar')).toBe(true);
		});

		it('Shift+Meta shortcuts should work with Shift+Ctrl on Windows', () => {
			const { result } = renderHook(() =>
				useKeyboardShortcutHelpers({ shortcuts: appShortcuts, tabShortcuts: {} })
			);

			// Ctrl+Shift+Backspace should work for killInstance
			const event = createKeyboardEvent({
				key: 'Backspace',
				ctrlKey: true,
				shiftKey: true,
			});
			expect(result.current.isShortcut(event, 'killInstance')).toBe(true);
		});
	});
});
