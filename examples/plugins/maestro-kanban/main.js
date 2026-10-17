/** @import { MaestroSdk } from '@maestro/plugin-sdk' */
/* global module, console, setTimeout, clearTimeout */

// Fixed column ladder for Phase 01. Placement is DERIVED from live tab status
// every refresh, never stored; Phase 02 replaces deriveColumn's policy but
// keeps its (card) -> columnId shape.
const COLUMN_IDS = ['backlog', 'in-progress', 'review', 'blocked', 'done'];

// Metadata-only topics this board needs to stay live. All ten are confirmed
// real in src/shared/plugins/events.ts; agent.statusChanged is the one whose
// field names lie (see sessionIdForEvent below).
const EVENT_TOPICS = [
	'session.created',
	'session.updated',
	'session.removed',
	'session.activated',
	'agent.statusChanged',
	'agent.completed',
	'agent.error',
	'agent.exited',
	'run.completed',
	'usage.updated',
];

// Stay well under the host's 64 KB maestro.ui.panelPost budget: the sandbox
// has no TextEncoder to measure real UTF-8 bytes, so JSON string length is
// used as a conservative proxy and the target is set with headroom.
const PANEL_BUDGET_BYTES = 56 * 1024;
const REFRESH_DEBOUNCE_MS = 150;
const PANEL_PUSH_DEBOUNCE_MS = 50;

// ===========================================================================
// Phase 02 column model (pure functions only - no `sdk`/`maestro` calls, no
// I/O). This section defines the user-owned board/column shape documented in
// Phase-02-Column-Model-And-YAML-Persistence.md: a strict YAML subset parsed
// and serialized by hand because the sandbox has no `require` and therefore
// no YAML library. The filesystem plumbing that actually reads and writes
// board files through `maestro.fs.*` is a later task in that same phase.
// ===========================================================================

// The ladder from Phase 01 (COLUMN_IDS above), reshaped into the column
// model below. Used by resolveColumns() when no board file exists yet.
const DEFAULT_COLUMNS = [
	{ id: 'backlog', title: 'Backlog' },
	{ id: 'in-progress', title: 'In Progress' },
	{ id: 'review', title: 'Review' },
	{ id: 'blocked', title: 'Blocked' },
	{ id: 'done', title: 'Done', terminal: true },
];

const KNOWN_TOP_LEVEL_KEYS = ['version', 'project', 'columns'];
const KNOWN_COLUMN_KEYS = ['id', 'title', 'maps_to', 'terminal', 'wip_limit'];

function boardParseError(message) {
	const err = new Error(message);
	err.name = 'BoardParseError';
	return err;
}

/** Splits board YAML text into non-blank, non-comment lines, each carrying
 * its original 1-based line number so every rejection can cite one. Tabs are
 * rejected here, globally, before anything else is parsed. */
function boardYamlLines(text) {
	const rawLines = String(text).split(/\r\n|\r|\n/);
	const lines = [];
	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i];
		const lineNumber = i + 1;
		if (raw.indexOf('\t') !== -1) {
			throw boardParseError('Tab indentation is not supported (line ' + lineNumber + ')');
		}
		const trimmed = raw.trim();
		if (trimmed === '' || trimmed.charAt(0) === '#') continue;
		const indent = raw.length - raw.replace(/^ */, '').length;
		lines.push({ lineNumber: lineNumber, indent: indent, content: raw.slice(indent) });
	}
	return lines;
}

function rejectAnchorOrAlias(value, lineNumber) {
	const trimmed = value.trim();
	const first = trimmed.charAt(0);
	if (first === '&' || first === '*') {
		throw boardParseError('Anchors and aliases are not supported (line ' + lineNumber + ')');
	}
	if (first === '[' || first === '{') {
		throw boardParseError('Flow collections are not supported (line ' + lineNumber + ')');
	}
}

/** Parses one scalar value: quoted strings unescape per YAML's own quoting
 * rules, everything else is taken verbatim with trailing whitespace trimmed.
 * Anchors, aliases, and flow collections are rejected rather than guessed. */
