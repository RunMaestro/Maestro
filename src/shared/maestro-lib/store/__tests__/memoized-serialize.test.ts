import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeStoreDocument } from '../io';
import { serializeWithMemoizedArray } from '../memoized-serialize';

const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: `Agent ${id}`,
	toolType: 'claude-code',
	aiTabs: [{ id: `${id}-t1`, logs: [{ id: 'l1', text: 'hello\nworld', source: 'user' }] }],
	rcOnlyField: { nested: [1, { deep: true }] },
	...extra,
});

/** A sessions document the way conf writes one, with keys on both sides of the array. */
const sessionsDocument = () => ({
	zebraKey: { nested: [1, 2] },
	sessions: [agent('a1'), { weird: 'entry' }, agent('a2')],
	activeSessionId: 'a1',
	omitted: undefined,
});

describe('serializeWithMemoizedArray', () => {
	afterEach(() => vi.restoreAllMocks());

	it('is byte for byte conf format for a sessions document', () => {
		const doc = sessionsDocument();
		expect(serializeWithMemoizedArray(doc, 'sessions')).toBe(confText(doc));
	});

	it('matches for an empty list, a missing list, and a non-document', () => {
		expect(serializeWithMemoizedArray({ sessions: [] }, 'sessions')).toBe(
			confText({ sessions: [] })
		);
		expect(serializeWithMemoizedArray({ other: 1 }, 'sessions')).toBe(confText({ other: 1 }));
		expect(serializeWithMemoizedArray([1, 2], 'sessions')).toBe(confText([1, 2]));
	});

	it('does not re-serialize an element that did not change', () => {
		const doc = sessionsDocument();
		serializeWithMemoizedArray(doc, 'sessions');

		const spy = vi.spyOn(JSON, 'stringify');
		const again = serializeWithMemoizedArray(doc, 'sessions');
		expect(again).toBe(confText(doc));

		// The elements of the array are never stringified again; only the keys around it are.
		const stringifiedAgents = spy.mock.calls.filter(
			([value]) => typeof value === 'object' && value !== null && 'toolType' in value
		);
		expect(stringifiedAgents).toHaveLength(0);
	});

	it('re-serializes only the element that was replaced by a new object', () => {
		const doc = sessionsDocument();
		serializeWithMemoizedArray(doc, 'sessions');
		const renamed = { ...(doc.sessions[0] as ReturnType<typeof agent>), name: 'Renamed' };
		const next = { ...doc, sessions: [renamed, doc.sessions[1], doc.sessions[2]] };

		const spy = vi.spyOn(JSON, 'stringify');
		const text = serializeWithMemoizedArray(next, 'sessions');
		expect(text).toBe(confText(next));
		const stringifiedAgents = spy.mock.calls.filter(
			([value]) => typeof value === 'object' && value !== null && 'toolType' in value
		);
		expect(stringifiedAgents).toHaveLength(1);
		expect(stringifiedAgents[0][0]).toBe(renamed);
	});
});

describe('serializeStoreDocument with a memo key', () => {
	it('writes the same text with and without it', () => {
		const doc = sessionsDocument();
		expect(serializeStoreDocument(doc, 'sessions')).toBe(serializeStoreDocument(doc));
		expect(serializeStoreDocument(doc, 'sessions')).toBe(confText(doc));
	});

	it('still refuses a payload that cannot be written', () => {
		expect(() => serializeStoreDocument(undefined, 'sessions')).toThrow();
	});
});
