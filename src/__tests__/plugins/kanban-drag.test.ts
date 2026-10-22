/**
 * @file kanban-drag.test.ts
 * @description Tests the drag, drop, and reconciliation half of
 * `examples/plugins/maestro-kanban/panel.html`: a drop posts the `move`
 * command the sandbox expects, an illegal column refuses the drop and posts
 * nothing, a sandbox rejection puts the card back where it started and says
 * why, Escape mid-drag cancels without posting, and a keyboard move posts the
 * byte-identical payload a drag does.
 *
 * The harness that extracts and runs the panel's single inline `<script>`
 * against jsdom is shared with `kanban-panel.test.ts`, which owns rendering,
 * the switcher, and keyboard SELECTION; see
 * `src/__tests__/helpers/kanbanPanel.ts`. Listed in `jsdomOnlyTs` in
 * `vitest.config.mts` because the panel script reads `document` at load.
 *
 * Two things about jsdom shape these tests, and both are load-bearing rather
 * than incidental:
 *
 *  - jsdom has no `DragEvent`, so a drag event is dispatched as a
 *    `MouseEvent`, which carries the `clientY` the panel's insertion math
 *    reads and leaves `dataTransfer` undefined. The panel already guards every
 *    `dataTransfer` access (some engines refuse a custom MIME type mid-drag),
 *    so that absence exercises a real branch instead of faking one.
 *  - jsdom gives every element a zero-sized rect, which would make the
 *    cursor read as "below the last card" in every column and quietly turn
 *    every insertion-index assertion into a tautology. `layOutCards()` lays
 *    the cards out as a real stack first, so a `clientY` picks a genuine slot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	board,
	cardTitlesIn,
	columnElement,
	columnIdOfCard,
	findCardElement,
	loadPanel,
	makeCard,
	press,
	pushSnapshot,
	snapshotWith,
	teardownPanel,
	type SnapshotCard,
	type SnapshotColumn,
	type SnapshotMoveRejection,
} from '../helpers/kanbanPanel';

/** The rendered column order every helper in this file indexes by. */
const COLUMNS = ['backlog', 'in-progress', 'review'];
const COLUMN_TITLES: Record<string, string> = {
	backlog: 'Backlog',
	'in-progress': 'In Progress',
	review: 'Review',
};
const BOARD_ID = '/Users/dev/projects/widgets';

/** Height each card is given by layOutCards(), so a test can name a cursor
 * position in terms of rows rather than pixels. */
const CARD_HEIGHT = 100;

/** A three-column snapshot with `boardId` set, since a real `move` payload
 * always carries the board it was dropped on. */
function dragSnapshot(
	byColumn: Partial<Record<string, SnapshotCard[]>>,
	opts: {
		readOnly?: string[];
		moveRejection?: SnapshotMoveRejection | null;
		boardId?: string | null;
	} = {}
) {
	const columns: SnapshotColumn[] = COLUMNS.map((id) => ({
		id,
		title: COLUMN_TITLES[id]!,
		cards: byColumn[id] ?? [],
		...((opts.readOnly ?? []).includes(id) ? { readOnly: true } : {}),
	}));
	return snapshotWith(
		{},
		{
			columns,
			boardId: opts.boardId === undefined ? BOARD_ID : opts.boardId,
			moveRejection: opts.moveRejection ?? null,
		}
	);
}

function card(title: string, key: string, overrides: Partial<SnapshotCard> = {}): SnapshotCard {
	const [sessionId, tabId] = key.split('::');
	return makeCard({ key, sessionId, tabId, title, ...overrides });
}

/** jsdom gives every element a zero-sized rect, so the panel's insertion math
 * (which compares the cursor against each card's midpoint) would always report
 * "after the last card" and every index assertion would pass for the wrong
 * reason. This lays each column's cards out as a real stack: the card in row N
 * spans y = N*100 through N*100+100, so `rowTop(N)` is that card's top half
 * and `rowBottom(N)` its bottom half. Call it after every render. */