function parseScalarString(rest, lineNumber) {
	const trimmedEnd = rest.replace(/\s+$/, '');
	if (
		trimmedEnd.length >= 2 &&
		trimmedEnd.charAt(0) === '"' &&
		trimmedEnd.charAt(trimmedEnd.length - 1) === '"'
	) {
		return trimmedEnd.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	if (
		trimmedEnd.length >= 2 &&
		trimmedEnd.charAt(0) === "'" &&
		trimmedEnd.charAt(trimmedEnd.length - 1) === "'"
	) {
		return trimmedEnd.slice(1, -1).replace(/''/g, "'");
	}
	rejectAnchorOrAlias(trimmedEnd, lineNumber);
	return trimmedEnd;
}

function parseKeyValue(content, lineNumber) {
	const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(content);
	if (!match) {
		throw boardParseError("Could not parse '" + content + "' (line " + lineNumber + ')');
	}
	return { key: match[1], rest: match[2], lineNumber: lineNumber };
}

function parseColumnItem(kvLines) {
	const column = {};
	const seen = new Set();
	const firstLine = kvLines.length > 0 ? kvLines[0].lineNumber : 0;
	for (let i = 0; i < kvLines.length; i++) {
		const kv = parseKeyValue(kvLines[i].content, kvLines[i].lineNumber);
		if (seen.has(kv.key)) {
			throw boardParseError(
				"Duplicate key '" + kv.key + "' in column (line " + kv.lineNumber + ')'
			);
		}
		seen.add(kv.key);
		if (KNOWN_COLUMN_KEYS.indexOf(kv.key) === -1) {
			throw boardParseError("Unknown column key '" + kv.key + "' (line " + kv.lineNumber + ')');
		}
		if (kv.rest === '') {
			throw boardParseError("'" + kv.key + "' requires a value (line " + kv.lineNumber + ')');
		}
		if (kv.key === 'id') column.id = parseScalarString(kv.rest, kv.lineNumber);
		else if (kv.key === 'title') column.title = parseScalarString(kv.rest, kv.lineNumber);
		else if (kv.key === 'maps_to') column.maps_to = parseScalarString(kv.rest, kv.lineNumber);
		else if (kv.key === 'terminal') {
			if (kv.rest !== 'true' && kv.rest !== 'false') {
				throw boardParseError("'terminal' must be true or false (line " + kv.lineNumber + ')');
			}
			column.terminal = kv.rest === 'true';
		} else if (kv.key === 'wip_limit') {
			if (!/^\d+$/.test(kv.rest)) {
				throw boardParseError(
					"'wip_limit' must be a non-negative integer (line " + kv.lineNumber + ')'
				);
			}
			column.wip_limit = parseInt(kv.rest, 10);
		}
	}
	if (!column.id) {
		throw boardParseError("Column is missing required 'id' (line " + firstLine + ')');
	}
	if (!column.title) {
		throw boardParseError("Column is missing required 'title' (line " + firstLine + ')');
	}
	return column;
}

function parseColumnsBlock(lines, startIndex) {
	const columns = [];
	const ids = new Set();
	let i = startIndex;
	if (i >= lines.length || lines[i].indent === 0) {
		const nearLine = i < lines.length ? lines[i].lineNumber : lines[startIndex - 1].lineNumber;
		throw boardParseError('columns requires at least one entry (line ' + nearLine + ')');
	}
	const dashIndent = lines[i].indent;
	while (i < lines.length && lines[i].indent > 0) {
		const entry = lines[i];
		if (entry.indent !== dashIndent) {
			throw boardParseError(
				'Unexpected indentation in columns list (line ' + entry.lineNumber + ')'
			);
		}
		const dashMatch = /^-(\s+)(\S.*)$/.exec(entry.content);
		if (!dashMatch) {
			throw boardParseError(
				"Expected a list item ('- key: value') in columns (line " + entry.lineNumber + ')'
			);
		}
		const itemContentIndent = entry.indent + 1 + dashMatch[1].length;
		const kvLines = [{ content: dashMatch[2], lineNumber: entry.lineNumber }];
		i++;
		while (i < lines.length && lines[i].indent === itemContentIndent) {
			kvLines.push({ content: lines[i].content, lineNumber: lines[i].lineNumber });
			i++;
		}
		if (i < lines.length && lines[i].indent > dashIndent) {
			throw boardParseError('Nested maps are not supported (line ' + lines[i].lineNumber + ')');
		}
		const column = parseColumnItem(kvLines);
		if (ids.has(column.id)) {
			throw boardParseError(
				"Duplicate column id '" + column.id + "' (line " + kvLines[0].lineNumber + ')'
			);
		}
		ids.add(column.id);
		columns.push(column);
	}
	return { columns: columns, nextIndex: i };
}

/**
 * Parses the strict kanban board YAML subset documented in this phase's
 * playbook entry. Pure: takes text, returns a board object, or throws
 * naming the offending key or line. No host calls.
 * @param {string} text
 * @param {{ expectProject?: boolean }} [options]
 */
function parseBoardYaml(text, options) {
	const expectProject = !!(options && options.expectProject);
	const lines = boardYamlLines(text);
	const board = {};
	const seenTopLevel = new Set();
	let i = 0;
	while (i < lines.length) {
		const entry = lines[i];
		if (entry.indent !== 0) {
			throw boardParseError('Unexpected indentation at top level (line ' + entry.lineNumber + ')');
		}
		const kv = parseKeyValue(entry.content, entry.lineNumber);
		if (seenTopLevel.has(kv.key)) {
			throw boardParseError(
				"Duplicate top-level key '" + kv.key + "' (line " + kv.lineNumber + ')'
			);
		}
		seenTopLevel.add(kv.key);
		if (KNOWN_TOP_LEVEL_KEYS.indexOf(kv.key) === -1) {
			throw boardParseError("Unknown top-level key '" + kv.key + "' (line " + kv.lineNumber + ')');
		}
		if (kv.key === 'version') {
			if (kv.rest === '' || !/^\d+$/.test(kv.rest)) {
				throw boardParseError('version must be an integer (line ' + kv.lineNumber + ')');
			}
			board.version = parseInt(kv.rest, 10);
			i++;
		} else if (kv.key === 'project') {
			if (kv.rest === '') {
				throw boardParseError('project requires a value (line ' + kv.lineNumber + ')');
			}
			board.project = parseScalarString(kv.rest, kv.lineNumber);
			i++;
		} else {
			if (kv.rest !== '') {
				throw boardParseError('columns must not have an inline value (line ' + kv.lineNumber + ')');
			}
			const result = parseColumnsBlock(lines, i + 1);
			board.columns = result.columns;
			i = result.nextIndex;
		}
	}
	if (typeof board.version !== 'number') {
		throw boardParseError('version is required');
	}
	if (!Array.isArray(board.columns) || board.columns.length === 0) {
		throw boardParseError('columns is required and must not be empty');
	}
	if (expectProject && typeof board.project !== 'string') {
		throw boardParseError('project is required on a project board');
	}
	if (!expectProject && typeof board.project === 'string') {
		throw boardParseError('project is not allowed on the global board');
	}
	return board;
}

function serializeScalarString(value) {
	const str = String(value);
	const needsQuoting =
		str === '' ||
		str !== str.trim() ||
		str === 'true' ||
		str === 'false' ||
		/^\d+$/.test(str) ||
		/[:#'"\n]/.test(str) ||
		str.charAt(0) === '-' ||
		str.charAt(0) === '&' ||
		str.charAt(0) === '*' ||
		str.charAt(0) === '[' ||
		str.charAt(0) === '{';
	if (!needsQuoting) return str;
	return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Serializes a board object back into the YAML subset `parseBoardYaml`
 * accepts, with a leading comment flagging the file as Maestro-managed but
 * hand-editable. Round-trips everything the parser accepts. No host calls.
 * @param {{ version: number, project?: string, columns: object[] }} board
 */
function serializeBoardYaml(board) {
	const lines = ['# Maestro-managed kanban board. Safe to hand-edit; keep the shape above.'];
	lines.push('version: ' + String(board.version));
	if (typeof board.project === 'string') {
		lines.push('project: ' + serializeScalarString(board.project));
	}
	lines.push('columns:');
	const columns = Array.isArray(board.columns) ? board.columns : [];
	for (let i = 0; i < columns.length; i++) {
		const column = columns[i];
		lines.push('  - id: ' + serializeScalarString(column.id));
		lines.push('    title: ' + serializeScalarString(column.title));
		if (typeof column.maps_to === 'string') {
			lines.push('    maps_to: ' + serializeScalarString(column.maps_to));
		}
		if (column.terminal === true) {
			lines.push('    terminal: true');
		}
		if (typeof column.wip_limit === 'number') {
			lines.push('    wip_limit: ' + String(column.wip_limit));
		}
	}
	return lines.join('\n') + '\n';
}

/** 32-bit FNV-1a over UTF-16 code units, hex-encoded to 8 digits. Not
 * cryptographic; only needs to be stable and cheap. */
function fnv1a32Hex(str) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	let hex = (hash >>> 0).toString(16);
	while (hex.length < 8) hex = '0' + hex;
	return hex;
}

function sanitizeSlugBasename(name) {
	const lowered = String(name || '').toLowerCase();
	const cleaned = lowered.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	return cleaned || 'project';
}

/**
 * Produces the `<basename>-<fnv1a8>` slug a project's board file is named
 * after: `~/.maestro/kanban-boards/<slug>.yaml`. Stable for a given absolute
 * path; two projects sharing a basename still get different slugs because
 * the hash covers the full path. No host calls.
 * @param {string} projectPath
 */
function projectBoardSlug(projectPath) {
	const normalized = String(projectPath || '');
	const segments = normalized.split(/[\\/]/).filter(function (segment) {
		return segment.length > 0;
	});
	const basename = segments.length > 0 ? segments[segments.length - 1] : '';
	return sanitizeSlugBasename(basename) + '-' + fnv1a32Hex(normalized);
}

/**
 * Produces the effective column list for a project: the project's own
 * columns when a project board exists, `DEFAULT_COLUMNS` otherwise. Each
 * returned column carries the global column it `maps_to` (or `null` when
 * unmapped, including when the name does not exist on the global board).
 * No host calls.
 * @param {{ columns: object[] } | null | undefined} projectBoard
 * @param {{ columns: object[] } | null | undefined} globalBoard
 */
function resolveColumns(projectBoard, globalBoard) {
	const columns =
		projectBoard && Array.isArray(projectBoard.columns) && projectBoard.columns.length > 0
			? projectBoard.columns
			: DEFAULT_COLUMNS;
	const globalColumns =
		globalBoard && Array.isArray(globalBoard.columns) ? globalBoard.columns : [];
	const globalById = new Map();
	for (let i = 0; i < globalColumns.length; i++) {
		globalById.set(globalColumns[i].id, globalColumns[i]);
	}
	return columns.map(function (column) {
		const globalColumn =
			typeof column.maps_to === 'string' && globalById.has(column.maps_to)
				? globalById.get(column.maps_to)
				: null;
		return {
			id: column.id,
			title: column.title,
			terminal: column.terminal === true,
			wip_limit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
			maps_to: column.maps_to,
			globalColumn: globalColumn,
		};
	});
}

/**
 * The set of column ids a card may legally occupy. When the card is already
 * sitting on one of its project's own columns (or has no column yet), that
 * is simply the project's resolved columns. Otherwise the card is parked on
 * a global column with no matching local column, so legality falls back to
 * the global board's own columns - the case Phase 03 consumes when it
 * aggregates cards from many projects onto one global board. No host calls.
 * @param {{ columnId?: string } | null | undefined} card
 * @param {{ columns: object[] } | null | undefined} projectBoard
 * @param {{ columns: object[] } | null | undefined} globalBoard
 */
function legalColumnsFor(card, projectBoard, globalBoard) {
	const resolved = resolveColumns(projectBoard, globalBoard);
	const projectColumnIds = resolved.map(function (column) {
		return column.id;
	});
	const currentColumnId = card && typeof card.columnId === 'string' ? card.columnId : null;
	if (currentColumnId === null || projectColumnIds.indexOf(currentColumnId) !== -1) {
		return projectColumnIds;
	}
	const globalColumns = Array.isArray(globalBoard && globalBoard.columns)
		? globalBoard.columns
		: [];
	return globalColumns.map(function (column) {
		return column.id;
	});
}

/**
 * Exactly one terminal column per board: the column with `terminal: true`,
 * falling back to a column whose id is `done`, falling back to the last
 * column. Returns `null` only when `columns` is empty. No host calls.
 * @param {object[]} columns
 */
function resolveTerminalColumn(columns) {
	const list = Array.isArray(columns) ? columns : [];
	for (let i = 0; i < list.length; i++) {
		if (list[i] && list[i].terminal === true) return list[i];
	}
	for (let i = 0; i < list.length; i++) {
		if (list[i] && list[i].id === 'done') return list[i];
	}
	return list.length > 0 ? list[list.length - 1] : null;
}

// ===========================================================================
// End of Phase 02 column model.
// ===========================================================================

let sdk = null;
/** @type {Map<string, object>} card key -> card */
let cards = new Map();
/** @type {Map<string, string>} sessionId -> session title */
const sessionTitle = new Map();
/** @type {Map<string, string>} sessionId -> provider/agent id */
const sessionAgentId = new Map();
/** @type {Map<string, string>} sessionId -> project path */
const sessionProjectPath = new Map();
/** @type {Map<string, number>} sessionId -> last time we saw activity */
const sessionLastActivity = new Map();
/** @type {Set<string>} sessions touched since the last tabs.list() re-read */
const dirtySessions = new Set();

let refreshTimer = null;
let panelTimer = null;

// ===========================================================================
// Phase 02 filesystem plumbing: reads and writes the board files under
// ~/.maestro/kanban.yaml and ~/.maestro/kanban-boards/<slug>.yaml through
// maestro.fs.*. Every path this plugin ever touches is produced by
// boardFilePath() below; nothing else is ever handed to maestro.fs.*. Parsed
// boards are cached in memory keyed by path - there is no polling, so the
// cache is only cleared by invalidateBoardCache(), called on the 'refresh'
// command and when the panel is opened (see registerCommands below).
// ===========================================================================

const GLOBAL_BOARD_PATH = '~/.maestro/kanban.yaml';
const PROJECT_BOARDS_DIR = '~/.maestro/kanban-boards';

/** @type {Map<string, { board: object|null, error: { message: string, path: string }|null }>} */
const boardCache = new Map();

/**
 * The one place a board file path is produced. `null`/`undefined` names the
 * global board; any other value must be a non-empty project path, which maps
 * to that project's board file. The leading `~` is left in place for the
 * host to expand (see plugin-home-path.ts) - this plugin never resolves it
 * itself. Throws on anything else, so a caller cannot smuggle an arbitrary
 * path into maestro.fs.* through this helper.
 * @param {string|null|undefined} projectPath
 */
function boardFilePath(projectPath) {
	if (projectPath === null || projectPath === undefined) {
		return GLOBAL_BOARD_PATH;
	}
	if (typeof projectPath !== 'string' || projectPath === '') {
		throw new Error(
			'boardFilePath requires a non-empty project path, or null for the global board'
		);
	}
	return PROJECT_BOARDS_DIR + '/' + projectBoardSlug(projectPath) + '.yaml';
}

/** True for the "file does not exist" failure maestro.fs.read rejects with
 * (the host's fs.statSync/readFileSync surface Node's ENOENT, and the RPC
 * boundary preserves only the error message, not Node's `err.code`). */
function isFileNotFoundError(err) {
	return !!err && typeof err.message === 'string' && err.message.indexOf('ENOENT') !== -1;
}

function errorMessage(err) {
	return err && err.message ? String(err.message) : String(err);
}

/**
 * Reads and parses one board file. Never rejects: a missing file resolves to
 * `{ board: null, error: null }` ("use defaults"); a file that exists but
 * fails to parse, or whose `project` key names a path other than
 * `expectedProjectPath`, resolves to `{ board: null, error }` so the caller
 * can surface the failure instead of silently falling back to defaults.
 * @param {string} path
 * @param {string|null} expectedProjectPath
 */
async function readBoardFile(path, expectedProjectPath) {
	let text;
	try {
		text = await sdk.fs.read(path);
	} catch (err) {
		if (isFileNotFoundError(err)) return { board: null, error: null };
		return { board: null, error: { message: errorMessage(err), path: path } };
	}
	try {
		const board = parseBoardYaml(text, { expectProject: expectedProjectPath !== null });
		if (expectedProjectPath !== null && board.project !== expectedProjectPath) {
			throw boardParseError(
				"board's project (" +
					board.project +
					') does not match the file it was read from (' +
					expectedProjectPath +
					')'
			);
		}
		return { board: board, error: null };
	} catch (err) {
		return { board: null, error: { message: errorMessage(err), path: path } };
	}
}

async function loadBoard(path, expectedProjectPath) {
	if (boardCache.has(path)) return boardCache.get(path);
	const result = await readBoardFile(path, expectedProjectPath);
	boardCache.set(path, result);
	return result;
}

/** Loads one project's board file, from cache when present. Resolves to
 * `{ board, error }` - see readBoardFile. `board` is `null` when the file
 * does not exist, meaning "use DEFAULT_COLUMNS".
 * @param {string} projectPath */
function loadProjectBoard(projectPath) {
	return loadBoard(boardFilePath(projectPath), projectPath);
}

/** Loads the global board file the same way loadProjectBoard loads a
 * project's. Resolves to `{ board, error }` - see readBoardFile. */
function loadGlobalBoard() {
	return loadBoard(boardFilePath(null), null);
}

/** Drops every cached board so the next load re-reads from disk. Called on
 * the 'refresh' command and when the panel is opened; nothing polls. */
function invalidateBoardCache() {
	boardCache.clear();
}

/**
 * Writes `board` to the project's board file. Reads the current file first
 * and refuses to overwrite one the parser could not read (an ENOENT is fine
 * - there is nothing to protect - but a parse failure aborts the write), so
 * a hand-edit this plugin does not understand is never silently destroyed.
 * @param {string} projectPath
 * @param {object} board
 */
async function saveProjectBoard(projectPath, board) {
	const path = boardFilePath(projectPath);
	let existingText = null;
	try {
		existingText = await sdk.fs.read(path);
	} catch (err) {
		if (!isFileNotFoundError(err)) throw err;
	}
	if (existingText !== null) {
		// Throws (and aborts the write below) if the existing file does not
		// parse; the raised error is the parser's own message.
		parseBoardYaml(existingText, { expectProject: true });
	}
	await sdk.fs.write(path, serializeBoardYaml(board));
	boardCache.set(path, { board: board, error: null });
	return board;
}

// ===========================================================================
// End of Phase 02 filesystem plumbing.
// ===========================================================================

function cardKey(sessionId, tabId) {
	return sessionId + '::' + tabId;
}

/**
 * Pure: maps a card's live tab status to a column. Only two signals are
 * meaningful today - everything else (idle, unknown, undefined) is backlog.
 * Kept generic (not limited to the 'idle'/'busy' values tabs.list() actually
 * emits) so a richer status string is handled correctly if the host ever
 * reports one.
 * @param {{ status?: string }} card
 */
function deriveColumn(card) {
	const status = card && typeof card.status === 'string' ? card.status : '';
	if (status === 'error') return 'blocked';
	if (status === 'busy' || status === 'connecting') return 'in-progress';
	return 'backlog';
}

function fallbackTitle(sessionId, ordinal) {
	const base = sessionTitle.get(sessionId) || sessionAgentId.get(sessionId) || 'Agent';
	return base + ' ' + ordinal;
}

/** Which session a given event payload is about. `agent.statusChanged` is the
 * one topic whose `tabId` field actually carries the session id - see the
 * host facts in Phase-01-Plugin-Scaffold-And-Live-Board.md. */
function sessionIdForEvent(topic, payload) {
	if (!payload) return undefined;
	if (topic === 'agent.statusChanged') {
		return typeof payload.tabId === 'string' ? payload.tabId : undefined;
	}
	return typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
}

function markDirty(sessionId) {
	if (!sessionId) return;
	dirtySessions.add(sessionId);
	sessionLastActivity.set(sessionId, Date.now());
	scheduleRefresh();
}

function rebuildSessionMeta(sessions) {
	for (const s of Array.isArray(sessions) ? sessions : []) {
		if (!s || typeof s.id !== 'string') continue;
		if (typeof s.title === 'string') sessionTitle.set(s.id, s.title);
		if (typeof s.agentId === 'string') sessionAgentId.set(s.id, s.agentId);
		if (typeof s.projectPath === 'string') sessionProjectPath.set(s.id, s.projectPath);
	}
}

/** Full rebuild of the card model from one maestro.tabs.list() response.
 * tabs.list() always returns every tab (it takes no session filter), so a
 * full rebuild keeps every session in sync in one pass rather than patching
 * just the sessions that triggered this refresh. */
function rebuildCardsFromTabs(tabs) {
	const next = new Map();
	const ordinals = new Map();
	for (const tab of Array.isArray(tabs) ? tabs : []) {
		if (!tab || typeof tab !== 'object') continue;
		if (tab.type !== 'ai') continue; // terminal tabs are never cards
		if (typeof tab.sessionId !== 'string' || typeof tab.id !== 'string') continue;
		const sessionId = tab.sessionId;
		const ordinal = (ordinals.get(sessionId) || 0) + 1;
		ordinals.set(sessionId, ordinal);
		const key = cardKey(sessionId, tab.id);
		const existing = cards.get(key);
		const title =
			typeof tab.title === 'string' && tab.title ? tab.title : fallbackTitle(sessionId, ordinal);
		const status = typeof tab.status === 'string' ? tab.status : 'idle';
		const createdAt =
			typeof tab.createdAt === 'number'
				? tab.createdAt
				: existing
					? existing.createdAt
					: Date.now();
		const projectPath =
			typeof tab.projectPath === 'string'
				? tab.projectPath
				: sessionProjectPath.get(sessionId) || (existing ? existing.projectPath : undefined);
		const card = {
			key: key,
			sessionId: sessionId,
			tabId: tab.id,
			title: title,
			agentId: sessionAgentId.get(sessionId) || (existing ? existing.agentId : undefined),
			projectPath: projectPath,
			status: status,
			createdAt: createdAt,
			lastActivityAt:
				sessionLastActivity.get(sessionId) || (existing ? existing.lastActivityAt : createdAt),
			columnId: null,
		};
		card.columnId = deriveColumn(card);
		next.set(key, card);
	}
	cards = next;
}

function scheduleRefresh() {
	if (refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		doRefresh();
	}, REFRESH_DEBOUNCE_MS);
}

function doRefresh() {
	if (!sdk) return;
	dirtySessions.clear();
	sdk.tabs
		.list()
		.then((tabs) => {
			rebuildCardsFromTabs(tabs);
			schedulePanelPush();
		})
		.catch((err) => {
			// A rejected RPC degrades this refresh only; existing cards are left
			// as they were rather than wiping the board.
			console.error('maestro-kanban: tabs.list failed: ' + String(err));
		});
}

function schedulePanelPush() {
	if (panelTimer) return;
	panelTimer = setTimeout(() => {
		panelTimer = null;
		pushSnapshotNow();
	}, PANEL_PUSH_DEBOUNCE_MS);
}

function cardToJson(card) {
	return {
		key: card.key,
		sessionId: card.sessionId,
		tabId: card.tabId,
		title: card.title,
		agentId: card.agentId,
		projectPath: card.projectPath,
		status: card.status,
		createdAt: card.createdAt,
		lastActivityAt: card.lastActivityAt,
	};
}

function buildSnapshot() {
	const byColumn = new Map(COLUMN_IDS.map((id) => [id, []]));
	const ordered = Array.from(cards.values()).sort((a, b) => a.createdAt - b.createdAt);
	for (const card of ordered) {
		const list = byColumn.get(card.columnId) || byColumn.get('backlog');
		list.push(cardToJson(card));
	}
	return {
		updatedAt: Date.now(),
		columns: COLUMN_IDS.map((id) => ({ id: id, cards: byColumn.get(id) })),
	};
}

function serializedSize(snapshot) {
	try {
		return JSON.stringify(snapshot).length;
	} catch {
		return Infinity;
	}
}

/** Trim a snapshot under budget: first drop optional fields from every card,
 * then drop the oldest card per column (round-robin) until it fits. */
function trimToBudget(snapshot) {
	if (serializedSize(snapshot) <= PANEL_BUDGET_BYTES) return { snapshot: snapshot, trimmed: false };
	for (const column of snapshot.columns) {
		column.cards = column.cards.map((c) => ({
			key: c.key,
			sessionId: c.sessionId,
			tabId: c.tabId,
			title: c.title,
			agentId: c.agentId,
			status: c.status,
			lastActivityAt: c.lastActivityAt,
		}));
	}
	let guard = 0;
	while (serializedSize(snapshot) > PANEL_BUDGET_BYTES && guard < 10000) {
		guard++;
		let droppedAny = false;
		for (const column of snapshot.columns) {
			if (column.cards.length > 0) {
				column.cards.shift();
				droppedAny = true;
				if (serializedSize(snapshot) <= PANEL_BUDGET_BYTES) break;
			}
		}
		if (!droppedAny) break;
	}
	return { snapshot: snapshot, trimmed: true };
}

function safeToast(message) {
	if (!sdk) return Promise.resolve();
	return sdk.notifications.toast(message).catch(() => {});
}

function pushSnapshotNow() {
	if (panelTimer) {
		clearTimeout(panelTimer);
		panelTimer = null;
	}
	if (!sdk) return;
	const result = trimToBudget(buildSnapshot());
	if (result.trimmed) {
		console.warn('maestro-kanban: board snapshot exceeded the panel budget and was trimmed');
		safeToast('Kanban board is large; some card detail was trimmed to fit the panel.');
	}
	sdk.ui.panelPost('board', result.snapshot).catch((err) => {
		console.error('maestro-kanban: panelPost failed: ' + String(err));
	});
}

function onSessionCreated(payload) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	if (typeof payload.title === 'string') sessionTitle.set(payload.sessionId, payload.title);
	if (typeof payload.agentId === 'string') sessionAgentId.set(payload.sessionId, payload.agentId);
	if (typeof payload.projectPath === 'string')
		sessionProjectPath.set(payload.sessionId, payload.projectPath);
	markDirty(payload.sessionId);
}

