/**
 * @file kanban-panel.test.ts
 * @description Tests for `examples/plugins/maestro-kanban/panel.html`, the
 * board UI. `examples/plugins/agent-flow/` (the template this suite was
 * supposed to be modeled on, per `agent-flow-panel.test.ts`) does not exist
 * in this checkout, consistent with every other finding in this phase. This
 * suite extracts the panel's single inline `<script>` and runs it directly
 * against jsdom with `new Function(script)()`, the same pattern
 * `windowModeScript.test.ts` uses for `window-mode.js`, then drives it with
 * `window` message events the way the real host delivers `maestro:panelData`
 * and reads the card click's `postMessage` call the way the real host
 * receives `maestro:invokeCommand`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const panelPath = path.resolve(
	fileURLToPath(import.meta.url),
	'../../../../examples/plugins/maestro-kanban/panel.html'
);
const panelHtml = readFileSync(panelPath, 'utf8');

const bodyMatch = panelHtml.match(/<body>([\s\S]*?)<script>/);
const scriptMatch = panelHtml.match(/<script>([\s\S]*?)<\/script>/);
if (!bodyMatch || !scriptMatch) {
	throw new Error('panel.html did not match the expected single <body>/<script> shape');
}
const initialBodyHtml = bodyMatch[1]!;
const panelScript = scriptMatch[1]!;

interface SnapshotCard {
	key: string;
	sessionId: string;
	tabId: string;
	title?: string;
	agentId?: string;
	projectPath?: string;
	status?: string;
	createdAt?: number;
	lastActivityAt?: number;
}

interface SnapshotColumn {
	id: string;
	title: string;
	wipLimit?: number;
	readOnly?: boolean;
	cards: SnapshotCard[];
}

/** One entry of the board switcher, matching `boardOptions()` in main.js. */
interface SnapshotBoard {
	id: string;
	kind: 'global' | 'project';
	name: string;
	projectPath: string | null;
	cardCount: number;
}

// id -> title, matching DEFAULT_COLUMNS in main.js (the columns rendered
// before any project board is active).
const DEFAULT_COLUMN_TITLES: Record<string, string> = {
	backlog: 'Backlog',
	'in-progress': 'In Progress',
	review: 'Review',
	blocked: 'Blocked',
	done: 'Done',
};
const COLUMN_IDS = Object.keys(DEFAULT_COLUMN_TITLES);

/** Builds a snapshot shaped exactly like `main.js`'s `buildSnapshot()`: every
 * default column present, in order, with its title and the requested cards
 * placed by column id. `boardError` mirrors the same field buildSnapshot()
 * emits when a board file failed to parse; `activeProjectPath` and
 * `projectBoardMissing` mirror the fields it emits for the write-default-board
 * empty-state button. */
function snapshotWith(
	byColumn: Partial<Record<string, SnapshotCard[]>>,
	opts: {
		boardError?: { message: string; path: string } | null;
		columns?: SnapshotColumn[];
		activeProjectPath?: string | null;
		projectBoardMissing?: boolean;
		boardId?: string | null;
		boardName?: string;
		boards?: SnapshotBoard[];
		boardsHidden?: number;
		globalBoardMissing?: boolean;
	} = {}
) {
	return {
		updatedAt: Date.now(),
		columns:
			opts.columns ??
			COLUMN_IDS.map((id) => ({
				id,
				title: DEFAULT_COLUMN_TITLES[id]!,
				cards: byColumn[id] ?? [],
			})),
		boardError: opts.boardError ?? null,
		activeProjectPath: opts.activeProjectPath ?? null,
		projectBoardMissing: opts.projectBoardMissing ?? false,
		boardId: opts.boardId ?? null,
		boardName: opts.boardName ?? 'All Agents',
		boards: opts.boards ?? [],
		boardsHidden: opts.boardsHidden,
		globalBoardMissing: opts.globalBoardMissing ?? false,
	};
}

function emptySnapshot() {
	return snapshotWith({});
}

function makeCard(overrides: Partial<SnapshotCard> = {}): SnapshotCard {
	return {
		key: 'session-1::tab-1',
		sessionId: 'session-1',
		tabId: 'tab-1',
		title: 'My Tab',
		agentId: 'claude-code',
		projectPath: '/Users/dev/projects/maestro',
		status: 'idle',
		createdAt: 1,
		lastActivityAt: Date.now(),
		...overrides,
	};
}

let messageHandler: ((event: MessageEvent) => void) | undefined;

/** Resets `#board` to the panel's static pre-script markup and re-runs the
 * panel's inline script, capturing the `message` listener it registers via a
 * spy on `addEventListener` (the listener is an anonymous closure, so this is
 * the only way to reach it directly rather than going through a real
 * `postMessage` round trip, which jsdom delivers asynchronously). */
function loadPanel() {
	document.body.innerHTML = initialBodyHtml;
	const originalAddEventListener = window.addEventListener.bind(window);
	const addSpy = vi
		.spyOn(window, 'addEventListener')
		.mockImplementation(
			(
				type: string,
				listener: EventListenerOrEventListenerObject,
				options?: boolean | AddEventListenerOptions
			) => {
				if (type === 'message') messageHandler = listener as (event: MessageEvent) => void;
				return originalAddEventListener(type, listener, options);
			}
		);
	// eslint-disable-next-line no-new-func -- executing the panel's own inline <script> exactly as the real webview would.
	new Function(panelScript)();
	addSpy.mockRestore();
}

function pushSnapshot(snapshot: unknown) {
	if (!messageHandler) throw new Error('panel.html never registered a message listener');
	messageHandler(
		new MessageEvent('message', { data: { type: 'maestro:panelData', data: snapshot } })
	);
}

function board(): HTMLElement {
	const el = document.getElementById('board');
	if (!el) throw new Error('panel.html has no #board element');
	return el;
}

function switcher(): HTMLSelectElement {
	const el = document.getElementById('board-switcher');
	if (!(el instanceof HTMLSelectElement)) throw new Error('panel.html has no #board-switcher');
	return el;
}

function switcherOptions(): { value: string; label: string; disabled: boolean }[] {
	return Array.from(switcher().options).map((option) => ({
		value: option.value,
		label: option.textContent ?? '',
		disabled: option.disabled,
	}));
}

function findCardElement(title: string): HTMLElement {
	const titles = Array.from(board().querySelectorAll<HTMLElement>('.card-title'));
	const match = titles.find((el) => el.textContent?.includes(title));
	if (!match) throw new Error(`no rendered card titled "${title}"`);
	const card = match.closest<HTMLElement>('.card');
	if (!card) throw new Error('card title is not inside a .card element');
	return card;
}

describe('maestro-kanban panel.html', () => {
	beforeEach(() => {
		messageHandler = undefined;
		loadPanel();
	});

	afterEach(() => {
		if (messageHandler) window.removeEventListener('message', messageHandler);
		messageHandler = undefined;
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

	it('posts the focus command with the right (sessionId, tabId) when a card is clicked', () => {
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

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		findCardElement('Click Me').click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'focus',
			args: { sessionId: 'session-9', tabId: 'tab-9' },
		});
	});
});