function layOutCards() {
	for (const body of Array.from(board().querySelectorAll<HTMLElement>('.column-body'))) {
		Array.from(body.querySelectorAll<HTMLElement>('.card')).forEach((el, index) => {
			const top = index * CARD_HEIGHT;
			el.getBoundingClientRect = () =>
				({
					top,
					bottom: top + CARD_HEIGHT,
					height: CARD_HEIGHT,
					left: 0,
					right: 240,
					width: 240,
					x: 0,
					y: top,
					toJSON: () => ({}),
				}) as DOMRect;
		});
	}
}

/** A cursor in the TOP half of the card drawn in row N: the panel inserts
 * BEFORE that card. */
function rowTop(row: number): number {
	return row * CARD_HEIGHT + 10;
}

/** A cursor in the BOTTOM half of the card drawn in row N: the panel inserts
 * AFTER that card. */
function rowBottom(row: number): number {
	return row * CARD_HEIGHT + CARD_HEIGHT - 10;
}

/** Starts a drag the way the engine does. `dataTransfer` is absent under
 * jsdom, which the panel tolerates by design (dragState carries the payload). */
function dragStart(title: string) {
	findCardElement(title).dispatchEvent(new Event('dragstart', { bubbles: true }));
}

/** The engine's drag-cancel / drag-finished notification. Fires after a real
 * drop too, where the panel has already cleared `dragState` and this is a
 * no-op, so every test that finishes a gesture sends it. */
function dragEnd(title: string) {
	findCardElement(title).dispatchEvent(new Event('dragend', { bubbles: true }));
}

/** Dispatches a drag event at a point inside a column. `overTitle` names the
 * card under the cursor (the panel anchors on it when there is one); omit it
 * to point at the column's empty space below the last card. Returns the event
 * so a caller can read `defaultPrevented`, which is how the panel signals
 * whether it accepted the drop at all. */
function dragEventAt(
	type: 'dragover' | 'drop' | 'dragleave',
	columnId: string,
	opts: { overTitle?: string; clientY?: number } = {}
): MouseEvent {
	const target =
		opts.overTitle !== undefined
			? findCardElement(opts.overTitle)
			: (columnElement(columnId, COLUMNS).querySelector<HTMLElement>('.column-body') ??
				columnElement(columnId, COLUMNS));
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientY: opts.clientY ?? 0,
	});
	target.dispatchEvent(event);
	return event;
}

function dragOver(columnId: string, opts: { overTitle?: string; clientY?: number } = {}) {
	return dragEventAt('dragover', columnId, opts);
}

function drop(columnId: string, opts: { overTitle?: string; clientY?: number } = {}) {
	return dragEventAt('drop', columnId, opts);
}

function spyOnPost() {
	return vi.spyOn(window, 'postMessage').mockImplementation(() => {});
}

/** Every `move` the panel posted, in order. */
function movesPosted(spy: ReturnType<typeof spyOnPost>): unknown[] {
	return spy.mock.calls
		.map((call) => call[0] as { commandId?: string })
		.filter((message) => message && message.commandId === 'move');
}

function placeholder(): HTMLElement | null {
	return document.getElementById('drop-placeholder');
}

/** Index of the insertion line inside a column's body, counting only the cards
 * around it, so a test can assert WHERE the gap is and not merely that one
 * exists. */
function placeholderIndexIn(columnId: string): number | null {
	const body = columnElement(columnId, COLUMNS).querySelector<HTMLElement>('.column-body');
	if (!body) return null;
	let index = 0;
	for (const child of Array.from(body.children)) {
		if (child.id === 'drop-placeholder') return index;
		if (child.classList.contains('card')) index += 1;
	}
	return null;
}

function toastText(): string | null {
	const toast = document.getElementById('toast');
	if (!toast || toast.hidden) return null;
	return toast.textContent;
}

function columnClasses(columnId: string): DOMTokenList {
	return columnElement(columnId, COLUMNS).classList;
}

