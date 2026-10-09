import { describe, it, expect, beforeEach } from 'vitest';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';

describe('CoworkingRegistry', () => {
	let registry: CoworkingRegistry;

	beforeEach(() => {
		registry = new CoworkingRegistry();
	});

	function rec(id: string, tabUuid: string, sessionId: string, cwd = '/tmp', title = 'Terminal') {
		return { id, tabUuid, sessionId, cwd, title };
	}

	it('returns an empty list for a session with no records', () => {
		expect(registry.listForSession('sess-1')).toEqual([]);
	});

	it('lists terminals scoped to the requested sessionId only', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-b', 'sess-2'));
		expect(registry.listForSession('sess-1')).toEqual([
			{ id: 'term:1', cwd: '/tmp', title: 'Terminal' },
		]);
		expect(registry.listForSession('sess-2')).toEqual([
			{ id: 'term:1', cwd: '/tmp', title: 'Terminal' },
		]);
	});

	it('does NOT leak records across sessions (privacy regression test for PR #948 blocker)', () => {
		// Session A has term:3 only; session B has term:1 only. Asking for either
		// session must never include the other's records, regardless of insertion order.
		registry.upsertTerminal(rec('term:3', 'uuid-a3', 'sess-A', '/a', 'A-Term-3'));
		registry.upsertTerminal(rec('term:1', 'uuid-b1', 'sess-B', '/b', 'B-Term-1'));
		expect(registry.listForSession('sess-A')).toEqual([
			{ id: 'term:3', cwd: '/a', title: 'A-Term-3' },
		]);
		expect(registry.listForSession('sess-B')).toEqual([
			{ id: 'term:1', cwd: '/b', title: 'B-Term-1' },
		]);
		expect(registry.resolveTabUuidForSession('sess-A', 'term:1')).toBeNull();
		expect(registry.resolveTabUuidForSession('sess-B', 'term:3')).toBeNull();
	});

	it('sorts entries by numeric coworkingId', () => {
		registry.upsertTerminal(rec('term:10', 'uuid-c', 'sess-1'));
		registry.upsertTerminal(rec('term:2', 'uuid-d', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		expect(registry.listForSession('sess-1').map((e) => e.id)).toEqual([
			'term:1',
			'term:2',
			'term:10',
		]);
	});

	it('resolveTabUuidForSession resolves only within the requested session', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-b', 'sess-2'));
		expect(registry.resolveTabUuidForSession('sess-1', 'term:1')).toBe('uuid-a');
		expect(registry.resolveTabUuidForSession('sess-2', 'term:1')).toBe('uuid-b');
		expect(registry.resolveTabUuidForSession('sess-3', 'term:1')).toBeNull();
	});

	it('removeTerminal drops the record', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		expect(registry.listForSession('sess-1')).toHaveLength(1);
		registry.removeTerminal('uuid-a');
		expect(registry.listForSession('sess-1')).toHaveLength(0);
	});

	it('syncSessionTerminals replaces only the targeted session', () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-x', 'sess-2'));
		registry.syncSessionTerminals('sess-1', [
			rec('term:2', 'uuid-b', 'sess-1', '/home', 'Alpha'),
			rec('term:3', 'uuid-c', 'sess-1', '/home', 'Beta'),
		]);
		expect(registry.listForSession('sess-1').map((e) => e.id)).toEqual(['term:2', 'term:3']);
		expect(registry.listForSession('sess-2').map((e) => e.id)).toEqual(['term:1']);
	});

	it("removeSession clears all of a session's terminals", () => {
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.upsertTerminal(rec('term:2', 'uuid-b', 'sess-1'));
		registry.upsertTerminal(rec('term:1', 'uuid-c', 'sess-2'));
		registry.removeSession('sess-1');
		expect(registry.listForSession('sess-2')).toHaveLength(1);
		expect(registry.listForSession('sess-1')).toHaveLength(0);
	});

	it('onChange fires on mutations and unsubscribe stops it', () => {
		let calls = 0;
		const off = registry.onChange(() => {
			calls += 1;
		});
		registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
		registry.removeTerminal('uuid-a');
		expect(calls).toBe(2);
		off();
		registry.upsertTerminal(rec('term:2', 'uuid-b', 'sess-1'));
		expect(calls).toBe(2);
	});
});