function onSessionUpdated(payload) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	if (typeof payload.title === 'string') sessionTitle.set(payload.sessionId, payload.title);
	markDirty(payload.sessionId);
}

/** session.removed drops that session's cards immediately, with no
 * maestro.tabs.list() re-read - the host already told us it is gone. */
function onSessionRemoved(payload) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	const sessionId = payload.sessionId;
	sessionTitle.delete(sessionId);
	sessionAgentId.delete(sessionId);
	sessionProjectPath.delete(sessionId);
	sessionLastActivity.delete(sessionId);
	dirtySessions.delete(sessionId);
	let removedAny = false;
	for (const [key, card] of cards) {
		if (card.sessionId === sessionId) {
			cards.delete(key);
			removedAny = true;
		}
	}
	if (removedAny) schedulePanelPush();
}

function onGenericSessionEvent(topic, payload) {
	markDirty(sessionIdForEvent(topic, payload));
}

function registerEventHandlers(maestro) {
	maestro.events.on('session.created', onSessionCreated);
	maestro.events.on('session.updated', onSessionUpdated);
	maestro.events.on('session.removed', onSessionRemoved);
	maestro.events.on('session.activated', (payload) =>
		onGenericSessionEvent('session.activated', payload)
	);
	maestro.events.on('agent.statusChanged', (payload) =>
		onGenericSessionEvent('agent.statusChanged', payload)
	);
	maestro.events.on('agent.completed', (payload) =>
		onGenericSessionEvent('agent.completed', payload)
	);
	maestro.events.on('agent.error', (payload) => onGenericSessionEvent('agent.error', payload));
	maestro.events.on('agent.exited', (payload) => onGenericSessionEvent('agent.exited', payload));
	maestro.events.on('run.completed', (payload) => onGenericSessionEvent('run.completed', payload));
	maestro.events.on('usage.updated', (payload) => onGenericSessionEvent('usage.updated', payload));
}

