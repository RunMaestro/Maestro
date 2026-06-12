import { describe, expect, it } from 'vitest';
import {
	buildConfettiLaunchOptions,
	buildConfettiSettingsSnippet,
	DEFAULT_CONFETTI_COLORS,
	DEFAULT_CONFETTI_SETTINGS,
	originKeysToOrigins,
	toggleShapeSelection,
} from '../../../../../renderer/components/PlaygroundPanel/utils/confettiSettings';

describe('PlaygroundPanel confetti helpers', () => {
	it('maps selected origin keys to grid coordinates in insertion order', () => {
		const origins = originKeysToOrigins(new Set(['2-1', '0-0', '1-2']));

		expect(origins).toEqual([
			{ x: 0.5, y: 1 },
			{ x: 0, y: 0 },
			{ x: 1, y: 0.5 },
		]);
	});

	it('skips invalid selected origin keys', () => {
		const origins = originKeysToOrigins(
			new Set(['bad', '0-0-extra', '1', '1-9', 'x-y', '-1-0', '2-1'])
		);

		expect(origins).toEqual([{ x: 0.5, y: 1 }]);
	});

	it('returns no launch options when no origins are selected', () => {
		expect(buildConfettiLaunchOptions(DEFAULT_CONFETTI_SETTINGS, new Set())).toEqual([]);
	});

	it('builds launch options with particles divided across origins', () => {
		const options = buildConfettiLaunchOptions(DEFAULT_CONFETTI_SETTINGS, new Set(['2-1', '0-0']));

		expect(options).toHaveLength(2);
		expect(options[0]).toMatchObject({
			particleCount: 50,
			origin: { x: 0.5, y: 1 },
			zIndex: 99999,
			disableForReducedMotion: false,
		});
		expect(options[1]).toMatchObject({
			particleCount: 50,
			origin: { x: 0, y: 0 },
		});
	});

	it('preserves all configurable confetti settings in launch options', () => {
		const settings = {
			...DEFAULT_CONFETTI_SETTINGS,
			particleCount: 333,
			angle: 180,
			gravity: 1.5,
			colors: ['#000000'],
		};
		const [option] = buildConfettiLaunchOptions(settings, new Set(['1-1']));

		expect(option).toMatchObject({
			particleCount: 333,
			angle: 180,
			gravity: 1.5,
			colors: ['#000000'],
			origin: { x: 0.5, y: 0.5 },
		});
	});

	it('toggles shapes while preserving the final selected shape', () => {
		expect(toggleShapeSelection(['square', 'circle'], 'square')).toEqual(['circle']);
		expect(toggleShapeSelection(['circle'], 'circle')).toEqual(['circle']);
		expect(toggleShapeSelection(['circle'], 'star')).toEqual(['circle', 'star']);
	});

	it('builds a single-origin copy snippet', () => {
		const snippet = buildConfettiSettingsSnippet(DEFAULT_CONFETTI_SETTINGS, new Set(['2-1']));

		expect(snippet).toContain('// Confetti Settings');
		expect(snippet).toContain('particleCount: 100');
		expect(snippet).toContain('shapes: ["square","circle"]');
		expect(snippet).toContain('origin: { x: 0.5, y: 1 }');
		expect(snippet).toContain(JSON.stringify(DEFAULT_CONFETTI_COLORS[0]));
	});

	it('builds a multi-origin copy snippet with commented coordinates', () => {
		const snippet = buildConfettiSettingsSnippet(
			DEFAULT_CONFETTI_SETTINGS,
			new Set(['2-1', '0-2'])
		);

		expect(snippet).toContain('// Multiple origins:');
		expect(snippet).toContain('// { x: 0.5, y: 1 }');
		expect(snippet).toContain('// { x: 1, y: 0 }');
	});
});
