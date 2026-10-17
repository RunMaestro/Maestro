/** @import { MaestroSdk } from '@maestro/plugin-sdk' */
/* global module, console, setTimeout, clearTimeout */

// Phase 01's fixed column ladder is gone from here: buildSnapshot() now
// renders resolveColumns()'s output for "the active board" (see
// activeProjectPath below). Card placement itself is no longer derived fresh
// every refresh either: see the "Phase 02 placement persistence" section
// below, which remembers where a card was put and only falls back to
// deriveColumn() for a card that has never been placed.

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

// Phase 01's fixed column ladder, reshaped into the column model below.
// Used by resolveColumns() when no board file exists yet.
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
 * On the global board (`options.global`), legality is a different question
 * entirely - which global columns the card's home project can reach - and is
 * answered by legalGlobalColumnsFor() in the Phase 03 section below.
 * @param {{ columnId?: string } | null | undefined} card
 * @param {{ columns: object[] } | null | undefined} projectBoard
 * @param {{ columns: object[] } | null | undefined} globalBoard
 * @param {{ global?: boolean }} [options]
 */
function legalColumnsFor(card, projectBoard, globalBoard, options) {
	if (options && options.global === true) {
		return legalGlobalColumnsFor(card, projectBoard, globalBoard);
	}
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

// ===========================================================================
// Phase 03 global board aggregation (pure functions only - no `sdk`/`maestro`
// calls, no I/O, nothing read out of the module-level runtime state below).
// The global board is not a board anyone owns cards on: it is a projection of
// every project's cards onto the global board's columns, and the card's home
// project placement stays the only stored truth. Three rules hold that
// projection together, and they have to agree or a drop will appear to work
// and then revert on the next snapshot:
//
//   1. A project column reaches a global column through `maps_to` and through
//      nothing else. A column with no `maps_to` is unmapped even when its id
//      happens to match a global column id, because that is exactly the case
//      DEFAULT_COLUMNS lands in: honoring an id match would quietly aggregate
//      every board-less project onto the global board and the Unmapped lane
//      would never appear for the case the phase explicitly calls out ("cards
//      whose agent cwd has no project board at all").
//   2. Whatever buildGlobalBoard() renders, legalGlobalColumnsFor() offers as
//      a drop target, and projectColumnForGlobalColumn() can write back to.
//      All three derive from the same resolveColumns() output.
//   3. A card the projection cannot place sits in the read-only Unmapped lane
//      and can be dragged nowhere, rather than being dropped from the board
//      or offered a move that would snap back.
// ===========================================================================

/** The id and title of the generated lane that collects cards the projection
 * cannot place. The id is reserved rather than validated: column ids come out
 * of YAML unrestricted, so buildGlobalBoard() yields to a global column that
 * declares this id instead of emitting a duplicate (see below). */
const UNMAPPED_COLUMN_ID = '__unmapped__';
const UNMAPPED_COLUMN_TITLE = 'Unmapped';

/**
 * One card's declared position within its column, for callers with no access
 * to the placement store: the card's own `order` when it carries a finite
 * one, null otherwise. The runtime's cardOrderOf() is the same question asked
 * of persisted placements. No host calls.
 * @param {{ order?: unknown }} card
 * @returns {number|null}
 */
function declaredCardOrder(card) {
	const order = card && card.order;
	return typeof order === 'number' && isFinite(order) ? order : null;
}

/**
 * Display order of two cards sitting in the same column, given a function
 * that reports a card's explicit position. Cards the user has positioned
 * come out in that position, in a block; a card nobody has dragged sorts
 * above them by last activity, newest first, so a tab that just appeared is
 * at the top of its column rather than buried at an arbitrary depth.
 * `createdAt` and finally `key` are tiebreaks, so cards that match on every
 * other signal still sort deterministically - which is what keeps a global
 * column stable even though the orders it is interleaving were each numbered
 * inside a different project's column and therefore collide freely.
 * No host calls.
 * @param {object} a
 * @param {object} b
 * @param {(card: object) => number|null} orderOf
 */
function compareCardsByOrder(a, b, orderOf) {
	const aOrder = orderOf(a);
	const bOrder = orderOf(b);
	if (aOrder === null && bOrder !== null) return -1;
	if (aOrder !== null && bOrder === null) return 1;
	if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
	if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
	if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Looks one project's board out of the collection buildGlobalBoard() is
 * handed. Accepts a Map or a plain object keyed by project path, whose values
 * are either a board or the `{ board, error }` shape loadProjectBoard()
 * resolves to - the runtime has the latter in hand, and a board object can
 * never carry a `board` key (see KNOWN_TOP_LEVEL_KEYS), so unwrapping it is
 * unambiguous. Returns null for "this project has no board", which is the
 * signal that sends its cards to the Unmapped lane. No host calls.
 * @param {Map<string, object>|Record<string, object>|null|undefined} projectBoards
 * @param {unknown} projectPath
 */
function projectBoardFor(projectBoards, projectPath) {
	if (!projectBoards || typeof projectPath !== 'string' || projectPath === '') return null;
	let entry;
	if (typeof (/** @type {Map<string, object>} */ (projectBoards).get) === 'function') {
		entry = /** @type {Map<string, object>} */ (projectBoards).get(projectPath);
	} else if (Object.prototype.hasOwnProperty.call(projectBoards, projectPath)) {
		entry = /** @type {Record<string, object>} */ (projectBoards)[projectPath];
	}
	if (!entry || typeof entry !== 'object') return null;
	if (Object.prototype.hasOwnProperty.call(entry, 'board')) {
		const unwrapped = /** @type {{ board: object|null }} */ (entry).board;
		return unwrapped && typeof unwrapped === 'object' ? unwrapped : null;
	}
	return entry;
}

/**
 * The global column a card projects onto, or null when it cannot be placed
 * and belongs in the Unmapped lane. Null covers all three ways that happens:
 * the card's project has no board file at all, the card sits on a project
 * column with no (or an orphaned) `maps_to`, and the card's stored column is
 * no longer one its project declares. No host calls.
 * @param {{ columnId?: string } | null | undefined} card
 * @param {{ columns: object[] } | null | undefined} projectBoard
 * @param {{ columns: object[] } | null | undefined} globalBoard
 * @returns {string|null}
 */
function globalColumnForCard(card, projectBoard, globalBoard) {
	if (!projectBoard) return null;
	const columnId = card && typeof card.columnId === 'string' ? card.columnId : null;
	if (columnId === null) return null;
	const resolved = resolveColumns(projectBoard, globalBoard);
	for (let i = 0; i < resolved.length; i++) {
		if (resolved[i].id !== columnId) continue;
		return resolved[i].globalColumn ? resolved[i].globalColumn.id : null;
	}
	return null;
}

/**
 * The global column ids a card may legally be dropped on: the global columns
 * its *home project* can reach through one of its own columns' `maps_to`,
 * deduped and returned in the global board's own column order so the panel
 * can compare them against what it renders. Empty for a card whose project
 * has no board (an Unmapped-lane card can go nowhere), which is what stops a
 * drop being offered that the move handler would only refuse. No host calls.
 * @param {{ columnId?: string } | null | undefined} card
 * @param {{ columns: object[] } | null | undefined} projectBoard
 * @param {{ columns: object[] } | null | undefined} globalBoard
 * @returns {string[]}
 */
function legalGlobalColumnsFor(card, projectBoard, globalBoard) {
	if (!projectBoard) return [];
	const globalColumns = Array.isArray(globalBoard && globalBoard.columns)
		? globalBoard.columns
		: [];
	const reachable = new Set();
	const resolved = resolveColumns(projectBoard, globalBoard);
	for (let i = 0; i < resolved.length; i++) {
		if (resolved[i].globalColumn) reachable.add(resolved[i].globalColumn.id);
	}
	const ids = [];
	for (let i = 0; i < globalColumns.length; i++) {
		if (reachable.has(globalColumns[i].id)) ids.push(globalColumns[i].id);
	}
	return ids;
}

/**
 * Which of a project's own columns a global-board move writes back to, given
 * the global column the card was dropped on. Returns null when the project
 * cannot reach that global column at all (the move must be refused, not
 * guessed at).
 *
 * A project is allowed to point several columns at one global column, so the
 * choice can be genuinely ambiguous: keep the card where it already is when
 * its current column maps to the target (dropping a card on the global column
 * it is already projected into is a reorder, and must not silently relocate
 * it inside its own project), otherwise take the project's first mapping. The
 * returned `ambiguous` flag is true whenever more than one column mapped, so
 * the caller can record the choice in the plugin log - this function stays
 * pure and does not log itself. No host calls.
 * @param {{ columnId?: string } | null | undefined} card
 * @param {{ columns: object[] } | null | undefined} projectBoard
 * @param {{ columns: object[] } | null | undefined} globalBoard
 * @param {unknown} globalColumnId
 * @returns {{ columnId: string, ambiguous: boolean, candidates: string[] }|null}
 */
function projectColumnForGlobalColumn(card, projectBoard, globalBoard, globalColumnId) {
	if (!projectBoard || typeof globalColumnId !== 'string' || globalColumnId === '') return null;
	const resolved = resolveColumns(projectBoard, globalBoard);
	const candidates = [];
	for (let i = 0; i < resolved.length; i++) {
		if (resolved[i].globalColumn && resolved[i].globalColumn.id === globalColumnId) {
			candidates.push(resolved[i].id);
		}
	}
	if (candidates.length === 0) return null;
	const currentColumnId = card && typeof card.columnId === 'string' ? card.columnId : null;
	const keepsCurrent = currentColumnId !== null && candidates.indexOf(currentColumnId) !== -1;
	return {
		columnId: keepsCurrent ? currentColumnId : candidates[0],
		ambiguous: candidates.length > 1,
		candidates: candidates,
	};
}

/**
 * Projects every card onto the global board's columns: each card lands in the
 * global column its home project column maps to, and everything the
 * projection cannot place collects in the read-only Unmapped lane. The lane
 * is appended only when it has cards, so a fully mapped set of projects does
 * not render a permanently dead column, and it yields its id to a global
 * column that already declares `__unmapped__` rather than emitting two
 * columns with one id.
 *
 * Columns come out in the model's own shape (`wip_limit`, like
 * resolveColumns), carrying the input card objects themselves in display
 * order; the snapshot layer is what renames keys and runs cards through
 * cardToJson. `options.orderOf` reports a card's explicit position and
 * defaults to declaredCardOrder(), so a caller with a placement store can
 * hand its own reader in. No host calls.
 * @param {{ columns: object[] } | null | undefined} globalBoard
 * @param {Map<string, object>|Record<string, object>|null|undefined} projectBoards
 * @param {Iterable<object>} cards
 * @param {{ orderOf?: (card: object) => number|null }} [options]
 */
function buildGlobalBoard(globalBoard, projectBoards, cards, options) {
	const orderOf =
		options && typeof options.orderOf === 'function' ? options.orderOf : declaredCardOrder;
	const globalColumns = Array.isArray(globalBoard && globalBoard.columns)
		? globalBoard.columns
		: [];
	const columns = globalColumns.map(function (column) {
		return {
			id: column.id,
			title: column.title,
			terminal: column.terminal === true,
			wip_limit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
			readOnly: false,
			cards: [],
		};
	});
	const byId = new Map(
		columns.map(function (column) {
			return [column.id, column];
		})
	);
	const unmapped = byId.get(UNMAPPED_COLUMN_ID) || {
		id: UNMAPPED_COLUMN_ID,
		title: UNMAPPED_COLUMN_TITLE,
		terminal: false,
		wip_limit: undefined,
		readOnly: true,
		cards: [],
	};
	for (const card of cards || []) {
		if (!card) continue;
		const projectBoard = projectBoardFor(projectBoards, card.projectPath);
		const targetId = globalColumnForCard(card, projectBoard, globalBoard);
		const target = targetId !== null ? byId.get(targetId) : undefined;
		(target || unmapped).cards.push(card);
	}
	if (unmapped.cards.length > 0 && !byId.has(UNMAPPED_COLUMN_ID)) {
		columns.push(unmapped);
	}
	for (let i = 0; i < columns.length; i++) {
		columns[i].cards.sort(function (a, b) {
			return compareCardsByOrder(a, b, orderOf);
		});
	}
	return { columns: columns, unmappedColumnId: UNMAPPED_COLUMN_ID };
}

// ===========================================================================
// End of Phase 03 global board aggregation.
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

/** Project path of the session the host most recently reported as activated
 * via session.activated - what buildSnapshot() below treats as "the active
 * board" whose resolveColumns() output renders in the panel. null before any
 * session.activated event has fired this run (there is no host API to learn
 * the already-focused session at activate() time), or when the activated
 * session has no known project path yet; either way buildSnapshot() falls
 * back to resolveColumns(null, globalBoard), i.e. DEFAULT_COLUMNS. */
let activeProjectPath = null;

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

/**
 * Seeds a brand-new project board file with `DEFAULT_COLUMNS`, but only when
 * the project has no board file at all yet - unlike `saveProjectBoard`,
 * which overwrites a parseable file on purpose, this refuses whenever
 * anything is already at the path (valid or not), so it can never clobber a
 * hand-edited or previously-written board. Backs the 'write-default-board'
 * command. Resolves to the path written; throws (naming the path) if a file
 * is already there, or if the read to check that fails for any reason other
 * than "missing".
 * @param {string} projectPath
 */
async function writeDefaultBoard(projectPath) {
	if (typeof projectPath !== 'string' || projectPath === '') {
		throw new Error('writeDefaultBoard requires a non-empty project path');
	}
	const path = boardFilePath(projectPath);
	let fileExists = true;
	try {
		await sdk.fs.read(path);
	} catch (err) {
		if (!isFileNotFoundError(err)) throw err;
		fileExists = false;
	}
	if (fileExists) {
		throw new Error('A board file already exists at ' + path);
	}
	const board = {
		version: 1,
		project: projectPath,
		columns: DEFAULT_COLUMNS.map(function (column) {
			return Object.assign({}, column);
		}),
	};
	await sdk.fs.write(path, serializeBoardYaml(board));
	boardCache.set(path, { board: board, error: null });
	return path;
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
 * reports one. Only consulted for a card with no remembered placement yet -
 * resolveCardColumnId() below is what every live card actually goes through.
 * @param {{ status?: string }} card
 */
function deriveColumn(card) {
	const status = card && typeof card.status === 'string' ? card.status : '';
	if (status === 'error') return 'blocked';
	if (status === 'busy' || status === 'connecting') return 'in-progress';
	return 'backlog';
}

// ===========================================================================
// Phase 02 placement persistence: remembers which column a card sits in
// instead of re-deriving it from live tab status on every refresh (Phase
// 01's deriveColumn() above is now only the landing spot for a card that has
// never been placed). Placements are grouped per board - keyed by the same
// boardFilePath() string this plugin already uses for board YAML - so a
// project board and the global board (Phase 03) never share one map and
// fight over the same keys. Stored through maestro.storage as a JSON object
// of { [cardKey]: { columnId, order } }, cached in memory the same way
// boardCache is; nothing polls.
//
// A placement is a column id plus an explicit position within that column.
// `order` is a dense 0..n index written by a move (see placeInColumnOrder in
// the Phase 03 section) and is absent for a card nobody has dragged yet,
// which is what makes a never-moved card sort by last activity instead of by
// a position it never asked for. The pre-ordering format stored a bare
// column-id string per card, so a string is still read as
// { columnId: <string>, order: null }: a user upgrading the plugin keeps
// every column they had, and loses only positions that were never recorded.
// ===========================================================================

/** @typedef {{ columnId: string, order: number|null }} Placement */
/** @type {Map<string, Map<string, Placement>>} boardFilePath() -> (cardKey -> Placement) */
const placementCache = new Map();
/** @type {Set<string>} board paths whose in-memory placement map changed and
 * still needs a maestro.storage.set to catch up. */
const dirtyPlacementBoards = new Set();

function placementStorageKey(boardPath) {
	return 'placements:' + boardPath;
}

/**
 * Reads one stored placement value into the { columnId, order } shape, or
 * null when it is neither shape this plugin has ever written. A bare string
 * is the pre-ordering format and keeps the column it names with no position;
 * an `order` that is not a finite number is dropped rather than trusted,
 * since a NaN order would poison every comparison in its column.
 * @param {unknown} value
 * @returns {Placement|null}
 */
function readStoredPlacement(value) {
	if (typeof value === 'string') {
		return value === '' ? null : { columnId: value, order: null };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const entry = /** @type {{ columnId?: unknown, order?: unknown }} */ (value);
	if (typeof entry.columnId !== 'string' || entry.columnId === '') return null;
	const hasOrder = typeof entry.order === 'number' && isFinite(entry.order);
	return {
		columnId: entry.columnId,
		order: hasOrder ? Math.floor(/** @type {number} */ (entry.order)) : null,
	};
}

/** Loads one board's placement map, from cache when present. Corrupt or
 * unexpected stored JSON (neither a bare column id nor a { columnId, order }
 * object) is treated the same as "nothing stored yet" rather than thrown,
 * since a placement map is disposable - the worst case is deriveColumn()
 * picking a landing spot again.
 * @param {string} boardPath */
async function loadPlacements(boardPath) {
	if (placementCache.has(boardPath)) return placementCache.get(boardPath);
	const map = new Map();
	try {
		const raw = await sdk.storage.get(placementStorageKey(boardPath));
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					const placement = readStoredPlacement(parsed[key]);
					if (placement) map.set(key, placement);
				}
			}
		}
	} catch (err) {
		console.error(
			'maestro-kanban: failed to read stored placements for ' + boardPath + ': ' + String(err)
		);
	}
	placementCache.set(boardPath, map);
	return map;
}

/** Records a card's column in the in-memory cache and marks its board for a
 * write on the next flushDirtyPlacements(). The card's recorded order is
 * left alone: a column change and a position change are written separately
 * through setPlacementOrder() below, so each caller says what it actually
 * knows (a move writes both; a repair writes the column and then clears the
 * order on purpose). A no-op when the column is already exactly what is
 * cached, so an unchanged refresh never schedules a redundant storage.set. */
function setPlacement(boardPath, key, columnId) {
	const map = placementCache.get(boardPath) || new Map();
	const existing = map.get(key);
	if (existing && existing.columnId === columnId) return;
	map.set(key, { columnId: columnId, order: existing ? existing.order : null });
	placementCache.set(boardPath, map);
	dirtyPlacementBoards.add(boardPath);
}

/** Records a card's explicit position within its column. Only ever called
 * for a card that already has a placement (the move handler writes the
 * column first, and a renumber only ever touches cards already on the
 * board), so an order with no column to hang off is not written. */
function setPlacementOrder(boardPath, key, order) {
	const map = placementCache.get(boardPath);
	const existing = map && map.get(key);
	if (!existing) return;
	if (existing.order === order) return;
	map.set(key, { columnId: existing.columnId, order: order });
	dirtyPlacementBoards.add(boardPath);
}

/** Writes every board whose placement map changed since the last flush, one
 * maestro.storage.set per board, then clears the dirty set. A failed write
 * logs and moves on - the in-memory cache stays authoritative for this
 * session either way, so a transient storage failure degrades to "forgets on
 * restart" rather than losing the current board. */
async function flushDirtyPlacements() {
	const boardPaths = Array.from(dirtyPlacementBoards);
	dirtyPlacementBoards.clear();
	for (const boardPath of boardPaths) {
		const map = placementCache.get(boardPath) || new Map();
		const obj = {};
		for (const [key, placement] of map) {
			obj[key] =
				placement.order === null
					? { columnId: placement.columnId }
					: { columnId: placement.columnId, order: placement.order };
		}
		try {
			await sdk.storage.set(placementStorageKey(boardPath), JSON.stringify(obj));
		} catch (err) {
			console.error(
				'maestro-kanban: failed to persist placements for ' + boardPath + ': ' + String(err)
			);
		}
	}
}

/**
 * The column a card belongs in: its remembered placement when one is stored
 * and still legal on its project's current columns; a repair to that
 * project's first column, logged and re-persisted, when the stored column no
 * longer exists (the user edited the YAML out from under it); or
 * deriveColumn()'s landing spot for a card that has never been placed. A
 * card with no projectPath has nowhere to key a placement under, so it
 * always falls back to deriveColumn(), same as Phase 01.
 * @param {{ key: string, projectPath?: string, status?: string }} card
 */
async function resolveCardColumnId(card) {
	if (typeof card.projectPath !== 'string' || card.projectPath === '') {
		return deriveColumn(card);
	}
	const boardPath = boardFilePath(card.projectPath);
	const [placements, projectBoardResult] = await Promise.all([
		loadPlacements(boardPath),
		loadProjectBoard(card.projectPath),
	]);
	const legalIds = resolveColumns(projectBoardResult.board, null).map((column) => column.id);
	const placement = placements.get(card.key);
	if (placement) {
		if (legalIds.indexOf(placement.columnId) !== -1) return placement.columnId;
		const fallback = legalIds[0];
		console.warn(
			'maestro-kanban: card ' +
				card.key +
				' was on column "' +
				placement.columnId +
				'", which no longer exists on its board; repaired to "' +
				fallback +
				'"'
		);
		setPlacement(boardPath, card.key, fallback);
		// The recorded order was a position in a column that no longer exists,
		// so it says nothing about where the card belongs now: clear it and let
		// the card sort by last activity in the column it was repaired into.
		setPlacementOrder(boardPath, card.key, null);
		return fallback;
	}
	const derived = deriveColumn(card);
	setPlacement(boardPath, card.key, derived);
	return derived;
}

/** Prunes every board's placement map down to the card keys that currently
 * exist, so storage does not grow without bound as tabs come and go. Only
 * ever called once, right after activate()'s first seed() - never from
 * doRefresh() or the 'refresh' command - since pruning is long-term storage
 * hygiene, not something the live board needs on every event. */
async function prunePlacements() {
	const liveKeys = new Set(cards.keys());
	for (const [boardPath, map] of placementCache) {
		for (const key of Array.from(map.keys())) {
			if (!liveKeys.has(key)) {
				map.delete(key);
				dirtyPlacementBoards.add(boardPath);
			}
		}
	}
	await flushDirtyPlacements();
}

/** Deletes every board's stored placement map, in storage and in memory, so
 * the next seed() re-derives every live card's landing spot from scratch via
 * deriveColumn(). Backs the 'clear-placements' command. */
async function clearAllPlacements() {
	const boardPaths = new Set(placementCache.keys());
	for (const card of cards.values()) {
		if (typeof card.projectPath === 'string' && card.projectPath !== '') {
			boardPaths.add(boardFilePath(card.projectPath));
		}
	}
	placementCache.clear();
	dirtyPlacementBoards.clear();
	for (const boardPath of boardPaths) {
		try {
			await sdk.storage.delete(placementStorageKey(boardPath));
		} catch (err) {
			console.error(
				'maestro-kanban: failed to clear placements for ' + boardPath + ': ' + String(err)
			);
		}
	}
}

// ===========================================================================
// End of Phase 02 placement persistence.
// ===========================================================================

// ===========================================================================
// Phase 03 move command: the single write path a drag (or a keyboard move)
// ends in. The panel's own legality check is advisory - it exists so a drop
// is never offered where it would fail - and this handler re-checks every
// move against legalColumnsFor() before touching anything, because the panel
// is untrusted renderer code and its snapshot can be stale by the time the
// post lands.
//
// A refusal cannot be a reply to the post: the panel bridge is one-way (see
// PANEL_DATA_CHANNEL in src/shared/plugins/panel-host.ts), so a refused move
// rides the next snapshot as `moveRejection: { cardKey, reason }` and the
// panel returns the card to its origin and shows the reason.
// ===========================================================================

/** @type {{ cardKey: string, reason: string }|null} A move the sandbox
 * refused, handed to the panel on the next snapshot and drained there: a
 * rejection is a one-shot message, not board state, so it must never stick
 * to every later snapshot. */
let pendingMoveRejection = null;

/**
 * A card's explicit position within its column, or null when nobody has
 * dragged it yet. Read straight out of the placement store rather than a
 * second in-memory map, so the order the board renders and the order it
 * persists cannot disagree, and so a restart resumes exactly where the user
 * left the column. A card with no projectPath has no placement to key an
 * order under, so it is always unordered.
 * @param {{ key: string, projectPath?: string }} card
 * @returns {number|null}
 */
function cardOrderOf(card) {
	if (typeof card.projectPath !== 'string' || card.projectPath === '') return null;
	const map = placementCache.get(boardFilePath(card.projectPath));
	const placement = map ? map.get(card.key) : undefined;
	return placement && typeof placement.order === 'number' ? placement.order : null;
}

/** Writes a card's explicit position within its column. A card with no
 * projectPath cannot carry one (handleMove refuses to move such a card for
 * the same reason), so it is skipped rather than silently half-applied.
 * @param {{ key: string, projectPath?: string }} card
 * @param {number|null} order */
function setCardOrder(card, order) {
	if (typeof card.projectPath !== 'string' || card.projectPath === '') return;
	setPlacementOrder(boardFilePath(card.projectPath), card.key, order);
}

/**
 * Display order of two cards sitting in the same column: the pure
 * compareCardsByOrder() rule, asked of persisted placements. The global
 * board's own projection asks the same rule of the card's declared `order`,
 * so a column reads the same way whichever board it is rendered on.
 */
function compareCardsInColumn(a, b) {
	return compareCardsByOrder(a, b, cardOrderOf);
}

/**
 * Buckets every live card into the active board's resolved columns, in
 * display order. The one place that mapping is decided, so the index the
 * panel reports in a drop and the index buildSnapshot() renders can never
 * drift apart. A card whose own columnId is not one of these resolved ids
 * lands in the first column rather than being dropped.
 * @param {{ id: string }[]} resolvedColumns
 * @returns {Map<string, object[]>}
 */
function groupCardsByColumn(resolvedColumns) {
	const fallbackColumnId = resolvedColumns.length > 0 ? resolvedColumns[0].id : 'backlog';
	const byColumn = new Map(resolvedColumns.map((column) => [column.id, []]));
	for (const card of cards.values()) {
		const list = byColumn.get(card.columnId) || byColumn.get(fallbackColumnId);
		if (list) list.push(card);
	}
	for (const list of byColumn.values()) list.sort(compareCardsInColumn);
	return byColumn;
}

/** Loads the boards buildSnapshot() and the move handler both need: the
 * active project's board, the global board, and resolveColumns()' output for
 * the pair. */
async function resolveActiveBoard() {
	const [projectResult, globalResult] = await Promise.all([
		activeProjectPath !== null
			? loadProjectBoard(activeProjectPath)
			: Promise.resolve({ board: null, error: null }),
		loadGlobalBoard(),
	]);
	return {
		projectResult: projectResult,
		globalResult: globalResult,
		columns: resolveColumns(projectResult.board, globalResult.board),
	};
}

/**
 * The id of the board the panel is currently rendering, which a `move` post
 * echoes back so a move aimed at a board the user has since switched away
 * from can be refused instead of silently landing on the wrong board. There
 * is exactly one board on screen today and it has no id, so this is null and
 * the panel posts null; the board switcher task is what gives a board an id.
 */
function currentBoardId() {
	return null;
}

/** Records a refusal for the next snapshot and reports it back to the
 * caller. The snapshot push is what the panel actually reacts to. */
function refuseMove(key, reason) {
	pendingMoveRejection = { cardKey: key, reason: reason };
	console.warn('maestro-kanban: refused move of "' + key + '": ' + reason);
	return pushSnapshotNow().then(() => ({ ok: false, reason: reason }));
}

/** Renumbers `columnId`'s cards into dense 0..n orders, with the card for
 * `key` (which may be arriving from another column) spliced in at `index`.
 * Every card in the column comes out explicitly ordered, including the ones
 * that were still sorting by last activity: once the user has arranged a
 * column by hand, a later burst of activity must not reshuffle it under
 * them. Returns the index the card actually landed on after clamping. */
function placeInColumnOrder(resolvedColumns, columnId, key, index) {
	const members = (groupCardsByColumn(resolvedColumns).get(columnId) || []).filter(
		(card) => card.key !== key
	);
	const moved = cards.get(key);
	const requested =
		typeof index === 'number' && isFinite(index) ? Math.floor(index) : members.length;
	const at = Math.max(0, Math.min(requested, members.length));
	const ordered = members.slice();
	if (moved) ordered.splice(at, 0, moved);
	for (let i = 0; i < ordered.length; i++) setCardOrder(ordered[i], i);
	return at;
}

/** Renumbers the column a card just left so its survivors keep dense orders
 * rather than a hole where the card used to be. Cards that were never
 * positioned by hand keep no order, so they stay in the last-activity block
 * at the top of the column instead of being pinned by a move they had
 * nothing to do with. */
function renumberColumnOrder(resolvedColumns, columnId) {
	if (typeof columnId !== 'string' || columnId === '') return;
	const members = groupCardsByColumn(resolvedColumns).get(columnId) || [];
	let next = 0;
	for (const card of members) {
		if (cardOrderOf(card) === null) continue;
		setCardOrder(card, next);
		next++;
	}
}

/**
 * Backs the panel's `move` command: `{ cardKey, toColumnId, toIndex,
 * boardId }`. Re-checks legality against the card's own project board (never
 * the panel's claim), writes the placement and the order, then pushes a
 * fresh snapshot. Every refusal names a specific reason, since "the move did
 * not apply" with no explanation is indistinguishable from a bug.
 * @param {{ cardKey?: unknown, toColumnId?: unknown, toIndex?: unknown, boardId?: unknown }} args
 */
async function handleMove(args) {
	const key = args && typeof args.cardKey === 'string' ? args.cardKey : '';
	const toColumnId = args && typeof args.toColumnId === 'string' ? args.toColumnId : '';
	const toIndex = args && typeof args.toIndex === 'number' ? args.toIndex : null;
	const boardId =
		args && typeof args.boardId === 'string' && args.boardId !== '' ? args.boardId : null;

	if (key === '' || toColumnId === '') {
		return refuseMove(key, 'the move was missing a card or a target column');
	}
	if (boardId !== null && boardId !== currentBoardId()) {
		return refuseMove(key, 'the board changed while the card was moving; try again');
	}
	const card = cards.get(key);
	if (!card) {
		return refuseMove(key, 'that card is no longer on the board');
	}
	if (typeof card.projectPath !== 'string' || card.projectPath === '') {
		// Nothing to key a placement under, so the move would survive until the
		// next refresh and then quietly snap back. Refusing is the honest answer.
		return refuseMove(key, 'that agent has no project folder, so the board cannot remember a move');
	}

	const [active, cardProjectResult] = await Promise.all([
		resolveActiveBoard(),
		loadProjectBoard(card.projectPath),
	]);
	const legal = legalColumnsFor(card, cardProjectResult.board, active.globalResult.board);
	if (legal.indexOf(toColumnId) === -1) {
		return refuseMove(key, '"' + toColumnId + '" is not a column that card can move to');
	}
	if (!active.columns.some((column) => column.id === toColumnId)) {
		return refuseMove(key, '"' + toColumnId + '" is no longer a column on this board');
	}

	const fromColumnId = card.columnId;
	card.columnId = toColumnId;
	setPlacement(boardFilePath(card.projectPath), key, toColumnId);
	const landedAt = placeInColumnOrder(active.columns, toColumnId, key, toIndex);
	if (fromColumnId !== toColumnId) renumberColumnOrder(active.columns, fromColumnId);
	await flushDirtyPlacements();
	await pushSnapshotNow();
	return { ok: true, columnId: toColumnId, index: landedAt };
}

// ===========================================================================
// End of Phase 03 move command.
// ===========================================================================

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
 * just the sessions that triggered this refresh. Column assignment is async
 * (it may read a board file and the placement store), so cards are built in
 * a first pass and their columns resolved in a second, and `cards` is only
 * swapped once every card has one - never partially. */
async function rebuildCardsFromTabs(tabs) {
	const built = [];
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
		built.push({
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
		});
	}
	const next = new Map();
	for (const card of built) {
		card.columnId = await resolveCardColumnId(card);
		next.set(card.key, card);
	}
	cards = next;
	await flushDirtyPlacements();
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
		.then((tabs) => rebuildCardsFromTabs(tabs))
		.then(() => {
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
		pushSnapshotNow().catch((err) => {
			console.error('maestro-kanban: pushSnapshotNow failed: ' + String(err));
		});
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

/**
 * Builds the panel snapshot for "the active board": resolveColumns()'s
 * output for activeProjectPath (or DEFAULT_COLUMNS when none is active yet),
 * each column carrying its title and wip_limit so the panel never has to
 * guess either. A card whose own columnId is not one of these resolved ids -
 * its home project uses different columns than the active board, or its
 * placement predates this task's fallback-bucket logic - lands in the first
 * column rather than being dropped; real cross-project aggregation is a
 * later Phase 03 task. Within a column, cards come out in
 * groupCardsByColumn()'s order, which honors whatever a move wrote.
 * `boardError` surfaces whichever of the active project's or the global
 * board's file most recently failed to parse, so a broken file is
 * diagnosable from the board itself, and `moveRejection` carries the one
 * refused move the panel still has to be told about - see handleMove().
 */
async function buildSnapshot() {
	const active = await resolveActiveBoard();
	const projectResult = active.projectResult;
	const globalResult = active.globalResult;
	const resolvedColumns = active.columns;
	const byColumn = groupCardsByColumn(resolvedColumns);
	// Drained, not copied: a refusal is a one-shot message to the panel, so it
	// must not ride every snapshot after the one that reports it.
	const moveRejection = pendingMoveRejection;
	pendingMoveRejection = null;
	const boardError =
		(activeProjectPath !== null && projectResult.error) || globalResult.error || null;
	// True only when there is an active project and it has no board file at
	// all yet (ENOENT, not a parse failure - that case is already covered by
	// boardError above). Lets the panel offer "write a default board" exactly
	// when there is a project with nothing to lose, never when one merely
	// failed to parse.
	const projectBoardMissing =
		activeProjectPath !== null && projectResult.board === null && projectResult.error === null;
	return {
		updatedAt: Date.now(),
		columns: resolvedColumns.map((column) => ({
			id: column.id,
			title: column.title,
			wipLimit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
			cards: (byColumn.get(column.id) || []).map(cardToJson),
		})),
		boardError: boardError,
		activeProjectPath: activeProjectPath,
		projectBoardMissing: projectBoardMissing,
		boardId: currentBoardId(),
		moveRejection: moveRejection,
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
 * then drop the bottom card of each column (round-robin) until it fits. The
 * bottom is the least prominent slot in compareCardsInColumn()'s order - the
 * end of the user's own arrangement, or the stalest never-positioned card -
 * so trimming never eats the card that just did something. */
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
				column.cards.pop();
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

async function pushSnapshotNow() {
	if (panelTimer) {
		clearTimeout(panelTimer);
		panelTimer = null;
	}
	if (!sdk) return;
	const snapshot = await buildSnapshot();
	const result = trimToBudget(snapshot);
	if (result.trimmed) {
		console.warn('maestro-kanban: board snapshot exceeded the panel budget and was trimmed');
		safeToast('Kanban board is large; some card detail was trimmed to fit the panel.');
	}
	await sdk.ui.panelPost('board', result.snapshot).catch((err) => {
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

/** Besides the usual markDirty() refresh, session.activated also updates
 * activeProjectPath - see its declaration above - so buildSnapshot() renders
 * whichever project the user just focused. A session with no known project
 * path (not yet seen by rebuildSessionMeta()/onSessionCreated()) clears it
 * back to null rather than leaving a stale project's columns on screen. */
function onSessionActivated(payload) {
	const sessionId = sessionIdForEvent('session.activated', payload);
	if (sessionId) {
		const projectPath = sessionProjectPath.get(sessionId);
		activeProjectPath = typeof projectPath === 'string' && projectPath !== '' ? projectPath : null;
	}
	markDirty(sessionId);
}

function registerEventHandlers(maestro) {
	maestro.events.on('session.created', onSessionCreated);
	maestro.events.on('session.updated', onSessionUpdated);
	maestro.events.on('session.removed', onSessionRemoved);
	maestro.events.on('session.activated', onSessionActivated);
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
		await rebuildCardsFromTabs(tabs);
	} catch (err) {
		console.error('maestro-kanban: tabs.list failed: ' + String(err));
	}
	await pushSnapshotNow();
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

	// Invoked by the panel's empty-state button via parent.postMessage; no
	// manifest `commands` entry is needed since it is never surfaced in the
	// command palette (same reasoning as 'focus' above).
	maestro.commands.register('write-default-board', (args) => {
		const projectPath =
			args && typeof args.projectPath === 'string' && args.projectPath !== ''
				? args.projectPath
				: undefined;
		if (!projectPath) {
			return safeToast('No active project to write a board file for.').then(() => ({
				ok: false,
			}));
		}
		return writeDefaultBoard(projectPath)
			.then((path) =>
				pushSnapshotNow().then(() =>
					safeToast('Wrote default board to ' + path).then(() => ({ ok: true, path: path }))
				)
			)
			.catch((err) => {
				console.error('maestro-kanban: write-default-board failed: ' + String(err));
				return safeToast(errorMessage(err)).then(() => ({ ok: false, error: errorMessage(err) }));
			});
	});

	maestro.commands.register('clear-placements', () =>
		clearAllPlacements()
			.then(() => seed())
			.then(() => ({ ok: true }))
			.catch((err) => {
				console.error('maestro-kanban: clear-placements failed: ' + String(err));
				return { ok: false };
			})
	);

	// Invoked by the panel when a drag ends in a drop (and, later, by its
	// keyboard move); no manifest `commands` entry is needed since it is never
	// surfaced in the command palette.
	maestro.commands.register('move', (args) =>
		handleMove(args).catch((err) => {
			console.error('maestro-kanban: move failed: ' + String(err));
			return refuseMove(
				args && typeof args.cardKey === 'string' ? args.cardKey : '',
				errorMessage(err)
			);
		})
	);

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

	// Phase 03 pure global board aggregation, exported for direct unit testing
	// (see src/__tests__/plugins/kanban-global-board.test.ts). Pure like the
	// Phase 02 model above: no host calls, and nothing read out of the runtime
	// state, so a test calls them without activate().
	UNMAPPED_COLUMN_ID: UNMAPPED_COLUMN_ID,
	UNMAPPED_COLUMN_TITLE: UNMAPPED_COLUMN_TITLE,
	buildGlobalBoard: buildGlobalBoard,
	globalColumnForCard: globalColumnForCard,
	legalGlobalColumnsFor: legalGlobalColumnsFor,
	projectColumnForGlobalColumn: projectColumnForGlobalColumn,
	compareCardsByOrder: compareCardsByOrder,
	declaredCardOrder: declaredCardOrder,

	// Phase 02 filesystem plumbing, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-persistence.test.ts). These call
	// sdk.fs.read/write, so a test must call activate() with a stub SDK first.
	boardFilePath: boardFilePath,
	loadProjectBoard: loadProjectBoard,
	loadGlobalBoard: loadGlobalBoard,
	saveProjectBoard: saveProjectBoard,
	writeDefaultBoard: writeDefaultBoard,
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
		await prunePlacements();
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
		activeProjectPath = null;
		placementCache.clear();
		dirtyPlacementBoards.clear();
		pendingMoveRejection = null;
		if (sdk) {
			return sdk.events.unsubscribe().catch(() => {});
		}
		return undefined;
	},
};