/** Re-seed everything from sessions.list()/tabs.list() and push right away.
 * Used at activate() and by the 'refresh' command. A rejected sessions.list()
 * still lets tabs.list() run, so the board degrades rather than going blank. */
async function seed() {
	try {
		const sessions = await sdk.sessions.list();
		rebuildSessionMeta(sessions);
	} catch (err) {
		console.error('maestro-kanban: sessions.list failed: ' + String(err));
	}
	try {
		const tabs = await sdk.tabs.list();
		rebuildCardsFromTabs(tabs);
	} catch (err) {
		console.error('maestro-kanban: tabs.list failed: ' + String(err));
	}
	pushSnapshotNow();
}

function registerCommands(maestro) {
	maestro.commands.register('open', () => {
		invalidateBoardCache();
		return maestro.ui.togglePanel('board').catch(() => {});
	});

	maestro.commands.register('refresh', () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		dirtySessions.clear();
		invalidateBoardCache();
		return seed();
	});

	// Phase 01 has no stored placement to clear; Phase 02 owns storage.
	maestro.commands.register('clear-placements', () => Promise.resolve({ ok: true }));

	// Invoked by the panel via parent.postMessage; no manifest `commands`
	// entry is needed since it is never surfaced in the command palette.
	maestro.commands.register('focus', (args) => {
		const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined;
		const tabId = args && typeof args.tabId === 'string' ? args.tabId : undefined;
		if (!sessionId) return Promise.resolve({ ok: false });
		return maestro.sessions
			.focus(sessionId, tabId)
			.then(() => ({ ok: true }))
			.catch((err) => {
				console.error('maestro-kanban: sessions.focus failed: ' + String(err));
				return safeToast('Could not jump to that agent.').then(() => ({ ok: false }));
			});
	});
}

