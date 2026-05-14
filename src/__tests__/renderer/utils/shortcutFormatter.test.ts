/**
 * Tests for shortcutFormatter.ts
 *
 * Platform detection now uses window.maestro.platform (Electron preload bridge)
 * instead of navigator.userAgent. Since isMac() is a function call (not a
 * module-level constant), we can simply set window.maestro.platform before
 * each test — no dynamic imports needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Undo the global mock from setup.ts — this file tests the real module
vi.unmock('../../../renderer/utils/shortcutFormatter');

import {
	formatKey,
	formatShortcutKeys,
	formatMetaKey,
	formatEnterToSend,
	formatEnterToSendTooltip,
	isMacOS,
} from '../../../renderer/utils/shortcutFormatter';

describe('shortcutFormatter', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('macOS Platform', () => {
		beforeEach(() => {
			(window as any).maestro = { platform: 'darwin' };
		});

		describe('isMacOS()', () => {
			it('returns true on macOS', () => {
				expect(isMacOS()).toBe(true);
			});
		});

		describe('formatKey()', () => {
			describe('modifier keys', () => {
				it('maps Meta to ⌘', () => {
					expect(formatKey('Meta')).toBe('⌘');
				});

				it('maps Alt to ⌥', () => {
					expect(formatKey('Alt')).toBe('⌥');
				});

				it('maps Shift to ⇧', () => {
					expect(formatKey('Shift')).toBe('⇧');
				});

				it('maps Control to ⌃', () => {
					expect(formatKey('Control')).toBe('⌃');
				});

				it('maps Ctrl to ⌃', () => {
					expect(formatKey('Ctrl')).toBe('⌃');
				});
			});

			describe('arrow keys', () => {
				it('maps ArrowUp to ↑', () => {
					expect(formatKey('ArrowUp')).toBe('↑');
				});

				it('maps ArrowDown to ↓', () => {
					expect(formatKey('ArrowDown')).toBe('↓');
				});

				it('maps ArrowLeft to ←', () => {
					expect(formatKey('ArrowLeft')).toBe('←');
				});

				it('maps ArrowRight to →', () => {
					expect(formatKey('ArrowRight')).toBe('→');
				});
			});

			describe('special keys', () => {
				it('maps Backspace to ⌫', () => {
					expect(formatKey('Backspace')).toBe('⌫');
				});

				it('maps Delete to ⌦', () => {
					expect(formatKey('Delete')).toBe('⌦');
				});

				it('maps Enter to ↩', () => {
					expect(formatKey('Enter')).toBe('↩');
				});

				it('maps Return to ↩', () => {
					expect(formatKey('Return')).toBe('↩');
				});

				it('maps Escape to ⎋', () => {
					expect(formatKey('Escape')).toBe('⎋');
				});

				it('maps Tab to ⇥', () => {
					expect(formatKey('Tab')).toBe('⇥');
				});

				it('maps Space to ␣', () => {
					expect(formatKey('Space')).toBe('␣');
				});
			});

			describe('character keys', () => {
				it('uppercases single lowercase letter', () => {
					expect(formatKey('a')).toBe('A');
				});

				it('uppercases another lowercase letter', () => {
					expect(formatKey('k')).toBe('K');
				});

				it('uppercases single number', () => {
					expect(formatKey('1')).toBe('1');
				});

				it('keeps uppercase letter as-is', () => {
					expect(formatKey('Z')).toBe('Z');
				});
			});

			describe('other keys', () => {
				it('returns F-keys unchanged', () => {
					expect(formatKey('F1')).toBe('F1');
					expect(formatKey('F12')).toBe('F12');
				});

				it('returns unknown keys unchanged', () => {
					expect(formatKey('PageUp')).toBe('PageUp');
					expect(formatKey('Home')).toBe('Home');
					expect(formatKey('End')).toBe('End');
				});
			});
		});

		describe('formatShortcutKeys()', () => {
			it('uses space as default separator', () => {
				expect(formatShortcutKeys(['Meta', 'k'])).toBe('⌘ K');
			});

			it('formats Meta+Shift+k correctly', () => {
				expect(formatShortcutKeys(['Meta', 'Shift', 'k'])).toBe('⌘ ⇧ K');
			});

			it('formats Alt+Meta+ArrowRight correctly', () => {
				expect(formatShortcutKeys(['Alt', 'Meta', 'ArrowRight'])).toBe('⌥ ⌘ →');
			});

			it('accepts custom separator', () => {
				expect(formatShortcutKeys(['Meta', 'Shift', 'k'], '+')).toBe('⌘+⇧+K');
			});

			it('handles empty array', () => {
				expect(formatShortcutKeys([])).toBe('');
			});

			it('handles single key', () => {
				expect(formatShortcutKeys(['Escape'])).toBe('⎋');
			});

			it('formats complex shortcuts', () => {
				expect(formatShortcutKeys(['Control', 'Alt', 'Delete'])).toBe('⌃ ⌥ ⌦');
			});

			it('formats function key shortcuts', () => {
				expect(formatShortcutKeys(['Alt', 'F4'])).toBe('⌥ F4');
			});
		});

		describe('formatMetaKey()', () => {
			it('returns ⌘ on macOS', () => {
				expect(formatMetaKey()).toBe('⌘');
			});
		});

		describe('formatEnterToSend()', () => {
			it('returns Enter when enterToSend is true', () => {
				expect(formatEnterToSend(true)).toBe('Enter');
			});

			it('returns ⌘ + Enter when enterToSend is false', () => {
				expect(formatEnterToSend(false)).toBe('⌘ + Enter');
			});
		});

		describe('formatEnterToSendTooltip()', () => {
			it('returns Cmd variant when enterToSend is true', () => {
				expect(formatEnterToSendTooltip(true)).toBe('Switch to Cmd+Enter to send');
			});

			it('returns Enter variant when enterToSend is false', () => {
				expect(formatEnterToSendTooltip(false)).toBe('Switch to Enter to send');
			});
		});
	});

	describe('Windows/Linux Platform', () => {
		beforeEach(() => {
			(window as any).maestro = { platform: 'win32' };
		});

		describe('isMacOS()', () => {
			it('returns false on Windows/Linux', () => {
				expect(isMacOS()).toBe(false);
			});
		});

		describe('formatKey()', () => {
			describe('modifier keys', () => {
				it('maps Meta to Ctrl', () => {
					expect(formatKey('Meta')).toBe('Ctrl');
				});

				it('maps Alt to Alt', () => {
					expect(formatKey('Alt')).toBe('Alt');
				});

				it('maps Shift to Shift', () => {
					expect(formatKey('Shift')).toBe('Shift');
				});

				it('maps Control to Ctrl', () => {
					expect(formatKey('Control')).toBe('Ctrl');
				});

				it('maps Ctrl to Ctrl', () => {
					expect(formatKey('Ctrl')).toBe('Ctrl');
				});
			});

			describe('arrow keys', () => {
				it('maps ArrowUp to ↑', () => {
					expect(formatKey('ArrowUp')).toBe('↑');
				});

				it('maps ArrowDown to ↓', () => {
					expect(formatKey('ArrowDown')).toBe('↓');
				});

				it('maps ArrowLeft to ←', () => {
					expect(formatKey('ArrowLeft')).toBe('←');
				});

				it('maps ArrowRight to →', () => {
					expect(formatKey('ArrowRight')).toBe('→');
				});
			});

			describe('special keys', () => {
				it('maps Backspace to Backspace', () => {
					expect(formatKey('Backspace')).toBe('Backspace');
				});

				it('maps Delete to Delete', () => {
					expect(formatKey('Delete')).toBe('Delete');
				});

				it('maps Enter to Enter', () => {
					expect(formatKey('Enter')).toBe('Enter');
				});

				it('maps Return to Enter', () => {
					expect(formatKey('Return')).toBe('Enter');
				});

				it('maps Escape to Esc', () => {
					expect(formatKey('Escape')).toBe('Esc');
				});

				it('maps Tab to Tab', () => {
					expect(formatKey('Tab')).toBe('Tab');
				});

				it('maps Space to Space', () => {
					expect(formatKey('Space')).toBe('Space');
				});
			});

			describe('character keys', () => {
				it('uppercases single lowercase letter', () => {
					expect(formatKey('a')).toBe('A');
				});

				it('uppercases another lowercase letter', () => {
					expect(formatKey('k')).toBe('K');
				});

				it('uppercases single number', () => {
					expect(formatKey('1')).toBe('1');
				});

				it('keeps uppercase letter as-is', () => {
					expect(formatKey('Z')).toBe('Z');
				});
			});

			describe('other keys', () => {
				it('returns F-keys unchanged', () => {
					expect(formatKey('F1')).toBe('F1');
					expect(formatKey('F12')).toBe('F12');
				});

				it('returns unknown keys unchanged', () => {
					expect(formatKey('PageUp')).toBe('PageUp');
					expect(formatKey('Home')).toBe('Home');
					expect(formatKey('End')).toBe('End');
				});
			});
		});

		describe('formatShortcutKeys()', () => {
			it('uses + as default separator', () => {
				expect(formatShortcutKeys(['Meta', 'k'])).toBe('Ctrl+K');
			});

			it('formats Meta+Shift+k correctly', () => {
				expect(formatShortcutKeys(['Meta', 'Shift', 'k'])).toBe('Ctrl+Shift+K');
			});

			it('formats Alt+Meta+ArrowRight correctly', () => {
				expect(formatShortcutKeys(['Alt', 'Meta', 'ArrowRight'])).toBe('Alt+Ctrl+→');
			});

			it('accepts custom separator', () => {
				expect(formatShortcutKeys(['Meta', 'Shift', 'k'], ' ')).toBe('Ctrl Shift K');
			});

			it('handles empty array', () => {
				expect(formatShortcutKeys([])).toBe('');
			});

			it('handles single key', () => {
				expect(formatShortcutKeys(['Escape'])).toBe('Esc');
			});

			it('formats complex shortcuts', () => {
				expect(formatShortcutKeys(['Control', 'Alt', 'Delete'])).toBe('Ctrl+Alt+Delete');
			});

			it('formats function key shortcuts', () => {
				expect(formatShortcutKeys(['Alt', 'F4'])).toBe('Alt+F4');
			});
		});

		describe('formatMetaKey()', () => {
			it('returns Ctrl on Windows/Linux', () => {
				expect(formatMetaKey()).toBe('Ctrl');
			});
		});

		describe('formatEnterToSend()', () => {
			it('returns Enter when enterToSend is true', () => {
				expect(formatEnterToSend(true)).toBe('Enter');
			});

			it('returns Ctrl + Enter when enterToSend is false', () => {
				expect(formatEnterToSend(false)).toBe('Ctrl + Enter');
			});
		});

		describe('formatEnterToSendTooltip()', () => {
			it('returns Ctrl variant when enterToSend is true', () => {
				expect(formatEnterToSendTooltip(true)).toBe('Switch to Ctrl+Enter to send');
			});

			it('returns Enter variant when enterToSend is false', () => {
				expect(formatEnterToSendTooltip(false)).toBe('Switch to Enter to send');
			});
		});
	});

	describe('Edge Cases', () => {
		it('handles missing window.maestro gracefully', () => {
			(window as any).maestro = undefined;
			// When maestro is undefined, isMac() returns false (non-Mac fallback)
			expect(isMacOS()).toBe(false);
		});

		it('handles Linux platform', () => {
			(window as any).maestro = { platform: 'linux' };
			expect(isMacOS()).toBe(false);
			expect(formatKey('Meta')).toBe('Ctrl');
		});

		it('handles empty platform', () => {
			(window as any).maestro = { platform: '' };
			expect(isMacOS()).toBe(false);
		});

		it('handles special characters in key names', () => {
			(window as any).maestro = { platform: 'darwin' };
			// Key names with special characters should be returned as-is
			expect(formatKey('+')).toBe('+');
			expect(formatKey('-')).toBe('-');
			expect(formatKey('/')).toBe('/');
		});

		it('handles unicode characters', () => {
			(window as any).maestro = { platform: 'darwin' };
			// Unicode characters should be uppercased if single char
			expect(formatKey('a')).toBe('A');
			// Multi-char unicode should be returned as-is
			expect(formatKey('hello')).toBe('hello');
		});
	});

	describe('All Key Mappings Coverage', () => {
		describe('macOS - complete key map coverage', () => {
			beforeEach(() => {
				(window as any).maestro = { platform: 'darwin' };
			});

			it('covers all 16 macOS key mappings', () => {
				const macMappings: [string, string][] = [
					['Meta', '⌘'],
					['Alt', '⌥'],
					['Shift', '⇧'],
					['Control', '⌃'],
					['Ctrl', '⌃'],
					['ArrowUp', '↑'],
					['ArrowDown', '↓'],
					['ArrowLeft', '←'],
					['ArrowRight', '→'],
					['Backspace', '⌫'],
					['Delete', '⌦'],
					['Enter', '↩'],
					['Return', '↩'],
					['Escape', '⎋'],
					['Tab', '⇥'],
					['Space', '␣'],
				];

				for (const [input, expected] of macMappings) {
					expect(formatKey(input)).toBe(expected);
				}
			});
		});

		describe('Windows/Linux - complete key map coverage', () => {
			beforeEach(() => {
				(window as any).maestro = { platform: 'win32' };
			});

			it('covers all 16 Windows/Linux key mappings', () => {
				const otherMappings: [string, string][] = [
					['Meta', 'Ctrl'],
					['Alt', 'Alt'],
					['Shift', 'Shift'],
					['Control', 'Ctrl'],
					['Ctrl', 'Ctrl'],
					['ArrowUp', '↑'],
					['ArrowDown', '↓'],
					['ArrowLeft', '←'],
					['ArrowRight', '→'],
					['Backspace', 'Backspace'],
					['Delete', 'Delete'],
					['Enter', 'Enter'],
					['Return', 'Enter'],
					['Escape', 'Esc'],
					['Tab', 'Tab'],
					['Space', 'Space'],
				];

				for (const [input, expected] of otherMappings) {
					expect(formatKey(input)).toBe(expected);
				}
			});
		});
	});
});
