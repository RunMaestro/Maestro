/**
 * @file kanbanPanel.ts
 * @description Shared harness for the two suites that drive
 * `examples/plugins/maestro-kanban/panel.html` against a real DOM:
 * `kanban-panel.test.ts` (rendering, header, switcher, keyboard) and
 * `kanban-drag.test.ts` (drag, drop, reconciliation).
 *
 * The panel ships as one HTML file with a single inline `<script>`, so there is
 * no module to import. This harness extracts that script and runs it directly
 * with `new Function(script)()`, the same pattern `windowModeScript.test.ts`
 * uses for `window-mode.js`, then drives it with `window` message events the
 * way the real host delivers `maestro:panelData` and reads `postMessage` the
 * way the real host receives `maestro:invokeCommand`.
 *
 * Both suites must run under jsdom, so each is listed in `jsdomOnlyTs` in
 * `vitest.config.mts`.
 */

import { vi } from 'vitest';
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

export interface SnapshotCard {
	key: string;
	sessionId: string;
	tabId: string;
	title?: string;
	agentId?: string;
	projectPath?: string;
	status?: string;
	createdAt?: number;
	lastActivityAt?: number;
	/** Stamped by the sandbox for the global board; the panel dims every
	 * column outside this list and refuses its drops and keyboard moves. */
	legalColumnIds?: string[];
	/** Phase 04 access state: whether this plugin may message this card's
	 * session or read its History right now. */
	accessGranted?: boolean;
}

export interface SnapshotColumn {
	id: string;
	title: string;
	wipLimit?: number;
	readOnly?: boolean;
	cards: SnapshotCard[];
}

/** One entry of the board switcher, matching `boardOptions()` in main.js. */
export interface SnapshotBoard {
	id: string;
	kind: 'global' | 'project';
	name: string;
	projectPath: string | null;
	cardCount: number;
}

/** The `moveRejection` the sandbox stamps onto the next snapshot when it
 * refuses a move. The panel bridge is one-way, so a rejection can only ever
 * arrive this way and never as a reply to the post. */
export interface SnapshotMoveRejection {
	cardKey: string;
	reason: string;
}

// id -> title, matching DEFAULT_COLUMNS in main.js (the columns rendered
// before any project board is active).
export const DEFAULT_COLUMN_TITLES: Record<string, string> = {
	backlog: 'Backlog',
	'in-progress': 'In Progress',
	review: 'Review',
	blocked: 'Blocked',
	done: 'Done',
};
export const COLUMN_IDS = Object.keys(DEFAULT_COLUMN_TITLES);

/** Builds a snapshot shaped exactly like `main.js`'s `buildSnapshot()`: every
 * default column present, in order, with its title and the requested cards
 * placed by column id. `boardError` mirrors the same field buildSnapshot()
 * emits when a board file failed to parse; `activeProjectPath` and
 * `projectBoardMissing` mirror the fields it emits for the write-default-board
 * empty-state button. */
export function snapshotWith(
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
		moveRejection?: SnapshotMoveRejection | null;
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
		moveRejection: opts.moveRejection ?? null,
	};
}

export function emptySnapshot() {
	return snapshotWith({});
}

export function makeCard(overrides: Partial<SnapshotCard> = {}): SnapshotCard {
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
		// Granted by default so every test written before Phase 04's access
		// gate landed keeps seeing the pane's ordinary History/composer
		// sections; a test exercising the ungranted state sets this false.
		accessGranted: true,
		...overrides,
	};
}

let messageHandler: ((event: MessageEvent) => void) | undefined;
/** The panel's own `document` keydown listener (arrow keys, Enter, Escape).
 * Captured the same way as the message listener, and removed by
 * teardownPanel(): loadPanel() runs the script again per test, and a listener
 * left on the shared `document` would keep answering keys with the PREVIOUS
 * test's closure over `currentSnapshot`. */
let keydownHandler: ((event: KeyboardEvent) => void) | undefined;

/** Resets `#board` to the panel's static pre-script markup and re-runs the
 * panel's inline script, capturing the `message` listener it registers via a
 * spy on `addEventListener` (the listener is an anonymous closure, so this is
 * the only way to reach it directly rather than going through a real
 * `postMessage` round trip, which jsdom delivers asynchronously). */
