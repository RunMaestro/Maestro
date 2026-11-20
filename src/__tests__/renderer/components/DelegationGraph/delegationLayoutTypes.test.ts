import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
	DEFAULT_DELEGATION_LAYOUT,
	DEFAULT_GLOBAL_DELEGATION_LAYOUT,
	DELEGATION_ALGORITHM_LAYOUTS,
	DELEGATION_LAYOUT_LABELS,
	DELEGATION_LAYOUT_TYPES,
	isDelegationAlgorithmLayout,
	isDelegationLayoutType,
	nextDelegationLayout,
	type DelegationLayoutType,
} from '../../../../renderer/components/DelegationGraph/delegationLayoutTypes';

describe('delegationLayoutTypes', () => {
	describe('DELEGATION_LAYOUT_TYPES', () => {
		it('lists the shared graph layouts and manual placement in toolbar order', () => {
			expect(DELEGATION_LAYOUT_TYPES).toEqual([
				'hierarchical',
				'force',
				'radial',
				'mindmap',
				'lobes',
				'manual',
			]);
		});

		// One list serves the picker and the settings validator, so a layout
		// without a label, or a label without a layout, is a layout the user can
		// pick and not read, or read and not keep.
		it('has a name and a description for every layout, and no label without a layout', () => {
			for (const type of DELEGATION_LAYOUT_TYPES) {
				expect(DELEGATION_LAYOUT_LABELS[type].name).toBeTruthy();
				expect(DELEGATION_LAYOUT_LABELS[type].description).toBeTruthy();
			}
			expect(Object.keys(DELEGATION_LAYOUT_LABELS).sort()).toEqual(
				[...DELEGATION_LAYOUT_TYPES].sort()
			);
		});

		it('gives every layout a distinct name', () => {
			const names = DELEGATION_LAYOUT_TYPES.map((type) => DELEGATION_LAYOUT_LABELS[type].name);
			expect(new Set(names).size).toBe(names.length);
		});
	});

	describe('DELEGATION_ALGORITHM_LAYOUTS', () => {
		it('is every layout except manual, in the same order', () => {
			expect(DELEGATION_ALGORITHM_LAYOUTS).toEqual(
				DELEGATION_LAYOUT_TYPES.filter((type) => type !== 'manual')
			);
		});

		it('defaults to hierarchical, the first algorithm', () => {
			expect(DEFAULT_DELEGATION_LAYOUT).toBe('hierarchical');
			expect(DELEGATION_ALGORITHM_LAYOUTS[0]).toBe(DEFAULT_DELEGATION_LAYOUT);
		});
		it('uses Lobes as the global default only', () => {
			expect(DEFAULT_GLOBAL_DELEGATION_LAYOUT).toBe('lobes');
		});
	});

	describe('nextDelegationLayout', () => {
		it('advances through the algorithms in order', () => {
			expect(nextDelegationLayout('hierarchical')).toBe('force');
			expect(nextDelegationLayout('force')).toBe('radial');
		});

		it('wraps at the end of the list', () => {
			// Read the last entry rather than naming it, so adding a layout does
			// not turn this into a false failure about the wrap behaviour.
			const last = DELEGATION_ALGORITHM_LAYOUTS[DELEGATION_ALGORITHM_LAYOUTS.length - 1];
			expect(nextDelegationLayout(last)).toBe(DELEGATION_ALGORITHM_LAYOUTS[0]);
		});

		it('visits every algorithm exactly once per cycle', () => {
			const seen: DelegationLayoutType[] = [];
			let current: DelegationLayoutType = DELEGATION_ALGORITHM_LAYOUTS[0];
			for (let i = 0; i < DELEGATION_ALGORITHM_LAYOUTS.length; i++) {
				seen.push(current);
				current = nextDelegationLayout(current);
			}
			expect(new Set(seen).size).toBe(DELEGATION_ALGORITHM_LAYOUTS.length);
			expect(current).toBe(DELEGATION_ALGORITHM_LAYOUTS[0]);
		});

		// `manual` is entered by dragging a node. A cycle that could land on it
		// would select an arrangement that does not exist yet.
		it('never cycles into manual', () => {
			for (const type of DELEGATION_LAYOUT_TYPES) {
				expect(nextDelegationLayout(type)).not.toBe('manual');
			}
		});

		it('leaves manual for the first algorithm', () => {
			expect(nextDelegationLayout('manual')).toBe(DELEGATION_ALGORITHM_LAYOUTS[0]);
		});

		it('restarts the cycle from an unrecognized layout rather than sticking', () => {
			expect(nextDelegationLayout('nonsense' as DelegationLayoutType)).toBe(
				DELEGATION_ALGORITHM_LAYOUTS[0]
			);
		});
	});

	describe('isDelegationLayoutType', () => {
		it('accepts every listed layout, manual included', () => {
			for (const type of DELEGATION_LAYOUT_TYPES) {
				expect(isDelegationLayoutType(type)).toBe(true);
			}
		});

		// The Document Graph's own layout names must not pass: a value copied from
		// the wrong setting would reach a canvas that cannot draw it.
		it('rejects a layout this graph does not draw, and anything that is not a string', () => {
			for (const value of ['timeline', 'Hierarchical', '', null, undefined, 0]) {
				expect(isDelegationLayoutType(value)).toBe(false);
			}
		});
	});

	describe('isDelegationAlgorithmLayout', () => {
		it('is true for every layout except manual', () => {
			for (const type of DELEGATION_LAYOUT_TYPES) {
				expect(isDelegationAlgorithmLayout(type)).toBe(type !== 'manual');
			}
		});
	});

	// The settings validator imports this module for the union. An import here
	// would put the physics engine in every bundle that only needs the names.
	it('imports the shared layout vocabulary without importing the layout engine', () => {
		const source = readFileSync(
			resolve(
				__dirname,
				'../../../../renderer/components/DelegationGraph/delegationLayoutTypes.ts'
			),
			'utf8'
		);
		expect(source).toContain('../DocumentGraph/layoutTypes');
		expect(source).not.toContain('mindMapLayouts');
		expect(source).not.toMatch(/\brequire\(/);
	});
});
