/**
 * @file board-dispatcher.test.ts
 * @description Tests for the Board Phase 3 dispatcher. Covers the pure
 * promotion / WIP-cap / completion helpers and the full orchestrator lifecycle
 * with fakes for the spawn/completion path (no Electron, no filesystem):
 *   - a 3-card DAG (A, B, then C depending on both) drains in order under a WIP
 *     cap of 1;
 *   - a card emitting a block marker lands in `blocked` and does not unblock C;
 *   - the circuit breaker trips after two failures;
 *   - stale `running` cards are reclaimed.
 */

import { describe, it, expect } from 'vitest';
import {
	BoardDispatcher,
	promoteEligibleCards,
	claimReadyCards,
	claimReadyCardsPooled,
	computeBusyAgentIds,
	countRunning,
	reclaimStaleRunning,
	applyCardResult,
	type BoardDispatcherDeps,
	type CardAssignment,
	type CardSpawnResult,
} from '../../../main/board/board-dispatcher';
import type { Board, BoardCard, CardStatus } from '../../../shared/board/types';

const NOW = '2026-07-10T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function card(overrides: Partial<BoardCard> & { id: string }): BoardCard {
	return {
		title: `Card ${overrides.id}`,
		body: 'do the thing',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'todo' as CardStatus,
		createdAt: `2026-07-10T00:00:0${overrides.id.charCodeAt(0) % 9}.000Z`,
		updatedAt: NOW,
		...overrides,
	};
}

