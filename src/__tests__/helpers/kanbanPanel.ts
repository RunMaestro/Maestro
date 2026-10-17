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
	/** Phase 04 card notes: this plugin's own storage, keyed by card key and
	 * never gated by accessGranted (see noteFor() in main.js). */
	description?: string;
	comments?: { id: string; body: string; createdAt: number }[];
	lastCommentAt?: number | null;
	/** Phase 04 messaging: the last `send-message` attempt's outcome for this
	 * card (see `lastMessageOutcomes` in main.js), or null/absent when nothing
	 * has ever been sent. */
	messageOutcome?: { status: 'sent' | 'failed'; error: string | null; at: number } | null;
	/** Phase 05 Done decay: `agingRenderState()`'s numbers in main.js. Present
	 * only on a card the terminal column is currently aging, which is what the
	 * panel reads as "there is a fade and a countdown to draw here"; absent on
	 * every other card. */
	aging?: SnapshotCardAging;
}

/** The `aging` payload one card carries, matching `agingRenderState()` in
 * main.js. `opacity` is the RENDER opacity, already floored at
 * AGING_RENDER_OPACITY_FLOOR (0.4) rather than the model's 0.1, so a card
 * still on the board is never drawn past legibility. */
export interface SnapshotCardAging {
	opacity: number;
	elapsedDays: number;
	horizonDays: number;
	daysRemaining: number;
	expiringSoon: boolean;
	expired: boolean;
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

/** Phase 04 History excerpt: the one session a detail pane has asked
 * `read-history` about, and what main.js's cache holds for it - see
 * `historyExcerptSnapshot()`. Null when no pane has asked (or the session it
 * asked about is no longer granted). */
/** One row of the Phase 05 archive view, matching `archiveViewRow()` in
 * main.js. `hasLiveTab` is a THIRD state: true the tab is still open (so the
 * record can be restored), false it is gone (so the record is read-only), and
 * null the host would not say. */
export interface SnapshotArchiveRecord {
	key: string;
	boardId: string | null;
	title: string;
	projectPath: string | null;
	projectName: string | null;
	agentName: string | null;
	retiredAt: number;
	reason: string;
	columnHistory?: string[];
	description?: string;
	commentCount?: number;
	comments?: { id: string; body: string; createdAt: number }[];
	hasLiveTab: boolean | null;
}

/** The Phase 05 archive payload, which rides on the snapshot only while the
 * panel has that view open - see `buildArchiveView()` in main.js. */
export interface SnapshotArchive {
	open: true;
	filter: string;
	boardName?: string;
	boardCount?: number;
	records: SnapshotArchiveRecord[];
	total: number;
	hidden: number;
	archivedTotal?: number;
	errors: { path: string; message: string }[];
	tabsUnknown: boolean;
}

/** Phase 05 board settings payload, matching `boardSettingsSnapshot()` in
 * main.js. Unlike the archive payload it rides EVERY snapshot (answering it
 * is a Map lookup in the sandbox, not a file read), so the panel's surface
 * opens on real values with no round trip. `boardId` null is the unnamed
 * pre-activation board, which has nowhere to store settings. */
export interface SnapshotBoardSettings {
	boardId: string | null;
	boardName: string;
	agingEnabled: boolean;
	horizonDays: number;
	closeTabsOnRetire: boolean;
	/** True when this board has nothing stored of its own, so the values came
	 * from `inheritedFrom` (the Global board) or the defaults. */
	inherited: boolean;
	inheritedFrom: string | null;
	minHorizonDays: number;
	maxHorizonDays: number;
}

export interface SnapshotHistoryExcerpt {
	sessionId: string;
	status: 'loading' | 'loaded' | 'error';
	rows: { summary?: string; timestamp?: number; type?: string; success?: boolean }[];
	error: string | null;
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
		historyExcerpt?: SnapshotHistoryExcerpt | null;
		/** Phase 05: how many cards Clear Done would retire right now, per
		 * `cardsInTerminalColumn()` in main.js. The panel's confirm names this
		 * number and the control is hidden when it is zero, so it is NOT
		 * derived from the columns above - on the Global board the two are
		 * deliberately different things. */
		doneCardCount?: number;
		/** Phase 05: the archive view's payload, present ONLY while the panel
		 * has that view open (the sandbox attaches null the rest of the time,
		 * which is also what a snapshot pushed before the open post came back
		 * looks like). */
		archive?: SnapshotArchive | null;
		/** Phase 05: the board settings payload. Defaults to the board named by
		 * `boardId`/`boardName` running on the shipped defaults, which is what
		 * a board nobody has configured looks like. */
		settings?: SnapshotBoardSettings | null;
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
		historyExcerpt: opts.historyExcerpt ?? null,
		doneCardCount: opts.doneCardCount ?? 0,
		archive: opts.archive ?? null,
		settings:
			opts.settings === undefined
				? makeBoardSettings({
						boardId: opts.boardId ?? null,
						boardName: opts.boardName ?? 'All Agents',
					})
				: opts.settings,
	};
}

