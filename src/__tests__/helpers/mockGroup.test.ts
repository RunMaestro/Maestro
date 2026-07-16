import { describe, expect, it } from 'vitest';
import { createMockGroup } from './mockGroup';

describe('createMockGroup', () => {
	it('returns deterministic four-field defaults', () => {
		expect(createMockGroup()).toEqual({
			id: 'group-1',
			name: 'Test Group',
			emoji: '📁',
			collapsed: false,
		});
	});

	it('applies overrides without changing defaults', () => {
		expect(createMockGroup({ id: 'group-2', name: 'Build', collapsed: true })).toEqual({
			id: 'group-2',
			name: 'Build',
			emoji: '📁',
			collapsed: true,
		});
	});

	it('returns a fresh object for every call', () => {
		const first = createMockGroup();
		const second = createMockGroup();

		expect(first).not.toBe(second);
		first.name = 'Mutated';
		expect(second.name).toBe('Test Group');
	});
});
