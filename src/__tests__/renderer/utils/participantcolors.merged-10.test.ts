// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/participantColors.test.ts
// Source: src/__tests__/renderer/utils/search.test.ts
// Source: src/__tests__/renderer/utils/shellCommandInput.test.ts
import { describe, it, expect, vi, beforeEach, afterEach, test } from 'vitest';
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
import React from 'react';
import { render } from '@testing-library/react';
import {
	fuzzyMatch,
	fuzzyMatchWithScore,
	fuzzyMatchWithIndices,
	filterSlashCommands,
	renderFuzzyHighlight,
	FuzzyMatchResult,
} from '../../../renderer/utils/search';
import {
	commandFromShellFence,
	detectCommandModeEntry,
	isRunnableShellLanguage,
	isAiCommandMode,
	isShellCommandMode,
	nextComposerCommandMode,
	normalizeComposerCommandMode,
	previousComposerCommandMode,
	stripShellCommandEscape,
} from '../../../renderer/utils/shellCommandInput';
// Source: src/__tests__/renderer/utils/participantColors.test.ts
describe('', () => {
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
	function parseHSL(hsl: string): {
		hue: number;
		saturation: number;
		lightness: number;
	} {
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
					const round4 = parseHSL(generateParticipantColor(4 * COLOR_PALETTE_SIZE, darkTheme));
					expect(round4.saturation).toBe(25);
				});
				it('dark theme lightness should not go below 40', () => {
					// Round 3: 60 - 24 = 36 => clamped to 40
					const round3 = parseHSL(generateParticipantColor(3 * COLOR_PALETTE_SIZE, darkTheme));
					expect(round3.lightness).toBe(40);
				});
				it('light theme lightness should not go above 70', () => {
					// Round 4: 45 + 32 = 77 => clamped to 70
					const round4 = parseHSL(generateParticipantColor(4 * COLOR_PALETTE_SIZE, lightTheme));
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
				const { colors } = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
				expect(colors['Moderator']).toBe(
					generateParticipantColor(MODERATOR_COLOR_INDEX, darkTheme)
				);
			});
			it('should identify Moderator only when name is "Moderator" and no sessionPath', () => {
				const participants: ParticipantColorInfo[] = [
					{ name: 'Moderator', sessionPath: '/path/mod' }, // has sessionPath, not the real Moderator
					{ name: 'Alice', sessionPath: '/path/alice' },
				];
				const { colors } = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
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
				const { colors } = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
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
				const { colors } = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
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
				const { colors } = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
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
				const { colors } = buildParticipantColorMapWithPreferences(participants, lightTheme, {});
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
				const { colors } = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
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
				vi.mocked(window.maestro.settings.get).mockRejectedValue(new Error('Settings unavailable'));
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
				expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatColorPreferences', {});
			});
			it('should propagate errors from settings.set', async () => {
				vi.mocked(window.maestro.settings.set).mockRejectedValue(new Error('Write failed'));
				await expect(saveColorPreferences({ '/path/alice': 1 })).rejects.toThrow('Write failed');
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
				const first = buildParticipantColorMapWithPreferences(participants, darkTheme, {});
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
});
// Source: src/__tests__/renderer/utils/search.test.ts
describe('', () => {
	describe('search utils', () => {
		describe('fuzzyMatch', () => {
			describe('basic matching', () => {
				it('returns true for empty query', () => {
					expect(fuzzyMatch('any text', '')).toBe(true);
				});
				it('returns true when query matches exactly', () => {
					expect(fuzzyMatch('hello', 'hello')).toBe(true);
				});
				it('returns true when query is substring', () => {
					expect(fuzzyMatch('hello world', 'world')).toBe(true);
				});
				it('returns true when characters appear in order', () => {
					expect(fuzzyMatch('hello world', 'hlwrd')).toBe(true);
				});
				it('returns false when characters do not appear in order', () => {
					expect(fuzzyMatch('hello', 'oeh')).toBe(false);
				});
				it('returns false when query has characters not in text', () => {
					expect(fuzzyMatch('hello', 'xyz')).toBe(false);
				});
			});
			describe('case insensitivity', () => {
				it('matches regardless of case in text', () => {
					expect(fuzzyMatch('HELLO', 'hello')).toBe(true);
				});
				it('matches regardless of case in query', () => {
					expect(fuzzyMatch('hello', 'HELLO')).toBe(true);
				});
				it('matches with mixed case', () => {
					expect(fuzzyMatch('HeLLo WoRLd', 'hElLo')).toBe(true);
				});
			});
			describe('edge cases', () => {
				it('handles empty text with empty query', () => {
					expect(fuzzyMatch('', '')).toBe(true);
				});
				it('handles empty text with non-empty query', () => {
					expect(fuzzyMatch('', 'a')).toBe(false);
				});
				it('handles single character match', () => {
					expect(fuzzyMatch('abc', 'b')).toBe(true);
				});
				it('handles single character no match', () => {
					expect(fuzzyMatch('abc', 'z')).toBe(false);
				});
				it('handles query longer than text (no match)', () => {
					expect(fuzzyMatch('ab', 'abc')).toBe(false);
				});
				it('handles special characters', () => {
					expect(fuzzyMatch('hello-world_test.ts', 'hwt')).toBe(true);
				});
				it('handles numbers', () => {
					expect(fuzzyMatch('file123.ts', '123')).toBe(true);
				});
				it('handles unicode characters', () => {
					expect(fuzzyMatch('caf\u00e9 test', 'caf')).toBe(true);
				});
			});
			describe('file path matching', () => {
				it('matches file names', () => {
					expect(fuzzyMatch('src/renderer/utils/search.ts', 'search')).toBe(true);
				});
				it('matches path segments', () => {
					expect(fuzzyMatch('src/renderer/utils/search.ts', 'rnd')).toBe(true);
				});
				it('matches extension', () => {
					expect(fuzzyMatch('myfile.tsx', 'tsx')).toBe(true);
				});
				it('matches across path separators', () => {
					expect(fuzzyMatch('src/renderer/utils/search.ts', 'sruts')).toBe(true);
				});
			});
			describe('realistic search scenarios', () => {
				it('matches component names', () => {
					expect(fuzzyMatch('SessionListItem', 'sli')).toBe(true);
					expect(fuzzyMatch('SessionListItem', 'seslit')).toBe(true);
				});
				it('matches function names', () => {
					expect(fuzzyMatch('handleUserInput', 'hui')).toBe(true);
					expect(fuzzyMatch('handleUserInput', 'hndlinput')).toBe(true);
				});
				it('rejects non-matching patterns', () => {
					expect(fuzzyMatch('SessionListItem', 'xyz')).toBe(false);
					expect(fuzzyMatch('handleUserInput', 'abc')).toBe(false);
				});
			});
		});
		describe('fuzzyMatchWithScore', () => {
			describe('basic matching', () => {
				it('returns matches: true and score: 0 for empty query', () => {
					const result = fuzzyMatchWithScore('any text', '');
					expect(result.matches).toBe(true);
					expect(result.score).toBe(0);
				});
				it('returns matches: true when query matches exactly', () => {
					const result = fuzzyMatchWithScore('hello', 'hello');
					expect(result.matches).toBe(true);
					expect(result.score).toBeGreaterThan(0);
				});
				it('returns matches: false with score: 0 when no match', () => {
					const result = fuzzyMatchWithScore('hello', 'xyz');
					expect(result.matches).toBe(false);
					expect(result.score).toBe(0);
				});
				it('returns matches: false when characters out of order', () => {
					const result = fuzzyMatchWithScore('hello', 'oeh');
					expect(result.matches).toBe(false);
					expect(result.score).toBe(0);
				});
			});
			describe('scoring - consecutive matches', () => {
				it('scores consecutive matches higher than scattered matches', () => {
					const consecutiveResult = fuzzyMatchWithScore('abcdef', 'abc');
					const scatteredResult = fuzzyMatchWithScore('aXbXcX', 'abc');
					expect(consecutiveResult.score).toBeGreaterThan(scatteredResult.score);
				});
				it('accumulates bonus for each consecutive character', () => {
					// Longer consecutive runs should score higher
					const twoConsecutive = fuzzyMatchWithScore('ab', 'ab');
					const threeConsecutive = fuzzyMatchWithScore('abc', 'abc');
					// Three consecutive chars should have higher total score per character
					expect(threeConsecutive.score).toBeGreaterThan(twoConsecutive.score);
				});
			});
			describe('scoring - position bonuses', () => {
				it('scores matches at start higher than matches later', () => {
					const startMatch = fuzzyMatchWithScore('abc', 'a');
					const laterMatch = fuzzyMatchWithScore('xxxabc', 'a');
					expect(startMatch.score).toBeGreaterThan(laterMatch.score);
				});
				it('gives bonus for match at word boundaries (space)', () => {
					const wordBoundary = fuzzyMatchWithScore('hello world', 'w');
					const midWord = fuzzyMatchWithScore('hewollo', 'w');
					// Word boundary match gets +8 bonus
					expect(wordBoundary.score).toBeGreaterThan(midWord.score);
				});
				it('gives bonus for match at word boundaries (dash)', () => {
					const dashBoundary = fuzzyMatchWithScore('hello-world', 'w');
					const midWord = fuzzyMatchWithScore('hewollo', 'w');
					expect(dashBoundary.score).toBeGreaterThan(midWord.score);
				});
				it('gives bonus for match at word boundaries (underscore)', () => {
					const underscoreBoundary = fuzzyMatchWithScore('hello_world', 'w');
					const midWord = fuzzyMatchWithScore('hewollo', 'w');
					expect(underscoreBoundary.score).toBeGreaterThan(midWord.score);
				});
				it('gives bonus for match at word boundaries (slash)', () => {
					const slashBoundary = fuzzyMatchWithScore('path/file', 'f');
					const midWord = fuzzyMatchWithScore('pafile', 'f');
					expect(slashBoundary.score).toBeGreaterThan(midWord.score);
				});
				it('gives bonus for match at text start (position 0)', () => {
					const startMatch = fuzzyMatchWithScore('abc', 'a');
					// Match at position 0 gets +8 for word boundary
					expect(startMatch.score).toBeGreaterThan(0);
				});
			});
			describe('scoring - case sensitivity bonus', () => {
				it('scores case-sensitive matches higher', () => {
					const caseSensitive = fuzzyMatchWithScore('Hello', 'H');
					const caseInsensitive = fuzzyMatchWithScore('hello', 'H');
					expect(caseSensitive.score).toBeGreaterThan(caseInsensitive.score);
				});
				it('accumulates case bonus for multiple matching chars', () => {
					const allCaseMatch = fuzzyMatchWithScore('ABC', 'ABC');
					const noCaseMatch = fuzzyMatchWithScore('abc', 'ABC');
					expect(allCaseMatch.score).toBeGreaterThan(noCaseMatch.score);
				});
			});
			describe('scoring - text length and specificity', () => {
				it('scores shorter text higher (better specificity)', () => {
					const shortText = fuzzyMatchWithScore('abc', 'abc');
					const longText = fuzzyMatchWithScore('abcdefghij', 'abc');
					expect(shortText.score).toBeGreaterThan(longText.score);
				});
				it('calculates length ratio bonus correctly', () => {
					// query.length / text.length * 30
					const perfectMatch = fuzzyMatchWithScore('ab', 'ab'); // ratio = 1.0 -> +30
					expect(perfectMatch.score).toBeGreaterThan(0);
				});
			});
			describe('scoring - exact substring bonus', () => {
				it('gives bonus for exact substring match', () => {
					const exactSubstring = fuzzyMatchWithScore('hello world', 'world');
					const fuzzyOnly = fuzzyMatchWithScore('wXoXrXlXd', 'world');
					// exactSubstring should get +50 bonus for substring
					expect(exactSubstring.score).toBeGreaterThan(fuzzyOnly.score);
				});
			});
			describe('scoring - exact match bonus', () => {
				it('gives highest score for exact match', () => {
					const exactMatch = fuzzyMatchWithScore('hello', 'hello');
					const substring = fuzzyMatchWithScore('hello world', 'hello');
					// Exact match gets +100 bonus
					expect(exactMatch.score).toBeGreaterThan(substring.score);
				});
				it('exact match is case insensitive', () => {
					const exactMatch = fuzzyMatchWithScore('hello', 'HELLO');
					// Should still get exact match bonus since lowerText === lowerQuery
					expect(exactMatch.matches).toBe(true);
					expect(exactMatch.score).toBeGreaterThan(100); // Has base score + exact match bonus
				});
			});
			describe('edge cases', () => {
				it('handles empty text with empty query', () => {
					const result = fuzzyMatchWithScore('', '');
					expect(result.matches).toBe(true);
					expect(result.score).toBe(0);
				});
				it('handles empty text with non-empty query', () => {
					const result = fuzzyMatchWithScore('', 'a');
					expect(result.matches).toBe(false);
					expect(result.score).toBe(0);
				});
				it('handles query longer than text', () => {
					const result = fuzzyMatchWithScore('ab', 'abc');
					expect(result.matches).toBe(false);
					expect(result.score).toBe(0);
				});
				it('handles special characters', () => {
					const result = fuzzyMatchWithScore('hello-world_test.ts', 'hwt');
					expect(result.matches).toBe(true);
					expect(result.score).toBeGreaterThan(0);
				});
				it('handles numbers', () => {
					const result = fuzzyMatchWithScore('file123.ts', '123');
					expect(result.matches).toBe(true);
					expect(result.score).toBeGreaterThan(0);
				});
			});
			describe('scoring comparisons for ranking', () => {
				it('ranks exact matches highest', () => {
					const candidates = ['test', 'testing', 'test file', 'my test'];
					const results = candidates.map((c) => ({
						text: c,
						...fuzzyMatchWithScore(c, 'test'),
					}));
					// Sort by score descending
					results.sort((a, b) => b.score - a.score);
					// Exact match should be first
					expect(results[0].text).toBe('test');
				});
				it('ranks start-of-string matches higher (same length)', () => {
					// Use same-length strings to isolate position bonus effect
					const candidates = ['test_abc', 'abc_test'];
					const results = candidates.map((c) => ({
						text: c,
						...fuzzyMatchWithScore(c, 'test'),
					}));
					results.sort((a, b) => b.score - a.score);
					// 'test_abc' starts with match, should rank higher
					expect(results[0].text).toBe('test_abc');
				});
				it('provides meaningful ranking for file search', () => {
					const files = [
						'src/renderer/utils/search.ts',
						'src/__tests__/search.test.ts',
						'search.ts',
						'MySearchComponent.tsx',
					];
					const results = files.map((f) => ({
						file: f,
						...fuzzyMatchWithScore(f, 'search'),
					}));
					results.sort((a, b) => b.score - a.score);
					// All should match
					expect(results.every((r) => r.matches)).toBe(true);
					// Shortest exact match should be first
					expect(results[0].file).toBe('search.ts');
				});
				it('ranks component names sensibly', () => {
					const components = ['SessionListItem', 'SessionList', 'SessionManager', 'ListItem'];
					const results = components.map((c) => ({
						component: c,
						...fuzzyMatchWithScore(c, 'sesl'),
					}));
					// Filter to only matches
					const matches = results.filter((r) => r.matches);
					matches.sort((a, b) => b.score - a.score);
					// SessionList should rank higher than SessionListItem (shorter, better specificity)
					const sessionListIdx = matches.findIndex((m) => m.component === 'SessionList');
					const sessionListItemIdx = matches.findIndex((m) => m.component === 'SessionListItem');
					if (sessionListIdx !== -1 && sessionListItemIdx !== -1) {
						expect(sessionListIdx).toBeLessThan(sessionListItemIdx);
					}
				});
			});
			describe('position bonus calculation', () => {
				it('gives maximum position bonus (50) for match at index 0', () => {
					const result = fuzzyMatchWithScore('abc', 'a');
					// Position bonus = max(0, 50 - 0) = 50
					expect(result.matches).toBe(true);
					expect(result.score).toBeGreaterThan(0);
				});
				it('gives decreasing bonus for later match positions', () => {
					const earlyMatch = fuzzyMatchWithScore('abc', 'a'); // firstMatchIndex = 0
					const laterMatch = fuzzyMatchWithScore('xxxxabc', 'a'); // firstMatchIndex = 4
					expect(earlyMatch.score).toBeGreaterThan(laterMatch.score);
				});
				it('gives no position bonus for very late matches', () => {
					// If firstMatchIndex >= 50, position bonus = max(0, 50 - 50+) = 0
					const fiftyChars = 'x'.repeat(50) + 'a';
					const result = fuzzyMatchWithScore(fiftyChars, 'a');
					expect(result.matches).toBe(true);
					// Still has base score but no position bonus
				});
			});
			describe('first match tracking', () => {
				it('correctly tracks first match position', () => {
					// The first character match determines position bonus
					const result1 = fuzzyMatchWithScore('hello', 'h'); // firstMatch at 0
					const result2 = fuzzyMatchWithScore('hello', 'e'); // firstMatch at 1
					const result3 = fuzzyMatchWithScore('hello', 'o'); // firstMatch at 4
					expect(result1.score).toBeGreaterThan(result2.score);
					expect(result2.score).toBeGreaterThan(result3.score);
				});
				it('uses first match for multi-char queries', () => {
					const result = fuzzyMatchWithScore('hello', 'elo');
					// First match is 'e' at index 1
					expect(result.matches).toBe(true);
					expect(result.score).toBeGreaterThan(0);
				});
			});
			describe('consecutive match reset', () => {
				it('resets consecutive counter after non-match', () => {
					// In 'abXcd', matching 'abcd':
					// a-b are consecutive, then X breaks it, c-d are consecutive again
					const broken = fuzzyMatchWithScore('abXcd', 'abcd');
					const continuous = fuzzyMatchWithScore('abcd', 'abcd');
					expect(continuous.score).toBeGreaterThan(broken.score);
				});
			});
			describe('interface contract', () => {
				it('returns FuzzyMatchResult interface', () => {
					const result: FuzzyMatchResult = fuzzyMatchWithScore('test', 'test');
					expect(result).toHaveProperty('matches');
					expect(result).toHaveProperty('score');
					expect(typeof result.matches).toBe('boolean');
					expect(typeof result.score).toBe('number');
				});
			});
			describe('integration scenarios', () => {
				it('handles real file search scenario', () => {
					const files = [
						'src/renderer/components/SessionList.tsx',
						'src/renderer/components/SessionListItem.tsx',
						'src/renderer/hooks/useSession.ts',
						'src/main/session-manager.ts',
						'src/__tests__/session.test.ts',
					];
					const query = 'seslist';
					const results = files
						.map((f) => ({ file: f, ...fuzzyMatchWithScore(f, query) }))
						.filter((r) => r.matches)
						.sort((a, b) => b.score - a.score);
					// Should find SessionList and SessionListItem
					expect(results.length).toBeGreaterThan(0);
					expect(results.some((r) => r.file.includes('SessionList.tsx'))).toBe(true);
				});
				it('handles command palette scenario', () => {
					const commands = [
						'New Session',
						'Delete Session',
						'Rename Session',
						'Toggle Terminal',
						'Show Settings',
						'New Tab',
					];
					const query = 'ns';
					const results = commands
						.map((c) => ({ command: c, ...fuzzyMatchWithScore(c, query) }))
						.filter((r) => r.matches)
						.sort((a, b) => b.score - a.score);
					// 'New Session' should match and rank high
					expect(results.some((r) => r.command === 'New Session')).toBe(true);
				});
				it('handles code search scenario', () => {
					const symbols = [
						'handleUserInput',
						'handleKeyPress',
						'handleMouseEvent',
						'processUserAction',
						'userInputHandler',
					];
					const query = 'hui';
					const results = symbols
						.map((s) => ({ symbol: s, ...fuzzyMatchWithScore(s, query) }))
						.filter((r) => r.matches)
						.sort((a, b) => b.score - a.score);
					// handleUserInput should match
					expect(results.some((r) => r.symbol === 'handleUserInput')).toBe(true);
				});
			});
		});
		describe('fuzzyMatchWithIndices', () => {
			it('returns empty array for empty query', () => {
				expect(fuzzyMatchWithIndices('anything', '')).toEqual([]);
			});
			it('returns empty array for non-match', () => {
				expect(fuzzyMatchWithIndices('history', 'xyz')).toEqual([]);
			});
			it('returns correct indices for prefix match', () => {
				expect(fuzzyMatchWithIndices('history', 'hist')).toEqual([0, 1, 2, 3]);
			});
			it('returns correct indices for fuzzy match across dot boundary', () => {
				// With '.' as extra boundary, "splan" should match s(0) then p(7) at ".plan" boundary
				const indices = fuzzyMatchWithIndices('speckit.plan', 'splan', '.');
				expect(indices).toHaveLength(5);
				expect(indices[0]).toBe(0); // s
				expect(indices[1]).toBe(8); // p (after dot, not index 1)
			});
			it('falls back to greedy when no boundary match exists', () => {
				const indices = fuzzyMatchWithIndices('abcdef', 'ace');
				expect(indices).toEqual([0, 2, 4]);
			});
			it('returns empty array when query is longer than text', () => {
				expect(fuzzyMatchWithIndices('hi', 'history')).toEqual([]);
			});
			it('falls back to greedy when boundary choice would prevent remaining match', () => {
				// "aa" in "ab.a": boundary 'a' is at index 3 (after '.'), but picking it
				// for qi=0 leaves no chars for qi=1. Should fall back to index 0.
				const indices = fuzzyMatchWithIndices('ab.a', 'aa', '.');
				expect(indices).toEqual([0, 3]);
			});
		});
		describe('slash command fuzzy matching', () => {
			it('matches boundary-anchored abbreviation (splan → speckit.plan)', () => {
				expect(fuzzyMatchWithScore('speckit.plan', 'splan', '.').matches).toBe(true);
			});
			it('ranks prefix match above fuzzy match', () => {
				const prefix = fuzzyMatchWithScore('speckit.plan', 'spec', '.');
				const fuzzy = fuzzyMatchWithScore('speckit.plan', 'splan', '.');
				expect(prefix.score).toBeGreaterThan(fuzzy.score);
			});
			it('matches across dot boundaries', () => {
				expect(fuzzyMatchWithScore('openspec.plan', 'oplan', '.').matches).toBe(true);
				expect(fuzzyMatchWithScore('speckit.list', 'slist', '.').matches).toBe(true);
			});
			it('gives dot boundary bonus only when opted in', () => {
				const withDot = fuzzyMatchWithScore('hello.world', 'w', '.');
				const withoutDot = fuzzyMatchWithScore('hello.world', 'w');
				expect(withDot.score).toBeGreaterThan(withoutDot.score);
			});
		});
		describe('renderFuzzyHighlight', () => {
			it('returns the plain string when nothing matched, so no query costs no DOM', () => {
				expect(renderFuzzyHighlight('Section A', new Set())).toBe('Section A');
			});
			it('emphasizes exactly the matched character positions', () => {
				const indices = new Set(fuzzyMatchWithIndices('Swept 2026-09-04', 'swe'));
				const { container } = render(
					React.createElement('div', null, renderFuzzyHighlight('Swept 2026-09-04', indices))
				);
				const bolded = Array.from(container.querySelectorAll('span'))
					.filter((el) => el.style.fontWeight === '700')
					.map((el) => el.textContent)
					.join('');
				expect(bolded).toBe('Swe');
			});
			it('honors caller-supplied styles', () => {
				const { container } = render(
					React.createElement(
						'div',
						null,
						renderFuzzyHighlight('ab', new Set([0]), {
							match: { color: 'rgb(145, 70, 255)' },
							rest: {},
						})
					)
				);
				const spans = container.querySelectorAll('span');
				expect(spans[0].style.color).toBe('rgb(145, 70, 255)');
				expect(spans[1].style.color).toBe('');
			});
		});
		describe('filterSlashCommands', () => {
			it('ranks prefix match above fuzzy matches when typing /npm', () => {
				const commands = [
					{ command: '/openspec.implement' },
					{ command: '/fewer-permission-prompts' },
					{ command: '/npm-test' },
				];
				const result = filterSlashCommands(commands, 'npm', false);
				expect(result[0].command).toBe('/npm-test');
			});
			it('keeps direct prefix match on top even when fuzzy matches share many characters', () => {
				const commands = [
					{ command: '/manage-permissions' }, // fuzzy: m-a-n
					{ command: '/man-page' }, // prefix
				];
				const result = filterSlashCommands(commands, 'man', false);
				expect(result[0].command).toBe('/man-page');
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/shellCommandInput.test.ts
describe('', () => {
	describe('detectCommandModeEntry', () => {
		test('enters on a bang typed into an empty composer, consuming the bang', () => {
			expect(detectCommandModeEntry('', '!')).toBe('');
		});
		test('keeps whatever followed the bang in a paste', () => {
			expect(detectCommandModeEntry('', '!git status')).toBe('git status');
		});
		test('treats a whitespace-only composer as empty', () => {
			expect(detectCommandModeEntry('   ', '!ls')).toBe('ls');
			expect(detectCommandModeEntry('\n', '!ls')).toBe('ls');
		});
		test('preserves leading whitespace around the consumed bang', () => {
			expect(detectCommandModeEntry('', '  !ls')).toBe('  ls');
		});
		test('does not enter when the composer already had a message', () => {
			// Caret moved to the start of an in-progress message and `!` typed: that
			// must stay a message, not silently become a shell command.
			expect(detectCommandModeEntry('deploy the site', '!deploy the site')).toBeNull();
		});
		test('does not enter on a bang that is not leading', () => {
			expect(detectCommandModeEntry('', 'do it now!')).toBeNull();
		});
		test('does not enter for ordinary text', () => {
			expect(detectCommandModeEntry('', 'fix the login bug')).toBeNull();
			expect(detectCommandModeEntry('', '')).toBeNull();
		});
		test('does not enter for the escape form', () => {
			// `\!` is how you send a literal leading bang to the agent.
			expect(detectCommandModeEntry('', '\\!important')).toBeNull();
		});
	});
	describe('stripShellCommandEscape', () => {
		test('unwraps a leading escaped bang', () => {
			expect(stripShellCommandEscape('\\!important message')).toBe('!important message');
		});
		test('preserves leading whitespace while unwrapping', () => {
			expect(stripShellCommandEscape('  \\!hey')).toBe('  !hey');
		});
		test('leaves ordinary messages untouched', () => {
			expect(stripShellCommandEscape('fix the login bug')).toBe('fix the login bug');
		});
		test('only strips the leading escape, not later ones', () => {
			expect(stripShellCommandEscape('\\!a and \\!b')).toBe('!a and \\!b');
		});
		test('leaves a non-leading backslash-bang untouched', () => {
			expect(stripShellCommandEscape('echo \\!x')).toBe('echo \\!x');
		});
	});
	describe('the bang ladder', () => {
		test('climbs agent -> shell -> ai and stops there', () => {
			expect(nextComposerCommandMode('off')).toBe('shell');
			expect(nextComposerCommandMode('shell')).toBe('ai');
			// No rung above AI command mode, so the bang stays in the request text.
			expect(nextComposerCommandMode('ai')).toBeNull();
		});
		test('descends ai -> shell -> agent and floors at agent', () => {
			expect(previousComposerCommandMode('ai')).toBe('shell');
			expect(previousComposerCommandMode('shell')).toBe('off');
			expect(previousComposerCommandMode('off')).toBe('off');
		});
		test('only the shell rung reports as a shell command line', () => {
			expect(isShellCommandMode('shell')).toBe(true);
			expect(isShellCommandMode('ai')).toBe(false);
			expect(isAiCommandMode('ai')).toBe(true);
			expect(isAiCommandMode('shell')).toBe(false);
		});
	});
	describe('normalizeComposerCommandMode', () => {
		test('reads the legacy boolean encoding as the shell rung', () => {
			// Tabs written before AI command mode existed stored `true` for what is
			// now 'shell'. Those drafts must still route to the shell after an update.
			expect(normalizeComposerCommandMode(true)).toBe('shell');
			expect(normalizeComposerCommandMode(false)).toBe('off');
		});
		test('passes through the current encoding', () => {
			expect(normalizeComposerCommandMode('shell')).toBe('shell');
			expect(normalizeComposerCommandMode('ai')).toBe('ai');
			expect(normalizeComposerCommandMode('off')).toBe('off');
		});
		test('falls back to ordinary chat for anything unrecognised', () => {
			// A corrupt value must land the user in chat, never in a shell.
			expect(normalizeComposerCommandMode(undefined)).toBe('off');
			expect(normalizeComposerCommandMode(null)).toBe('off');
			expect(normalizeComposerCommandMode('bogus')).toBe('off');
			expect(normalizeComposerCommandMode(1)).toBe('off');
		});
	});
	describe('isRunnableShellLanguage', () => {
		test('accepts the shell tags agents write and their Shiki canonical ids', () => {
			for (const lang of ['bash', 'sh', 'shell', 'zsh', 'console', 'shellscript', 'shellsession']) {
				expect(isRunnableShellLanguage(lang)).toBe(true);
			}
		});
		test('is case-insensitive', () => {
			expect(isRunnableShellLanguage('Bash')).toBe(true);
		});
		test('rejects other languages and other shell dialects', () => {
			for (const lang of ['python', 'text', 'fish', 'powershell', '', null, undefined]) {
				expect(isRunnableShellLanguage(lang)).toBe(false);
			}
		});
	});
	describe('commandFromShellFence', () => {
		test('runs an ordinary fence as written, line continuations included', () => {
			const code = 'cd ~/dl && curl -L -o out.mp4 \\\n  "https://example.com/a.mp4"';
			expect(commandFromShellFence(`\n${code}\n`)).toBe(code);
		});
		test('runs only the prompt lines of a session transcript, prompt stripped', () => {
			const code = '$ npm test\n> vitest run\n 12 passed\n$ git status';
			expect(commandFromShellFence(code)).toBe('npm test\ngit status');
		});
		test('does not mistake a variable for a prompt', () => {
			expect(commandFromShellFence('$HOME/bin/tool --flag')).toBe('$HOME/bin/tool --flag');
		});
		test('returns an empty string for a blank fence', () => {
			expect(commandFromShellFence('  \n ')).toBe('');
		});
	});
});
