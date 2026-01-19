/**
 * Tests for shortcutFormatter.ts
 *
 * This module formats keyboard shortcuts for display based on the platform.
 * Since platform detection happens at module load time, we need to use
 * dynamic imports with different navigator mocks for each platform.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('shortcutFormatter', () => {
	// Store original navigator to restore after tests
	const originalNavigator = global.navigator;

	afterEach(() => {
		// Restore original navigator
		vi.unstubAllGlobals();
		// Reset module cache to allow re-evaluation with different navigator
		vi.resetModules();
	});

	describe('macOS Platform', () => {
		let formatKey: (key: string) => string;
		let formatShortcutKeys: (keys: string[], separator?: string) => string;
		let isMacOS: () => boolean;

		beforeEach(async () => {
			// Reset modules first
			vi.resetModules();
			// Mock navigator for macOS
			vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
			// Dynamically import after setting up mock
			const module = await import('../../../renderer/utils/shortcutFormatter');
			formatKey = module.formatKey;
			formatShortcutKeys = module.formatShortcutKeys;
			isMacOS = module.isMacOS;
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
	});

	describe('Windows/Linux Platform', () => {
		let formatKey: (key: string) => string;
		let formatShortcutKeys: (keys: string[], separator?: string) => string;
		let isMacOS: () => boolean;

		beforeEach(async () => {
			// Reset modules first
			vi.resetModules();
			// Mock navigator for Windows
			vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
			// Dynamically import after setting up mock
			const module = await import('../../../renderer/utils/shortcutFormatter');
			formatKey = module.formatKey;
			formatShortcutKeys = module.formatShortcutKeys;
			isMacOS = module.isMacOS;
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
	});

	describe('Edge Cases', () => {
		beforeEach(async () => {
			vi.resetModules();
			// Use macOS for these tests
			vi.stubGlobal('navigator', { userAgent: 'Mac' });
			// Need to wait for import
		});

		it('handles undefined navigator gracefully', async () => {
			vi.resetModules();
			// Simulate environment without navigator (like Node.js)
			vi.stubGlobal('navigator', undefined);

			// Module should fall back to non-Mac behavior when navigator is undefined
			const module = await import('../../../renderer/utils/shortcutFormatter');
			// When navigator is undefined, the check `typeof navigator !== 'undefined'` is false
			// So isMac will be false
			expect(module.isMacOS()).toBe(false);
		});

		it('handles Linux user agent', async () => {
			vi.resetModules();
			vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });

			const module = await import('../../../renderer/utils/shortcutFormatter');
			expect(module.isMacOS()).toBe(false);
			expect(module.formatKey('Meta')).toBe('Ctrl');
		});

		it('handles empty user agent', async () => {
			vi.resetModules();
			vi.stubGlobal('navigator', { userAgent: '' });

			const module = await import('../../../renderer/utils/shortcutFormatter');
			expect(module.isMacOS()).toBe(false);
		});

		it('handles special characters in key names', async () => {
			vi.resetModules();
			vi.stubGlobal('navigator', { userAgent: 'Mac' });

			const module = await import('../../../renderer/utils/shortcutFormatter');
			// Key names with special characters should be returned as-is
			expect(module.formatKey('+')).toBe('+');
			expect(module.formatKey('-')).toBe('-');
			expect(module.formatKey('/')).toBe('/');
		});

		it('handles unicode characters', async () => {
			vi.resetModules();
			vi.stubGlobal('navigator', { userAgent: 'Mac' });

			const module = await import('../../../renderer/utils/shortcutFormatter');
			// Unicode characters should be uppercased if single char
			expect(module.formatKey('a')).toBe('A');
			// Multi-char unicode should be returned as-is
			expect(module.formatKey('hello')).toBe('hello');
		});
	});

	describe('All Key Mappings Coverage', () => {
		describe('macOS - complete key map coverage', () => {
			beforeEach(async () => {
				vi.resetModules();
				vi.stubGlobal('navigator', { userAgent: 'Mac' });
			});

			it('covers all 16 macOS key mappings', async () => {
				const module = await import('../../../renderer/utils/shortcutFormatter');
				const { formatKey } = module;

				// All keys from MAC_KEY_MAP
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
			beforeEach(async () => {
				vi.resetModules();
				vi.stubGlobal('navigator', { userAgent: 'Windows' });
			});

			it('covers all 16 Windows/Linux key mappings', async () => {
				const module = await import('../../../renderer/utils/shortcutFormatter');
				const { formatKey } = module;

				// All keys from OTHER_KEY_MAP
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