function board(cards: BoardCard[], maxInProgress?: number): Board {
	return { id: 'b1', name: 'Test board', cards, ...(maxInProgress ? { maxInProgress } : {}) };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Marker-emitting outputs the fake spawner can return. */
const completeMarker = (summary?: string): CardSpawnResult => ({
	output: `<!-- maestro:card-complete${summary ? ` | ${summary}` : ''} -->`,
	exitCode: 0,
});
const blockMarker = (reason: string): CardSpawnResult => ({
	output: `<!-- maestro:card-block: ${reason} -->`,
	exitCode: 0,
});
const failure = (): CardSpawnResult => ({ output: 'boom', exitCode: 1 });

/**
 * In-memory board store + fake spawner. `loadBoard` returns a fresh clone and
 * `saveBoard` replaces the canonical copy, mirroring the real file semantics so
 * aliasing bugs surface. `spawnScript` maps card id -> result.
 */
function harness(
	initial: Board,
	spawnScript: (cardId: string) => CardSpawnResult,
	extra?: Partial<BoardDispatcherDeps>
) {
	let canonical = clone(initial);
	const spawns: string[] = [];
	const deps: BoardDispatcherDeps = {
		loadBoard: () => clone(canonical),
		saveBoard: (b) => {
			canonical = clone(b);
		},
		resolveOverrides: () => ({}),
		spawn: async ({ card: c }) => {
			spawns.push(c.id);
			return spawnScript(c.id);
		},
		now: () => NOW,
		nowMs: () => NOW_MS,
		...extra,
	};
	const dispatcher = new BoardDispatcher(deps);
	return {
		dispatcher,
		spawns,
		get board() {
			return canonical;
		},
		status: (id: string) => canonical.cards.find((c) => c.id === id)?.status,
		cardById: (id: string) => canonical.cards.find((c) => c.id === id)!,
	};
}

describe('promoteEligibleCards', () => {
	it('promotes todo cards whose parents are all done', () => {
		const b = board([card({ id: 'a', status: 'done' }), card({ id: 'c', parents: ['a'] })]);
		const promoted = promoteEligibleCards(b, NOW);
		expect(promoted.map((c) => c.id)).toEqual(['c']);
		expect(b.cards.find((c) => c.id === 'c')?.status).toBe('ready');
	});

	it('does not promote a card with an unfinished parent', () => {
		const b = board([card({ id: 'a', status: 'running' }), card({ id: 'c', parents: ['a'] })]);
		expect(promoteEligibleCards(b, NOW)).toEqual([]);
	});
});

describe('claimReadyCards (WIP cap)', () => {
	it('claims up to the cap, marking cards running with an open run', () => {
		const b = board([
			card({ id: 'a', status: 'ready', createdAt: '2026-07-10T00:00:01.000Z' }),
			card({ id: 'b', status: 'ready', createdAt: '2026-07-10T00:00:02.000Z' }),
			card({ id: 'c', status: 'ready', createdAt: '2026-07-10T00:00:03.000Z' }),
		]);
		const claimed = claimReadyCards(b, 2, NOW);
		expect(claimed.map((c) => c.id)).toEqual(['a', 'b']);
		expect(countRunning(b)).toBe(2);
		expect(claimed[0].runs?.[0]).toMatchObject({ attempt: 1, startedAt: NOW });
	});

	it('counts already-running cards against the cap', () => {
		const b = board([card({ id: 'a', status: 'running' }), card({ id: 'b', status: 'ready' })]);
		expect(claimReadyCards(b, 1, NOW)).toEqual([]);
	});

	it('claims the oldest ready card first', () => {
		const b = board([
			card({ id: 'b', status: 'ready', createdAt: '2026-07-10T00:00:02.000Z' }),
			card({ id: 'a', status: 'ready', createdAt: '2026-07-10T00:00:01.000Z' }),
		]);
		expect(claimReadyCards(b, 1, NOW).map((c) => c.id)).toEqual(['a']);
	});
});

describe('applyCardResult', () => {
	function running(id: string): BoardCard {
		return card({ id, status: 'running', runs: [{ attempt: 1, startedAt: NOW }] });
	}

	it('moves to done on a complete marker and records the summary', () => {
		const b = board([running('a')]);
		expect(applyCardResult(b, 'a', completeMarker('shipped'), NOW, 2)).toBe('done');
		const c = b.cards[0];
		expect(c.status).toBe('done');
		expect(c.runs?.[0]).toMatchObject({ outcome: 'done', summary: 'shipped', endedAt: NOW });
	});

	it('moves to done on a clean exit with no marker', () => {
		const b = board([running('a')]);
		expect(applyCardResult(b, 'a', { output: 'no markers', exitCode: 0 }, NOW, 2)).toBe('done');
	});

	it('blocks immediately on a block marker regardless of the breaker', () => {
		const b = board([running('a')]);
		expect(applyCardResult(b, 'a', blockMarker('needs creds'), NOW, 2)).toBe('blocked');
		expect(b.cards[0].runs?.[0]).toMatchObject({ outcome: 'blocked', summary: 'needs creds' });
	});

	it('retries a failed run until the breaker trips', () => {
		const b = board([running('a')]);
		// First failure: below the limit -> back to ready for retry.
		expect(applyCardResult(b, 'a', failure(), NOW, 2)).toBe('ready');
		// Simulate the next claim opening a second run, then fail again.
		b.cards[0].status = 'running';
		b.cards[0].runs?.push({ attempt: 2, startedAt: NOW });
		expect(applyCardResult(b, 'a', failure(), NOW, 2)).toBe('blocked');
	});
});

describe('reclaimStaleRunning', () => {
	it('reclaims a running card with no live process past the threshold', () => {
		const b = board([
			card({
				id: 'a',
				status: 'running',
				runs: [{ attempt: 1, startedAt: '2026-07-10T00:00:00.000Z' }],
			}),
		]);
		const later = NOW_MS + 60 * 60 * 1000; // one hour later
		const reclaimed = reclaimStaleRunning(b, new Set(), 30 * 60 * 1000, later, NOW);
		expect(reclaimed.map((c) => c.id)).toEqual(['a']);
		expect(b.cards[0].status).toBe('ready');
		expect(b.cards[0].runs?.[0]).toMatchObject({ outcome: 'error' });
	});

	it('does not reclaim a card that is still live (in flight)', () => {
		const b = board([card({ id: 'a', status: 'running', runs: [{ attempt: 1, startedAt: NOW }] })]);
		const later = NOW_MS + 60 * 60 * 1000;
		expect(reclaimStaleRunning(b, new Set(['a']), 30 * 60 * 1000, later, NOW)).toEqual([]);
		expect(b.cards[0].status).toBe('running');
	});
});

describe('BoardDispatcher lifecycle', () => {
	it('drains a 3-card DAG (A, B, then C) in order under a WIP cap of 1', async () => {
		const initial = board(
			[
				card({ id: 'a', createdAt: '2026-07-10T00:00:01.000Z' }),
				card({ id: 'b', createdAt: '2026-07-10T00:00:02.000Z' }),
				card({ id: 'c', parents: ['a', 'b'], createdAt: '2026-07-10T00:00:03.000Z' }),
			],
			1
		);
		const h = harness(initial, () => completeMarker());

		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('done');
		expect(h.status('b')).toBe('ready'); // promoted but not yet claimed (cap 1)
		expect(h.status('c')).toBe('todo');

		h.dispatcher.tick();
		await flush();
		expect(h.status('b')).toBe('done');
		expect(h.status('c')).toBe('todo'); // C not eligible until this tick's promote

		h.dispatcher.tick();
		await flush();
		expect(h.status('c')).toBe('done');

		expect(h.spawns).toEqual(['a', 'b', 'c']);
	});

	it('lands a block-marker card in blocked and never unblocks its child', async () => {
		const initial = board(
			[
				card({ id: 'a', createdAt: '2026-07-10T00:00:01.000Z' }),
				card({ id: 'b', createdAt: '2026-07-10T00:00:02.000Z' }),
				card({ id: 'c', parents: ['a', 'b'], createdAt: '2026-07-10T00:00:03.000Z' }),
			],
			2
		);
		const h = harness(initial, (id) =>
			id === 'b' ? blockMarker('cannot proceed') : completeMarker()
		);

		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('done');
		expect(h.status('b')).toBe('blocked');

		// A second tick must not promote/spawn C - one parent is blocked.
		h.dispatcher.tick();
		await flush();
		expect(h.status('c')).toBe('todo');
		expect(h.spawns).toEqual(['a', 'b']);
	});

	it('trips the circuit breaker after two consecutive failures', async () => {
		const initial = board([card({ id: 'a' })], 1);
		const h = harness(initial, () => failure());

		h.dispatcher.tick(); // attempt 1
		await flush();
		expect(h.status('a')).toBe('ready'); // retried, not yet blocked

		h.dispatcher.tick(); // attempt 2
		await flush();
		expect(h.status('a')).toBe('blocked');
		expect(h.cardById('a').runs?.length).toBe(2);
	});

	it('blocks a card whose assignee profile cannot be resolved', async () => {
		const initial = board([card({ id: 'a' })], 1);
		const h = harness(initial, () => completeMarker(), { resolveOverrides: () => null });

		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('blocked');
		expect(h.spawns).toEqual([]); // never spawned
	});
});

// ─── Board Phase 6: worker pool ──────────────────────────────────────────────

describe('computeBusyAgentIds', () => {
	it('collects workerAgentId from running cards only', () => {
		const b = board([
			card({
				id: 'a',
				status: 'running',
				runs: [{ attempt: 1, startedAt: NOW, workerAgentId: 'w1' }],
			}),
			card({ id: 'b', status: 'ready' }),
			card({
				id: 'c',
				status: 'done',
				runs: [{ attempt: 1, startedAt: NOW, workerAgentId: 'w2' }],
			}),
		]);
		expect([...computeBusyAgentIds(b)]).toEqual(['w1']);
	});
});

describe('claimReadyCardsPooled', () => {
	/** Assign every card to the first free worker in `pool`, else no-free-worker. */
	function poolAssign(pool: string[]) {
		return (_card: BoardCard, busy: ReadonlySet<string>): CardAssignment => {
			const free = pool.find((id) => !busy.has(id));
			return free ? { kind: 'assigned', agentId: free, overrides: {} } : { kind: 'no-free-worker' };
		};
	}

	it('runs at most one card per worker (2 ready cards, 1 worker)', () => {
		const b = board([
			card({ id: 'a', status: 'ready', createdAt: '2026-07-10T00:00:01.000Z' }),
			card({ id: 'b', status: 'ready', createdAt: '2026-07-10T00:00:02.000Z' }),
		]);
		const { claimed } = claimReadyCardsPooled(b, 5, NOW, poolAssign(['w1']));
		expect(claimed.map((c) => c.card.id)).toEqual(['a']);
		expect(claimed[0].agentId).toBe('w1');
		expect(b.cards.find((c) => c.id === 'a')?.status).toBe('running');
		// The second card is left ready (all workers busy) - not claimed, not blocked.
		expect(b.cards.find((c) => c.id === 'b')?.status).toBe('ready');
	});

	it('spreads cards across free workers and stamps workerAgentId', () => {
		const b = board([
			card({ id: 'a', status: 'ready', createdAt: '2026-07-10T00:00:01.000Z' }),
			card({ id: 'b', status: 'ready', createdAt: '2026-07-10T00:00:02.000Z' }),
		]);
		const { claimed } = claimReadyCardsPooled(b, 5, NOW, poolAssign(['w1', 'w2']));
		expect(claimed.map((c) => c.agentId)).toEqual(['w1', 'w2']);
		expect(b.cards[0].runs?.[0].workerAgentId).toBe('w1');
		expect(b.cards[1].runs?.[0].workerAgentId).toBe('w2');
	});

	it('leaves cards ready when the pool is empty (does not block or wait-hold)', () => {
		const b = board([card({ id: 'a', status: 'ready' })]);
		const { claimed, unresolvable } = claimReadyCardsPooled(b, 5, NOW, poolAssign([]));
		expect(claimed).toEqual([]);
		expect(unresolvable).toEqual([]);
		expect(b.cards[0].status).toBe('ready');
	});

	it('collects unresolvable cards without marking them running', () => {
		const b = board([card({ id: 'a', status: 'ready' })]);
		const { claimed, unresolvable } = claimReadyCardsPooled(b, 5, NOW, () => ({
			kind: 'unresolvable',
			reason: 'no such profile',
		}));
		expect(claimed).toEqual([]);
		expect(unresolvable.map((u) => u.card.id)).toEqual(['a']);
		expect(b.cards[0].status).toBe('ready'); // caller blocks it, not the claim
	});

	it('honors the WIP cap across the pool', () => {
		const b = board([
			card({ id: 'a', status: 'ready', createdAt: '2026-07-10T00:00:01.000Z' }),
			card({ id: 'b', status: 'ready', createdAt: '2026-07-10T00:00:02.000Z' }),
			card({ id: 'c', status: 'ready', createdAt: '2026-07-10T00:00:03.000Z' }),
		]);
		const { claimed } = claimReadyCardsPooled(b, 2, NOW, poolAssign(['w1', 'w2', 'w3']));
		expect(claimed.map((c) => c.card.id)).toEqual(['a', 'b']);
	});
});

describe('BoardDispatcher pool lifecycle', () => {
	/** Harness whose `assign` binds cards to free workers from a fixed pool. */
	function poolHarness(
		initial: Board,
		pool: string[],
		spawnScript: (id: string) => CardSpawnResult
	) {
		return harness(initial, spawnScript, {
			assign: (_card, busy) => {
				const free = pool.find((id) => !busy.has(id));
				return free
					? { kind: 'assigned', agentId: free, overrides: {} }
					: { kind: 'no-free-worker' };
			},
		});
	}

	it('runs two independent cards concurrently across two workers', async () => {
		const initial = board(
			[
				card({ id: 'a', createdAt: '2026-07-10T00:00:01.000Z' }),
				card({ id: 'b', createdAt: '2026-07-10T00:00:02.000Z' }),
			],
			5
		);
		const h = poolHarness(initial, ['w1', 'w2'], () => completeMarker());
		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('done');
		expect(h.status('b')).toBe('done');
		expect(h.spawns.sort()).toEqual(['a', 'b']);
	});

	it('serializes two cards onto a single worker across ticks', async () => {
		const initial = board(
			[
				card({ id: 'a', createdAt: '2026-07-10T00:00:01.000Z' }),
				card({ id: 'b', createdAt: '2026-07-10T00:00:02.000Z' }),
			],
			5
		);
		const h = poolHarness(initial, ['w1'], () => completeMarker());
		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('done');
		// b waited (only worker was busy), picked up next tick once w1 freed.
		expect(h.status('b')).toBe('ready');

		h.dispatcher.tick();
		await flush();
		expect(h.status('b')).toBe('done');
		expect(h.spawns).toEqual(['a', 'b']);
	});

	it('blocks an unresolvable card and never spawns it', async () => {
		const initial = board([card({ id: 'a' })], 5);
		const h = harness(initial, () => completeMarker(), {
			assign: () => ({ kind: 'unresolvable', reason: 'gone' }),
		});
		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('blocked');
		expect(h.spawns).toEqual([]);
	});
});
