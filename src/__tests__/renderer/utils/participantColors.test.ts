import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Theme } from '../../../shared/theme-types';
import {
	generateParticipantColor,
	buildParticipantColorMap,
	buildParticipantColorMapWithPreferences,
	loadColorPreferences,
	saveColorPreferences,
	MODERATOR_COLOR_INDEX,
	COLOR_PALETTE_SIZE,
} from '../../../renderer/utils/participantColors';
import type { ParticipantColorInfo } from '../../../renderer/utils/participantColors';

/**
 * Tests for participantColors utility
 *
 * Covers color generation, color map building (with and without preferences),
 * preference persistence, and edge cases.
 */

// --- Theme mocks ---

const darkTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		border: '#533483',
		textMain: '#e94560',
		textDim: '#a3a3a3',
		accent: '#e94560',
		accentDim: 'rgba(233, 69, 96, 0.2)',
		accentText: '#e94560',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const lightTheme: Theme = {
	id: 'github-light',
	name: 'GitHub Light',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#eaeef2',
		border: '#d0d7de',
		textMain: '#1f2328',
		textDim: '#656d76',
		accent: '#0969da',
		accentDim: 'rgba(9, 105, 218, 0.2)',
		accentText: '#0969da',
		accentForeground: '#ffffff',
		success: '#1a7f37',
		warning: '#9a6700',
		error: '#cf222e',
	},
};

// HSL regex for validating generated colors
const HSL_REGEX = /^hsl\(\d+, \d+%, \d+%\)$/;

// --- Helper to parse HSL values from a color string ---
function parseHSL(hsl: string): { hue: number; saturation: number; lightness: number } {
	const match = hsl.match(/^hsl\((\d+), (\d+)%, (\d+)%\)$/);
	if (!match) throw new Error(`Invalid HSL string: ${hsl}`);
	return {
		hue: parseInt(match[1], 10),
		saturation: parseInt(match[2], 10),
		lightness: parseInt(match[3], 10),
	};
}

// Known BASE_HUES array from source
const BASE_HUES = [210, 150, 30, 270, 0, 180, 60, 300, 120, 330];

// --- Tests ---

