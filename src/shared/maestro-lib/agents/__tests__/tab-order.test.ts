import { describe, expect, it } from 'vitest';
import { reconcileTabOrder } from '../tab-order';

const ai = (id: string) => ({ type: 'ai', id });
const file = (id: string) => ({ type: 'file', id });
const terminal = (id: string) => ({ type: 'terminal', id });

describe('reconcileTabOrder', () => {
	it("keeps the authority's order", () => {
		expect(reconcileTabOrder([ai('b'), ai('a')], [ai('a'), ai('b')])).toEqual([ai('b'), ai('a')]);
	});

	it('drops AI refs the authority lacks', () => {
		expect(reconcileTabOrder([ai('a')], [ai('a'), ai('gone')])).toEqual([ai('a')]);
	});

	it('adds a local non-AI ref after its local predecessor', () => {
		const result = reconcileTabOrder(
			[ai('a'), ai('b')],
			[ai('a'), file('f'), ai('b'), terminal('t')]
		);
		expect(result).toEqual([ai('a'), file('f'), ai('b'), terminal('t')]);
	});

	it('puts a non-AI ref first when it had no predecessor the result holds', () => {
		expect(reconcileTabOrder([ai('a')], [file('f'), ai('a')])).toEqual([file('f'), ai('a')]);
		// A predecessor that was itself dropped does not count.
		expect(reconcileTabOrder([ai('a')], [ai('gone'), file('f'), ai('a')])).toEqual([
			file('f'),
			ai('a'),
		]);
	});

	it('chains non-AI refs through each other', () => {
		expect(reconcileTabOrder([ai('a')], [ai('a'), file('f1'), file('f2')])).toEqual([
			ai('a'),
			file('f1'),
			file('f2'),
		]);
	});

	it('does not duplicate a non-AI ref the authority already holds', () => {
		expect(reconcileTabOrder([ai('a'), file('f')], [file('f'), ai('a')])).toEqual([
			ai('a'),
			file('f'),
		]);
	});

	it('returns the local order when there is no authority', () => {
		const local = [ai('a'), file('f')];
		const result = reconcileTabOrder(undefined, local);
		expect(result).toEqual(local);
		expect(result).not.toBe(local);
	});

	it('returns the authority when there is no local order', () => {
		expect(reconcileTabOrder([ai('a')], undefined)).toEqual([ai('a')]);
		expect(reconcileTabOrder([], [])).toEqual([]);
	});
});
