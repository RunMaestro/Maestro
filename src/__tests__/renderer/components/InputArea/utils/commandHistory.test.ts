import { describe, expect, it } from 'vitest';
import {
	filterCommandHistory,
	getCurrentCommandHistory,
} from '../../../../../renderer/components/InputArea/utils/commandHistory';
import { createInputAreaSession } from '../_fixtures';

describe('InputArea commandHistory utils', () => {
	it('prefers shell history in terminal mode', () => {
		const session = createInputAreaSession({
			shellCommandHistory: ['ls -la'],
			aiCommandHistory: ['explain code'],
			commandHistory: ['legacy'],
		} as any);

		expect(getCurrentCommandHistory(session, true)).toEqual(['ls -la']);
	});

	it('falls back to legacy history in terminal mode', () => {
		const session = createInputAreaSession({
			shellCommandHistory: [],
			commandHistory: ['legacy shell'],
		} as any);

		expect(getCurrentCommandHistory(session, true)).toEqual(['legacy shell']);
	});

	it('prefers AI history in AI mode', () => {
		const session = createInputAreaSession({
			aiCommandHistory: ['summarize this'],
			commandHistory: ['legacy'],
		} as any);

		expect(getCurrentCommandHistory(session, false)).toEqual(['summarize this']);
	});

	it('dedupes, filters case-insensitively, reverses, and caps at 10', () => {
		const history = [
			'alpha 1',
			'beta',
			'alpha 1',
			'alpha 2',
			'alpha 3',
			'alpha 4',
			'alpha 5',
			'alpha 6',
			'alpha 7',
			'alpha 8',
			'alpha 9',
			'alpha 10',
			'alpha 11',
		];

		expect(filterCommandHistory(history, 'ALPHA')).toEqual([
			'alpha 11',
			'alpha 10',
			'alpha 9',
			'alpha 8',
			'alpha 7',
			'alpha 6',
			'alpha 5',
			'alpha 4',
			'alpha 3',
			'alpha 2',
		]);
	});
});
