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
	cards: SnapshotCard[];
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
 * emits when a board file failed to parse. */
function snapshotWith(
	byColumn: Partial<Record<string, SnapshotCard[]>>,
	opts: { boardError?: { message: string; path: string } | null; columns?: SnapshotColumn[] } = {}
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
