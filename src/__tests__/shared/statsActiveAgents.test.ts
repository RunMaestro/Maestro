/**
 * Tests for the Usage Dashboard's "active in range" accounting.
 *
 * "Active" is a RANGE question, not a live-status one: an agent counts when it
 * recorded at least one query event inside the dashboard's selected range. The
 * failure this replaces is answering it with a per-card query count that falls
 * back to the PROVIDER total, which marks an agent that ran nothing as active
 * because a sibling on the same provider did.
 */

import { describe, it, expect } from 'vitest';
import {
	isAgentActiveInRange,
	countActiveAgents,
	type BySessionByDay,
} from '../../shared/statsActiveAgents';

/** `bySessionByDay` slice: session id -> per-day rows carrying a count. */
const aggregation = (byId: Record<string, number[]>): BySessionByDay =>
	Object.fromEntries(
		Object.entries(byId).map(([id, counts]) => [
			id,
			counts.map((count, i) => ({ date: `2026-01-0${i + 1}`, count })),
		])
	) as BySessionByDay;

describe('isAgentActiveInRange', () => {
	it('is true for an agent with queries in the range', () => {
		expect(isAgentActiveInRange('a', aggregation({ a: [0, 3] }))).toBe(true);
	});

	it('is false for an agent absent from the aggregation', () => {
		expect(isAgentActiveInRange('missing', aggregation({ a: [3] }))).toBe(false);
	});

	it('is false for an agent present with only zeroed days', () => {
		// Presence alone would nearly always be enough; the count sum guards
		// against a future aggregation emitting an empty or zeroed day series.
		expect(isAgentActiveInRange('a', aggregation({ a: [0, 0] }))).toBe(false);
	});

	it('is false for an empty day series', () => {
		expect(isAgentActiveInRange('a', aggregation({ a: [] }))).toBe(false);
	});

	it('is false when there is no aggregation at all', () => {
		expect(isAgentActiveInRange('a', undefined)).toBe(false);
	});
});

describe('countActiveAgents', () => {
	it('counts only the agents that recorded work themselves', () => {
		const agents = [{ id: 'busy' }, { id: 'idle' }, { id: 'never-ran' }];
		const data = aggregation({ busy: [5], idle: [0] });

		// `never-ran` shares a provider with `busy` in the real dashboard; that
		// must not lend it activity it did not have.
		expect(countActiveAgents(agents, data)).toBe(1);
	});

	it('is zero for an empty fleet', () => {
		expect(countActiveAgents([], aggregation({ a: [9] }))).toBe(0);
	});

	it('is zero when no aggregation has loaded yet', () => {
		expect(countActiveAgents([{ id: 'a' }], undefined)).toBe(0);
	});
});
