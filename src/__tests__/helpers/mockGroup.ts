import type { Group } from '../../renderer/types';

/**
 * Shared deterministic factory for the four-field `Group` contract.
 *
 * Each call returns a new object so per-test overrides and mutations cannot
 * leak between test cases. The Group shape currently contains no nested
 * mutable fields; if that changes, this factory must create fresh nested
 * objects and collections too.
 */
export function createMockGroup(overrides: Partial<Group> = {}): Group {
	return {
		id: 'group-1',
		name: 'Test Group',
		emoji: '📁',
		collapsed: false,
		...overrides,
	};
}