export function loadPanel() {
	messageHandler = undefined;
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
	const originalDocumentAddEventListener = document.addEventListener.bind(document);
	const docAddSpy = vi
		.spyOn(document, 'addEventListener')
		.mockImplementation(
			(
				type: string,
				listener: EventListenerOrEventListenerObject,
				options?: boolean | AddEventListenerOptions
			) => {
				if (type === 'keydown') keydownHandler = listener as (event: KeyboardEvent) => void;
				return originalDocumentAddEventListener(type, listener, options);
			}
		);
	// eslint-disable-next-line no-new-func -- executing the panel's own inline <script> exactly as the real webview would.
	new Function(panelScript)();
	addSpy.mockRestore();
	docAddSpy.mockRestore();
}

/** Drops the listeners the loaded panel left on the shared `window` and
 * `document`, then restores every spy. Call from `afterEach`. */
export function teardownPanel() {
	if (messageHandler) window.removeEventListener('message', messageHandler);
	messageHandler = undefined;
	if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
	keydownHandler = undefined;
	// A postMessage spy a test leaves standing would otherwise be handed
	// back to the next test's vi.spyOn() with its calls already recorded.
	vi.restoreAllMocks();
}

/** Delivers a keystroke the way the webview does: a real event on a real
 * target, so the panel's own `event.target` guard is exercised rather than
 * bypassed. */
export function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
	target.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
	);
}

/** Title of the card the keyboard is pointing at, or null when nothing is.
 * Reads only the title text node, not the whole `.card-title` row, so the
 * Phase 04 "not connected" access marker sitting beside it never bleeds into
 * the answer. */
export function selectedCardTitle(): string | null {
	const selected = board().querySelector<HTMLElement>('.card.selected');
	return selected ? (selected.querySelector('.card-title-text')?.textContent ?? null) : null;
}

/** The column ids in rendered order, so a test can say which column a card
 * ended up in without reaching for a DOM index. */
export function columnIdOfCard(title: string, columnIds: string[]): string | null {
	const cardColumn = findCardElement(title).closest<HTMLElement>('.column');
	const columns = Array.from(board().querySelectorAll<HTMLElement>('.column'));
	const index = columns.findIndex((column) => column === cardColumn);
	return index === -1 ? null : (columnIds[index] ?? null);
}

export function pushSnapshot(snapshot: unknown) {
	if (!messageHandler) throw new Error('panel.html never registered a message listener');
	messageHandler(
		new MessageEvent('message', { data: { type: 'maestro:panelData', data: snapshot } })
	);
}

export function board(): HTMLElement {
	const el = document.getElementById('board');
	if (!el) throw new Error('panel.html has no #board element');
	return el;
}

export function switcher(): HTMLSelectElement {
	const el = document.getElementById('board-switcher');
	if (!(el instanceof HTMLSelectElement)) throw new Error('panel.html has no #board-switcher');
	return el;
}

export function switcherOptions(): { value: string; label: string; disabled: boolean }[] {
	return Array.from(switcher().options).map((option) => ({
		value: option.value,
		label: option.textContent ?? '',
		disabled: option.disabled,
	}));
}

export function findCardElement(title: string): HTMLElement {
	const titles = Array.from(board().querySelectorAll<HTMLElement>('.card-title'));
	const match = titles.find((el) => el.textContent?.includes(title));
	if (!match) throw new Error(`no rendered card titled "${title}"`);
	const card = match.closest<HTMLElement>('.card');
	if (!card) throw new Error('card title is not inside a .card element');
	return card;
}

/** The `.column` element for a column id, located by its rendered position in
 * `columnIds` (the panel does not stamp the id onto the element). */
export function columnElement(columnId: string, columnIds: string[]): HTMLElement {
	const index = columnIds.indexOf(columnId);
	if (index === -1) throw new Error(`"${columnId}" is not in the column list given to the test`);
	const columns = Array.from(board().querySelectorAll<HTMLElement>('.column'));
	const column = columns[index];
	if (!column) throw new Error(`no rendered column at index ${index} for "${columnId}"`);
	return column;
}

/** Titles of the cards drawn in a column, top to bottom, so a test can assert
 * an insertion POSITION rather than just which column a card landed in.
 * Reads only the title text node, not the whole `.card-title` row, so the
 * Phase 04 "not connected" access marker sitting beside it never bleeds into
 * the answer. */
export function cardTitlesIn(columnId: string, columnIds: string[]): string[] {
	const body = columnElement(columnId, columnIds).querySelector<HTMLElement>('.column-body');
	if (!body) return [];
	return Array.from(body.querySelectorAll<HTMLElement>('.card')).map(
		(card) => card.querySelector('.card-title-text')?.textContent ?? ''
	);
}