/** The board settings payload for a board nobody has configured: aging off,
 * the 14-day default horizon, tabs left alone. */
export function makeBoardSettings(
	overrides: Partial<SnapshotBoardSettings> = {}
): SnapshotBoardSettings {
	return {
		boardId: '/Users/dev/projects/maestro',
		boardName: 'maestro',
		agingEnabled: false,
		horizonDays: 14,
		closeTabsOnRetire: false,
		inherited: true,
		inheritedFrom: null,
		minHorizonDays: 1,
		maxHorizonDays: 365,
		...overrides,
	};
}

/** A card's aging payload mid-horizon: day 7 of 14, so it is plainly faded
 * and plainly not about to go. The two interesting edges are the ends -
 * `daysRemaining` at or under a day (the distinct marker) and `expired`
 * (the sweep has not reached it yet) - and a test asks for those by name. */
export function makeCardAging(overrides: Partial<SnapshotCardAging> = {}): SnapshotCardAging {
	return {
		opacity: 0.7,
		elapsedDays: 7,
		horizonDays: 14,
		daysRemaining: 7,
		expiringSoon: false,
		expired: false,
		...overrides,
	};
}

/** One archive row shaped like `archiveViewRow()`'s output, with a live tab
 * behind it unless the test says otherwise. */
export function makeArchiveRecord(
	overrides: Partial<SnapshotArchiveRecord> = {}
): SnapshotArchiveRecord {
	return {
		key: 'session-1::tab-1',
		boardId: '/Users/dev/projects/maestro',
		title: 'Retired Tab',
		projectPath: '/Users/dev/projects/maestro',
		projectName: 'maestro',
		agentName: 'Widget Agent',
		retiredAt: Date.UTC(2026, 2, 14, 12, 0, 0),
		reason: 'aged out of Done',
		columnHistory: ['backlog', 'done'],
		description: '',
		commentCount: 0,
		comments: [],
		hasLiveTab: true,
		...overrides,
	};
}

/** The archive payload wrapped around a set of rows, with the counts the view
 * reads already consistent with them. */
