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
	type CardNotification,
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

	it('claims by priority first, oldest-first within a priority', () => {
		const b = board([
			card({
				id: 'oldLow',
				status: 'ready',
				priority: 'low',
				createdAt: '2026-07-10T00:00:01.000Z',
			}),
			card({ id: 'oldNormal', status: 'ready', createdAt: '2026-07-10T00:00:02.000Z' }),
			card({
				id: 'newHigh',
				status: 'ready',
				priority: 'high',
				createdAt: '2026-07-10T00:00:04.000Z',
			}),
			card({
				id: 'oldHigh',
				status: 'ready',
				priority: 'high',
				createdAt: '2026-07-10T00:00:03.000Z',
			}),
		]);
		expect(claimReadyCards(b, 4, NOW).map((c) => c.id)).toEqual([
			'oldHigh',
			'newHigh',
			'oldNormal',
			'oldLow',
		]);
	});

	it('treats an absent priority as normal', () => {
		const b = board([
			card({ id: 'low', status: 'ready', priority: 'low', createdAt: '2026-07-10T00:00:01.000Z' }),
			card({ id: 'plain', status: 'ready', createdAt: '2026-07-10T00:00:09.000Z' }),
		]);
		expect(claimReadyCards(b, 1, NOW).map((c) => c.id)).toEqual(['plain']);
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

	it('does NOT count reclaimed runs toward the breaker (engine restarts are not failures)', () => {
		// Two engine restarts mid-run used to record two `error` runs and
		// force-block a card that had never actually failed.
		const b = board([
			card({
				id: 'a',
				status: 'running',
				runs: [
					{ attempt: 1, startedAt: NOW, endedAt: NOW, outcome: 'reclaimed' },
					{ attempt: 2, startedAt: NOW, endedAt: NOW, outcome: 'reclaimed' },
					{ attempt: 3, startedAt: NOW },
				],
			}),
		]);
		// The third attempt is this card's FIRST real failure, so it retries.
		expect(applyCardResult(b, 'a', failure(), NOW, 2)).toBe('ready');
	});

	it('still trips the breaker on genuine failures interleaved with reclaims', () => {
		const b = board([
			card({
				id: 'a',
				status: 'running',
				runs: [
					{ attempt: 1, startedAt: NOW, endedAt: NOW, outcome: 'error' },
					{ attempt: 2, startedAt: NOW, endedAt: NOW, outcome: 'reclaimed' },
					{ attempt: 3, startedAt: NOW },
				],
			}),
		]);
		// A reclaim between two real failures must not reset the count either.
		expect(applyCardResult(b, 'a', failure(), NOW, 2)).toBe('blocked');
	});

	it('a successful run still resets the breaker across earlier reclaims', () => {
		const b = board([
			card({
				id: 'a',
				status: 'running',
				runs: [
					{ attempt: 1, startedAt: NOW, endedAt: NOW, outcome: 'error' },
					{ attempt: 2, startedAt: NOW, endedAt: NOW, outcome: 'done' },
					{ attempt: 3, startedAt: NOW, endedAt: NOW, outcome: 'reclaimed' },
					{ attempt: 4, startedAt: NOW },
				],
			}),
		]);
		expect(applyCardResult(b, 'a', failure(), NOW, 2)).toBe('ready');
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
		// `reclaimed`, not `error`: the host abandoned the attempt, the card did
		// not fail, so this must not feed the retry circuit breaker.
		expect(b.cards[0].runs?.[0]).toMatchObject({ outcome: 'reclaimed' });
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

describe('BoardDispatcher notifications', () => {
	/** Harness that records every notification the dispatcher emits. */
	function notifyHarness(
		initial: Board,
		spawnScript: (cardId: string) => CardSpawnResult,
		extra?: Partial<BoardDispatcherDeps>
	) {
		const events: CardNotification[] = [];
		const h = harness(initial, spawnScript, { notify: (e) => events.push(e), ...extra });
		return { ...h, events };
	}

	it('fires a done notification carrying the run summary', async () => {
		const h = notifyHarness(board([card({ id: 'a' })], 1), () =>
			completeMarker('shipped the thing')
		);

		h.dispatcher.tick();
		await flush();
		expect(h.events).toEqual([
			{ kind: 'done', cardId: 'a', cardTitle: 'Card a', detail: 'shipped the thing' },
		]);
	});

	it('fires a blocked notification carrying the block reason', async () => {
		const h = notifyHarness(board([card({ id: 'a' })], 1), () => blockMarker('needs a schema'));

		h.dispatcher.tick();
		await flush();
		expect(h.events).toEqual([
			{ kind: 'blocked', cardId: 'a', cardTitle: 'Card a', detail: 'needs a schema' },
		]);
	});

	it('fires blocked only when the circuit breaker actually trips, not on a retry', async () => {
		const h = notifyHarness(board([card({ id: 'a' })], 1), () => failure());

		h.dispatcher.tick(); // attempt 1 -> retried, nothing terminal to report
		await flush();
		expect(h.events).toEqual([]);

		h.dispatcher.tick(); // attempt 2 -> breaker trips
		await flush();
		expect(h.events.map((e) => e.kind)).toEqual(['blocked']);
		expect(h.events[0].cardId).toBe('a');
	});

	it('fires blocked when an assignee cannot be resolved', async () => {
		const h = notifyHarness(board([card({ id: 'a' })], 1), () => completeMarker(), {
			resolveOverrides: () => null,
		});

		h.dispatcher.tick();
		await flush();
		expect(h.events).toEqual([
			{
				kind: 'blocked',
				cardId: 'a',
				cardTitle: 'Card a',
				detail: 'Assignee profile "p1" could not be resolved.',
			},
		]);
	});

	it('fires blocked for an unresolvable card on the pooled path', async () => {
		const h = notifyHarness(board([card({ id: 'a' })], 1), () => completeMarker(), {
			assign: () => ({ kind: 'unresolvable', reason: 'Profile "p1" not found.' }),
		});

		h.dispatcher.tick();
		await flush();
		expect(h.events).toEqual([
			{ kind: 'blocked', cardId: 'a', cardTitle: 'Card a', detail: 'Profile "p1" not found.' },
		]);
		expect(h.status('a')).toBe('blocked');
	});

	it('survives a notifier that throws', async () => {
		const h = harness(board([card({ id: 'a' })], 1), () => completeMarker(), {
			notify: () => {
				throw new Error('toast exploded');
			},
		});

		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('done');
	});
});

describe('BoardDispatcher cancelCard', () => {
	/** Harness whose spawn never settles until the test resolves it, so a cancel
	 * can land while the card is genuinely in flight. */
	function pendingHarness(initial: Board, extra?: Partial<BoardDispatcherDeps>) {
		let settle: ((result: CardSpawnResult) => void) | null = null;
		const killed: string[] = [];
		const h = harness(initial, () => failure(), {
			spawn: () => new Promise<CardSpawnResult>((resolve) => (settle = resolve)),
			cancelSpawn: (cardId) => {
				killed.push(cardId);
				return true;
			},
			...extra,
		});
		return { ...h, killed, settle: (r: CardSpawnResult) => settle?.(r) };
	}

	it('kills the run, returns the card to todo, and records a canceled run', async () => {
		const h = pendingHarness(board([card({ id: 'a' })], 1));

		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('running');
		expect(h.dispatcher.isInFlight('a')).toBe(true);

		expect(h.dispatcher.cancelCard('a')).toBe(true);
		expect(h.killed).toEqual(['a']);
		expect(h.status('a')).toBe('todo');
		expect(h.dispatcher.isInFlight('a')).toBe(false);
		const run = h.cardById('a').runs?.[0];
		expect(run?.outcome).toBe('canceled');
		expect(run?.endedAt).toBe(NOW);
	});

	it('ignores the killed run resolving afterwards instead of re-finalizing it', async () => {
		const h = pendingHarness(board([card({ id: 'a' })], 1));

		h.dispatcher.tick();
		await flush();
		h.dispatcher.cancelCard('a');

		// The killed process reports in: no marker, null exit. Without the cancel
		// tombstone this would overwrite the cancel with a failed run.
		h.settle({ output: '', exitCode: null, error: 'killed' });
		await flush();
		expect(h.status('a')).toBe('todo');
		expect(h.cardById('a').runs?.length).toBe(1);
		expect(h.cardById('a').runs?.[0].outcome).toBe('canceled');
	});

	it('does not count canceled runs toward the failure circuit breaker', async () => {
		// maxFailures is 2; two canceled runs plus one genuine failure must still
		// retry (`ready`), because a user stopping a card is not the card failing.
		const initial = board(
			[
				card({
					id: 'a',
					runs: [
						{ attempt: 1, startedAt: NOW, endedAt: NOW, outcome: 'canceled' },
						{ attempt: 2, startedAt: NOW, endedAt: NOW, outcome: 'canceled' },
					],
				}),
			],
			1
		);
		const h = harness(initial, () => failure());

		h.dispatcher.tick();
		await flush();
		expect(h.status('a')).toBe('ready');
		expect(h.cardById('a').runs?.length).toBe(3);
	});

	it('is a no-op for a card that is not running', () => {
		const h = pendingHarness(board([card({ id: 'a', status: 'todo' })], 1));
		expect(h.dispatcher.cancelCard('a')).toBe(false);
		expect(h.dispatcher.cancelCard('nope')).toBe(false);
		expect(h.killed).toEqual([]);
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

	it('honors card priority when picking which ready card gets the free worker', () => {
		const b = board([
			card({ id: 'old', status: 'ready', createdAt: '2026-07-10T00:00:01.000Z' }),
			card({
				id: 'urgent',
				status: 'ready',
				priority: 'high',
				createdAt: '2026-07-10T00:00:09.000Z',
			}),
		]);
		const { claimed } = claimReadyCardsPooled(b, 5, NOW, poolAssign(['w1']));
		expect(claimed.map((c) => c.card.id)).toEqual(['urgent']);
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
