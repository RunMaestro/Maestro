/**
 * @file kanban-panel.test.ts
 * @description Tests for `examples/plugins/maestro-kanban/panel.html`, the
 * board UI: rendering, the parse-error banner, the empty state, the board
 * switcher, and keyboard access. `examples/plugins/agent-flow/` (the template
 * this suite was supposed to be modeled on, per `agent-flow-panel.test.ts`)
 * does not exist in this checkout, consistent with every other finding in this
 * phase.
 *
 * The harness that extracts and runs the panel's single inline `<script>`
 * against jsdom lives in `src/__tests__/helpers/kanbanPanel.ts`, shared with
 * `kanban-drag.test.ts`. Drag, drop, and optimistic reconciliation are that
 * file's subject, not this one's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	COLUMN_IDS,
	board,
	columnIdOfCard,
	emptySnapshot,
	findCardElement,
	loadPanel,
	makeCard,
	press,
	pushSnapshot,
	selectedCardTitle,
	snapshotWith,
	switcher,
	switcherOptions,
	teardownPanel,
} from '../helpers/kanbanPanel';

describe('maestro-kanban panel.html', () => {
	beforeEach(() => {
		loadPanel();
	});

	afterEach(() => {
		teardownPanel();
	});

	it('renders the expected columns and cards from a maestro:panelData message', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Backlog Tab' })],
				'in-progress': [
					makeCard({
						key: 'session-2::tab-2',
						sessionId: 'session-2',
						tabId: 'tab-2',
						title: 'Busy Tab',
						status: 'busy',
					}),
				],
			})
		);

		const columns = Array.from(board().querySelectorAll('.column'));
		expect(columns).toHaveLength(COLUMN_IDS.length);

		expect(findCardElement('Backlog Tab')).toBeTruthy();
		expect(findCardElement('Busy Tab')).toBeTruthy();

		const backlogColumn = columns[0]!;
		expect(backlogColumn.querySelector('.column-count')?.textContent).toBe('1');
		expect(backlogColumn.querySelector('.column-header span')?.textContent).toBe('Backlog');
		const inProgressColumn = columns[1]!;
		expect(inProgressColumn.querySelector('.column-count')?.textContent).toBe('1');
		const reviewColumn = columns[2]!;
		expect(reviewColumn.querySelector('.column-count')?.textContent).toBe('0');
	});

	it("renders a column's title from the resolved board data, not a hardcoded map", () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					columns: [
						{ id: 'doing', title: 'Doing Now', cards: [makeCard({ key: 'session-1::tab-1' })] },
					],
				}
			)
		);

		const columns = Array.from(board().querySelectorAll('.column'));
		expect(columns).toHaveLength(1);
		expect(columns[0]!.querySelector('.column-header span')?.textContent).toBe('Doing Now');
	});

	it('renders a warning-colored count once a column exceeds its wip_limit, and not before', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					columns: [
						{
							id: 'doing',
							title: 'Doing',
							wipLimit: 1,
							cards: [makeCard({ key: 'session-1::tab-1' })],
						},
					],
				}
			)
		);
		let count = board().querySelector('.column-count');
		expect(count?.classList.contains('over-limit')).toBe(false);

		pushSnapshot(
			snapshotWith(
				{},
				{
					columns: [
						{
							id: 'doing',
							title: 'Doing',
							wipLimit: 1,
							cards: [
								makeCard({ key: 'session-1::tab-1' }),
								makeCard({ key: 'session-2::tab-2', sessionId: 'session-2', tabId: 'tab-2' }),
							],
						},
					],
				}
			)
		);
		count = board().querySelector('.column-count');
		expect(count?.classList.contains('over-limit')).toBe(true);
		expect(count?.textContent).toBe('2');
	});

	it("shows a banner with the parser's message and file path when a board file failed to parse", () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardError: {
						message: "Column is missing required 'title' (line 4)",
						path: '~/.maestro/kanban-boards/widgets-1a2b3c4d.yaml',
					},
				}
			)
		);

		const banner = document.getElementById('banner');
		expect(banner?.hidden).toBe(false);
		expect(banner?.textContent).toContain("Column is missing required 'title' (line 4)");
		expect(banner?.textContent).toContain('~/.maestro/kanban-boards/widgets-1a2b3c4d.yaml');
	});

	it('hides the banner once the board file parses cleanly again', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{ boardError: { message: 'version is required', path: '~/.maestro/kanban.yaml' } }
			)
		);
		expect(document.getElementById('banner')?.hidden).toBe(false);

		pushSnapshot(emptySnapshot());
		expect(document.getElementById('banner')?.hidden).toBe(true);
	});

	it('renders the empty state, never a blank rectangle, when the snapshot has zero cards', () => {
		pushSnapshot(emptySnapshot());

		const emptyState = board().querySelector('.empty-state');
		expect(emptyState).toBeTruthy();
		expect(emptyState?.textContent).toMatch(/no agents yet/i);
		expect(board().querySelectorAll('.column')).toHaveLength(0);
	});

	it('does not render the write-default-board button when there is no active project', () => {
		pushSnapshot(emptySnapshot());

		expect(board().querySelector('.write-default-board-button')).toBeNull();
	});

	it('does not render the write-default-board button when the active project already has a board file', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{ activeProjectPath: '/Users/dev/projects/widgets', projectBoardMissing: false }
			)
		);

		expect(board().querySelector('.write-default-board-button')).toBeNull();
	});

	it('renders the write-default-board button in the empty state when the active project has no board file', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{ activeProjectPath: '/Users/dev/projects/widgets', projectBoardMissing: true }
			)
		);

		const button = board().querySelector('.write-default-board-button');
		expect(button).toBeTruthy();
		expect(button?.closest('.empty-state')).toBeTruthy();
	});

	it('posts the write-default-board command with the active project path when the button is clicked', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{ activeProjectPath: '/Users/dev/projects/widgets', projectBoardMissing: true }
			)
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		const button = board().querySelector<HTMLButtonElement>('.write-default-board-button');
		if (!button) throw new Error('write-default-board button did not render');
		button.click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'write-default-board',
			args: { projectPath: '/Users/dev/projects/widgets' },
		});
		// vi.spyOn on window.postMessage is left unrestored by every test in this
		// file that needs it (none call mockClear/mockRestore); restoring here
		// keeps a later test's fresh vi.spyOn call from reusing this mock's
		// already-recorded call and double-counting its own single click.
		postMessageSpy.mockRestore();
	});

	it('makes the card surface itself the drag handle', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Draggable Tab' })],
			})
		);

		expect(findCardElement('Draggable Tab').getAttribute('draggable')).toBe('true');
	});

	it('keeps form controls out of the draggable surface, since one silently kills an HTML5 drag', () => {
		pushSnapshot(
			snapshotWith(
				{ backlog: [makeCard({ key: 'session-1::tab-1', title: 'No Controls' })] },
				{ activeProjectPath: '/Users/dev/projects/widgets', projectBoardMissing: true }
			)
		);

		const cards = Array.from(board().querySelectorAll<HTMLElement>('.card'));
		expect(cards).toHaveLength(1);
		for (const card of cards) {
			expect(card.querySelectorAll('button, input, select, textarea, label, a[href]')).toHaveLength(
				0
			);
		}
		// The one <button> the panel does render lives in the empty state, which
		// is never inside a draggable card.
		for (const control of Array.from(board().querySelectorAll('button'))) {
			expect(control.closest('.card')).toBeNull();
		}
	});

	it("shows the active board's name and card count in the header", () => {
		pushSnapshot(
			snapshotWith(
				{
					backlog: [makeCard({ key: 'session-1::tab-1', title: 'One' })],
					review: [makeCard({ key: 'session-2::tab-2', sessionId: 'session-2', tabId: 'tab-2' })],
				},
				{ boardId: '/Users/dev/projects/widgets', boardName: 'widgets' }
			)
		);

		expect(document.getElementById('board-name')?.textContent).toBe('widgets');
		expect(document.getElementById('board-count')?.textContent).toBe('2 cards');
	});

	it('lists every board the sandbox reports with its card count, and selects the one on screen', () => {
		pushSnapshot(
			snapshotWith(
				{ backlog: [makeCard({ key: 'session-1::tab-1' })] },
				{
					boardId: '/Users/dev/projects/widgets',
					boardName: 'widgets',
					boards: [
						{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 4 },
						{
							id: '/Users/dev/projects/gadgets',
							kind: 'project',
							name: 'gadgets',
							projectPath: '/Users/dev/projects/gadgets',
							cardCount: 0,
						},
						{
							id: '/Users/dev/projects/widgets',
							kind: 'project',
							name: 'widgets',
							projectPath: '/Users/dev/projects/widgets',
							cardCount: 1,
						},
					],
				}
			)
		);

		// An empty project reads as "(0)" rather than being indistinguishable
		// from a board that failed to load.
		expect(switcherOptions()).toEqual([
			{ value: '__global__', label: 'Global (4)', disabled: false },
			{ value: '/Users/dev/projects/gadgets', label: 'gadgets (0)', disabled: false },
			{ value: '/Users/dev/projects/widgets', label: 'widgets (1)', disabled: false },
		]);
		expect(switcher().value).toBe('/Users/dev/projects/widgets');
	});

	it('keeps the full project path on each option, since two projects can share a basename', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardId: '__global__',
					boardName: 'Global',
					boards: [
						{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 0 },
						{
							id: '/Users/dev/a/widgets',
							kind: 'project',
							name: 'widgets',
							projectPath: '/Users/dev/a/widgets',
							cardCount: 0,
						},
					],
				}
			)
		);

		const option = Array.from(switcher().options).find((o) => o.value === '/Users/dev/a/widgets');
		expect(option?.title).toBe('/Users/dev/a/widgets');
	});

	it('posts the select-board command with the chosen board id when the switcher changes', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardId: '/Users/dev/projects/widgets',
					boardName: 'widgets',
					boards: [
						{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 1 },
						{
							id: '/Users/dev/projects/widgets',
							kind: 'project',
							name: 'widgets',
							projectPath: '/Users/dev/projects/widgets',
							cardCount: 1,
						},
					],
				}
			)
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		switcher().value = '__global__';
		switcher().dispatchEvent(new Event('change'));

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'select-board',
			args: { boardId: '__global__' },
		});
		postMessageSpy.mockRestore();
	});

	it('lists the unnamed pre-activation board, so the board on screen is always in the control', () => {
		pushSnapshot(
			snapshotWith(
				{ backlog: [makeCard({ key: 'session-1::tab-1' })] },
				{
					boardId: null,
					boardName: 'All Agents',
					boards: [
						{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 1 },
					],
				}
			)
		);

		expect(switcherOptions()).toEqual([
			{ value: '', label: 'All Agents (1)', disabled: false },
			{ value: '__global__', label: 'Global (1)', disabled: false },
		]);
		expect(switcher().value).toBe('');
	});

	it('says how many projects the snapshot could not carry rather than showing a quietly short list', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardId: '__global__',
					boardName: 'Global',
					boards: [
						{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 0 },
					],
					boardsHidden: 7,
				}
			)
		);

		const last = switcherOptions().pop();
		expect(last).toEqual({ value: '', label: '7 more projects not shown', disabled: true });
	});

	it('keeps the switcher in the header, never inside #board where a drag would die on it', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Draggable' })] })
		);

		expect(board().querySelector('#board-switcher')).toBeNull();
		expect(switcher().closest('#header')).toBeTruthy();
		expect(switcher().closest('.card')).toBeNull();
	});

	it('explains an absent global board instead of leaving a bare Unmapped lane looking broken', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardId: '__global__',
					boardName: 'Global',
					globalBoardMissing: true,
					columns: [
						{
							id: '__unmapped__',
							title: 'Unmapped',
							readOnly: true,
							cards: [makeCard({ key: 'session-1::tab-1' })],
						},
					],
				}
			)
		);

		const banner = document.getElementById('banner');
		expect(banner?.hidden).toBe(false);
		expect(banner?.className).toBe('banner-notice');
		expect(banner?.textContent).toContain('~/.maestro/kanban.yaml');
	});

	it('prefers a parse error over the missing-global-board notice in the one banner slot', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardId: '__global__',
					globalBoardMissing: true,
					boardError: { message: 'version is required', path: '~/.maestro/kanban.yaml' },
				}
			)
		);

		const banner = document.getElementById('banner');
		expect(banner?.className).toBe('');
		expect(banner?.textContent).toContain('version is required');
	});

	// ---------------------------------------------------------------------
	// Phase 04 card detail pane. A click now opens the detail pane beside
	// the board instead of jumping straight to the agent's tab; Open Tab on
	// that pane is the explicit path to the `focus` command a click used to
	// post directly (see the superseded "posts the focus command ... when a
	// card is clicked" test this replaces).
	// ---------------------------------------------------------------------

	it('opens the card detail pane instead of jumping away when a card is clicked', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-9::tab-9',
						sessionId: 'session-9',
						tabId: 'tab-9',
						title: 'Click Me',
						agentId: 'claude-code',
						projectPath: '/Users/dev/projects/widgets',
						status: 'busy',
					}),
				],
			})
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		findCardElement('Click Me').click();

		// The click itself posts nothing: it is not jumping anywhere.
		expect(postMessageSpy).not.toHaveBeenCalled();
		expect(document.getElementById('detail')?.hidden).toBe(false);
		expect(document.getElementById('detail-title')?.textContent).toBe('Click Me');
		expect(document.getElementById('detail-status-label')?.textContent).toBe('busy');
		expect(document.getElementById('detail-meta')?.textContent).toBe('claude-code | widgets');
	});

	it('posts the focus command only once Open Tab is clicked on the open detail pane', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-9::tab-9',
						sessionId: 'session-9',
						tabId: 'tab-9',
						title: 'Click Me',
					}),
				],
			})
		);

		findCardElement('Click Me').click();
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		document.getElementById('detail-open-tab')?.click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'focus',
			args: { sessionId: 'session-9', tabId: 'tab-9' },
		});
	});

	it('closes the detail pane with its own close button', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Closable' })] })
		);

		findCardElement('Closable').click();
		expect(document.getElementById('detail')?.hidden).toBe(false);

		document.getElementById('detail-close')?.click();
		expect(document.getElementById('detail')?.hidden).toBe(true);
	});

	it('closes the detail pane on Escape before closing the panel itself', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Detail Card' })] })
		);

		findCardElement('Detail Card').click();
		expect(document.getElementById('detail')?.hidden).toBe(false);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('Escape');

		expect(postMessageSpy).not.toHaveBeenCalled();
		expect(document.getElementById('detail')?.hidden).toBe(true);

		// With the detail pane now closed, Escape reaches the panel.
		press('Escape');
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect((postMessageSpy.mock.calls[0]![0] as { commandId: string }).commandId).toBe(
			'close-panel'
		);
	});

	it('keeps the open detail pane in sync with the next snapshot', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Original Title', status: 'idle' })],
			})
		);
		findCardElement('Original Title').click();
		expect(document.getElementById('detail-title')?.textContent).toBe('Original Title');

		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Renamed', status: 'busy' })],
			})
		);
		expect(document.getElementById('detail-title')?.textContent).toBe('Renamed');
		expect(document.getElementById('detail-status-label')?.textContent).toBe('busy');
	});

	it('closes the detail pane automatically when its card leaves the board', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Going Away' })] })
		);
		findCardElement('Going Away').click();
		expect(document.getElementById('detail')?.hidden).toBe(false);

		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-2::tab-2',
						sessionId: 'session-2',
						tabId: 'tab-2',
						title: 'New Card',
					}),
				],
			})
		);
		expect(document.getElementById('detail')?.hidden).toBe(true);
	});

	// ---------------------------------------------------------------------
	// Phase 03 keyboard access. The board has to be usable without a mouse,
	// and the keyboard move has to be the SAME move a drag makes - same
	// legality check, same `move` payload - or one of the two will rot.
	// ---------------------------------------------------------------------

	it('selects the first card on the board on the first arrow key, then walks the column', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({ key: 'session-1::tab-1', title: 'First' }),
					makeCard({
						key: 'session-2::tab-2',
						sessionId: 'session-2',
						tabId: 'tab-2',
						title: 'Second',
					}),
				],
			})
		);

		expect(selectedCardTitle()).toBeNull();
		// Nothing selected yet, so the first press points at a card rather
		// than doing nothing at all.
		press('ArrowDown');
		expect(selectedCardTitle()).toBe('First');
		// The selection takes real focus, which is what scrolls it into view.
		expect(document.activeElement).toBe(findCardElement('First'));

		press('ArrowDown');
		expect(selectedCardTitle()).toBe('Second');
		press('ArrowDown');
		// The bottom of the column is a wall, not a wrap.
		expect(selectedCardTitle()).toBe('Second');
		press('ArrowUp');
		expect(selectedCardTitle()).toBe('First');
		press('ArrowUp');
		expect(selectedCardTitle()).toBe('First');
	});

	it('crosses columns with Left/Right, skipping empty ones and stopping at the board edge', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Only Backlog' })],
				review: [
					makeCard({
						key: 'session-2::tab-2',
						sessionId: 'session-2',
						tabId: 'tab-2',
						title: 'Review One',
					}),
					makeCard({
						key: 'session-3::tab-3',
						sessionId: 'session-3',
						tabId: 'tab-3',
						title: 'Review Two',
					}),
				],
			})
		);

		press('ArrowRight');
		expect(selectedCardTitle()).toBe('Only Backlog');
		// In Progress is empty: stopping on it would read as a dead key, so the
		// selection crosses to the next column that actually has a card.
		press('ArrowRight');
		expect(selectedCardTitle()).toBe('Review One');
		press('ArrowDown');
		expect(selectedCardTitle()).toBe('Review Two');
		// Blocked and Done are empty too, so Right has nowhere left to go.
		press('ArrowRight');
		expect(selectedCardTitle()).toBe('Review Two');
		// Row 1 has no counterpart in a one-card column, so it clamps.
		press('ArrowLeft');
		expect(selectedCardTitle()).toBe('Only Backlog');
	});

	it("opens the selected card's tab directly on Enter, the same focus payload Open Tab posts", () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-9::tab-9',
						sessionId: 'session-9',
						tabId: 'tab-9',
						title: 'Enter Me',
					}),
				],
			})
		);

		press('ArrowDown');
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('Enter');

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'focus',
			args: { sessionId: 'session-9', tabId: 'tab-9' },
		});
	});

	it('does nothing on Enter when no card is selected, rather than guessing one', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Untouched' })] })
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('Enter');

		expect(postMessageSpy).not.toHaveBeenCalled();
	});

	it('posts the move command a drag would when Alt plus an arrow moves the selected card', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					boardId: '/Users/dev/projects/widgets',
					columns: [
						{
							id: 'backlog',
							title: 'Backlog',
							cards: [makeCard({ key: 'session-1::tab-1', title: 'Mover' })],
						},
						{
							id: 'review',
							title: 'Review',
							cards: [
								makeCard({
									key: 'session-2::tab-2',
									sessionId: 'session-2',
									tabId: 'tab-2',
									title: 'Sitting',
								}),
							],
						},
					],
				}
			)
		);

		press('ArrowRight');
		expect(selectedCardTitle()).toBe('Mover');

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('ArrowRight', { altKey: true });

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'move',
			args: {
				cardKey: 'session-1::tab-1',
				toColumnId: 'review',
				toIndex: 0,
				boardId: '/Users/dev/projects/widgets',
			},
		});
		// Applied optimistically, exactly as a drop is, and the selection
		// follows the card instead of being dropped by the re-render.
		expect(columnIdOfCard('Mover', ['backlog', 'review'])).toBe('review');
		expect(selectedCardTitle()).toBe('Mover');
	});

	it('refuses an Alt-arrow move onto a column the card cannot reach, and says why', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					columns: [
						{
							id: 'backlog',
							title: 'Backlog',
							cards: [
								makeCard({
									key: 'session-1::tab-1',
									title: 'Stuck',
									legalColumnIds: ['backlog'],
								}),
							],
						},
						{ id: 'review', title: 'Review', cards: [] },
					],
				}
			)
		);

		press('ArrowRight');
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('ArrowRight', { altKey: true });

		// Nothing posted, and the card did not move.
		expect(postMessageSpy).not.toHaveBeenCalled();
		expect(columnIdOfCard('Stuck', ['backlog', 'review'])).toBe('backlog');
		// A silently eaten key is indistinguishable from a broken board.
		const toast = document.getElementById('toast');
		expect(toast?.hidden).toBe(false);
		expect(toast?.textContent).toContain('Review');
	});

	it('refuses an Alt-arrow move into a read-only lane, the same way a drop is refused', () => {
		pushSnapshot(
			snapshotWith(
				{},
				{
					columns: [
						{
							id: 'todo',
							title: 'Todo',
							cards: [makeCard({ key: 'session-1::tab-1', title: 'Global Card' })],
						},
						{ id: '__unmapped__', title: 'Unmapped', readOnly: true, cards: [] },
					],
				}
			)
		);

		press('ArrowRight');
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('ArrowRight', { altKey: true });

		expect(postMessageSpy).not.toHaveBeenCalled();
		expect(columnIdOfCard('Global Card', ['todo', '__unmapped__'])).toBe('todo');
	});

	it('leaves the arrow keys to the board switcher, which owns them itself', () => {
		pushSnapshot(
			snapshotWith(
				{ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Not Selected' })] },
				{
					boards: [
						{
							id: '__global__',
							kind: 'global',
							name: 'Global',
							projectPath: null,
							cardCount: 1,
						},
					],
				}
			)
		);

		press('ArrowRight', {}, switcher());

		expect(selectedCardTitle()).toBeNull();
	});

	it('closes the panel on Escape, since the panel cannot dismiss itself', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Open Board' })] })
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('Escape');

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'close-panel',
			args: {},
		});
	});

	it('cancels a live drag on Escape instead of closing the panel', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'Dragging' })] })
		);

		const card = findCardElement('Dragging');
		card.dispatchEvent(new Event('dragstart', { bubbles: true }));
		expect(findCardElement('Dragging').classList.contains('dragging')).toBe(true);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		press('Escape');

		// One key press does one thing: the card comes back and the panel stays.
		expect(postMessageSpy).not.toHaveBeenCalled();
		expect(findCardElement('Dragging').classList.contains('dragging')).toBe(false);

		// And now that the drag is over, Escape closes the panel.
		press('Escape');
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect((postMessageSpy.mock.calls[0]![0] as { commandId: string }).commandId).toBe(
			'close-panel'
		);
	});

	it('keeps the selection on its card across a snapshot push, and drops it when the card leaves', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Survivor' })],
			})
		);
		press('ArrowDown');
		expect(selectedCardTitle()).toBe('Survivor');

		// A status change elsewhere must not cost the user their place.
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ key: 'session-1::tab-1', title: 'Survivor', status: 'busy' })],
			})
		);
		expect(selectedCardTitle()).toBe('Survivor');

		// The tab closed: the selection has nothing to point at any more.
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-2::tab-2',
						sessionId: 'session-2',
						tabId: 'tab-2',
						title: 'Newcomer',
					}),
				],
			})
		);
		expect(selectedCardTitle()).toBeNull();
	});
});