describe('participantColors', () => {
	describe('constants', () => {
		it('MODERATOR_COLOR_INDEX should be 0', () => {
			expect(MODERATOR_COLOR_INDEX).toBe(0);
		});

		it('COLOR_PALETTE_SIZE should be 10', () => {
			expect(COLOR_PALETTE_SIZE).toBe(10);
		});
	});

	describe('generateParticipantColor', () => {
		describe('basic output format', () => {
			it('should return a valid HSL string for dark theme', () => {
				const color = generateParticipantColor(0, darkTheme);
				expect(color).toMatch(HSL_REGEX);
			});

			it('should return a valid HSL string for light theme', () => {
				const color = generateParticipantColor(0, lightTheme);
				expect(color).toMatch(HSL_REGEX);
			});
		});

		describe('hue selection from BASE_HUES', () => {
			it('should use the correct base hue for each index within palette size', () => {
				for (let i = 0; i < COLOR_PALETTE_SIZE; i++) {
					const color = generateParticipantColor(i, darkTheme);
					const { hue } = parseHSL(color);
					expect(hue).toBe(BASE_HUES[i]);
				}
			});

			it('index 0 (Moderator) should always produce hue 210 (blue)', () => {
				const darkColor = generateParticipantColor(0, darkTheme);
				const lightColor = generateParticipantColor(0, lightTheme);
				expect(parseHSL(darkColor).hue).toBe(210);
				expect(parseHSL(lightColor).hue).toBe(210);
			});
		});

		describe('dark vs light theme differentiation', () => {
			it('dark theme should use lower saturation than light theme for same index', () => {
				// Dark: baseSaturation = 55, Light: baseSaturation = 65
				const darkColor = generateParticipantColor(0, darkTheme);
				const lightColor = generateParticipantColor(0, lightTheme);
				const darkSat = parseHSL(darkColor).saturation;
				const lightSat = parseHSL(lightColor).saturation;
				expect(darkSat).toBe(55);
				expect(lightSat).toBe(65);
			});

			it('dark theme should use higher base lightness than light theme', () => {
				// Dark: baseLightness = 60, Light: baseLightness = 45
				const darkColor = generateParticipantColor(0, darkTheme);
				const lightColor = generateParticipantColor(0, lightTheme);
				const darkLight = parseHSL(darkColor).lightness;
				const lightLight = parseHSL(lightColor).lightness;
				expect(darkLight).toBe(60);
				expect(lightLight).toBe(45);
			});

			it('should detect light theme from bgMain brightness > 128', () => {
				// #ff... means first byte is 255 > 128 => light
				const brightTheme: Theme = {
					...darkTheme,
					colors: { ...darkTheme.colors, bgMain: '#ff0000' },
				};
				const color = generateParticipantColor(0, brightTheme);
				const { saturation, lightness } = parseHSL(color);
				// Light theme values
				expect(saturation).toBe(65);
				expect(lightness).toBe(45);
			});

			it('should detect dark theme from bgMain brightness <= 128', () => {
				// #1a... means first byte is 26 <= 128 => dark
				const color = generateParticipantColor(0, darkTheme);
				const { saturation, lightness } = parseHSL(color);
				expect(saturation).toBe(55);
				expect(lightness).toBe(60);
			});

			it('should use bgMain first hex byte only for brightness detection', () => {
				// #80 = 128, not > 128, so dark theme
				const borderTheme: Theme = {
					...darkTheme,
					colors: { ...darkTheme.colors, bgMain: '#80ffff' },
				};
				const color = generateParticipantColor(0, borderTheme);
				const { saturation } = parseHSL(color);
				expect(saturation).toBe(55); // dark theme saturation
			});

			it('should treat #81 first byte as light theme (129 > 128)', () => {
				const borderTheme: Theme = {
					...darkTheme,
					colors: { ...darkTheme.colors, bgMain: '#810000' },
				};
				const color = generateParticipantColor(0, borderTheme);
				const { saturation } = parseHSL(color);
				expect(saturation).toBe(65); // light theme saturation
			});
		});

		describe('unique colors for different indices', () => {
			it('all indices within palette size should produce different colors', () => {
				const colors = new Set<string>();
				for (let i = 0; i < COLOR_PALETTE_SIZE; i++) {
					colors.add(generateParticipantColor(i, darkTheme));
				}
				expect(colors.size).toBe(COLOR_PALETTE_SIZE);
			});

			it('adjacent indices should have different hues', () => {
				for (let i = 0; i < COLOR_PALETTE_SIZE - 1; i++) {
					const color1 = generateParticipantColor(i, darkTheme);
					const color2 = generateParticipantColor(i + 1, darkTheme);
					expect(parseHSL(color1).hue).not.toBe(parseHSL(color2).hue);
				}
			});
		});

		describe('indices beyond palette size (wrapping with variation)', () => {
			it('index at palette size should wrap back to hue at index 0', () => {
				const wrapColor = generateParticipantColor(COLOR_PALETTE_SIZE, darkTheme);
				const baseColor = generateParticipantColor(0, darkTheme);
				expect(parseHSL(wrapColor).hue).toBe(parseHSL(baseColor).hue);
			});

			it('wrapped index should have different saturation than base', () => {
				const baseColor = generateParticipantColor(0, darkTheme);
				const wrapColor = generateParticipantColor(COLOR_PALETTE_SIZE, darkTheme);
				expect(parseHSL(wrapColor).saturation).not.toBe(parseHSL(baseColor).saturation);
			});

			it('wrapped index should have different lightness than base', () => {
				const baseColor = generateParticipantColor(0, darkTheme);
				const wrapColor = generateParticipantColor(COLOR_PALETTE_SIZE, darkTheme);
				expect(parseHSL(wrapColor).lightness).not.toBe(parseHSL(baseColor).lightness);
			});

			it('round 1 should reduce saturation by 10 (dark theme)', () => {
				const round0 = parseHSL(generateParticipantColor(0, darkTheme));
				const round1 = parseHSL(generateParticipantColor(COLOR_PALETTE_SIZE, darkTheme));
				// baseSaturation=55, round 1: 55-10=45
				expect(round0.saturation).toBe(55);
				expect(round1.saturation).toBe(45);
			});

			it('round 1 dark theme should decrease lightness by 8', () => {
				const round0 = parseHSL(generateParticipantColor(0, darkTheme));
				const round1 = parseHSL(generateParticipantColor(COLOR_PALETTE_SIZE, darkTheme));
				// baseLightness=60, round 1: max(40, 60-8)=52
				expect(round0.lightness).toBe(60);
				expect(round1.lightness).toBe(52);
			});

			it('round 1 light theme should increase lightness by 8', () => {
				const round0 = parseHSL(generateParticipantColor(0, lightTheme));
				const round1 = parseHSL(generateParticipantColor(COLOR_PALETTE_SIZE, lightTheme));
				// baseLightness=45, round 1: min(70, 45+8)=53
				expect(round0.lightness).toBe(45);
				expect(round1.lightness).toBe(53);
			});

			it('saturation should not go below 25', () => {
				// Round 3: 55 - 30 = 25 (clamped), Round 4: 55 - 40 = 15 => clamped to 25
				const round4 = parseHSL(
					generateParticipantColor(4 * COLOR_PALETTE_SIZE, darkTheme)
				);
				expect(round4.saturation).toBe(25);
			});

			it('dark theme lightness should not go below 40', () => {
				// Round 3: 60 - 24 = 36 => clamped to 40
				const round3 = parseHSL(
					generateParticipantColor(3 * COLOR_PALETTE_SIZE, darkTheme)
				);
				expect(round3.lightness).toBe(40);
			});

			it('light theme lightness should not go above 70', () => {
				// Round 4: 45 + 32 = 77 => clamped to 70
				const round4 = parseHSL(
					generateParticipantColor(4 * COLOR_PALETTE_SIZE, lightTheme)
				);
				expect(round4.lightness).toBe(70);
			});

			it('second round should produce different colors than first round', () => {
				for (let i = 0; i < COLOR_PALETTE_SIZE; i++) {
					const first = generateParticipantColor(i, darkTheme);
					const second = generateParticipantColor(i + COLOR_PALETTE_SIZE, darkTheme);
					expect(first).not.toBe(second);
				}
			});
		});

		describe('edge cases for theme detection', () => {
			it('should fall back to dark theme if bgMain has no valid hex prefix', () => {
				const invalidBgTheme: Theme = {
					...darkTheme,
					colors: { ...darkTheme.colors, bgMain: 'rgb(0,0,0)' },
				};
				const color = generateParticipantColor(0, invalidBgTheme);
				// bgBrightness falls back to 20 (< 128) => dark theme
				const { saturation } = parseHSL(color);
				expect(saturation).toBe(55); // dark theme
			});
		});
	});

	describe('buildParticipantColorMap', () => {
		it('should build a color map for all participants', () => {
			const names = ['Alice', 'Bob', 'Charlie'];
			const result = buildParticipantColorMap(names, darkTheme);
			expect(Object.keys(result)).toEqual(names);
		});

		it('each participant should get a valid HSL color', () => {
			const names = ['Alice', 'Bob'];
			const result = buildParticipantColorMap(names, darkTheme);
			for (const color of Object.values(result)) {
				expect(color).toMatch(HSL_REGEX);
			}
		});

		it('should assign colors by array index order', () => {
			const names = ['First', 'Second', 'Third'];
			const result = buildParticipantColorMap(names, darkTheme);
			expect(result['First']).toBe(generateParticipantColor(0, darkTheme));
			expect(result['Second']).toBe(generateParticipantColor(1, darkTheme));
			expect(result['Third']).toBe(generateParticipantColor(2, darkTheme));
		});

		it('should return empty object for empty array', () => {
			const result = buildParticipantColorMap([], darkTheme);
			expect(result).toEqual({});
		});

		it('should handle duplicate names (last wins)', () => {
			const names = ['Alice', 'Bob', 'Alice'];
			const result = buildParticipantColorMap(names, darkTheme);
			// forEach overwrites, so Alice gets index 2's color
			expect(result['Alice']).toBe(generateParticipantColor(2, darkTheme));
			expect(Object.keys(result).length).toBe(2); // Only Alice and Bob
		});

		it('should handle participants exceeding palette size', () => {
			const names = Array.from({ length: 15 }, (_, i) => `Participant${i}`);
			const result = buildParticipantColorMap(names, darkTheme);
			expect(Object.keys(result).length).toBe(15);
			// All should be valid HSL
			for (const color of Object.values(result)) {
				expect(color).toMatch(HSL_REGEX);
			}
		});
	});

	describe('buildParticipantColorMapWithPreferences', () => {
		it('should assign Moderator to index 0 (blue)', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
			];
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			expect(colors['Moderator']).toBe(
				generateParticipantColor(MODERATOR_COLOR_INDEX, darkTheme)
			);
		});

		it('should identify Moderator only when name is "Moderator" and no sessionPath', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator', sessionPath: '/path/mod' }, // has sessionPath, not the real Moderator
				{ name: 'Alice', sessionPath: '/path/alice' },
			];
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			// "Moderator" with sessionPath is NOT treated as the Moderator
			// It should get a regular non-zero index
			expect(colors['Moderator']).not.toBe(
				generateParticipantColor(MODERATOR_COLOR_INDEX, darkTheme)
			);
		});

		it('should respect existing preferences for participants', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];
			const preferences = { '/path/alice': 5 };
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				preferences
			);
			expect(colors['Alice']).toBe(generateParticipantColor(5, darkTheme));
		});

		it('should not allow non-moderator to claim index 0 via preferences', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
			];
			// Alice has a preference for index 0 (Moderator's reserved index)
			const preferences = { '/path/alice': 0 };
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				preferences
			);
			// Alice should NOT get index 0
			expect(colors['Alice']).not.toBe(
				generateParticipantColor(MODERATOR_COLOR_INDEX, darkTheme)
			);
			// Moderator should still have index 0
			expect(colors['Moderator']).toBe(
				generateParticipantColor(MODERATOR_COLOR_INDEX, darkTheme)
			);
		});

		it('should assign remaining participants from index 1 onward', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			// Alice gets index 1, Bob gets index 2
			expect(colors['Alice']).toBe(generateParticipantColor(1, darkTheme));
			expect(colors['Bob']).toBe(generateParticipantColor(2, darkTheme));
		});

		it('should skip already-used indices when assigning remaining participants', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
				{ name: 'Charlie', sessionPath: '/path/charlie' },
			];
			// Alice has preference for index 2
			const preferences = { '/path/alice': 2 };
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				preferences
			);
			expect(colors['Alice']).toBe(generateParticipantColor(2, darkTheme));
			// Bob should get 1 (first available after 0), Charlie should get 3 (2 is used)
			expect(colors['Bob']).toBe(generateParticipantColor(1, darkTheme));
			expect(colors['Charlie']).toBe(generateParticipantColor(3, darkTheme));
		});

		it('should return newPreferences only for participants without prior preferences', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];
			const preferences = { '/path/alice': 3 };
			const { newPreferences } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				preferences
			);
			// Only Bob should appear in newPreferences (Alice already had a preference)
			expect(newPreferences['/path/bob']).toBeDefined();
			expect(newPreferences['/path/alice']).toBeUndefined();
		});

		it('should not include Moderator in newPreferences', () => {
			const participants: ParticipantColorInfo[] = [{ name: 'Moderator' }];
			const { newPreferences } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			expect(Object.keys(newPreferences).length).toBe(0);
		});

		it('should handle participants without sessionPath (no preference saved)', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice' }, // no sessionPath
			];
			const { colors, newPreferences } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			// Alice should still get a color
			expect(colors['Alice']).toMatch(HSL_REGEX);
			// But no preference is saved for her (no sessionPath)
			expect(Object.keys(newPreferences).length).toBe(0);
		});

		it('should handle no Moderator in participants', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			// Without Moderator, index 0 is still skipped (nextIndex starts at 1)
			expect(colors['Alice']).toBe(generateParticipantColor(1, darkTheme));
			expect(colors['Bob']).toBe(generateParticipantColor(2, darkTheme));
		});

		it('should handle empty participants array', () => {
			const { colors, newPreferences } = buildParticipantColorMapWithPreferences(
				[],
				darkTheme,
				{}
			);
			expect(colors).toEqual({});
			expect(newPreferences).toEqual({});
		});

		it('should handle duplicate participant names (first assignment wins)', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice1' },
				{ name: 'Alice', sessionPath: '/path/alice2' },
			];
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			// First Alice gets index 1; second Alice is skipped because colors['Alice'] already exists
			expect(colors['Alice']).toBe(generateParticipantColor(1, darkTheme));
		});

		it('should handle conflicting preferences (first valid claim wins)', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];
			// Both prefer index 3
			const preferences = { '/path/alice': 3, '/path/bob': 3 };
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				preferences
			);
			// Alice gets index 3 first
			expect(colors['Alice']).toBe(generateParticipantColor(3, darkTheme));
			// Bob can't use 3, falls through to second pass
			expect(colors['Bob']).not.toBe(generateParticipantColor(3, darkTheme));
		});

		it('should use light theme when provided', () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
			];
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				lightTheme,
				{}
			);
			expect(colors['Moderator']).toBe(
				generateParticipantColor(MODERATOR_COLOR_INDEX, lightTheme)
			);
			expect(colors['Alice']).toBe(generateParticipantColor(1, lightTheme));
		});

		it('should handle many participants beyond palette size', () => {
			const participants: ParticipantColorInfo[] = [{ name: 'Moderator' }];
			for (let i = 0; i < 25; i++) {
				participants.push({ name: `Agent${i}`, sessionPath: `/path/agent${i}` });
			}
			const { colors } = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			// All 26 participants should have colors
			expect(Object.keys(colors).length).toBe(26);
			// All colors should be valid HSL
			for (const color of Object.values(colors)) {
				expect(color).toMatch(HSL_REGEX);
			}
			// All colors beyond palette size should still be unique within their round
			const colorValues = Object.values(colors);
			const uniqueColors = new Set(colorValues);
			expect(uniqueColors.size).toBe(colorValues.length);
		});
	});

	describe('loadColorPreferences', () => {
		let originalMaestro: typeof window.maestro;

		beforeEach(() => {
			originalMaestro = window.maestro;
			// @ts-expect-error - mock partial maestro object
			window.maestro = {
				settings: {
					get: vi.fn(),
					set: vi.fn(),
				},
			};
		});

		afterEach(() => {
			window.maestro = originalMaestro;
		});

		it('should return stored preferences', async () => {
			const storedPrefs = { '/path/alice': 3, '/path/bob': 5 };
			vi.mocked(window.maestro.settings.get).mockResolvedValue(storedPrefs);

			const result = await loadColorPreferences();
			expect(result).toEqual(storedPrefs);
			expect(window.maestro.settings.get).toHaveBeenCalledWith('groupChatColorPreferences');
		});

		it('should return empty object if no preferences stored', async () => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue(null);

			const result = await loadColorPreferences();
			expect(result).toEqual({});
		});

		it('should return empty object if undefined is returned', async () => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);

			const result = await loadColorPreferences();
			expect(result).toEqual({});
		});

		it('should return empty object on error', async () => {
			vi.mocked(window.maestro.settings.get).mockRejectedValue(
				new Error('Settings unavailable')
			);

			const result = await loadColorPreferences();
			expect(result).toEqual({});
		});
	});

	describe('saveColorPreferences', () => {
		let originalMaestro: typeof window.maestro;

		beforeEach(() => {
			originalMaestro = window.maestro;
			// @ts-expect-error - mock partial maestro object
			window.maestro = {
				settings: {
					get: vi.fn(),
					set: vi.fn().mockResolvedValue(undefined),
				},
			};
		});

		afterEach(() => {
			window.maestro = originalMaestro;
		});

		it('should call settings.set with the correct key and preferences', async () => {
			const prefs = { '/path/alice': 3, '/path/bob': 5 };
			await saveColorPreferences(prefs);

			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'groupChatColorPreferences',
				prefs
			);
		});

		it('should save empty preferences', async () => {
			await saveColorPreferences({});

			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'groupChatColorPreferences',
				{}
			);
		});

		it('should propagate errors from settings.set', async () => {
			vi.mocked(window.maestro.settings.set).mockRejectedValue(
				new Error('Write failed')
			);

			await expect(saveColorPreferences({ '/path/alice': 1 })).rejects.toThrow(
				'Write failed'
			);
		});
	});

	describe('integration: round-trip preferences', () => {
		let originalMaestro: typeof window.maestro;
		let mockStore: Record<string, unknown>;

		beforeEach(() => {
			originalMaestro = window.maestro;
			mockStore = {};
			// @ts-expect-error - mock partial maestro object
			window.maestro = {
				settings: {
					get: vi.fn((key: string) => Promise.resolve(mockStore[key] ?? null)),
					set: vi.fn((key: string, value: unknown) => {
						mockStore[key] = value;
						return Promise.resolve();
					}),
				},
			};
		});

		afterEach(() => {
			window.maestro = originalMaestro;
		});

		it('should persist and retrieve preferences across calls', async () => {
			const prefs = { '/path/alice': 3, '/path/bob': 7 };
			await saveColorPreferences(prefs);
			const loaded = await loadColorPreferences();
			expect(loaded).toEqual(prefs);
		});

		it('full workflow: build colors, save new prefs, reload and rebuild', async () => {
			const participants: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];

			// First build: no existing preferences
			const first = buildParticipantColorMapWithPreferences(
				participants,
				darkTheme,
				{}
			);
			expect(first.colors['Alice']).toBe(generateParticipantColor(1, darkTheme));
			expect(first.colors['Bob']).toBe(generateParticipantColor(2, darkTheme));

			// Save new preferences
			await saveColorPreferences(first.newPreferences);

			// Load preferences back
			const loadedPrefs = await loadColorPreferences();

			// Second build: with preferences, add a new participant
			const participants2: ParticipantColorInfo[] = [
				{ name: 'Moderator' },
				{ name: 'Alice', sessionPath: '/path/alice' },
				{ name: 'Charlie', sessionPath: '/path/charlie' },
				{ name: 'Bob', sessionPath: '/path/bob' },
			];
			const second = buildParticipantColorMapWithPreferences(
				participants2,
				darkTheme,
				loadedPrefs
			);

			// Alice and Bob should retain their preferred colors from first build
			expect(second.colors['Alice']).toBe(first.colors['Alice']);
			expect(second.colors['Bob']).toBe(first.colors['Bob']);
			// Charlie should get a new color that doesn't conflict
			expect(second.colors['Charlie']).toMatch(HSL_REGEX);
			expect(second.colors['Charlie']).not.toBe(second.colors['Alice']);
			expect(second.colors['Charlie']).not.toBe(second.colors['Bob']);
			expect(second.colors['Charlie']).not.toBe(second.colors['Moderator']);
		});
	});
});
