import { describe, it, expect } from 'vitest';
import { pickPrimaryAgentSeed } from '../../shared/primaryAgent';

describe('pickPrimaryAgentSeed', () => {
	const live = new Set(['a', 'b']);

	it('takes the first candidate that names a live agent', () => {
		expect(pickPrimaryAgentSeed(['', 'gone', 'b', 'a'], live)).toBe('b');
	});

	it('returns null when no candidate names a live agent', () => {
		expect(pickPrimaryAgentSeed([null, undefined, '', 'gone', 7], live)).toBeNull();
	});
});
