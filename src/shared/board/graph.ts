/**
 * Board DAG helpers.
 *
 * The board's `cards[].parents` form a dependency graph: a card is eligible to
 * run only once every parent it lists is `done`. These pure functions are the
 * heart of the Phase 3 dispatcher - they decide what runs next and refuse to
 * persist a cyclic graph. Framework-free so main, renderer, and CLI share them.
 */

import type { Board, BoardCard } from './types';

/** Build an id -> card lookup for a board. */
function indexById(board: Board): Map<string, BoardCard> {
	const map = new Map<string, BoardCard>();
	for (const card of board.cards) {
		map.set(card.id, card);
	}
	return map;
}

/**
 * Return the parents of `card` that are not yet `done`. A missing parent (an id
 * with no matching card) counts as a blocker: the card cannot proceed until the
 * dependency exists and completes. Order matches the card's `parents` list.
 */
export function getBlockers(card: BoardCard, board: Board): BoardCard['id'][] {
	const byId = indexById(board);
	const blockers: string[] = [];
	for (const parentId of card.parents) {
		const parent = byId.get(parentId);
		if (!parent || parent.status !== 'done') {
			blockers.push(parentId);
		}
	}
	return blockers;
}

/**
 * Return the cards that are eligible to run right now: status `todo` and every
 * parent already `done`. This is the set the dispatcher promotes to `ready`.
 * Cards already `ready`/`running`/`blocked`/`done`/`triage` are excluded - only
 * accepted-but-waiting work (`todo`) is considered.
 *
 * Order preserves the board's card order for deterministic dispatch.
 */
export function getEligibleCards(board: Board): BoardCard[] {
	const byId = indexById(board);
	return board.cards.filter((card) => {
		if (card.status !== 'todo') return false;
		return card.parents.every((parentId) => byId.get(parentId)?.status === 'done');
	});
}

/**
 * Return `true` if the board's parent graph contains a cycle. Uses an iterative
 * DFS with a three-color (white/gray/black) visit marking so a back-edge to a
 * card currently on the stack signals a cycle. Parent ids with no matching card
 * are ignored here (they are handled as blockers, not cycles).
 *
 * A self-parent (`card.parents` includes its own id) is a cycle.
 */
export function hasCycle(board: Board): boolean {
	const byId = indexById(board);
	// 0 = unvisited, 1 = on current DFS stack, 2 = fully explored.
	const state = new Map<string, number>();

	for (const start of board.cards) {
		if (state.get(start.id) === 2) continue;

		// Iterative DFS. Each frame tracks the card and which parent index is next.
		const stack: { id: string; parentIndex: number }[] = [{ id: start.id, parentIndex: 0 }];
		state.set(start.id, 1);

		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			const card = byId.get(frame.id);
			const parents = card?.parents ?? [];

			if (frame.parentIndex >= parents.length) {
				// Done with this card: mark explored and pop.
				state.set(frame.id, 2);
				stack.pop();
				continue;
			}

			const parentId = parents[frame.parentIndex];
			frame.parentIndex += 1;

			// Skip dangling parent ids - not a cycle, just a missing dependency.
			if (!byId.has(parentId)) continue;

			const parentState = state.get(parentId) ?? 0;
			if (parentState === 1) {
				// Back-edge to a card on the current stack -> cycle.
				return true;
			}
			if (parentState === 0) {
				state.set(parentId, 1);
				stack.push({ id: parentId, parentIndex: 0 });
			}
		}
	}

	return false;
}

/** In-flight card counts across every board in a project. */
export interface ActiveCardCounts {
	/** Cards a dispatcher is running right now. */
	running: number;
	/** Cards whose parents are all done, waiting for a free slot or worker. */
	ready: number;
}

/**
 * Count the `running` and `ready` cards across a project's boards. Pure, so the
 * status-bar indicator that displays it is a render of data rather than a
 * second source of truth. `total` is what the caller checks to decide whether
 * to show anything at all.
 */
export function countActiveCards(boards: readonly Board[]): ActiveCardCounts {
	let running = 0;
	let ready = 0;
	for (const board of boards) {
		for (const card of board.cards) {
			if (card.status === 'running') running += 1;
			else if (card.status === 'ready') ready += 1;
		}
	}
	return { running, ready };
}