export function archiveSnapshotPayload(
	records: SnapshotArchiveRecord[],
	opts: Partial<Omit<SnapshotArchive, 'records'>> = {}
): SnapshotArchive {
	return {
		open: true,
		filter: opts.filter ?? '',
		boardName: opts.boardName ?? 'maestro',
		boardCount: opts.boardCount ?? 1,
		records,
		total: opts.total ?? records.length,
		hidden: opts.hidden ?? 0,
		archivedTotal: opts.archivedTotal ?? records.length,
		errors: opts.errors ?? [],
		tabsUnknown: opts.tabsUnknown ?? false,
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
		description: '',
		comments: [],
		lastCommentAt: null,
		messageOutcome: null,
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

/** The header's Phase 05 Clear Done button. */
export function clearDoneButton(): HTMLButtonElement {
	const el = document.getElementById('clear-done');
	if (!(el instanceof HTMLButtonElement)) throw new Error('panel.html has no #clear-done');
	return el;
}

/** The in-panel Clear Done confirm row, with the text it is asking. */
export function clearDoneConfirm(): { row: HTMLElement; message: string; hidden: boolean } {
	const row = document.getElementById('clear-done-confirm');
	if (!row) throw new Error('panel.html has no #clear-done-confirm');
	return {
		row,
		message: document.getElementById('clear-done-confirm-message')?.textContent ?? '',
		hidden: Boolean(row.hidden),
	};
}

/** The header's Phase 05 Archive toggle. */
export function archiveToggle(): HTMLButtonElement {
	const el = document.getElementById('archive-toggle');
	if (!(el instanceof HTMLButtonElement)) throw new Error('panel.html has no #archive-toggle');
	return el;
}

/** The archive view's filter box. */
export function archiveFilter(): HTMLInputElement {
	const el = document.getElementById('archive-filter');
	if (!(el instanceof HTMLInputElement)) throw new Error('panel.html has no #archive-filter');
	return el;
}

/** One rendered archive row, read the way a person reads it: the title, the
 * live-tab marker's label, the meta line, and whether Restore is offered. */
export interface RenderedArchiveRow {
	key: string;
	title: string;
	marker: string;
	meta: string;
	restoreDisabled: boolean;
	restore: HTMLButtonElement;
	element: HTMLElement;
}

export function archiveRows(): RenderedArchiveRow[] {
	const list = document.getElementById('archive-list');
	if (!list) throw new Error('panel.html has no #archive-list');
	return Array.from(list.querySelectorAll<HTMLElement>('.archive-row')).map((row) => {
		const restore = row.querySelector<HTMLButtonElement>('.archive-row-restore');
		if (!restore) throw new Error('an archive row was rendered with no Restore control');
		return {
			key: row.getAttribute('data-card-key') ?? '',
			title: row.querySelector('.archive-row-name')?.textContent ?? '',
			marker:
				row.querySelector('.archive-row-live')?.textContent ??
				row.querySelector('.archive-row-gone')?.textContent ??
				'',
			meta: row.querySelector('.archive-row-meta')?.textContent ?? '',
			restoreDisabled: restore.disabled,
			restore,
			element: row,
		};
	});
}

/** What the archive view says about itself: its count line, its empty state
 * (when one is shown), and the unreadable-file notice. */
export function archiveStatus(): { count: string; empty: string | null; error: string | null } {
	const empty = document.getElementById('archive-empty');
	const error = document.getElementById('archive-error');
	return {
		count: document.getElementById('archive-count')?.textContent ?? '',
		empty: empty && !empty.hidden ? (empty.textContent ?? '') : null,
		error: error && !error.hidden ? (error.textContent ?? '') : null,
	};
}

/** The header's Phase 05 Aging toggle. */
export function boardSettingsToggle(): HTMLButtonElement {
	const el = document.getElementById('board-settings-toggle');
	if (!(el instanceof HTMLButtonElement))
		throw new Error('panel.html has no #board-settings-toggle');
	return el;
}

function settingsCheckbox(id: string): HTMLInputElement {
	const el = document.getElementById(id);
	if (!(el instanceof HTMLInputElement)) throw new Error(`panel.html has no #${id}`);
	return el;
}

export function boardSettingsAging(): HTMLInputElement {
	return settingsCheckbox('board-settings-aging');
}

export function boardSettingsHorizon(): HTMLInputElement {
	return settingsCheckbox('board-settings-horizon');
}

export function boardSettingsCloseTabs(): HTMLInputElement {
	return settingsCheckbox('board-settings-close-tabs');
}

/** The settings row read the way a person reads it: whether it is up, which
 * board it says it is configuring, what it says the horizon does, and the
 * close-tabs warning (plus whether that warning is in its armed state). */
export function boardSettingsSurface(): {
	hidden: boolean;
	scope: string;
	horizonNote: string;
	warning: string;
	warningArmed: boolean;
	status: string;
} {
	const row = document.getElementById('board-settings');
	if (!row) throw new Error('panel.html has no #board-settings');
	const warning = document.getElementById('board-settings-close-tabs-warning');
	return {
		hidden: Boolean(row.hidden),
		scope: document.getElementById('board-settings-scope')?.textContent ?? '',
		horizonNote: document.getElementById('board-settings-horizon-note')?.textContent ?? '',
		warning: warning?.textContent ?? '',
		warningArmed: warning?.classList.contains('is-armed') ?? false,
		status: document.getElementById('board-settings-status')?.textContent ?? '',
	};
}

/** One card's rendered decay, read the way a person sees it: how faint it is
 * (the custom property `.card.aging` draws from - NOT an inline `opacity`,
 * which would outrank the drag feedback), the sentence hovering it states,
 * and the countdown row with whether it is in its distinct last-day form.
 * `opacity` is null and `marker` is null on a card with no decay drawn. */
export function cardAging(title: string): {
	aging: boolean;
	opacity: number | null;
	tooltip: string;
	marker: string | null;
	markerSoon: boolean;
} {
	const card = findCardElement(title);
	const raw = card.style.getPropertyValue('--card-aging-opacity').trim();
	const marker = card.querySelector<HTMLElement>('.card-aging');
	return {
		aging: card.classList.contains('aging'),
		opacity: raw === '' ? null : Number(raw),
		tooltip: card.title,
		marker: marker ? (marker.textContent ?? '') : null,
		markerSoon: marker ? marker.classList.contains('card-aging-soon') : false,
	};
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
