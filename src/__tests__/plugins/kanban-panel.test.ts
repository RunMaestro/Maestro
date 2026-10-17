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
	clearDoneButton,
	clearDoneConfirm,
	archiveToggle,
	archiveFilter,
	archiveRows,
	archiveStatus,
	archiveSnapshotPayload,
	makeArchiveRecord,
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

		// The click opens the pane and asks for this session's History - it is
		// not jumping to the tab (that's Open Tab's job, tested below).
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'read-history',
			args: { sessionId: 'session-9' },
		});
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

		// Escape closes the pane locally and tells the sandbox to stop tracking
		// this session's History - it does not reach close-panel (that is the
		// SECOND Escape press, tested elsewhere).
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'close-history',
			args: {},
		});
		expect(document.getElementById('detail')?.hidden).toBe(true);

		// With the detail pane now closed, Escape reaches the panel.
		postMessageSpy.mockClear();
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
	// Phase 04 access state. A card whose session this plugin cannot message
	// or read History for yet carries a "not connected" marker, and its
	// detail pane swaps the History/composer sections for an explanation and
	// an Allow Access button that runs the sandbox's `request-access`
	// command.
	// ---------------------------------------------------------------------

	it('shows a "not connected" marker on a card whose session is not access-granted', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'No Access Yet', accessGranted: false })],
			})
		);

		const card = findCardElement('No Access Yet');
		expect(card.querySelector('.card-access-marker')?.textContent).toBe('Not connected');
	});

	it('shows no marker on a card whose session is access-granted', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Connected', accessGranted: true })],
			})
		);

		const card = findCardElement('Connected');
		expect(card.querySelector('.card-access-marker')).toBeNull();
	});

	it('replaces the History and Message sections with the access gate on an ungranted card', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Ungranted Card', accessGranted: false })],
			})
		);

		findCardElement('Ungranted Card').click();

		expect(document.getElementById('detail-access-gate')?.hidden).toBe(false);
		expect(document.getElementById('detail-history-section')?.hidden).toBe(true);
		expect(document.getElementById('detail-composer-section')?.hidden).toBe(true);
		expect(document.getElementById('detail-access-message')?.textContent).toBe(
			'Kanban Board needs your OK before it can message this agent or read its History.'
		);
	});

	it('shows the History and Message sections and hides the access gate on a granted card', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Granted Card', accessGranted: true })],
			})
		);

		findCardElement('Granted Card').click();

		expect(document.getElementById('detail-access-gate')?.hidden).toBe(true);
		expect(document.getElementById('detail-history-section')?.hidden).toBe(false);
		expect(document.getElementById('detail-composer-section')?.hidden).toBe(false);
	});

	it('posts request-access for the card session when Allow Access is clicked', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-5::tab-5',
						sessionId: 'session-5',
						tabId: 'tab-5',
						title: 'Ask For Access',
						accessGranted: false,
					}),
				],
			})
		);

		findCardElement('Ask For Access').click();
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		document.getElementById('detail-allow-access')?.click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'request-access',
			args: { sessionId: 'session-5' },
		});
	});

	it('switches the open detail pane to the granted state once the next snapshot reports it', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Pending Approval', accessGranted: false })],
			})
		);
		findCardElement('Pending Approval').click();
		expect(document.getElementById('detail-access-gate')?.hidden).toBe(false);

		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Pending Approval', accessGranted: true })],
			})
		);

		expect(document.getElementById('detail-access-gate')?.hidden).toBe(true);
		expect(document.getElementById('detail-history-section')?.hidden).toBe(false);
	});

	// ---------------------------------------------------------------------
	// Phase 04 card notes. A description and a comment thread, both read
	// straight off the snapshot and written through the sandbox's
	// `card-note` command - the panel never touches storage itself. Neither
	// is gated by accessGranted, so these run against makeCard()'s default
	// (granted) card.
	// ---------------------------------------------------------------------

	it('populates the description field from the snapshot when the detail pane opens', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Noted', description: 'Already written.' })],
			})
		);

		findCardElement('Noted').click();

		const input = document.getElementById('detail-description-input') as HTMLTextAreaElement;
		expect(input.value).toBe('Already written.');
	});

	it('posts a card-note description write when the description field blurs', () => {
		pushSnapshot(snapshotWith({ backlog: [makeCard({ title: 'Edit Me' })] }));
		findCardElement('Edit Me').click();

		const input = document.getElementById('detail-description-input') as HTMLTextAreaElement;
		input.value = 'New description.';
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		input.focus();
		input.blur();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'card-note',
			args: {
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'New description.',
			},
		});
	});

	it('does not overwrite the description field with a stale snapshot while it is focused', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Mid Edit', description: 'Original.' })],
			})
		);
		findCardElement('Mid Edit').click();

		const input = document.getElementById('detail-description-input') as HTMLTextAreaElement;
		input.focus();
		input.value = 'Still typing...';

		// A render can run anytime - here, because an unrelated event changed
		// the card's status - and must not clobber the in-progress edit.
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Mid Edit', description: 'Original.', status: 'busy' })],
			})
		);

		expect(input.value).toBe('Still typing...');
	});

	it('shows the empty-comments placeholder and no comment rows when there are none', () => {
		pushSnapshot(snapshotWith({ backlog: [makeCard({ title: 'No Comments Yet' })] }));
		findCardElement('No Comments Yet').click();

		expect(document.getElementById('detail-comments-empty')?.hidden).toBe(false);
		expect(document.getElementById('detail-comments-list')?.children.length).toBe(0);
	});

	it('renders the comment thread in storage order, oldest first and newest last', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						title: 'Discussed',
						comments: [
							{ id: 'c1', body: 'First comment', createdAt: 1000 },
							{ id: 'c2', body: 'Second comment', createdAt: 2000 },
						],
					}),
				],
			})
		);

		findCardElement('Discussed').click();

		expect(document.getElementById('detail-comments-empty')?.hidden).toBe(true);
		const bodies = Array.from(
			document.querySelectorAll('#detail-comments-list .detail-comment-body')
		).map((el) => el.textContent);
		expect(bodies).toEqual(['First comment', 'Second comment']);
	});

	it('posts a card-note comment write and clears the field when Add Comment is clicked', () => {
		pushSnapshot(snapshotWith({ backlog: [makeCard({ title: 'Commentable' })] }));
		findCardElement('Commentable').click();

		const input = document.getElementById('detail-comment-input') as HTMLTextAreaElement;
		input.value = 'A new comment';
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		document.getElementById('detail-comment-add')?.click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'card-note',
			args: { cardKey: 'session-1::tab-1', action: 'comment', body: 'A new comment' },
		});
		expect(input.value).toBe('');
	});

	it('does not post a blank comment', () => {
		pushSnapshot(snapshotWith({ backlog: [makeCard({ title: 'No Blank Comments' })] }));
		findCardElement('No Blank Comments').click();

		const input = document.getElementById('detail-comment-input') as HTMLTextAreaElement;
		input.value = '   ';
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		document.getElementById('detail-comment-add')?.click();

		expect(postMessageSpy).not.toHaveBeenCalled();
	});

	it('works on an ungranted card: the description and comment fields are not part of the access gate', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [makeCard({ title: 'Ungranted But Noted', accessGranted: false })],
			})
		);
		findCardElement('Ungranted But Noted').click();

		expect(document.getElementById('detail-access-gate')?.hidden).toBe(false);
		const descriptionInput = document.getElementById(
			'detail-description-input'
		) as HTMLTextAreaElement;
		descriptionInput.value = 'Works even ungranted.';
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		descriptionInput.focus();
		descriptionInput.blur();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'card-note',
			args: {
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'Works even ungranted.',
			},
		});
	});

	// ---------------------------------------------------------------------
	// Phase 04 History excerpt. The detail pane asks the sandbox's
	// `read-history` command for a granted card's session the moment the pane
	// opens on it (never for every card on the board, never on a timer), reads
	// the result back off the snapshot's `historyExcerpt`, and tells the
	// sandbox when it is done looking via `close-history` so a closed pane
	// does not keep spending the host's rate-limited transcripts.read budget.
	// ---------------------------------------------------------------------

	it('posts read-history for the card session when the detail pane opens on a granted card', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-7::tab-7',
						sessionId: 'session-7',
						tabId: 'tab-7',
						title: 'Granted Seven',
						accessGranted: true,
					}),
				],
			})
		);
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		findCardElement('Granted Seven').click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'read-history',
			args: { sessionId: 'session-7' },
		});
	});

	it('does not ask for History again when the same card is clicked a second time', () => {
		pushSnapshot(snapshotWith({ backlog: [makeCard({ title: 'Already Open' })] }));
		findCardElement('Already Open').click();
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		findCardElement('Already Open').click();

		expect(postMessageSpy).not.toHaveBeenCalled();
	});

	it('does not re-ask for History when switching between two cards of the same session', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-12::tab-a',
						sessionId: 'session-12',
						tabId: 'tab-a',
						title: 'Tab A',
					}),
					makeCard({
						key: 'session-12::tab-b',
						sessionId: 'session-12',
						tabId: 'tab-b',
						title: 'Tab B',
					}),
				],
			})
		);
		findCardElement('Tab A').click();
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		findCardElement('Tab B').click();

		expect(postMessageSpy).not.toHaveBeenCalled();
	});

	it('does not ask for History when the detail pane opens on an ungranted card', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ title: 'No Access', accessGranted: false })] })
		);
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		findCardElement('No Access').click();

		expect(postMessageSpy).not.toHaveBeenCalled();
	});

	it("shows a loading state until a snapshot carries this session's excerpt", () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ title: 'Waiting', sessionId: 'session-9' })] })
		);

		findCardElement('Waiting').click();

		expect(document.getElementById('detail-history-body')?.textContent).toContain(
			'Loading recent History'
		);
	});

	it('renders the History excerpt once a matching snapshot arrives, labeled as covering every tab', () => {
		const card = makeCard({ title: 'Loaded', sessionId: 'session-3' });
		pushSnapshot(snapshotWith({ backlog: [card] }));
		findCardElement('Loaded').click();

		pushSnapshot(
			snapshotWith(
				{ backlog: [card] },
				{
					historyExcerpt: {
						sessionId: 'session-3',
						status: 'loaded',
						rows: [
							{ summary: 'Did a thing', timestamp: 1700000000000, type: 'text', success: true },
						],
						error: null,
					},
				}
			)
		);

		const body = document.getElementById('detail-history-body');
		expect(body?.textContent).toContain('Did a thing');
		expect(body?.textContent).toContain('every tab');
	});

	it('shows a specific empty state rather than a blank box when there is no recent History', () => {
		const card = makeCard({ title: 'Empty', sessionId: 'session-6' });
		pushSnapshot(snapshotWith({ backlog: [card] }));
		findCardElement('Empty').click();

		pushSnapshot(
			snapshotWith(
				{ backlog: [card] },
				{ historyExcerpt: { sessionId: 'session-6', status: 'loaded', rows: [], error: null } }
			)
		);

		expect(document.getElementById('detail-history-body')?.textContent).toContain(
			'No recent History'
		);
	});

	it('renders a specific "History not available" message naming the reason for a non-grant denial', () => {
		const card = makeCard({ title: 'Errored', sessionId: 'session-4' });
		pushSnapshot(snapshotWith({ backlog: [card] }));
		findCardElement('Errored').click();

		pushSnapshot(
			snapshotWith(
				{ backlog: [card] },
				{
					historyExcerpt: {
						sessionId: 'session-4',
						status: 'error',
						rows: [],
						error: 'rate limited',
					},
				}
			)
		);

		expect(document.getElementById('detail-history-body')?.textContent).toBe(
			'History not available: rate limited'
		);
	});

	it('posts close-history when the detail pane closes on a granted card', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ title: 'Closing', sessionId: 'session-8' })] })
		);
		findCardElement('Closing').click();
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		document.getElementById('detail-close')?.click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'close-history',
			args: {},
		});
	});

	it('posts close-history when the pane switches from a granted card to an ungranted one', () => {
		pushSnapshot(
			snapshotWith({
				backlog: [
					makeCard({
						key: 'session-10::tab-10',
						sessionId: 'session-10',
						tabId: 'tab-10',
						title: 'Granted Ten',
						accessGranted: true,
					}),
					makeCard({
						key: 'session-11::tab-11',
						sessionId: 'session-11',
						tabId: 'tab-11',
						title: 'Ungranted Eleven',
						accessGranted: false,
					}),
				],
			})
		);
		findCardElement('Granted Ten').click();
		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		findCardElement('Ungranted Eleven').click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'close-history',
			args: {},
		});
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

	// ---------------------------------------------------------------------
	// Phase 05 manual Done maintenance. The header's Clear Done asks before
	// it retires anything, in the panel rather than with window.confirm(),
	// and names the count the sandbox reported; the detail pane's Archive Now
	// retires the one card the pane is open on. Both only ever post a
	// command - the panel never takes a card off the board itself.
	// ---------------------------------------------------------------------

	it('hides Clear Done while nothing is in Done and names the count once something is', () => {
		pushSnapshot(snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1' })] }));
		expect(clearDoneButton().hidden).toBe(true);

		pushSnapshot(
			snapshotWith(
				{ done: [makeCard({ key: 'session-1::tab-1' }), makeCard({ key: 'session-2::tab-2' })] },
				{ doneCardCount: 2 }
			)
		);
		expect(clearDoneButton().hidden).toBe(false);
		expect(clearDoneButton().textContent).toBe('Clear Done (2)');
	});

	it('asks in the panel, naming the count, and retires nothing until the confirm is answered', () => {
		pushSnapshot(
			snapshotWith(
				{ done: [makeCard({ key: 'session-1::tab-1' }), makeCard({ key: 'session-2::tab-2' })] },
				{ boardId: '/Users/dev/projects/widgets', doneCardCount: 2 }
			)
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		clearDoneButton().click();

		// The click asks; it does not clear. Nothing has been posted yet.
		expect(postMessageSpy).not.toHaveBeenCalled();
		const asked = clearDoneConfirm();
		expect(asked.hidden).toBe(false);
		expect(asked.message).toContain('2 cards');
		// The one thing a person needs to know before answering: this does not
		// cost them their tabs.
		expect(asked.message).toContain('Their tabs stay open');

		document.getElementById('clear-done-confirm-yes')?.click();
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'clear-done',
			// Echoed back so the sandbox can refuse a clear aimed at a board the
			// user has since switched away from.
			args: { boardId: '/Users/dev/projects/widgets' },
		});
		// The question is answered, so it is gone.
		expect(clearDoneConfirm().hidden).toBe(true);
		postMessageSpy.mockRestore();
	});

	it('says "1 card" rather than "1 cards" for a single Done card', () => {
		pushSnapshot(
			snapshotWith({ done: [makeCard({ key: 'session-1::tab-1' })] }, { doneCardCount: 1 })
		);
		clearDoneButton().click();
		expect(clearDoneConfirm().message).toContain('1 card from Done');
		expect(clearDoneConfirm().message).toContain('Its tab stays open');
	});

	it('posts nothing when the confirm is cancelled, by button or by Escape', () => {
		pushSnapshot(
			snapshotWith({ done: [makeCard({ key: 'session-1::tab-1' })] }, { doneCardCount: 1 })
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		clearDoneButton().click();
		// The keyboard lands on Cancel, never on the button that empties Done.
		expect(document.activeElement?.id).toBe('clear-done-confirm-no');
		document.getElementById('clear-done-confirm-no')?.click();
		expect(clearDoneConfirm().hidden).toBe(true);
		expect(postMessageSpy).not.toHaveBeenCalled();

		// Escape is the key that means "no", so it answers the confirm before
		// it reaches the detail pane or the panel itself.
		clearDoneButton().click();
		expect(clearDoneConfirm().hidden).toBe(false);
		press('Escape');
		expect(clearDoneConfirm().hidden).toBe(true);
		expect(postMessageSpy).not.toHaveBeenCalled();

		// With the confirm gone, Escape reaches the panel again.
		press('Escape');
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect((postMessageSpy.mock.calls[0]![0] as { commandId: string }).commandId).toBe(
			'close-panel'
		);
		postMessageSpy.mockRestore();
	});

	it('withdraws an open confirm once Done has emptied itself', () => {
		pushSnapshot(
			snapshotWith({ done: [makeCard({ key: 'session-1::tab-1' })] }, { doneCardCount: 1 })
		);
		clearDoneButton().click();
		expect(clearDoneConfirm().hidden).toBe(false);

		// The card aged out (or was dragged away) while the question was up:
		// a confirm naming a count that is now zero has no answer.
		pushSnapshot(snapshotWith({}, { doneCardCount: 0 }));
		expect(clearDoneConfirm().hidden).toBe(true);
		expect(clearDoneButton().hidden).toBe(true);
	});

	it('posts archive-card for the card the detail pane is open on, and leaves the pane to the next snapshot', () => {
		pushSnapshot(
			snapshotWith(
				{
					done: [
						makeCard({
							key: 'session-9::tab-9',
							sessionId: 'session-9',
							tabId: 'tab-9',
							title: 'Archive Me',
						}),
					],
				},
				{ doneCardCount: 1 }
			)
		);
		findCardElement('Archive Me').click();
		expect(document.getElementById('detail')?.hidden).toBe(false);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		document.getElementById('detail-archive-now')?.click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'archive-card',
			args: { cardKey: 'session-9::tab-9' },
		});
		// The pane stays until the card actually leaves the board, so a refused
		// archive does not look like a successful one.
		expect(document.getElementById('detail')?.hidden).toBe(false);

		pushSnapshot(snapshotWith({}, { doneCardCount: 0 }));
		expect(document.getElementById('detail')?.hidden).toBe(true);
		postMessageSpy.mockRestore();
	});

	// ---------------------------------------------------------------------
	// Phase 05 archive view. A second mode of the same panel: the board is
	// hidden, the retired records are listed newest first, and the only
	// action on a row is one POST - whether a card can come back is the
	// sandbox's answer, read off the row's `hasLiveTab`.
	// ---------------------------------------------------------------------

	it('toggles into the archive and back, posting archive-view each way and hiding the board', () => {
		pushSnapshot(
			snapshotWith({ done: [makeCard({ key: 'session-1::tab-1' })] }, { doneCardCount: 1 })
		);
		expect(archiveToggle().textContent).toBe('Archive');
		expect(board().hidden).toBe(false);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		archiveToggle().click();

		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'archive-view',
			args: { open: true, filter: '' },
		});
		expect(board().hidden).toBe(true);
		expect(document.getElementById('archive')?.hidden).toBe(false);
		expect(archiveToggle().textContent).toBe('Board');
		expect(archiveToggle().getAttribute('aria-pressed')).toBe('true');
		// Clear Done acts on the board, so it is not offered over the archive.
		expect(clearDoneButton().hidden).toBe(true);
		// Nothing has come back yet, so the view says so rather than claiming
		// the archive is empty.
		expect(archiveStatus().empty).toBe('Loading the archive...');

		archiveToggle().click();
		expect(postMessageSpy.mock.calls[1]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'archive-view',
			args: { open: false, filter: '' },
		});
		expect(board().hidden).toBe(false);
		expect(document.getElementById('archive')?.hidden).toBe(true);
		expect(clearDoneButton().hidden).toBe(false);
		postMessageSpy.mockRestore();
	});

	it('lists retired records newest first with their project, date and reason, and marks the live tabs', () => {
		archiveToggle().click();
		pushSnapshot(
			snapshotWith(
				{},
				{
					archive: archiveSnapshotPayload([
						makeArchiveRecord({
							key: 'session-1::tab-9',
							title: 'Newest',
							retiredAt: Date.UTC(2026, 2, 14, 12, 0, 0),
							reason: 'aged out of Done',
							projectName: 'widgets',
							projectPath: '/Users/dev/projects/widgets',
							agentName: 'Widget Agent',
						}),
						makeArchiveRecord({
							key: 'session-2::tab-8',
							title: 'Older',
							retiredAt: Date.UTC(2026, 1, 1, 9, 0, 0),
							reason: 'cleared out of Done by hand',
							hasLiveTab: false,
						}),
					]),
				}
			)
		);

		const rows = archiveRows();
		expect(rows.map((row) => row.title)).toEqual(['Newest', 'Older']);
		expect(rows[0]!.meta).toContain('widgets');
		expect(rows[0]!.meta).toContain('Widget Agent');
		// An ISO day, so it never reads as a different date than it says.
		expect(rows[0]!.meta).toContain('retired 2026-03-14');
		expect(rows[0]!.meta).toContain('aged out of Done');
		expect(rows[1]!.meta).toContain('cleared out of Done by hand');
		// The thing the task asks to be obvious: which records still have a
		// tab behind them.
		expect(rows[0]!.marker).toBe('Tab open');
		expect(rows[1]!.marker).toBe('No tab');
		expect(archiveStatus().count).toContain('2 retired cards');
	});

	it("offers Restore only for a record whose tab is still open, and posts that record's own board", () => {
		archiveToggle().click();
		pushSnapshot(
			snapshotWith(
				{},
				{
					archive: archiveSnapshotPayload([
						makeArchiveRecord({
							key: 'session-1::tab-1',
							title: 'Can Come Back',
							boardId: '/Users/dev/projects/widgets',
						}),
						makeArchiveRecord({
							key: 'session-2::tab-2',
							title: 'Tab Is Gone',
							hasLiveTab: false,
						}),
						makeArchiveRecord({
							key: 'session-3::tab-3',
							title: 'Cannot Tell',
							hasLiveTab: null,
						}),
					]),
				}
			)
		);

		const rows = archiveRows();
		expect(rows.map((row) => row.restoreDisabled)).toEqual([false, true, true]);
		// A read-only row says why, rather than offering a dead button.
		expect(rows[1]!.restore.title).toContain('no tab left to restore it to');
		expect(rows[2]!.marker).toBe('Tab unknown');

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		rows[1]!.restore.click();
		rows[2]!.restore.click();
		// A disabled control is wired to nothing at all, not merely dimmed.
		expect(postMessageSpy).not.toHaveBeenCalled();

		rows[0]!.restore.click();
		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'restore-card',
			args: { cardKey: 'session-1::tab-1', boardId: '/Users/dev/projects/widgets' },
		});
		postMessageSpy.mockRestore();
	});

	it('debounces the filter into one post, and renders what the sandbox filtered', () => {
		vi.useFakeTimers();
		try {
			archiveToggle().click();
			const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

			const input = archiveFilter();
			input.value = 'shi';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.value = 'ship';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			// Still inside the debounce: the sandbox re-reads the archive files
			// to answer one of these, so a held key must not be a read per key.
			expect(postMessageSpy).not.toHaveBeenCalled();

			vi.advanceTimersByTime(200);
			expect(postMessageSpy).toHaveBeenCalledTimes(1);
			expect(postMessageSpy.mock.calls[0]![0]).toEqual({
				type: 'maestro:invokeCommand',
				commandId: 'archive-view',
				args: { open: true, filter: 'ship' },
			});

			pushSnapshot(
				snapshotWith(
					{},
					{
						archive: archiveSnapshotPayload(
							[makeArchiveRecord({ key: 'session-1::tab-1', title: 'Ship the thing' })],
							{ filter: 'ship', total: 1, archivedTotal: 4 }
						),
					}
				)
			);
			expect(archiveRows().map((row) => row.title)).toEqual(['Ship the thing']);
			expect(archiveStatus().count).toContain('matching');
			// The box is never written from a snapshot: the user may still be
			// typing into it while the previous keystroke's answer arrives.
			expect(archiveFilter().value).toBe('ship');
			postMessageSpy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it('says an empty archive is empty, a filter found nothing, and an unreadable file is safe', () => {
		archiveToggle().click();
		pushSnapshot(snapshotWith({}, { archive: archiveSnapshotPayload([]) }));
		expect(archiveRows()).toHaveLength(0);
		expect(archiveStatus().empty).toContain('Nothing has been retired');
		expect(archiveStatus().count).toBe('');

		pushSnapshot(
			snapshotWith({}, { archive: archiveSnapshotPayload([], { filter: 'nope', total: 0 }) })
		);
		expect(archiveStatus().empty).toBe('No retired card matches "nope".');

		pushSnapshot(
			snapshotWith(
				{},
				{
					archive: archiveSnapshotPayload([], {
						errors: [
							{ path: '~/.maestro/kanban-archive/widgets-1a2b3c4d.json', message: 'bad JSON' },
						],
					}),
				}
			)
		);
		const error = archiveStatus().error ?? '';
		expect(error).toContain('~/.maestro/kanban-archive/widgets-1a2b3c4d.json');
		// The one thing a person needs to be told about a broken archive file.
		expect(error).toContain('Nothing is written to it until it parses again');
	});

	it('backs out of the archive on Escape before it closes the panel, and leaves the board keys alone while it is up', () => {
		pushSnapshot(
			snapshotWith({ backlog: [makeCard({ key: 'session-1::tab-1', title: 'On The Board' })] })
		);
		archiveToggle().click();
		pushSnapshot(
			snapshotWith(
				{ backlog: [makeCard({ key: 'session-1::tab-1', title: 'On The Board' })] },
				{ archive: archiveSnapshotPayload([makeArchiveRecord()]) }
			)
		);

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		// The board is hidden, so arrowing around it would be navigating
		// something nobody can see.
		press('ArrowDown');
		expect(selectedCardTitle()).toBeNull();

		press('Escape');
		expect(board().hidden).toBe(false);
		expect(
			postMessageSpy.mock.calls.map((call) => (call[0] as { commandId: string }).commandId)
		).toEqual(['archive-view']);

		// With the archive closed, Escape reaches the panel again.
		press('Escape');
		expect(
			postMessageSpy.mock.calls.map((call) => (call[0] as { commandId: string }).commandId)
		).toEqual(['archive-view', 'close-panel']);
		postMessageSpy.mockRestore();
	});
});