describe('maestro-kanban panel.html drag and drop', () => {
	beforeEach(() => {
		loadPanel();
	});

	afterEach(() => {
		teardownPanel();
	});

	it('posts the move command with the dropped-on column and insertion index', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [card('Alpha', 'session-1::tab-1'), card('Bravo', 'session-2::tab-2')],
				review: [card('Charlie', 'session-3::tab-3'), card('Delta', 'session-4::tab-4')],
			})
		);
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		// Between Charlie and Delta: the cursor is in Delta's top half, so the
		// card goes BEFORE Delta, which is index 1 of review's final order.
		dragOver('review', { overTitle: 'Delta', clientY: rowTop(1) });
		const dropEvent = drop('review', { overTitle: 'Delta', clientY: rowTop(1) });
		dragEnd('Alpha');

		// preventDefault is the panel accepting the drop rather than letting the
		// engine treat the column as inert.
		expect(dropEvent.defaultPrevented).toBe(true);
		expect(movesPosted(postSpy)).toEqual([
			{
				type: 'maestro:invokeCommand',
				commandId: 'move',
				args: {
					cardKey: 'session-1::tab-1',
					toColumnId: 'review',
					toIndex: 1,
					boardId: BOARD_ID,
				},
			},
		]);
		// And applied optimistically, in the posted position, before the sandbox
		// has said anything at all.
		expect(cardTitlesIn('review', COLUMNS)).toEqual(['Charlie', 'Alpha', 'Delta']);
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Bravo']);
	});

	it('posts a reorder within one column with the index the cursor pointed at', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [
					card('Alpha', 'session-1::tab-1'),
					card('Bravo', 'session-2::tab-2'),
					card('Charlie', 'session-3::tab-3'),
				],
			})
		);
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		// Below Charlie, the last card: index 2 of backlog's final order, which
		// is the order with Alpha already taken out.
		dragOver('backlog', { overTitle: 'Charlie', clientY: rowBottom(2) });
		drop('backlog', { overTitle: 'Charlie', clientY: rowBottom(2) });
		dragEnd('Alpha');

		expect(movesPosted(postSpy)).toEqual([
			{
				type: 'maestro:invokeCommand',
				commandId: 'move',
				args: {
					cardKey: 'session-1::tab-1',
					toColumnId: 'backlog',
					toIndex: 2,
					boardId: BOARD_ID,
				},
			},
		]);
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Bravo', 'Charlie', 'Alpha']);
	});

	it('posts nothing when a card is dropped back on the slot it came from', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [card('Alpha', 'session-1::tab-1'), card('Bravo', 'session-2::tab-2')],
			})
		);
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		// Above Bravo, which with Alpha removed is index 0 - exactly where Alpha
		// already is. The sandbox is never asked to write a no-op.
		dragOver('backlog', { overTitle: 'Bravo', clientY: rowTop(0) });
		drop('backlog', { overTitle: 'Bravo', clientY: rowTop(0) });
		dragEnd('Alpha');

		expect(movesPosted(postSpy)).toEqual([]);
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Alpha', 'Bravo']);
	});

	it('shows the insertion position while dragging, and clears it on dragleave', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [card('Alpha', 'session-1::tab-1')],
				review: [card('Charlie', 'session-3::tab-3'), card('Delta', 'session-4::tab-4')],
			})
		);
		layOutCards();

		expect(placeholder()).toBeNull();
		dragStart('Alpha');
		dragOver('review', { overTitle: 'Charlie', clientY: rowTop(0) });

		// A gap the user can see, at the index the drop would use, rather than a
		// position they only learn about after letting go.
		expect(placeholder()).not.toBeNull();
		expect(placeholderIndexIn('review')).toBe(0);

		dragOver('review', { overTitle: 'Delta', clientY: rowBottom(1) });
		expect(placeholderIndexIn('review')).toBe(2);

		// Leaving the column for something outside it takes the line away.
		dragEventAt('dragleave', 'review');
		expect(placeholder()).toBeNull();
		dragEnd('Alpha');
	});

	it('highlights the columns a card can reach and dims the ones it cannot', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [
					card('Alpha', 'session-1::tab-1', { legalColumnIds: ['backlog', 'in-progress'] }),
				],
			})
		);
		layOutCards();

		dragStart('Alpha');

		expect(columnClasses('backlog').contains('drop-legal')).toBe(true);
		expect(columnClasses('in-progress').contains('drop-legal')).toBe(true);
		expect(columnClasses('review').contains('drop-legal')).toBe(false);
		expect(columnClasses('review').contains('drop-illegal')).toBe(true);

		dragEnd('Alpha');
		// The dim is a drag affordance, not a state the board is left in.
		expect(columnClasses('review').contains('drop-illegal')).toBe(false);
	});

	it('posts nothing when a card is dropped on a column its project cannot reach', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [
					card('Alpha', 'session-1::tab-1', { legalColumnIds: ['backlog', 'in-progress'] }),
				],
			})
		);
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		const overEvent = dragOver('review', { clientY: rowTop(0) });
		const dropEvent = drop('review', { clientY: rowTop(0) });
		dragEnd('Alpha');

		expect(movesPosted(postSpy)).toEqual([]);
		// Neither event is accepted: an illegal column never calls
		// preventDefault, which is what makes the engine refuse the drop in a
		// real browser rather than show a drop cursor that then does nothing.
		expect(overEvent.defaultPrevented).toBe(false);
		expect(dropEvent.defaultPrevented).toBe(false);
		// No insertion line was ever offered over a column that could not take it.
		expect(placeholder()).toBeNull();
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('backlog');
	});

	it('posts nothing when a card is dropped into a read-only lane', () => {
		pushSnapshot(
			dragSnapshot(
				{
					backlog: [card('Alpha', 'session-1::tab-1')],
					review: [card('Stranded', 'session-9::tab-9')],
				},
				{ readOnly: ['review'] }
			)
		);
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		// The lane binds no drop listener at all, so this is the belt to the
		// legality check's braces: the global board's Unmapped lane is a place
		// cards are SHOWN, never a destination.
		const dropEvent = drop('review', { clientY: rowTop(0) });
		dragEnd('Alpha');

		expect(movesPosted(postSpy)).toEqual([]);
		expect(dropEvent.defaultPrevented).toBe(false);
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('backlog');
	});

	it('returns the card to its origin column and explains why when the sandbox rejects the move', () => {
		const alpha = card('Alpha', 'session-1::tab-1');
		pushSnapshot(dragSnapshot({ backlog: [alpha] }));
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		dragOver('review', { clientY: rowTop(0) });
		drop('review', { clientY: rowTop(0) });
		dragEnd('Alpha');

		expect(movesPosted(postSpy)).toHaveLength(1);
		// Optimistic: the card is in review while the sandbox is still deciding.
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('review');
		expect(toastText()).toBeNull();

		// The sandbox re-checked, refused, and said so on the next snapshot. The
		// bridge is one-way, so a rejection can only ever arrive this way.
		pushSnapshot(
			dragSnapshot(
				{ backlog: [alpha] },
				{
					moveRejection: {
						cardKey: 'session-1::tab-1',
						reason: 'Review is not reachable from this project',
					},
				}
			)
		);

		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('backlog');
		expect(toastText()).toBe('Move not applied: Review is not reachable from this project');
	});

	it('keeps the optimistic position when an unrelated snapshot lands before the move is acknowledged', () => {
		const alpha = card('Alpha', 'session-1::tab-1');
		pushSnapshot(dragSnapshot({ backlog: [alpha] }));
		layOutCards();

		spyOnPost();
		dragStart('Alpha');
		dragOver('review', { clientY: rowTop(0) });
		drop('review', { clientY: rowTop(0) });
		dragEnd('Alpha');
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('review');

		// A status push that crossed the move in flight still shows the card in
		// backlog. Snapping it back now and forward on the next push would read
		// as the board fighting the user, so the optimistic position holds.
		pushSnapshot(
			dragSnapshot({ backlog: [card('Alpha', 'session-1::tab-1', { status: 'busy' })] })
		);
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('review');
		expect(toastText()).toBeNull();

		// Once the sandbox's own snapshot agrees, the move is settled and the
		// panel is back to simply rendering what it is told.
		pushSnapshot(dragSnapshot({ review: [alpha] }));
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('review');
	});

	it('holds a snapshot that arrives mid-drag until the drag ends', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [card('Alpha', 'session-1::tab-1'), card('Bravo', 'session-2::tab-2')],
			})
		);
		layOutCards();

		dragStart('Alpha');
		// A refresh must never re-render the board out from under the cursor.
		pushSnapshot(dragSnapshot({ backlog: [card('Charlie', 'session-3::tab-3')] }));
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Alpha', 'Bravo']);

		dragEnd('Alpha');
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Charlie']);
	});

	it('cancels cleanly on Escape mid-drag: no move posted, card returned, visuals cleared', () => {
		pushSnapshot(
			dragSnapshot({
				backlog: [card('Alpha', 'session-1::tab-1'), card('Bravo', 'session-2::tab-2')],
			})
		);
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		dragOver('review', { clientY: rowTop(0) });
		expect(placeholder()).not.toBeNull();
		expect(findCardElement('Alpha').classList.contains('dragging')).toBe(true);

		press('Escape');

		expect(movesPosted(postSpy)).toEqual([]);
		// Escape with a drag in flight belongs to the drag: the panel stays open.
		expect(postSpy).not.toHaveBeenCalled();
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Alpha', 'Bravo']);
		expect(placeholder()).toBeNull();
		expect(findCardElement('Alpha').classList.contains('dragging')).toBe(false);
		expect(columnClasses('review').contains('drop-legal')).toBe(false);
		expect(columnClasses('review').contains('drop-illegal')).toBe(false);

		// The drag is genuinely over, not merely hidden: a drop arriving late
		// (the engine's own dragend, a stray event) posts nothing.
		drop('review', { clientY: rowTop(0) });
		dragEnd('Alpha');
		expect(movesPosted(postSpy)).toEqual([]);
		expect(columnIdOfCard('Alpha', COLUMNS)).toBe('backlog');
	});

	it('flushes a snapshot that arrived mid-drag once Escape cancels the drag', () => {
		pushSnapshot(dragSnapshot({ backlog: [card('Alpha', 'session-1::tab-1')] }));
		layOutCards();

		dragStart('Alpha');
		pushSnapshot(dragSnapshot({ backlog: [card('Charlie', 'session-3::tab-3')] }));
		press('Escape');

		// Cancelling is not a reason to go on showing a stale board.
		expect(cardTitlesIn('backlog', COLUMNS)).toEqual(['Charlie']);
	});

	it('posts the identical move payload whether a drag or the keyboard produced it', () => {
		const byColumn = {
			backlog: [card('Alpha', 'session-1::tab-1')],
			'in-progress': [card('Bravo', 'session-2::tab-2')],
		};

		// --- the drag ---
		pushSnapshot(dragSnapshot(byColumn));
		layOutCards();
		const dragSpy = spyOnPost();
		dragStart('Alpha');
		dragOver('in-progress', { overTitle: 'Bravo', clientY: rowTop(0) });
		drop('in-progress', { overTitle: 'Bravo', clientY: rowTop(0) });
		dragEnd('Alpha');
		const draggedMoves = movesPosted(dragSpy);

		// --- the keyboard, on a fresh panel so the board starts from the same
		// state. teardownPanel() first, because a keydown listener left on the
		// shared document would answer the arrow keys below with this panel's
		// closure as well as the next one's. ---
		teardownPanel();
		loadPanel();
		pushSnapshot(dragSnapshot(byColumn));
		layOutCards();
		const keySpy = spyOnPost();
		press('ArrowRight');
		press('ArrowRight', { altKey: true });
		const keyboardMoves = movesPosted(keySpy);

		// Pinned explicitly as well as against each other, so the two drifting
		// together to the same wrong payload cannot pass.
		const expected = [
			{
				type: 'maestro:invokeCommand',
				commandId: 'move',
				args: {
					cardKey: 'session-1::tab-1',
					toColumnId: 'in-progress',
					toIndex: 0,
					boardId: BOARD_ID,
				},
			},
		];
		expect(draggedMoves).toEqual(expected);
		expect(keyboardMoves).toEqual(expected);
		expect(keyboardMoves).toEqual(draggedMoves);
	});

	it('posts a null boardId when no board is active, rather than inventing one', () => {
		pushSnapshot(dragSnapshot({ backlog: [card('Alpha', 'session-1::tab-1')] }, { boardId: null }));
		layOutCards();

		const postSpy = spyOnPost();
		dragStart('Alpha');
		dragOver('review', { clientY: rowTop(0) });
		drop('review', { clientY: rowTop(0) });
		dragEnd('Alpha');

		expect(movesPosted(postSpy)).toEqual([
			{
				type: 'maestro:invokeCommand',
				commandId: 'move',
				args: {
					cardKey: 'session-1::tab-1',
					toColumnId: 'review',
					toIndex: 0,
					boardId: null,
				},
			},
		]);
	});
});