module.exports = {
	// Phase 02 pure column model, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-board-model.test.ts). The sandbox host
	// never calls these itself; it only calls activate()/deactivate() below.
	parseBoardYaml: parseBoardYaml,
	serializeBoardYaml: serializeBoardYaml,
	DEFAULT_COLUMNS: DEFAULT_COLUMNS,
	projectBoardSlug: projectBoardSlug,
	resolveColumns: resolveColumns,
	legalColumnsFor: legalColumnsFor,
	resolveTerminalColumn: resolveTerminalColumn,

	// Phase 02 filesystem plumbing, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-persistence.test.ts). These call
	// sdk.fs.read/write, so a test must call activate() with a stub SDK first.
	boardFilePath: boardFilePath,
	loadProjectBoard: loadProjectBoard,
	loadGlobalBoard: loadGlobalBoard,
	saveProjectBoard: saveProjectBoard,
	invalidateBoardCache: invalidateBoardCache,

	/** @param {MaestroSdk} maestro */
	async activate(maestro) {
		sdk = maestro;
		registerCommands(maestro);
		registerEventHandlers(maestro);
		try {
			await maestro.events.subscribe(EVENT_TOPICS);
		} catch (err) {
			console.error('maestro-kanban: events.subscribe failed: ' + String(err));
		}
		await seed();
	},

	deactivate() {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		if (panelTimer) {
			clearTimeout(panelTimer);
			panelTimer = null;
		}
		dirtySessions.clear();
		cards = new Map();
		if (sdk) {
			return sdk.events.unsubscribe().catch(() => {});
		}
		return undefined;
	},
};
