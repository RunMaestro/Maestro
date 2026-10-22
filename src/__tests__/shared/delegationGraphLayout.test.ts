import { describe, it, expect } from 'vitest';
import {
	DELEGATION_GRAPH_LAYOUTS_SETTING,
	mergeSavedPositions,
	parseSavedPositions,
	parseScopeStorageKey,
	prunePositions,
	scopeStorageKey,
	type DelegationSavedPositions,
} from '../../shared/delegationGraphLayout';
import type { DelegationGraphScope } from '../../shared/delegationGraph';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';
import { SETTINGS_DEFAULTS } from '../../main/stores/defaults';

function node(id: string, x = 0, y = 0) {
	return { id, position: { x, y }, data: { label: id } };
}

describe('delegationGraphLayout', () => {
	describe('the settings key', () => {
		it('names a key the settings registry knows, as a sparse object', () => {
			const meta = SETTINGS_METADATA[DELEGATION_GRAPH_LAYOUTS_SETTING];
			expect(meta).toBeDefined();
			expect(meta.type).toBe('object');
			expect(meta.default).toEqual({});
		});

		it('has the same default in the main store', () => {
			expect(SETTINGS_DEFAULTS[DELEGATION_GRAPH_LAYOUTS_SETTING]).toEqual({});
		});
	});

	describe('scopeStorageKey', () => {
		it("stores the whole fleet under 'all'", () => {
			expect(scopeStorageKey({ kind: 'all' })).toBe('all');
		});

		it('stores a group under group:<groupId>', () => {
			expect(scopeStorageKey({ kind: 'group', groupId: 'g-1' })).toBe('group:g-1');
		});
		it('stores a cluster separately from a group with the same id', () => {
			expect(scopeStorageKey({ kind: 'agent', sessionId: 'g-1' })).toBe('agent:g-1');
		});

		// The whole point of a per-scope key: one agent sits in two graphs at two
		// places, so no two scopes may share a key.
		it('gives every scope its own key', () => {
			const keys = [
				scopeStorageKey({ kind: 'all' }),
				scopeStorageKey({ kind: 'group', groupId: 'all' }),
				scopeStorageKey({ kind: 'group', groupId: 'g-1' }),
				scopeStorageKey({ kind: 'group', groupId: 'g-2' }),
			];
			expect(new Set(keys).size).toBe(keys.length);
		});
	});

	describe('parseScopeStorageKey', () => {
		it('is the inverse of scopeStorageKey', () => {
			const scopes: DelegationGraphScope[] = [
				{ kind: 'all' },
				{ kind: 'group', groupId: 'g-1' },
				{ kind: 'group', groupId: 'all' },
				{ kind: 'group', groupId: 'has:a:colon' },
				{ kind: 'agent', sessionId: 'a' },
				{ kind: 'agent', sessionId: 'has:a:colon' },
			];
			for (const scope of scopes) {
				expect(parseScopeStorageKey(scopeStorageKey(scope))).toEqual(scope);
			}
		});

		it('refuses a key scopeStorageKey could not have written', () => {
			expect(parseScopeStorageKey('')).toBeNull();
			expect(parseScopeStorageKey('group:')).toBeNull();
			expect(parseScopeStorageKey('agent:')).toBeNull();
			expect(parseScopeStorageKey('ALL')).toBeNull();
			expect(parseScopeStorageKey('worktree:w-1')).toBeNull();
			expect(parseScopeStorageKey('g-1')).toBeNull();
		});
	});

	describe('parseSavedPositions', () => {
		it('keeps a pair of finite numbers, and only x and y', () => {
			expect(
				parseSavedPositions({ a: { x: 10, y: -20.5 }, b: { x: 0, y: 0, width: 240, extra: true } })
			).toEqual({ a: { x: 10, y: -20.5 }, b: { x: 0, y: 0 } });
		});

		// A force layout that diverges produces NaN. JSON would write it as null,
		// so the state in memory and the state on disk would stop agreeing.
		it('drops a coordinate that is not a finite number', () => {
			expect(
				parseSavedPositions({
					nan: { x: NaN, y: 1 },
					infinite: { x: 1, y: Infinity },
					text: { x: '10', y: 20 },
					nulled: { x: null, y: 20 },
					partial: { x: 10 },
					empty: {},
					missing: null,
					scalar: 7,
					ok: { x: 1, y: 2 },
				})
			).toEqual({ ok: { x: 1, y: 2 } });
		});

		it('reads anything that is not an object as nothing saved', () => {
			expect(parseSavedPositions(undefined)).toEqual({});
			expect(parseSavedPositions(null)).toEqual({});
			expect(parseSavedPositions('positions')).toEqual({});
			expect(parseSavedPositions(42)).toEqual({});
			expect(parseSavedPositions([{ x: 1, y: 2 }])).toEqual({});
		});

		it('does not hand back the object it was given', () => {
			const raw = { a: { x: 1, y: 2 } };
			const parsed = parseSavedPositions(raw);
			expect(parsed.a).not.toBe(raw.a);
		});
	});

	describe('mergeSavedPositions', () => {
		it('puts a node with a saved position where the user left it', () => {
			const { placed, unplaced } = mergeSavedPositions([node('a')], { a: { x: 120, y: 340 } });
			expect(placed).toEqual([{ id: 'a', position: { x: 120, y: 340 }, data: { label: 'a' } }]);
			expect(unplaced).toEqual([]);
		});

		// The saved position wins over whatever the node arrived with, including a
		// position an algorithm just computed.
		it('lets the saved position win over the one the node came in with', () => {
			const { placed } = mergeSavedPositions([node('a', 999, 999)], { a: { x: 1, y: 2 } });
			expect(placed[0].position).toEqual({ x: 1, y: 2 });
		});

		// A node with no saved position must be reported, not passed off as placed:
		// the origin it usually arrives with would be read as a real position, and
		// every new agent would stack up at {0,0}.
		it('reports a node with no saved position as unplaced, untouched', () => {
			const fresh = node('new');
			const { placed, unplaced } = mergeSavedPositions([node('a'), fresh], {
				a: { x: 5, y: 5 },
			});
			expect(placed.map((n) => n.id)).toEqual(['a']);
			expect(unplaced).toEqual([fresh]);
			expect(unplaced[0]).toBe(fresh);
		});

		it('keeps the order of the nodes in each list', () => {
			const saved = { b: { x: 1, y: 1 }, d: { x: 2, y: 2 } };
			const { placed, unplaced } = mergeSavedPositions(
				[node('a'), node('b'), node('c'), node('d')],
				saved
			);
			expect(placed.map((n) => n.id)).toEqual(['b', 'd']);
			expect(unplaced.map((n) => n.id)).toEqual(['a', 'c']);
		});

		it('treats every node as unplaced when nothing is saved', () => {
			const { placed, unplaced } = mergeSavedPositions([node('a'), node('b')], {});
			expect(placed).toEqual([]);
			expect(unplaced.map((n) => n.id)).toEqual(['a', 'b']);
		});

		it('ignores a saved position for an agent that is not on the canvas', () => {
			const { placed, unplaced } = mergeSavedPositions([node('a')], {
				a: { x: 1, y: 1 },
				gone: { x: 9, y: 9 },
			});
			expect(placed.map((n) => n.id)).toEqual(['a']);
			expect(unplaced).toEqual([]);
		});

		it('changes neither the nodes nor the saved positions it was given', () => {
			const original = node('a', 7, 7);
			const saved = { a: { x: 1, y: 2 } };
			const { placed } = mergeSavedPositions([original], saved);

			expect(original.position).toEqual({ x: 7, y: 7 });
			placed[0].position.x = 500;
			expect(saved.a).toEqual({ x: 1, y: 2 });
		});

		// An agent id is data. One that happens to spell a property every object
		// inherits must not be answered by that property.
		it('does not read an inherited property as a saved position', () => {
			const { placed, unplaced } = mergeSavedPositions([node('constructor'), node('toString')], {});
			expect(placed).toEqual([]);
			expect(unplaced.map((n) => n.id)).toEqual(['constructor', 'toString']);
		});
	});

	describe('prunePositions', () => {
		const saved: DelegationSavedPositions = {
			a: { x: 1, y: 1 },
			deleted: { x: 2, y: 2 },
			b: { x: 3, y: 3 },
		};

		it('drops the coordinates of a deleted agent', () => {
			expect(prunePositions(saved, ['a', 'b'])).toEqual({ a: { x: 1, y: 1 }, b: { x: 3, y: 3 } });
		});

		// "Live" means the agent exists, not that it is drawn. A spill agent whose
		// edge was removed is alive and off the canvas; it keeps its place.
		it('keeps an agent that is alive but not on the canvas', () => {
			const pruned = prunePositions(saved, ['a', 'b', 'deleted', 'never-placed']);
			expect(pruned).toEqual(saved);
		});

		it('returns the same object when nothing was dropped', () => {
			expect(prunePositions(saved, ['a', 'b', 'deleted'])).toBe(saved);
		});

		it('returns a new object when something was dropped, and leaves the input alone', () => {
			const pruned = prunePositions(saved, ['a']);
			expect(pruned).not.toBe(saved);
			expect(pruned).toEqual({ a: { x: 1, y: 1 } });
			expect(Object.keys(saved)).toEqual(['a', 'deleted', 'b']);
		});

		it('accepts a Set, an array, or any other iterable of live ids', () => {
			const expected = { a: { x: 1, y: 1 } };
			expect(prunePositions(saved, new Set(['a']))).toEqual(expected);
			expect(prunePositions(saved, ['a'])).toEqual(expected);
			expect(prunePositions(saved, new Map([['a', true]]).keys())).toEqual(expected);
		});

		it('drops everything when no agent is left', () => {
			expect(prunePositions(saved, [])).toEqual({});
		});

		it('has nothing to do with nothing saved', () => {
			const empty: DelegationSavedPositions = {};
			expect(prunePositions(empty, ['a'])).toBe(empty);
		});
	});
});
