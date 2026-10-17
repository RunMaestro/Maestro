/** @import { MaestroSdk } from '@maestro/plugin-sdk' */
/* global module, console, setTimeout, clearTimeout, setInterval, clearInterval */

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

// ===========================================================================
// Phase 05 aging model (pure functions only - no `sdk`/`maestro` calls, no
// I/O, nothing read out of the runtime state below). A Done column that only
// grows stops being information, so a card that has sat in the terminal
// column long enough fades and is eventually retired to the archive. Three
// rules keep that from ever being a surprise:
//
//   1. Aging is opt-in. `agingEnabled` defaults to false, and with it off
//      every card renders at opacity 1 and nothing ever expires, no matter
//      how long it has been sitting there.
//   2. Only the terminal column ages. A card dragged back out of Done has no
//      aging state at all (setPlacement() below drops the stamp on any
//      column change), and dragging it back in starts a fresh clock rather
//      than resuming the old one.
//   3. Any new message or comment on the card restarts the clock. "Done but
//      still being talked about" is not stale, so the newest of the two
//      timestamps wins over the moment the card entered Done.
//
// Nothing here closes a tab, writes a file, or removes a card: this layer
// only answers "how faint is this card, and is it past its horizon". The
// retirement that acts on `expired` is a separate, later step.
// ===========================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Opacity of a card that has reached its horizon. Deliberately above zero:
 * a card that is still on the board is still actionable, so it fades to
 * "nearly gone" and then disappears by being retired, never by rendering as
 * an invisible hit target the user cannot see but can still click. */
const AGING_OPACITY_FLOOR = 0.1;

/** A horizon of less than a day would retire cards faster than the
 * low-frequency retirement tick runs, and anything past a year is
 * indistinguishable from "off" - both ends are clamped rather than refused,
 * so a hand-edited stored value can never wedge the board. */
const MIN_HORIZON_DAYS = 1;
const MAX_HORIZON_DAYS = 365;

/** @typedef {{ agingEnabled: boolean, horizonDays: number, closeTabsOnRetire: boolean }} AgingSettings */

/** The settings a board with nothing stored runs under. Aging off and tab
 * closing off are both load-bearing defaults: a board the user has never
 * configured must behave exactly like Phase 04's did, and must never close
 * an AI tab (and its transcript) as a side effect of a board setting. */
const DEFAULT_AGING_SETTINGS = { agingEnabled: false, horizonDays: 14, closeTabsOnRetire: false };

/**
 * Reads whatever is stored (or posted by the panel) into a complete
 * `AgingSettings`. Every field falls back to its default independently, so a
 * partial patch from the settings surface and a half-written storage value
 * both land on the same safe shape; `horizonDays` is rounded and clamped
 * into [MIN_HORIZON_DAYS, MAX_HORIZON_DAYS] rather than rejected.
 * @param {unknown} raw
 * @returns {AgingSettings}
 */
function normalizeAgingSettings(raw) {
	const value =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? /** @type {{ agingEnabled?: unknown, horizonDays?: unknown, closeTabsOnRetire?: unknown }} */ (
					raw
				)
			: {};
	const horizonRaw = value.horizonDays;
	let horizonDays = DEFAULT_AGING_SETTINGS.horizonDays;
	if (typeof horizonRaw === 'number' && isFinite(horizonRaw)) {
		horizonDays = Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, Math.round(horizonRaw)));
	}
	return {
		agingEnabled: value.agingEnabled === true,
		horizonDays: horizonDays,
		closeTabsOnRetire: value.closeTabsOnRetire === true,
	};
}

/** A timestamp this plugin is willing to treat as a clock reading, or null.
 * @param {unknown} value */
function finiteTimestamp(value) {
	return typeof value === 'number' && isFinite(value) ? value : null;
}

/** Rounds an opacity to three decimals so the same elapsed time always
 * renders the same string, instead of 0.5499999999999999 one tick and 0.55
 * the next. @param {number} value */
function roundOpacity(value) {
	return Math.round(value * 1000) / 1000;
}

/**
 * The whole aging picture for one card, as a value: whether aging applies to
 * it at all, when its clock started, how far along it is, how faint it
 * should render, and whether it is past its horizon.
 *
 * `card` carries what this layer needs and nothing more:
 *   - `columnId` and `terminalColumnId`: aging applies only when they match,
 *     so a card sitting anywhere but Done is reported as not aging even if a
 *     stale stamp survived somewhere.
 *   - `enteredDoneAt`: when the card entered the terminal column, or null
 *     for a card that has never been there (the caller stores this on the
 *     card's placement - see setPlacement()/setPlacementDoneSince() below).
 *   - `lastCommentAt` and `lastMessageAt`: the newest of the two restarts
 *     the clock when it is later than `enteredDoneAt`.
 *
 * A disabled board still reports the real `enteredDoneAt`/`elapsedDays` -
 * the panel's settings surface shows how old the Done cards already are
 * before anyone turns aging on - but reports `opacity: 1` and
 * `expired: false`, which is what "aging is opt-in" means in practice.
 *
 * @param {{ columnId?: unknown, terminalColumnId?: unknown, enteredDoneAt?: unknown, lastCommentAt?: unknown, lastMessageAt?: unknown }} card
 * @param {unknown} settings
 * @param {number} now
 * @returns {{ enabled: boolean, enteredDoneAt: number|null, resetAt: number|null, elapsedDays: number, horizonDays: number, opacity: number, expired: boolean }}
 */
function agingState(card, settings, now) {
	const resolved = normalizeAgingSettings(settings);
	const horizonDays = resolved.horizonDays;
	const source = card && typeof card === 'object' ? card : {};
	const columnId = typeof source.columnId === 'string' ? source.columnId : null;
	const terminalColumnId =
		typeof source.terminalColumnId === 'string' ? source.terminalColumnId : null;
	const inTerminalColumn =
		columnId !== null && terminalColumnId !== null && columnId === terminalColumnId;
	const enteredDoneAt = inTerminalColumn ? finiteTimestamp(source.enteredDoneAt) : null;
	const idle = {
		enabled: false,
		enteredDoneAt: enteredDoneAt,
		resetAt: null,
		elapsedDays: 0,
		horizonDays: horizonDays,
		opacity: 1,
		expired: false,
	};
	// Not in Done, or in Done but not stamped yet (the stamp lands on the
	// next reconcile): either way there is no clock to read.
	if (!inTerminalColumn || enteredDoneAt === null) return idle;

	const lastCommentAt = finiteTimestamp(source.lastCommentAt);
	const lastMessageAt = finiteTimestamp(source.lastMessageAt);
	let newestTouch = null;
	if (lastCommentAt !== null) newestTouch = lastCommentAt;
	if (lastMessageAt !== null && (newestTouch === null || lastMessageAt > newestTouch)) {
		newestTouch = lastMessageAt;
	}
	const resetAt = newestTouch !== null && newestTouch > enteredDoneAt ? newestTouch : null;
	const clockStart = resetAt === null ? enteredDoneAt : resetAt;
	// A clock start in the future (a clock skew, or a comment stamped ahead)
	// reads as "just now" rather than as negative age.
	const elapsedDays = Math.max(0, (now - clockStart) / MS_PER_DAY);

	if (!resolved.agingEnabled) {
		return {
			enabled: false,
			enteredDoneAt: enteredDoneAt,
			resetAt: resetAt,
			elapsedDays: elapsedDays,
			horizonDays: horizonDays,
			opacity: 1,
			expired: false,
		};
	}

	const progress = Math.min(1, Math.max(0, elapsedDays / horizonDays));
	return {
		enabled: true,
		enteredDoneAt: enteredDoneAt,
		resetAt: resetAt,
		elapsedDays: elapsedDays,
		horizonDays: horizonDays,
		opacity: roundOpacity(1 - progress * (1 - AGING_OPACITY_FLOOR)),
		expired: elapsedDays >= horizonDays,
	};
}

// ===========================================================================
// End of Phase 05 aging model.
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

// ===========================================================================
// Phase 04 access state. The host, not this plugin, decides which sessions
// this board may message or read History of (see plugin-session-grants.ts):
// a session it created itself, or one the user approved through a one-time
// Maestro confirmation. This plugin never creates sessions, so every card's
// session starts OUTSIDE grantedSessions and only enters it when
// sessions.requestAccess() resolves { granted: true } - never assumed from
// the session merely existing on the board. A dispatch or History read the
// host later denies for a revoked grant drops the session back out of this
// set (see isGrantDenial() below and its two call sites) so the card returns
// to its "not connected" state.
// ===========================================================================

/** @type {Set<string>} sessionId -> granted to message or read History for */
const grantedSessions = new Set();

/** Whether this plugin may message `sessionId` or read its History right
 * now. Drives the card's "not connected" marker and the detail pane's
 * access gate; never optimistic, so an unrecognized or never-asked session
 * reads as not granted rather than assuming the best. */
function isSessionAccessGranted(sessionId) {
	return typeof sessionId === 'string' && grantedSessions.has(sessionId);
}

/** True for the specific denial `transcripts.read` and `agents.dispatch` both
 * throw when a `granted-sessions` plugin's session is not (or no longer) in
 * its grant set (see the two handlers in plugin-host-handlers.ts - they share
 * this exact substring). Distinguishing this from every other denial (rate
 * limit, egress conflict, an unsigned plugin, no unattended consent, ...) is
 * what lets a revoked grant drop the card back to its "not connected" state
 * instead of rendering a generic error.
 * @param {string} message
 */
function isGrantDenial(message) {
	return typeof message === 'string' && message.indexOf('is not granted to this plugin') !== -1;
}

// ===========================================================================
// Phase 04 History excerpt. transcripts.read returns History, not a live
// transcript (see the host facts at the top of this phase's playbook entry),
// and it is rate-limited and audited - so this plugin only ever calls it for
// the one session a detail pane is actually open on, never for every card in
// a snapshot, and caches what it reads so repeatedly opening or re-rendering
// the same pane does not spend that budget again. The cache is invalidated by
// that session's own agent.completed/run.completed events, not a timer: see
// onHistoryRelevantEvent() below, which also re-reads immediately when the
// invalidated session is the one currently open.
// ===========================================================================

/** maestro.transcripts.read only ever projects these fields - the small,
 * labeled-as-History excerpt the detail pane shows, never the fuller
 * fullResponse/agentSessionId/etc. a different reader might want. */
const HISTORY_EXCERPT_FIELDS = ['summary', 'timestamp', 'type', 'success'];
/** A small limit: the excerpt is "recent History", not a full transcript. */
const HISTORY_EXCERPT_LIMIT = 8;
/** Short TTL: long enough that opening the same pane twice in a row (or
 * switching between two tabs of the same agent) does not re-read, short
 * enough that a pane left open does not keep showing minutes-old History
 * between completion events. */
const HISTORY_CACHE_TTL_MS = 20000;

/** @typedef {{ fetchedAt: number, rows: object[]|null, error: string|null }} HistoryCacheEntry */
/** @type {Map<string, HistoryCacheEntry>} sessionId -> last read (or last
 * denial) of that session's History excerpt. */
const historyCache = new Map();

/** The session the detail pane most recently asked for History on, or null
 * when no pane has asked (or the one that asked has since closed). Drives
 * both historyExcerptSnapshot() below and which session's
 * agent.completed/run.completed event triggers a proactive re-read instead
 * of a merely lazy cache invalidation. */
let openHistorySessionId = null;

/**
 * Reads and caches one session's recent History excerpt. Serves the cached
 * entry when it is still within HISTORY_CACHE_TTL_MS, unless `force` is set
 * (the event-driven re-read below always forces). Never rejects: a denial is
 * recorded as `{ error }` for historyExcerptSnapshot() to render as "History
 * not available", except a revoked grant, which instead removes the session
 * from grantedSessions and its cache entry and resolves to null, so the card
 * returns to its ungranted state on the next snapshot rather than showing an
 * error about a History it is no longer allowed to read at all.
 * @param {string} sessionId
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<HistoryCacheEntry|null>}
 */
async function readSessionHistoryExcerpt(sessionId, options) {
	const force = !!(options && options.force);
	const cached = historyCache.get(sessionId);
	if (!force && cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
		return cached;
	}
	try {
		const rows = await sdk.transcripts.read({
			sessionId: sessionId,
			fields: HISTORY_EXCERPT_FIELDS,
			limit: HISTORY_EXCERPT_LIMIT,
		});
		const result = { fetchedAt: Date.now(), rows: Array.isArray(rows) ? rows : [], error: null };
		historyCache.set(sessionId, result);
		return result;
	} catch (err) {
		const message = errorMessage(err);
		if (isGrantDenial(message)) {
			grantedSessions.delete(sessionId);
			historyCache.delete(sessionId);
			return null;
		}
		const result = { fetchedAt: Date.now(), rows: null, error: message };
		historyCache.set(sessionId, result);
		return result;
	}
}

/** The History excerpt buildSnapshot() hands the panel: null when no pane has
 * asked for one, or the session it last asked for is no longer granted (the
 * access gate already covers that card; there is nothing to show). Reads the
 * cache only - fetching is read-history's job, never buildSnapshot()'s, so
 * pushing a snapshot for an unrelated reason (a move, a comment, an unrelated
 * card's status changing) never itself triggers a transcripts.read. `status`
 * is 'loading' for a session read-history has been asked about but has not
 * resolved yet. */
function historyExcerptSnapshot() {
	if (openHistorySessionId === null || !isSessionAccessGranted(openHistorySessionId)) return null;
	const cached = historyCache.get(openHistorySessionId);
	if (!cached) {
		return { sessionId: openHistorySessionId, status: 'loading', rows: [], error: null };
	}
	if (cached.error) {
		return { sessionId: openHistorySessionId, status: 'error', rows: [], error: cached.error };
	}
	return {
		sessionId: openHistorySessionId,
		status: 'loaded',
		rows: cached.rows || [],
		error: null,
	};
}

/** Besides the usual markDirty() refresh, agent.completed and run.completed
 * also drop that session's cached History excerpt - the event the task asks
 * this to re-read on, never a timer - and, when that session is the one the
 * detail pane currently has open, re-read it right away and push, so an open
 * pane's excerpt catches up with the turn that just finished without the user
 * having to close and reopen the pane. A session nothing has ever read
 * History for has no cache entry to invalidate, so this is a no-op for every
 * card the user has not opened the detail pane on.
 * @param {string} topic
 * @param {unknown} payload
 */
function onHistoryRelevantEvent(topic, payload) {
	onGenericSessionEvent(topic, payload);
	const sessionId = sessionIdForEvent(topic, payload);
	if (!sessionId || !historyCache.has(sessionId)) return;
	historyCache.delete(sessionId);
	if (sessionId !== openHistorySessionId || !isSessionAccessGranted(sessionId)) return;
	readSessionHistoryExcerpt(sessionId, { force: true })
		.then(() => pushSnapshotNow())
		.catch((err) => {
			console.error('maestro-kanban: History re-read on ' + topic + ' failed: ' + String(err));
		});
}

// ===========================================================================
// End of Phase 04 History excerpt.
// ===========================================================================

// ===========================================================================
// Phase 04 messaging. maestro.agents.dispatch(sessionId, prompt, { tabId }) -
// nothing else in the payload, since both the outer and the `opts` schema are
// closed and an extra key throws - is the only way this plugin ever sends a
// prompt to an agent's tab, and the `send-message` command below is the only
// place it is called. The command never rejects: it always resolves and
// always pushes a fresh snapshot, because the panel<->sandbox bridge is one
// way (see ui.panelPost) and the snapshot's `messageOutcome` on the card (see
// cardToJson) is the only channel the composer has for learning whether its
// send resolved or failed. `lastMessageOutcomes` is this plugin's own
// in-memory bookkeeping of that outcome, never persisted - unlike
// description/comments, a send attempt is not data the user asked this board
// to remember across a restart.
// ===========================================================================

/** @typedef {{ status: 'sent'|'failed', error: string|null, at: number }} MessageOutcome */
/** @type {Map<string, MessageOutcome>} cardKey -> the last send-message
 * attempt's outcome, read by cardToJson() so the composer can tell a send it
 * is still waiting on apart from one the host has already answered. */
const lastMessageOutcomes = new Map();

/**
 * Calls `agents.dispatch` for one already-granted session/tab and never
 * rejects: resolves `{ ok: true, error: null }` on success, or
 * `{ ok: false, error }` with the host's own message on any denial. A denial
 * for a revoked grant additionally drops the session out of grantedSessions
 * and its History cache - the same recovery readSessionHistoryExcerpt()
 * already does - so the card returns to its ungranted state on the snapshot
 * the caller pushes; every other denial (unsigned, no unattended consent, the
 * rate cap, an unknown tab) is returned as-is, naming what is missing in the
 * host's own words rather than a guess this plugin would have to maintain.
 * @param {string} sessionId
 * @param {string} tabId
 * @param {string} prompt
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function dispatchCardMessage(sessionId, tabId, prompt) {
	try {
		await sdk.agents.dispatch(sessionId, prompt, { tabId: tabId });
		return { ok: true, error: null };
	} catch (err) {
		const message = errorMessage(err);
		if (isGrantDenial(message)) {
			grantedSessions.delete(sessionId);
			historyCache.delete(sessionId);
		} else {
			console.error('maestro-kanban: agents.dispatch failed: ' + String(err));
		}
		return { ok: false, error: message };
	}
}

// ===========================================================================
// End of Phase 04 messaging.
// ===========================================================================

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
//
// Phase 05 adds a third field, `enteredDoneAt`: the moment the card landed
// in the terminal column, which is where the aging clock starts. It lives on
// the placement rather than in a map of its own precisely so that a column
// change cannot leave it behind - setPlacement() writes a fresh record on
// every column change, so a card dragged out of Done loses its aging state
// in the same write that moves it, and dragging it back in starts a new
// clock instead of resuming the old one. It is absent (null) for every card
// that is not in Done, and for a card whose stamp has not been reconciled
// yet (see reconcileAgingClocks() below).
// ===========================================================================

/** @typedef {{ columnId: string, order: number|null, enteredDoneAt: number|null }} Placement */
/** @type {Map<string, Map<string, Placement>>} boardFilePath() -> (cardKey -> Placement) */
const placementCache = new Map();
/** @type {Set<string>} board paths whose in-memory placement map changed and
 * still needs a maestro.storage.set to catch up. */
const dirtyPlacementBoards = new Set();

function placementStorageKey(boardPath) {
	return 'placements:' + boardPath;
}

/**
 * Reads one stored placement value into the { columnId, order,
 * enteredDoneAt } shape, or null when it is neither shape this plugin has
 * ever written. A bare string is the pre-ordering format and keeps the
 * column it names with no position; an `order` that is not a finite number
 * is dropped rather than trusted, since a NaN order would poison every
 * comparison in its column, and the same goes for a non-finite
 * `enteredDoneAt`, which would make every elapsed-time comparison NaN.
 * @param {unknown} value
 * @returns {Placement|null}
 */
function readStoredPlacement(value) {
	if (typeof value === 'string') {
		return value === '' ? null : { columnId: value, order: null, enteredDoneAt: null };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const entry = /** @type {{ columnId?: unknown, order?: unknown, enteredDoneAt?: unknown }} */ (
		value
	);
	if (typeof entry.columnId !== 'string' || entry.columnId === '') return null;
	const hasOrder = typeof entry.order === 'number' && isFinite(entry.order);
	return {
		columnId: entry.columnId,
		order: hasOrder ? Math.floor(/** @type {number} */ (entry.order)) : null,
		enteredDoneAt: finiteTimestamp(entry.enteredDoneAt),
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
	// A column change always drops the aging stamp: a card leaving Done has
	// no aging state at all, and one arriving in Done gets a fresh clock from
	// reconcileAgingClocks() rather than inheriting a stamp from the last
	// time it was there.
	map.set(key, {
		columnId: columnId,
		order: existing ? existing.order : null,
		enteredDoneAt: null,
	});
	placementCache.set(boardPath, map);
	dirtyPlacementBoards.add(boardPath);
}

/** Stamps (or clears) the moment a card entered the terminal column. Only
 * ever called by reconcileAgingClocks() below, and only for a card that
 * already has a placement - the column is the thing being timed, so a stamp
 * with no column to hang off is not written.
 * @param {string} boardPath
 * @param {string} key
 * @param {number|null} at
 */
function setPlacementDoneSince(boardPath, key, at) {
	const map = placementCache.get(boardPath);
	const existing = map && map.get(key);
	if (!existing) return;
	if (existing.enteredDoneAt === at) return;
	map.set(key, { columnId: existing.columnId, order: existing.order, enteredDoneAt: at });
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
	map.set(key, {
		columnId: existing.columnId,
		order: order,
		enteredDoneAt: existing.enteredDoneAt,
	});
	dirtyPlacementBoards.add(boardPath);
}

/** Forgets a card's placement entirely, so the card has no column, no
 * position and no aging clock on that board any more. Phase 05's retirement
 * is the only caller: a retired card's record lives in the archive from then
 * on, and leaving a placement behind would both put the card back on the
 * board at the next rebuild and keep a stale Done clock in storage. Returns
 * whether there was anything to forget.
 * @param {string} boardPath
 * @param {string} key
 */
function removePlacement(boardPath, key) {
	const map = placementCache.get(boardPath);
	if (!map || !map.has(key)) return false;
	map.delete(key);
	dirtyPlacementBoards.add(boardPath);
	return true;
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
			/** @type {{ columnId: string, order?: number, enteredDoneAt?: number }} */
			const stored = { columnId: placement.columnId };
			if (placement.order !== null) stored.order = placement.order;
			if (placement.enteredDoneAt !== null) stored.enteredDoneAt = placement.enteredDoneAt;
			obj[key] = stored;
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
// Phase 04 card notes: a description and a comment thread, kept in plugin
// storage keyed by card key (cardKey(), the same `sessionId::tabId` identity
// every card already carries - see the `card-note` command below). Unlike
// the placement map above, a card's notes are never pruned when its tab
// closes: the whole point is that they survive the tab closing and its card
// being archived, so nothing here ever reads from or depends on `cards`.
// They are also independent of the access-grant state in the section
// above - the panel's own data, not something the host gates - so every
// function here works identically on a granted or an ungranted card.
//
// Loaded once into memory at activate() (see loadCardNotes(), called
// alongside loadSelectedBoard() before the first seed()), then kept
// authoritative in memory with a write-through to storage on every change -
// same shape as selectBoard() above, not the batched flush placements use,
// because a note write (a blur, a posted comment) is already rare enough
// that there is nothing to coalesce.
// ===========================================================================

const CARD_NOTES_STORAGE_KEY = 'card-notes';

/** @typedef {{ id: string, body: string, createdAt: number }} CardComment */
/** @typedef {{ description: string, comments: CardComment[], lastCommentAt: number|null }} CardNote */

/** @type {Map<string, CardNote>} cardKey -> note */
let cardNotes = new Map();

/** The note a card with nothing stored yet is treated as having: never
 * written to storage itself, but a shape every caller can rely on so nobody
 * has to null-check `cardNotes.get(key)`. */
function emptyCardNote() {
	return { description: '', comments: [], lastCommentAt: null };
}

/** Reads one stored comment into its `{ id, body, createdAt }` shape, or null
 * when it is missing a piece this plugin never wrote without. Corrupt
 * entries are dropped rather than trusted, same reasoning as
 * readStoredPlacement() above - a note is disposable storage, not a ledger.
 * @param {unknown} value
 * @returns {CardComment|null}
 */
function readStoredComment(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const entry = /** @type {{ id?: unknown, body?: unknown, createdAt?: unknown }} */ (value);
	if (typeof entry.id !== 'string' || entry.id === '') return null;
	if (typeof entry.body !== 'string' || entry.body === '') return null;
	if (typeof entry.createdAt !== 'number' || !isFinite(entry.createdAt)) return null;
	return { id: entry.id, body: entry.body, createdAt: entry.createdAt };
}

/** Reads one stored note value into its `CardNote` shape, or null when it is
 * not a shape this plugin has ever written.
 * @param {unknown} value
 * @returns {CardNote|null}
 */
function readStoredCardNote(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const entry =
		/** @type {{ description?: unknown, comments?: unknown, lastCommentAt?: unknown }} */ (value);
	const description = typeof entry.description === 'string' ? entry.description : '';
	const comments = Array.isArray(entry.comments)
		? entry.comments.map(readStoredComment).filter(Boolean)
		: [];
	const lastCommentAt =
		typeof entry.lastCommentAt === 'number' && isFinite(entry.lastCommentAt)
			? entry.lastCommentAt
			: null;
	return {
		description: description,
		comments: /** @type {CardComment[]} */ (comments),
		lastCommentAt: lastCommentAt,
	};
}

/** Restores every card's note from storage. Called once, before activate()'s
 * first seed(), so the very first snapshot already carries whatever was
 * written in a previous session. A storage failure, or a value that is not
 * the object this plugin writes, degrades to "no notes yet" rather than
 * throwing the activation. */
async function loadCardNotes() {
	cardNotes = new Map();
	try {
		const raw = await sdk.storage.get(CARD_NOTES_STORAGE_KEY);
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					const note = readStoredCardNote(parsed[key]);
					if (note) cardNotes.set(key, note);
				}
			}
		}
	} catch (err) {
		console.error('maestro-kanban: failed to read stored card notes: ' + String(err));
	}
}

/** A card's note, read-only: whatever is stored, or emptyCardNote() when
 * nothing has been written for this card key yet. Never mutates the cache -
 * every caller that wants to change a note goes through setCardDescription()
 * or addCardComment() below.
 * @param {string} cardKey
 */
function noteFor(cardKey) {
	return cardNotes.get(cardKey) || emptyCardNote();
}

/** Writes the whole `cardNotes` map to storage in one call. A failed write
 * logs and moves on: the in-memory map stays authoritative for this session
 * either way, so a transient storage failure degrades to "forgets on
 * restart" rather than losing the note just written. */
async function persistCardNotes() {
	const obj = {};
	for (const [key, note] of cardNotes) {
		obj[key] = note;
	}
	try {
		await sdk.storage.set(CARD_NOTES_STORAGE_KEY, JSON.stringify(obj));
	} catch (err) {
		console.error('maestro-kanban: failed to persist card notes: ' + String(err));
	}
}

/** Sets a card's description and persists it. Backs the `card-note` command's
 * `description` action. A no-op when the new text is exactly what is already
 * stored, so a blur that changed nothing never schedules a redundant write.
 * @param {string} cardKey
 * @param {string} description
 */
async function setCardDescription(cardKey, description) {
	const existing = noteFor(cardKey);
	if (existing.description === description) return existing;
	const updated = {
		description: description,
		comments: existing.comments,
		lastCommentAt: existing.lastCommentAt,
	};
	cardNotes.set(cardKey, updated);
	await persistCardNotes();
	return updated;
}

/** 32 bits of Math.random(), base36-encoded, prefixed with the current time
 * in the same base - unique enough for a comment id within one card's
 * thread, which is all this ever has to be. Not cryptographic, same spirit
 * as fnv1a32Hex() above. */
function nextCommentId() {
	return Date.now().toString(36) + '-' + Math.floor(Math.random() * 0x100000000).toString(36);
}

/** Appends a comment to a card's thread and persists it, stamping the card's
 * `lastCommentAt` with the comment's own timestamp - what Phase 05's aging
 * clock reads. Backs the `card-note` command's `comment` action. Comments
 * are appended only: this phase never edits or removes one in place.
 * @param {string} cardKey
 * @param {string} body
 */
async function addCardComment(cardKey, body) {
	const existing = noteFor(cardKey);
	const comment = { id: nextCommentId(), body: body, createdAt: Date.now() };
	const updated = {
		description: existing.description,
		comments: existing.comments.concat([comment]),
		lastCommentAt: comment.createdAt,
	};
	cardNotes.set(cardKey, updated);
	await persistCardNotes();
	return updated;
}

// ===========================================================================
// End of Phase 04 card notes.
// ===========================================================================

// ===========================================================================
// Phase 05 aging runtime: the stateful half of the aging model above. Three
// pieces, in the order a card meets them.
//
//   1. Board settings. `{ agingEnabled, horizonDays, closeTabsOnRetire }`
//      stored per board id - the same ids the switcher uses, so a project
//      path or GLOBAL_BOARD_ID - in one storage value, loaded once at
//      activate() and written through on every change (the same shape the
//      card notes above use, and for the same reason: a settings write is a
//      click, not something to coalesce).
//   2. Which settings a given card runs under. A card ages in its own
//      project's Done column, so its own project board's settings win; the
//      Global board's settings stand in as the default for every project
//      that has none of its own, which is what makes the Global board's
//      settings surface mean something. Neither stored means
//      DEFAULT_AGING_SETTINGS, which is aging off.
//   3. The clock stamp. reconcileAgingClocks() runs after every card rebuild
//      and is the only writer of `enteredDoneAt`: it stamps a card that is
//      in its board's terminal column and has no stamp, and clears one that
//      is stamped but no longer in Done. setPlacement() already drops the
//      stamp on a column change, so the clear is a repair for stored state
//      written before this phase existed, not the normal path.
//
// Nothing here closes a tab or deletes a card. agingStateForCard() answers
// "how faint, how old, expired yet"; acting on `expired` is a later step.
// ===========================================================================

const BOARD_SETTINGS_STORAGE_KEY = 'board-settings';

/** @type {Map<string, AgingSettings>} board id -> that board's settings */
let boardSettings = new Map();

/** Restores every board's settings from storage. Called once, alongside
 * loadCardNotes(), before activate()'s first seed(), so the first snapshot
 * already renders at the right opacity instead of flashing full-strength
 * cards. A storage failure, or a value that is not the object this plugin
 * writes, degrades to "every board on defaults" (aging off) rather than
 * throwing the activation. */
async function loadBoardSettings() {
	boardSettings = new Map();
	try {
		const raw = await sdk.storage.get(BOARD_SETTINGS_STORAGE_KEY);
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					boardSettings.set(key, normalizeAgingSettings(parsed[key]));
				}
			}
		}
	} catch (err) {
		console.error('maestro-kanban: failed to read stored board settings: ' + String(err));
	}
}

/** Writes every board's settings in one call. A failed write logs and moves
 * on: the in-memory map stays authoritative for this session, so the failure
 * degrades to "forgets on restart" rather than refusing the change. */
async function persistBoardSettings() {
	const obj = {};
	for (const [boardId, settings] of boardSettings) {
		obj[boardId] = settings;
	}
	try {
		await sdk.storage.set(BOARD_SETTINGS_STORAGE_KEY, JSON.stringify(obj));
	} catch (err) {
		console.error('maestro-kanban: failed to persist board settings: ' + String(err));
	}
}

/** One board's stored settings, or null when that board has never been
 * configured. Callers that want an answer either way use
 * agingSettingsForBoard() below.
 * @param {string|null} boardId */
function storedBoardSettings(boardId) {
	if (typeof boardId !== 'string' || boardId === '') return null;
	return boardSettings.get(boardId) || null;
}

/** The settings a board runs under: its own when it has them, the Global
 * board's when it does not, and DEFAULT_AGING_SETTINGS when neither exists.
 * @param {string|null} boardId
 * @returns {AgingSettings} */
function agingSettingsForBoard(boardId) {
	return (
		storedBoardSettings(boardId) ||
		storedBoardSettings(GLOBAL_BOARD_ID) ||
		normalizeAgingSettings(DEFAULT_AGING_SETTINGS)
	);
}

/** Records one board's settings and persists the whole map. `patch` is
 * merged over whatever that board already has, so the settings surface can
 * post a single toggle without restating the other two.
 * @param {string} boardId
 * @param {unknown} patch
 * @returns {Promise<AgingSettings>} */
async function setBoardAgingSettings(boardId, patch) {
	const current = storedBoardSettings(boardId) || agingSettingsForBoard(boardId);
	const merged = normalizeAgingSettings(
		Object.assign({}, current, patch && typeof patch === 'object' ? patch : {})
	);
	const existing = storedBoardSettings(boardId);
	if (
		existing &&
		existing.agingEnabled === merged.agingEnabled &&
		existing.horizonDays === merged.horizonDays &&
		existing.closeTabsOnRetire === merged.closeTabsOnRetire
	) {
		return existing;
	}
	boardSettings.set(boardId, merged);
	await persistBoardSettings();
	return merged;
}

/** The settings one card ages under: its own project board's, per the
 * fallback chain in agingSettingsForBoard(). A card with no project path has
 * no board to read settings off and runs on the Global board's (or the
 * defaults).
 * @param {{ projectPath?: string }} card */
function agingSettingsForCard(card) {
	const projectPath =
		card && typeof card.projectPath === 'string' && card.projectPath !== ''
			? card.projectPath
			: null;
	return agingSettingsForBoard(projectPath);
}

/** A card's stored placement, synchronously, or null. Safe to read without
 * awaiting loadPlacements() because every live card has already been through
 * resolveCardColumnId(), which loads its board's map before returning.
 * @param {{ key: string, projectPath?: string }} card */
function placementForCard(card) {
	if (!card || typeof card.projectPath !== 'string' || card.projectPath === '') return null;
	const map = placementCache.get(boardFilePath(card.projectPath));
	return (map && map.get(card.key)) || null;
}

/** The terminal column id of one project's board, or null when that project
 * resolves to no columns at all. Reads come from boardCache after the first
 * call, so a whole reconcile pass is one board read per distinct project.
 * @param {string} projectPath */
async function terminalColumnIdForProject(projectPath) {
	const projectBoardResult = await loadProjectBoard(projectPath);
	const terminal = resolveTerminalColumn(resolveColumns(projectBoardResult.board, null));
	return terminal ? terminal.id : null;
}

/** Stamps every card that is sitting in its board's terminal column without
 * a clock, and clears the stamp on every card that has one but is no longer
 * in Done. Called from rebuildCardsFromTabs() before the placement flush, so
 * a stamp rides out to storage in the same write as the placement it belongs
 * to. Never closes a tab, never removes a card: this only moves the clock.
 * @param {number} [now] */
async function reconcileAgingClocks(now) {
	const at = typeof now === 'number' && isFinite(now) ? now : Date.now();
	/** @type {Map<string, string|null>} project path -> terminal column id */
	const terminalByProject = new Map();
	for (const card of cards.values()) {
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		if (!terminalByProject.has(card.projectPath)) {
			terminalByProject.set(card.projectPath, await terminalColumnIdForProject(card.projectPath));
		}
		const terminalId = terminalByProject.get(card.projectPath);
		const boardPath = boardFilePath(card.projectPath);
		const placement = placementForCard(card);
		if (!placement) continue;
		const inTerminal = terminalId !== null && placement.columnId === terminalId;
		if (inTerminal && placement.enteredDoneAt === null) {
			setPlacementDoneSince(boardPath, card.key, at);
		} else if (!inTerminal && placement.enteredDoneAt !== null) {
			setPlacementDoneSince(boardPath, card.key, null);
		}
	}
}

/** The last time a message this plugin sent for a card actually landed, or
 * null. A failed send is not a message on the card, so it does not restart
 * the aging clock.
 * @param {string} key */
function lastSentMessageAt(key) {
	const outcome = lastMessageOutcomes.get(key);
	return outcome && outcome.status === 'sent' ? outcome.at : null;
}

/** agingState() for one live card, assembled from the runtime state the pure
 * function deliberately knows nothing about: the card's stored stamp, its
 * note's newest comment, the newest message sent through its composer, and
 * its board's settings.
 * @param {object} card
 * @param {string|null} terminalColumnId
 * @param {number} [now] */
function agingStateForCard(card, terminalColumnId, now) {
	const placement = placementForCard(card);
	return agingState(
		{
			columnId: card.columnId,
			terminalColumnId: terminalColumnId,
			enteredDoneAt: placement ? placement.enteredDoneAt : null,
			lastCommentAt: noteFor(card.key).lastCommentAt,
			lastMessageAt: lastSentMessageAt(card.key),
		},
		agingSettingsForCard(card),
		typeof now === 'number' && isFinite(now) ? now : Date.now()
	);
}

// ===========================================================================
// End of Phase 05 aging runtime.
// ===========================================================================

// ===========================================================================
// Phase 05 archive storage: where a retired card goes. Aging is only ever
// allowed to be non-destructive, so a card that ages out of Done is not
// deleted - it is written to a per-board JSON file under
// `~/.maestro/kanban-archive`, inside the same `~/.maestro/kanban*` area
// Phase 02 confined this plugin to, and stays browsable from the panel.
//
// Four rules, all of them about not losing anything:
//
//   1. One function builds the path. archiveFilePath() is the only producer
//      of a string ever handed to maestro.fs.* for the archive, the same
//      discipline boardFilePath() holds for board YAML, so no caller can
//      smuggle an arbitrary path through it.
//   2. A missing file is an empty archive, not an error. Nothing has ever
//      been retired on that board yet.
//   3. A file that exists but does not parse is surfaced (the archive view
//      renders the error) and NEVER overwritten. maestro.fs.write replaces
//      a whole file, so writing over an archive we could not read would
//      destroy every record in it; saveArchive() re-reads and aborts
//      instead, exactly as saveProjectBoard() does for a board file.
//   4. The file is capped. Past ARCHIVE_RECORD_CAP records the oldest are
//      pruned first, and each prune is logged with the card key it dropped
//      so the one destructive act in this whole phase leaves a trail.
//
// Deliberately uncached, unlike boardCache above: the archive is read when
// the archive view opens and when the retirement tick runs (hours apart),
// and a stale cache here would mean showing a card as archived that was
// already restored. One fs.read per read is the cheaper trade.
// ===========================================================================

const ARCHIVE_DIR = '~/.maestro/kanban-archive';

/** Basename of the Global board's archive file. The Global board's id is
 * the reserved GLOBAL_BOARD_ID rather than a path, so it gets a reserved
 * basename too; every project path slugs through projectBoardSlug(), whose
 * output always ends in `-<fnv1a8>` and can therefore never collide with
 * this literal. */
const GLOBAL_ARCHIVE_BASENAME = 'global';

/** How many records one board's archive keeps. Past this the oldest are
 * pruned on write. Chosen to be far more than a board will retire in normal
 * use while still bounding the file: 500 records of a card's title,
 * description and comments stays comfortably small to read and re-write as
 * one JSON document. */
const ARCHIVE_RECORD_CAP = 500;

/** @typedef {{ key: string, retiredAt: number, reason: string, title: string, sessionId: string|null, tabId: string|null, agentName: string|null, projectPath: string|null, columnHistory: string[], description: string, comments: CardComment[] }} ArchiveRecord */

/**
 * The one place an archive file path is produced. `GLOBAL_BOARD_ID` names
 * the Global board's archive; any other value must be a non-empty project
 * path, which maps to that project's archive file under the same
 * `<basename>-<fnv1a8>` slug its board YAML already uses, so the two files
 * for one project are recognizably a pair. The leading `~` is left for the
 * host to expand (see plugin-home-path.ts). Throws on anything else.
 * @param {string|null|undefined} boardId
 */
function archiveFilePath(boardId) {
	if (boardId === GLOBAL_BOARD_ID) {
		return ARCHIVE_DIR + '/' + GLOBAL_ARCHIVE_BASENAME + '.json';
	}
	if (typeof boardId !== 'string' || boardId === '') {
		throw new Error(
			'archiveFilePath requires a board id: a non-empty project path, or GLOBAL_BOARD_ID'
		);
	}
	return ARCHIVE_DIR + '/' + projectBoardSlug(boardId) + '.json';
}

/** A string field of a stored record, or '' - an archive is read by a
 * person, so a missing title is an empty line and not a dropped record.
 * @param {unknown} value */
function archiveString(value) {
	return typeof value === 'string' ? value : '';
}

/** A string field that is allowed to be genuinely absent (a card with no
 * project, a tab that was never known), as `null` rather than ''.
 * @param {unknown} value */
function archiveNullableString(value) {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Reads one stored entry into an `ArchiveRecord`, or null when it is
 * missing the two fields this plugin never writes a record without - the
 * card key it is a record OF, and when it was retired, which is what the
 * cap prunes and the archive view sorts on. Everything else degrades to an
 * empty value: same reasoning as readStoredComment() above, except
 * inverted, because an archive IS a ledger - a record with a readable key
 * and date is kept even if the rest of it was hand-edited into nonsense,
 * rather than silently vanishing.
 * @param {unknown} value
 * @returns {ArchiveRecord|null}
 */
function readStoredArchiveRecord(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const entry = /** @type {Record<string, unknown>} */ (value);
	if (typeof entry.key !== 'string' || entry.key === '') return null;
	const retiredAt = finiteTimestamp(entry.retiredAt);
	if (retiredAt === null) return null;
	const comments = Array.isArray(entry.comments)
		? /** @type {CardComment[]} */ (entry.comments.map(readStoredComment).filter(Boolean))
		: [];
	const columnHistory = Array.isArray(entry.columnHistory)
		? entry.columnHistory.filter(function (id) {
				return typeof id === 'string' && id !== '';
			})
		: [];
	return {
		key: entry.key,
		retiredAt: retiredAt,
		reason: archiveString(entry.reason),
		title: archiveString(entry.title),
		sessionId: archiveNullableString(entry.sessionId),
		tabId: archiveNullableString(entry.tabId),
		agentName: archiveNullableString(entry.agentName),
		projectPath: archiveNullableString(entry.projectPath),
		columnHistory: /** @type {string[]} */ (columnHistory),
		description: archiveString(entry.description),
		comments: comments,
	};
}

/** Newest retirement first, which is both the order the archive view lists
 * in and the order the cap prunes from the end of.
 * @param {ArchiveRecord} a @param {ArchiveRecord} b */
function compareArchiveRecords(a, b) {
	if (b.retiredAt !== a.retiredAt) return b.retiredAt - a.retiredAt;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Reads one board's archive. Never rejects, so neither the retirement tick
 * nor the archive view has to guard it:
 *   - missing file -> `{ records: [], error: null, exists: false }`
 *   - unreadable or unparseable -> `{ records: [], error, exists: true }`,
 *     which the archive view renders and saveArchive() refuses to write
 *     over.
 * Records come back normalized and newest first; an entry too broken to
 * read is dropped from the returned list but, because a dropped entry does
 * not make the FILE unparseable, is also dropped from the next write. That
 * is the one lossy path here and it only reaches entries missing a card key
 * or a retirement date.
 * @param {string} boardId
 * @returns {Promise<{ records: ArchiveRecord[], error: { message: string, path: string }|null, exists: boolean }>}
 */
async function loadArchive(boardId) {
	const path = archiveFilePath(boardId);
	let text;
	try {
		text = await sdk.fs.read(path);
	} catch (err) {
		if (isFileNotFoundError(err)) return { records: [], error: null, exists: false };
		return { records: [], error: { message: errorMessage(err), path: path }, exists: true };
	}
	try {
		const parsed = JSON.parse(String(text));
		const list = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === 'object' && Array.isArray(parsed.records)
				? parsed.records
				: null;
		if (list === null) {
			throw new Error('archive file is not a record array');
		}
		const records = /** @type {ArchiveRecord[]} */ (
			list.map(readStoredArchiveRecord).filter(Boolean)
		);
		records.sort(compareArchiveRecords);
		return { records: records, error: null, exists: true };
	} catch (err) {
		return { records: [], error: { message: errorMessage(err), path: path }, exists: true };
	}
}

/**
 * Applies the cap, pruning the oldest records first. Pure, and separated
 * from the write so a test can read the prune without a filesystem. Logs
 * every dropped record by key: this is the only place the plugin discards
 * something a user might want back, so it is never silent.
 * @param {ArchiveRecord[]} records
 * @param {string} path
 * @returns {ArchiveRecord[]}
 */
function pruneArchiveRecords(records, path) {
	const sorted = records.slice().sort(compareArchiveRecords);
	if (sorted.length <= ARCHIVE_RECORD_CAP) return sorted;
	const dropped = sorted.slice(ARCHIVE_RECORD_CAP);
	for (const record of dropped) {
		console.warn(
			'maestro-kanban: archive ' +
				path +
				' is at its ' +
				ARCHIVE_RECORD_CAP +
				'-record cap; pruning oldest record ' +
				record.key +
				' retired ' +
				new Date(record.retiredAt).toISOString()
		);
	}
	return sorted.slice(0, ARCHIVE_RECORD_CAP);
}

/**
 * Writes one board's archive as a whole JSON document (maestro.fs.write
 * replaces a file, so there is no append). Re-reads first and REFUSES the
 * write when what is already there does not parse, so a hand-edit or a
 * half-written file is never destroyed by the next retirement - the same
 * guard saveProjectBoard() holds over a board file, and the reason the
 * archive is worth having at all.
 *
 * Resolves to the records actually written. Throws, naming the path, when
 * the existing file is unreadable; the caller leaves the card on the board
 * and tries again on the next tick rather than dropping it on the floor.
 * @param {string} boardId
 * @param {ArchiveRecord[]} records
 * @returns {Promise<ArchiveRecord[]>}
 */
async function saveArchive(boardId, records) {
	const path = archiveFilePath(boardId);
	const existing = await loadArchive(boardId);
	if (existing.error) {
		throw new Error(
			'Refusing to overwrite an unreadable archive at ' + path + ': ' + existing.error.message
		);
	}
	const kept = pruneArchiveRecords(Array.isArray(records) ? records : [], path);
	await sdk.fs.write(path, JSON.stringify({ version: 1, records: kept }, null, '\t') + '\n');
	return kept;
}

/**
 * Adds records to one board's archive and writes it back, newest first and
 * capped. A record whose key is already archived replaces the stored one
 * rather than doubling it, so retiring a card that was restored and retired
 * again leaves one entry and not two. Resolves to the written list; throws
 * through saveArchive() when the existing file is unreadable.
 * @param {string} boardId
 * @param {ArchiveRecord[]} additions
 * @returns {Promise<ArchiveRecord[]>}
 */
async function appendToArchive(boardId, additions) {
	const existing = await loadArchive(boardId);
	if (existing.error) {
		throw new Error(
			'Refusing to overwrite an unreadable archive at ' +
				archiveFilePath(boardId) +
				': ' +
				existing.error.message
		);
	}
	const incoming = (Array.isArray(additions) ? additions : [])
		.map(readStoredArchiveRecord)
		.filter(Boolean);
	/** @type {Map<string, ArchiveRecord>} */
	const byKey = new Map();
	for (const record of existing.records) byKey.set(record.key, record);
	for (const record of /** @type {ArchiveRecord[]} */ (incoming)) byKey.set(record.key, record);
	return saveArchive(boardId, Array.from(byKey.values()));
}

// ===========================================================================
// End of Phase 05 archive storage.
// ===========================================================================

// ===========================================================================
// Phase 05 retirement: the one way a card leaves the board. The aging model
// above says a card is `expired`; this is what acts on that, and it is
// deliberately the narrowest thing that can: an archive record is written,
// the card's placement is forgotten, and the card drops out of the in-memory
// model. Nothing else. In particular THIS PATH NEVER TOUCHES A TAB - losing
// an AI tab and its transcript as a side effect of a board setting is
// unacceptable, so the opt-in close (`closeTabsOnRetire`) is a separate
// layer, immediately below, that runs alongside retirement rather than
// inside it: only the aging sweep calls into it, and only for a card that
// has already come back from here as retired.
//
// Five properties worth knowing:
//
//   1. It runs on activate() and then on a low-frequency interval -
//      RETIREMENT_TICK_MS is hours, not seconds. Aging is measured in days,
//      so a card is retired within a few hours of its horizon and the plugin
//      spends essentially nothing watching the clock. Opening the panel does
//      not sweep; neither does a refresh.
//   2. The archive write comes FIRST and the board edit second. If
//      appendToArchive() throws (an unreadable archive file it refuses to
//      overwrite), that board's cards are left exactly where they are and
//      the next tick tries again - a card is never removed from the board
//      without a record of it existing.
//   3. A card is archived under its own project's board id, which is the
//      board it was actually on, so a retirement from the Global board's
//      view still lands in the right project's archive file.
//   4. The archive is the thing that keeps a retired card off the board. Its
//      tab usually still exists (retirement does not close it, and the
//      opt-in close is off by default), so
//      rebuildCardsFromTabs() would otherwise rebuild the card from
//      tabs.list() on the next event and drop it back into Backlog. The
//      per-board set of archived keys is read once per board per session and
//      maintained by retirement (and, later, by Restore).
//   5. A retired card's note (its description and comment thread) is left in
//      storage, not deleted. The record carries a copy for the archive view
//      to render, and keeping the original means Restore puts the card back
//      with its thread intact rather than with a flattened snapshot of it.
// ===========================================================================

/** How often the retirement sweep runs. Hours, not seconds: the horizon it
 * enforces is measured in days, so checking a few times a day retires a card
 * well inside the day it expired while costing nothing in between. */
const RETIREMENT_TICK_MS = 6 * 60 * 60 * 1000;

/** The reason stamped on a card the aging horizon retired, as opposed to one
 * a person archived by hand (those reasons come from their own callers in a
 * later task). Stored on the record and shown in the archive view, so it is
 * a sentence fragment a person reads, not a code. */
const RETIREMENT_REASON_AGED = 'aged out of Done';

/** How many columns of one card's trail are kept. A card that has been
 * dragged around for months should not grow an unbounded array in its
 * archive record; the oldest hops are dropped first. */
const COLUMN_TRAIL_CAP = 24;

/** @type {Map<string, string[]>} card key -> the columns it has been seen in
 * this session, oldest first, consecutive duplicates collapsed. This is the
 * `columnHistory` an archive record carries. It is session-scoped on purpose:
 * a column trail is interesting but not worth a format change to the
 * placement store (which records where a card IS, not where it has been), so
 * a card first seen after a restart has a trail that starts at the column it
 * was found in. A record therefore always names at least the column the card
 * retired from, which is the part that matters. */
const cardColumnTrail = new Map();

/** @type {Map<string, Set<string>>} board id -> the card keys that board's
 * archive holds. Read once per board per session (see
 * archivedKeysForBoard()) rather than per rebuild, and kept current by
 * retirement itself, so no sweep or repaint re-reads an archive file. */
const archivedCardKeys = new Map();

/** @type {ReturnType<typeof setInterval>|null} */
let retirementTimer = null;

/** Appends a column to a card's trail, collapsing a repeat of the column it
 * is already on so a rebuild that changes nothing does not grow the trail.
 * @param {string} key
 * @param {string} columnId
 */
function noteCardColumn(key, columnId) {
	if (typeof key !== 'string' || key === '') return;
	if (typeof columnId !== 'string' || columnId === '') return;
	const trail = cardColumnTrail.get(key) || [];
	if (trail.length > 0 && trail[trail.length - 1] === columnId) return;
	trail.push(columnId);
	if (trail.length > COLUMN_TRAIL_CAP) trail.splice(0, trail.length - COLUMN_TRAIL_CAP);
	cardColumnTrail.set(key, trail);
}

/** One card's column trail for its archive record, with `columnId` appended
 * when the trail does not already end there - so a record always names the
 * column the card retired from even if the trail was never populated.
 * @param {string} key
 * @param {unknown} columnId
 * @returns {string[]}
 */
function columnTrailFor(key, columnId) {
	const trail = (cardColumnTrail.get(key) || []).slice();
	if (typeof columnId === 'string' && columnId !== '' && trail[trail.length - 1] !== columnId) {
		trail.push(columnId);
	}
	return trail;
}

/**
 * The set of card keys one board's archive holds, read from disk the first
 * time and cached for the session after that. An archive file this plugin
 * cannot read yields an EMPTY set, logged: the safe direction when in doubt
 * is to leave a card on the board the user can see, not to hide it on the
 * strength of a file that did not parse.
 * @param {string} boardId
 * @returns {Promise<Set<string>>}
 */
async function archivedKeysForBoard(boardId) {
	const cached = archivedCardKeys.get(boardId);
	if (cached) return cached;
	/** @type {Set<string>} */
	const keys = new Set();
	const result = await loadArchive(boardId);
	if (result.error) {
		console.error(
			'maestro-kanban: cannot read the archive at ' +
				result.error.path +
				', so no card on that board is treated as archived: ' +
				result.error.message
		);
	}
	for (const record of result.records) keys.add(record.key);
	archivedCardKeys.set(boardId, keys);
	return keys;
}

/** Whether a card has already been retired and therefore does not belong on
 * the board, even though its tab is still open. Synchronous: every board with
 * live cards has been through archivedKeysForBoard() in the same rebuild.
 * @param {{ key: string, projectPath?: string }} card
 */
function isCardArchived(card) {
	if (!card || typeof card.projectPath !== 'string' || card.projectPath === '') return false;
	const keys = archivedCardKeys.get(card.projectPath);
	return !!keys && keys.has(card.key);
}

/** Makes sure every board represented in `cardList` has its archived-key set
 * loaded, so the rebuild that follows can filter synchronously. One fs.read
 * per board per session.
 * @param {Iterable<{ projectPath?: string }>} cardList
 */
async function ensureArchivedKeysLoaded(cardList) {
	/** @type {Set<string>} */
	const boardIds = new Set();
	for (const card of cardList) {
		if (card && typeof card.projectPath === 'string' && card.projectPath !== '') {
			if (!archivedCardKeys.has(card.projectPath)) boardIds.add(card.projectPath);
		}
	}
	for (const boardId of boardIds) await archivedKeysForBoard(boardId);
}

/**
 * One live card as the archive record that outlives it: the card's identity,
 * what it was called, who was working it, where it had been, and this
 * plugin's own note on it, flattened into the record so the archive view can
 * render a retired card with no live card to read. `agentName` prefers the
 * session's title (the name the user gave the agent in the Left Bar) and
 * falls back to the provider id, which is all this plugin knows for a
 * session it has never seen a title for.
 * @param {object} card
 * @param {string} reason
 * @param {number} retiredAt
 * @returns {ArchiveRecord}
 */
function archiveRecordForCard(card, reason, retiredAt) {
	const note = noteFor(card.key);
	return {
		key: card.key,
		retiredAt: retiredAt,
		reason: archiveString(reason),
		title: archiveString(card.title),
		sessionId: archiveNullableString(card.sessionId),
		tabId: archiveNullableString(card.tabId),
		agentName:
			archiveNullableString(sessionTitle.get(card.sessionId)) ||
			archiveNullableString(card.agentId),
		projectPath: archiveNullableString(card.projectPath),
		columnHistory: columnTrailFor(card.key, card.columnId),
		description: note.description,
		comments: note.comments.slice(),
	};
}

/**
 * Every card whose aging horizon has passed, with the state that says so.
 * Reads the same agingStateForCard() the panel renders opacity from, so a
 * card is only ever retired on exactly the condition the user watched it fade
 * towards. A card with no project path has no board, no terminal column and
 * no archive, so it is never retirable.
 * @param {number} now
 * @returns {Promise<{ card: object, state: ReturnType<typeof agingState> }[]>}
 */
async function collectExpiredCards(now) {
	/** @type {Map<string, string|null>} project path -> terminal column id */
	const terminalByProject = new Map();
	const expired = [];
	for (const card of cards.values()) {
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		if (!terminalByProject.has(card.projectPath)) {
			terminalByProject.set(card.projectPath, await terminalColumnIdForProject(card.projectPath));
		}
		const state = agingStateForCard(card, terminalByProject.get(card.projectPath), now);
		if (state.expired) expired.push({ card: card, state: state });
	}
	return expired;
}

/**
 * Retires cards: archive record first, board edit second, no tab touched.
 * The single path a card leaves the board by - the aging sweep below and the
 * manual Clear Done / Archive Now actions all come through here, so there is
 * exactly one place that knows how a card is removed.
 *
 * Cards are grouped by their own project board so each archive file is read
 * and written once. A board whose archive refuses the write (unreadable file)
 * leaves its cards on the board and reports them in `failed`; the next tick
 * retries. Resolves to the keys that were actually retired.
 * @param {object[]} targets
 * @param {string} reason
 * @param {number} [now]
 * @returns {Promise<{ retired: string[], failed: string[] }>}
 */
async function retireCards(targets, reason, now) {
	const at = typeof now === 'number' && isFinite(now) ? now : Date.now();
	/** @type {Map<string, object[]>} board id -> cards retiring from it */
	const byBoard = new Map();
	/** @type {string[]} */
	const failed = [];
	for (const card of Array.isArray(targets) ? targets : []) {
		if (!card || typeof card.key !== 'string' || card.key === '') continue;
		if (typeof card.projectPath !== 'string' || card.projectPath === '') {
			// No project means no board file, no placement and no archive file to
			// write to: there is nowhere to retire this card TO.
			console.warn(
				'maestro-kanban: cannot retire card ' +
					card.key +
					': that agent has no project folder, so it has no archive to retire to'
			);
			failed.push(card.key);
			continue;
		}
		const group = byBoard.get(card.projectPath) || [];
		group.push(card);
		byBoard.set(card.projectPath, group);
	}

	/** @type {string[]} */
	const retired = [];
	for (const [boardId, group] of byBoard) {
		const records = group.map(function (card) {
			return archiveRecordForCard(card, reason, at);
		});
		try {
			await appendToArchive(boardId, records);
		} catch (err) {
			// The archive refused the write, so nothing is removed: a card is
			// never taken off the board without a record of it.
			console.error(
				'maestro-kanban: could not archive ' +
					group.length +
					' card(s) from ' +
					boardId +
					'; leaving them on the board for the next sweep: ' +
					errorMessage(err)
			);
			for (const card of group) failed.push(card.key);
			continue;
		}
		const archivedKeys = await archivedKeysForBoard(boardId);
		const boardPath = boardFilePath(boardId);
		for (const card of group) {
			archivedKeys.add(card.key);
			removePlacement(boardPath, card.key);
			cards.delete(card.key);
			cardColumnTrail.delete(card.key);
			console.log(
				'maestro-kanban: retired card ' +
					card.key +
					' ("' +
					archiveString(card.title) +
					'") to ' +
					archiveFilePath(boardId) +
					': ' +
					archiveString(reason)
			);
			retired.push(card.key);
		}
	}
	if (retired.length > 0) await flushDirtyPlacements();
	return { retired: retired, failed: failed };
}

/**
 * One pass of the aging sweep: find the expired cards, close the tabs the
 * user opted into closing, and retire the rest. Called at activate() and
 * then every RETIREMENT_TICK_MS. A pass that retires nothing is completely
 * silent - no snapshot push, no log, no tabs.list() - so the common case
 * (aging off, or nothing near its horizon) costs one walk of the card map.
 *
 * The three steps are strictly ordered, and the order is the safety
 * property: the plan decides which cards may lose a tab (and defers the
 * ones whose tab is busy), retirement writes the archive and edits the
 * board, and only a card that came back from retirement as actually retired
 * has its tab closed.
 * @param {number} [now]
 * @returns {Promise<{ retired: string[], failed: string[], closed: string[], deferred: string[] }>}
 */
async function runRetirementSweep(now) {
	const at = typeof now === 'number' && isFinite(now) ? now : Date.now();
	const expired = await collectExpiredCards(at);
	if (expired.length === 0) return { retired: [], failed: [], closed: [], deferred: [] };
	const plan = await planRetirementTabCloses(
		expired.map(function (entry) {
			return entry.card;
		})
	);
	const result =
		plan.retire.length > 0
			? await retireCards(plan.retire, RETIREMENT_REASON_AGED, at)
			: { retired: [], failed: [] };
	const closed = await closeTabsForRetiredCards(
		plan.closeTabs,
		result.retired,
		RETIREMENT_REASON_AGED
	);
	if (result.retired.length > 0) await pushSnapshotNow();
	return {
		retired: result.retired,
		failed: result.failed,
		closed: closed,
		deferred: plan.deferred.map(function (card) {
			return card.key;
		}),
	};
}

/** Starts the low-frequency sweep. Idempotent, so a reactivation never ends
 * up with two intervals. Unref'd where the host's timers support it, so the
 * interval is never the reason a process stays alive. */
function startRetirementTicks() {
	if (retirementTimer) return;
	retirementTimer = setInterval(function () {
		runRetirementSweep().catch(function (err) {
			console.error('maestro-kanban: retirement sweep failed: ' + String(err));
		});
	}, RETIREMENT_TICK_MS);
	if (retirementTimer && typeof retirementTimer.unref === 'function') retirementTimer.unref();
}

/** Stops the sweep. Called from deactivate(), which is the only reason a
 * plugin that is going away must not leave a timer behind. */
function stopRetirementTicks() {
	if (!retirementTimer) return;
	clearInterval(retirementTimer);
	retirementTimer = null;
}

// ===========================================================================
// End of Phase 05 retirement.
// ===========================================================================

// ===========================================================================
// Phase 05 opt-in tab close: the one place in this plugin that can destroy
// something the user cannot get back. Retirement above is pure bookkeeping;
// this layer sits BESIDE it rather than inside it, so that every other way a
// card can leave the board - the manual Clear Done and Archive Now actions,
// and anything a later phase adds - reaches retireCards() and provably
// cannot reach a tab. Only the aging sweep calls in here, which is what
// "only at age-out" means in code.
//
// Four conditions, all of which must hold before maestro.tabs.close() is
// called even once:
//
//   1. The card's own board has `closeTabsOnRetire` set to true. The
//      default is false, and a board that has never been configured
//      inherits the Global board's setting or the default - the same
//      fallback chain the rest of aging uses.
//   2. The tab is the retiring card's OWN tabId. Nothing here iterates
//      tabs, closes a session's other tabs, or closes anything it did not
//      get from a card that just retired.
//   3. The tab's CURRENT status, from a fresh maestro.tabs.list() taken in
//      this sweep, is not busy. The card model's own `status` is as old as
//      the last rebuild, and an agent can start a turn in between; a busy
//      tab means the card's whole retirement is deferred to the next tick,
//      so the card keeps its placement, its clock and its tab.
//   4. The card actually retired. The archive write comes first, so a card
//      whose archive refused the write is still on the board - and a card
//      still on the board keeps its tab.
//
// Every close is logged with the card key, the tab id and the retirement
// reason, and so is every deferral, because a vanished tab must never be a
// thing the user has to reconstruct from the absence of a card.
// ===========================================================================

/** Tab statuses that mean "do not close this tab": a turn is running, or one
 * is about to be. Deliberately the narrow, literal set the host emits rather
 * than "anything that is not idle" - treating an unrecognized status as busy
 * would defer such a card's retirement forever instead of once. */
const BUSY_TAB_STATUSES = new Set(['busy', 'connecting']);

/** @param {unknown} status */
function isTabStatusBusy(status) {
	return typeof status === 'string' && BUSY_TAB_STATUSES.has(status);
}

/**
 * Every tab's status right now, read fresh rather than taken from the card
 * model: a card's `status` is as old as the last rebuild, and this is the
 * check standing between a busy agent and a closed transcript.
 * @returns {Promise<Map<string, string>|null>} null when the host refused
 * the read, which is never treated as "not busy".
 */
async function readLiveTabStatuses() {
	try {
		const tabs = await sdk.tabs.list();
		/** @type {Map<string, string>} */
		const statuses = new Map();
		for (const tab of Array.isArray(tabs) ? tabs : []) {
			if (!tab || typeof tab !== 'object') continue;
			if (typeof tab.id !== 'string' || tab.id === '') continue;
			statuses.set(tab.id, typeof tab.status === 'string' ? tab.status : '');
		}
		return statuses;
	} catch (err) {
		console.error(
			'maestro-kanban: tabs.list failed while checking whether a retiring card is busy, ' +
				'so no tab is closed and those cards wait for the next sweep: ' +
				errorMessage(err)
		);
		return null;
	}
}

/**
 * Splits the expired cards into the ones that retire in this sweep and the
 * ones that wait for the next one, and names the tabs that may be closed
 * afterwards. The tabs.list() read only happens when at least one expired
 * card's board actually opted in, so a board with the default settings adds
 * no RPC to a sweep.
 * @param {object[]} expiredCards
 * @returns {Promise<{ retire: object[], closeTabs: object[], deferred: object[] }>}
 */
async function planRetirementTabCloses(expiredCards) {
	/** @type {object[]} */
	const retire = [];
	/** @type {object[]} */
	const wantsClose = [];
	for (const card of Array.isArray(expiredCards) ? expiredCards : []) {
		if (!card) continue;
		const optedIn = agingSettingsForCard(card).closeTabsOnRetire === true;
		if (optedIn && typeof card.tabId === 'string' && card.tabId !== '') wantsClose.push(card);
		else retire.push(card);
	}
	if (wantsClose.length === 0) return { retire: retire, closeTabs: [], deferred: [] };

	const statuses = await readLiveTabStatuses();
	/** @type {object[]} */
	const closeTabs = [];
	/** @type {object[]} */
	const deferred = [];
	for (const card of wantsClose) {
		if (!statuses) {
			// No answer about this tab's status is not an answer of "idle".
			deferred.push(card);
			continue;
		}
		if (!statuses.has(card.tabId)) {
			// The tab is already gone, so there is nothing to close and nothing
			// to be careful about: the card retires on its own.
			retire.push(card);
			continue;
		}
		if (isTabStatusBusy(statuses.get(card.tabId))) {
			console.log(
				'maestro-kanban: card ' +
					card.key +
					' is past its Done horizon, but its tab ' +
					card.tabId +
					' is ' +
					statuses.get(card.tabId) +
					' and this board closes tabs on retirement; deferring its retirement to the next sweep'
			);
			deferred.push(card);
			continue;
		}
		retire.push(card);
		closeTabs.push(card);
	}
	return { retire: retire, closeTabs: closeTabs, deferred: deferred };
}

/**
 * Closes the tabs of the cards that actually retired. Called after
 * retireCards() and never before it: a card whose archive write failed is
 * still on the board, and a card still on the board keeps its tab.
 *
 * A close that the host rejects is logged and nothing more - the card stays
 * retired (its archive record is already written, and that is the ledger),
 * and the user is left with a tab they can close by hand, which is the safe
 * direction for this failure.
 * @param {object[]} candidates cards whose board opted in and whose tab was idle
 * @param {string[]} retiredKeys
 * @param {string} reason
 * @returns {Promise<string[]>} the tab ids actually closed
 */
async function closeTabsForRetiredCards(candidates, retiredKeys, reason) {
	if (!Array.isArray(candidates) || candidates.length === 0) return [];
	const retired = new Set(retiredKeys);
	/** @type {string[]} */
	const closed = [];
	for (const card of candidates) {
		if (!retired.has(card.key)) continue;
		try {
			await sdk.tabs.close(card.tabId);
		} catch (err) {
			console.error(
				'maestro-kanban: could not close tab ' +
					card.tabId +
					' for retired card ' +
					card.key +
					'; the card stays retired and the tab stays open: ' +
					errorMessage(err)
			);
			continue;
		}
		closed.push(card.tabId);
		console.log(
			'maestro-kanban: closed tab ' +
				card.tabId +
				' for retired card ' +
				card.key +
				' ("' +
				archiveString(card.title) +
				'"): ' +
				archiveString(reason) +
				' and this board has "close tabs when cards close" on'
		);
	}
	return closed;
}

// ===========================================================================
// End of Phase 05 opt-in tab close.
// ===========================================================================

// ===========================================================================
// Phase 05 manual Done maintenance: the two ways a PERSON retires a card, as
// opposed to the clock doing it. Clear Done empties the terminal column of
// the board on screen; Archive Now retires the one card the detail pane is
// open on. Neither is a second implementation of anything: both assemble a
// list of live cards and hand it to retireCards(), so there is exactly one
// place that knows how a card leaves the board, one place that writes an
// archive record, and one shape of record in the file whoever triggered it.
//
// Four properties worth knowing:
//
//   1. "In Done" means the same thing it means to aging: the card sits in
//      its OWN project board's terminal column. Clearing the board on screen
//      therefore retires exactly the cards that board would have faded out
//      by itself, and a card projected onto the Global board's Done lane
//      from some other project column is never swept up with them.
//   2. The sandbox recomputes that list at click time and never trusts the
//      panel's. The panel's count is what the confirm NAMES (it can only
//      come from a snapshot - the panel bridge carries no reply), and the
//      count actually retired is what the log and the toast report.
//   3. Neither path can touch a tab. They call retireCards(), which cannot
//      reach one, and neither calls into the opt-in close layer at all -
//      `closeTabsOnRetire` is read nowhere in this section. A tab is only
//      ever closed at age-out, which is what "only at age-out" means in
//      code rather than in a comment.
//   4. Neither is a palette command. Clear Done's whole safety property is
//      the in-panel confirm naming the count, and a palette entry would be a
//      way to run it without ever seeing that confirm.
// ===========================================================================

/** The reason stamped on a card a person cleared out of Done by hand, as
 * opposed to RETIREMENT_REASON_AGED for one the horizon retired. A sentence
 * fragment the archive view shows a person, not a code. */
const RETIREMENT_REASON_CLEARED = 'cleared out of Done by hand';

/** The reason stamped on the single card a person archived from the detail
 * pane. Distinct from RETIREMENT_REASON_CLEARED so the archive can say which
 * of the two actions a record came from. */
const RETIREMENT_REASON_ARCHIVED = 'archived by hand';

/**
 * Every card the board on screen counts as being in Done: the cards that
 * board shows (one project's, or everything on the Global and the unnamed
 * board) sitting in their own project board's terminal column. The same
 * definition agingState() ages a card under, so Clear Done retires exactly
 * the set that would have aged out and nothing else. A card with no project
 * path has no board file, no terminal column and no archive, so it is never
 * in this list.
 * @returns {Promise<object[]>}
 */
async function cardsInTerminalColumn() {
	const view = resolveBoardView();
	/** @type {Map<string, string|null>} project path -> terminal column id */
	const terminalByProject = new Map();
	const members = [];
	for (const card of boardCards(view)) {
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		if (!terminalByProject.has(card.projectPath)) {
			terminalByProject.set(card.projectPath, await terminalColumnIdForProject(card.projectPath));
		}
		const terminalId = terminalByProject.get(card.projectPath);
		if (terminalId !== null && card.columnId === terminalId) members.push(card);
	}
	return members;
}

/**
 * Backs the panel's `clear-done` command, which the panel only posts once
 * the user has answered its own confirm naming the count. `boardId` is
 * echoed back from the snapshot that confirm was shown on, so a clear aimed
 * at a board the user has since switched away from is refused rather than
 * emptying the Done column of whichever board is on screen now - the same
 * guard handleMove() holds over a drop.
 *
 * Retires nothing and says so when the column is already empty: a clear that
 * found nothing is not a failure, and the panel's own button is hidden in
 * that state anyway.
 * @param {string|null} boardId
 */
async function clearDoneColumn(boardId) {
	if (boardId !== null && boardId !== currentBoardId()) {
		const reason = 'the board changed before Clear Done ran; try again';
		console.warn('maestro-kanban: refused Clear Done: ' + reason);
		await safeToast('Clear Done was not run: ' + reason);
		return { ok: false, reason: reason, retired: 0, failed: 0 };
	}
	const targets = await cardsInTerminalColumn();
	if (targets.length === 0) {
		console.log('maestro-kanban: Clear Done found no cards in Done; nothing retired');
		return { ok: true, retired: 0, failed: 0 };
	}
	const result = await retireCards(targets, RETIREMENT_REASON_CLEARED);
	console.log(
		'maestro-kanban: Clear Done retired ' +
			result.retired.length +
			' of ' +
			targets.length +
			' card(s) in Done' +
			(result.failed.length > 0 ? ', leaving ' + result.failed.length + ' on the board' : '')
	);
	await pushSnapshotNow();
	if (result.failed.length > 0) {
		await safeToast(
			'Cleared ' +
				result.retired.length +
				' card(s) from Done. ' +
				result.failed.length +
				' could not be archived and stayed on the board.'
		);
	}
	return { ok: true, retired: result.retired.length, failed: result.failed.length };
}

/**
 * Backs the detail pane's `archive-card` command: retires the one card the
 * pane is open on, wherever it sits, through the same retireCards() the
 * clock uses. A card that is no longer on the board, or one whose agent has
 * no project folder to archive it under, is refused with a toast that says
 * which - an action that silently does nothing is indistinguishable from a
 * bug.
 * @param {string} cardKey
 */
async function archiveCardNow(cardKey) {
	const card = typeof cardKey === 'string' ? cards.get(cardKey) : undefined;
	if (!card) {
		const reason = 'that card is no longer on the board';
		console.warn('maestro-kanban: refused Archive Now for "' + cardKey + '": ' + reason);
		await safeToast('Could not archive that card: ' + reason);
		return { ok: false, reason: reason };
	}
	const result = await retireCards([card], RETIREMENT_REASON_ARCHIVED);
	if (result.retired.length === 0) {
		// retireCards() has already logged why (an unreadable archive file, or
		// an agent with no project folder); this is the user-facing half.
		await safeToast('Could not archive "' + archiveString(card.title) + '" - see the plugin log.');
		return { ok: false, reason: 'that card could not be archived' };
	}
	await pushSnapshotNow();
	return { ok: true, retired: result.retired.length };
}

// ===========================================================================
// End of Phase 05 manual Done maintenance.
// ===========================================================================

// ===========================================================================
// Phase 03 board selection: which board the panel is rendering. There are
// two kinds - one project's own board, and the Global board (the aggregation
// in the pure section above) - and the user's choice is remembered in plugin
// storage, so reopening Maestro lands on the board they left rather than
// snapping back to whichever agent happens to be focused.
//
// A board has an id. The snapshot carries it, the panel echoes it back in a
// `move` post, and handleMove() refuses a move whose id no longer matches, so
// a drop that was aimed at a board the user has since switched away from is
// refused instead of silently landing on the wrong board. A project board's
// id is its project path; the Global board's is the reserved
// GLOBAL_BOARD_ID. Project paths are absolute, so the two cannot collide.
//
// `null` is a third, unnamed board: nothing has been selected and no
// session.activated event has fired yet, so there is no project to render.
// That board shows DEFAULT_COLUMNS with every card on it, which is Phase
// 01's behavior and is kept deliberately - it is the only board a fresh
// install can show before the host reports a focused agent.
// ===========================================================================

const GLOBAL_BOARD_ID = '__global__';
const GLOBAL_BOARD_NAME = 'Global';
const SELECTED_BOARD_STORAGE_KEY = 'selected-board';

/** The board the user picked in the switcher, or null when they never have
 * (the panel then follows the active project). Restored from plugin storage
 * at activate() time by loadSelectedBoard(). */
let selectedBoardId = null;

/**
 * A project's name for display: the last segment of its path. Deliberately
 * not sanitizeSlugBasename(), which lowercases and mangles a name to make it
 * safe in a filename - this one is read by a person, so it keeps the
 * project's own capitalization and punctuation. Two projects sharing a
 * basename therefore read the same in the switcher; the panel carries the
 * full path as the option's tooltip so they are still tellable apart.
 * @param {string} projectPath
 */
function projectDisplayName(projectPath) {
	const segments = String(projectPath || '')
		.split(/[\\/]/)
		.filter(function (segment) {
			return segment.length > 0;
		});
	return segments.length > 0 ? segments[segments.length - 1] : String(projectPath || '');
}

/**
 * The board the panel renders right now: the user's explicit selection when
 * they have one, the active project's board otherwise. `projectPath` is null
 * for the Global board and for the unnamed pre-activation board, which the
 * `kind` tells apart.
 * @returns {{ kind: 'global'|'project', projectPath: string|null }}
 */
function resolveBoardView() {
	if (selectedBoardId === GLOBAL_BOARD_ID) return { kind: 'global', projectPath: null };
	if (selectedBoardId !== null) return { kind: 'project', projectPath: selectedBoardId };
	return { kind: 'project', projectPath: activeProjectPath };
}

/**
 * The id of the board the panel is currently rendering, which a `move` post
 * echoes back so a move aimed at a board the user has since switched away
 * from can be refused instead of silently landing on the wrong board. Null
 * only for the unnamed pre-activation board described above.
 */
function currentBoardId() {
	const view = resolveBoardView();
	return view.kind === 'global' ? GLOBAL_BOARD_ID : view.projectPath;
}

/** The cards a board shows: a project board shows that project's cards and
 * nothing else, the Global board shows everything, and the unnamed board
 * shows everything because it has no project to filter by. */
function boardCards(view) {
	const all = Array.from(cards.values());
	if (view.kind === 'project' && view.projectPath !== null) {
		return all.filter(function (card) {
			return card.projectPath === view.projectPath;
		});
	}
	return all;
}

/** At most this many project entries ride in a snapshot. The switcher is a
 * list a person reads, and the snapshot has a hard byte budget (see
 * PANEL_BUDGET_BYTES): a machine with hundreds of projects open would
 * otherwise spend the whole budget on project paths and leave none for the
 * cards. The ones kept are the busiest, and the panel is told how many it is
 * not seeing rather than being left to show a quietly incomplete list. */
const BOARD_OPTIONS_LIMIT = 48;

/**
 * Every board the switcher offers: the Global board first, then one entry
 * per project that has cards, by name. `cardCount` is what makes an empty
 * project obviously empty rather than looking broken, which is also why the
 * board currently on screen is always in its own list even when its count is
 * zero - a selection that vanished from the control it was made in would
 * leave the panel showing a board the user cannot name or switch away from.
 * `hiddenCount` is how many projects BOARD_OPTIONS_LIMIT cut.
 * @returns {{ boards: { id: string, kind: 'global'|'project', name: string, projectPath: string|null, cardCount: number }[], hiddenCount: number }}
 */
function boardOptions() {
	const counts = new Map();
	let total = 0;
	for (const card of cards.values()) {
		total++;
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		counts.set(card.projectPath, (counts.get(card.projectPath) || 0) + 1);
	}
	const view = resolveBoardView();
	const onScreen = view.kind === 'project' ? view.projectPath : null;
	if (onScreen !== null && !counts.has(onScreen)) counts.set(onScreen, 0);
	const byName = function (a, b) {
		const nameA = projectDisplayName(a);
		const nameB = projectDisplayName(b);
		if (nameA !== nameB) return nameA < nameB ? -1 : 1;
		return a < b ? -1 : a > b ? 1 : 0;
	};
	let projects = Array.from(counts.keys());
	let hiddenCount = 0;
	if (projects.length > BOARD_OPTIONS_LIMIT) {
		// Busiest first, so the cut falls on the projects with the least on
		// them; the board on screen survives the cut whatever its count.
		const ranked = projects.slice().sort(function (a, b) {
			if (a === onScreen) return -1;
			if (b === onScreen) return 1;
			const countA = counts.get(a);
			const countB = counts.get(b);
			if (countA !== countB) return countB - countA;
			return byName(a, b);
		});
		hiddenCount = projects.length - BOARD_OPTIONS_LIMIT;
		projects = ranked.slice(0, BOARD_OPTIONS_LIMIT);
	}
	projects.sort(byName);
	const boards = [
		{
			id: GLOBAL_BOARD_ID,
			kind: 'global',
			name: GLOBAL_BOARD_NAME,
			projectPath: null,
			cardCount: total,
		},
	];
	for (const projectPath of projects) {
		boards.push({
			id: projectPath,
			kind: 'project',
			name: projectDisplayName(projectPath),
			projectPath: projectPath,
			cardCount: counts.get(projectPath),
		});
	}
	return { boards: boards, hiddenCount: hiddenCount };
}

/** The name the panel header shows for the board on screen. The unnamed
 * pre-activation board is called "All Agents", since that is literally what
 * it renders - calling it "Global" would claim the aggregation, which it is
 * not (it has no global columns and no Unmapped lane). */
function currentBoardName() {
	const view = resolveBoardView();
	if (view.kind === 'global') return GLOBAL_BOARD_NAME;
	if (view.projectPath === null) return 'All Agents';
	return projectDisplayName(view.projectPath);
}

/** Restores the remembered board selection. Called once, before activate()'s
 * first seed(), so the panel's very first snapshot already renders the board
 * the user left rather than flashing a different one first. A storage
 * failure degrades to "follow the active project" rather than throwing the
 * activation. */
async function loadSelectedBoard() {
	try {
		const raw = await sdk.storage.get(SELECTED_BOARD_STORAGE_KEY);
		selectedBoardId = typeof raw === 'string' && raw !== '' ? raw : null;
	} catch (err) {
		console.error('maestro-kanban: failed to read the remembered board: ' + String(err));
		selectedBoardId = null;
	}
	return selectedBoardId;
}

/**
 * Switches the board and remembers the choice. Backs the panel's
 * `select-board` command. Any non-empty id other than GLOBAL_BOARD_ID is
 * taken as a project path and is NOT checked against boardOptions(): a
 * project whose cards have all closed is a legitimately empty board (it
 * renders its columns and a zero count), and refusing to show it would be
 * worse than showing it empty. An empty or non-string id clears the
 * selection back to "follow the active project".
 * @param {unknown} boardId
 */
async function selectBoard(boardId) {
	const next = typeof boardId === 'string' && boardId !== '' ? boardId : null;
	if (next === selectedBoardId) {
		await pushSnapshotNow();
		return { ok: true, boardId: next };
	}
	selectedBoardId = next;
	try {
		if (next === null) await sdk.storage.delete(SELECTED_BOARD_STORAGE_KEY);
		else await sdk.storage.set(SELECTED_BOARD_STORAGE_KEY, next);
	} catch (err) {
		// The board still switches for this session; only the memory of it is
		// lost, which is a strictly smaller failure than refusing the switch.
		console.error('maestro-kanban: failed to remember the selected board: ' + String(err));
	}
	await pushSnapshotNow();
	return { ok: true, boardId: next };
}

/** Loads the project board of every project that has a card, for the Global
 * board's projection. Resolves to a Map of project path -> loadProjectBoard()
 * result, which buildGlobalBoard() unwraps itself. Reads come from boardCache
 * after the first call, so this is one pass over the cards in the common
 * case. */
async function loadProjectBoardsForCards() {
	const paths = [];
	const seen = new Set();
	for (const card of cards.values()) {
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		if (seen.has(card.projectPath)) continue;
		seen.add(card.projectPath);
		paths.push(card.projectPath);
	}
	const results = await Promise.all(
		paths.map(function (projectPath) {
			return loadProjectBoard(projectPath);
		})
	);
	const map = new Map();
	for (let i = 0; i < paths.length; i++) map.set(paths[i], results[i]);
	return map;
}

// ===========================================================================
// End of Phase 03 board selection.
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
 * Buckets a board's cards into its resolved columns, in display order. The
 * one place that mapping is decided, so the index the panel reports in a drop
 * and the index buildSnapshot() renders can never drift apart. A card whose
 * own columnId is not one of these resolved ids lands in the first column
 * rather than being dropped. `boardCardList` is the board's own cards (see
 * boardCards) - a project board never buckets another project's cards into
 * its columns.
 * @param {{ id: string }[]} resolvedColumns
 * @param {object[]} boardCardList
 * @returns {Map<string, object[]>}
 */
function groupCardsByColumn(resolvedColumns, boardCardList) {
	const fallbackColumnId = resolvedColumns.length > 0 ? resolvedColumns[0].id : 'backlog';
	const byColumn = new Map(resolvedColumns.map((column) => [column.id, []]));
	for (const card of boardCardList) {
		const list = byColumn.get(card.columnId) || byColumn.get(fallbackColumnId);
		if (list) list.push(card);
	}
	for (const list of byColumn.values()) list.sort(compareCardsInColumn);
	return byColumn;
}

/** Loads the boards buildSnapshot() and the move handler both need: the
 * board the switcher currently points at (see resolveBoardView), its project
 * board, the global board, and resolveColumns()' output for the pair.
 * `columns` describes the project board, so the Global view - which has its
 * own column list from buildGlobalBoard() - does not read it. */
async function resolveActiveBoard() {
	const view = resolveBoardView();
	const projectPath = view.kind === 'project' ? view.projectPath : null;
	const [projectResult, globalResult] = await Promise.all([
		projectPath !== null
			? loadProjectBoard(projectPath)
			: Promise.resolve({ board: null, error: null }),
		loadGlobalBoard(),
	]);
	return {
		view: view,
		projectPath: projectPath,
		cards: boardCards(view),
		projectResult: projectResult,
		globalResult: globalResult,
		columns: resolveColumns(projectResult.board, globalResult.board),
	};
}

/** Records a refusal for the next snapshot and reports it back to the
 * caller. The snapshot push is what the panel actually reacts to. */
function refuseMove(key, reason) {
	pendingMoveRejection = { cardKey: key, reason: reason };
	console.warn('maestro-kanban: refused move of "' + key + '": ' + reason);
	return pushSnapshotNow().then(() => ({ ok: false, reason: reason }));
}

/** Clamps a requested drop index into `[0, length]`, defaulting to the end
 * for an index the panel did not send or sent as nonsense. */
function clampDropIndex(index, length) {
	const requested = typeof index === 'number' && isFinite(index) ? Math.floor(index) : length;
	return Math.max(0, Math.min(requested, length));
}

/** Renumbers `columnId`'s cards into dense 0..n orders, with the card for
 * `key` (which may be arriving from another column) spliced in at `index`.
 * Every card in the column comes out explicitly ordered, including the ones
 * that were still sorting by last activity: once the user has arranged a
 * column by hand, a later burst of activity must not reshuffle it under
 * them. Returns the index the card actually landed on after clamping. */
function placeInColumnOrder(resolvedColumns, boardCardList, columnId, key, index) {
	const members = (groupCardsByColumn(resolvedColumns, boardCardList).get(columnId) || []).filter(
		(card) => card.key !== key
	);
	const moved = cards.get(key);
	const at = clampDropIndex(index, members.length);
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
function renumberColumnOrder(resolvedColumns, boardCardList, columnId) {
	if (typeof columnId !== 'string' || columnId === '') return;
	const members = groupCardsByColumn(resolvedColumns, boardCardList).get(columnId) || [];
	renumberOrderedCards(members);
}

/** The shared half of a renumber: positioned cards keep dense 0..n orders in
 * their current display order, and a card nobody ever dragged keeps none. */
function renumberOrderedCards(members) {
	let next = 0;
	for (const card of members) {
		if (cardOrderOf(card) === null) continue;
		setCardOrder(card, next);
		next++;
	}
}

/** One project's cards sitting in one of its own columns, in display order.
 * The Global board's move path works in these terms because an `order` is
 * only ever a position inside a home-project column - see
 * reorderGlobalColumn(). */
function projectColumnMembers(projectPath, columnId) {
	const members = [];
	for (const card of cards.values()) {
		if (card.projectPath !== projectPath) continue;
		if (card.columnId !== columnId) continue;
		members.push(card);
	}
	members.sort(compareCardsInColumn);
	return members;
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
	if (active.view.kind === 'global') {
		return handleGlobalMove(
			card,
			cardProjectResult.board,
			active.globalResult.board,
			toColumnId,
			toIndex
		);
	}
	if (active.projectPath !== null && card.projectPath !== active.projectPath) {
		// A project board only renders its own project's cards, so this is a
		// post from a panel whose snapshot predates a board switch.
		return refuseMove(key, 'that card belongs to another project, not the board on screen');
	}
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
	noteCardColumn(key, toColumnId);
	const landedAt = placeInColumnOrder(active.columns, active.cards, toColumnId, key, toIndex);
	if (fromColumnId !== toColumnId) {
		renumberColumnOrder(active.columns, active.cards, fromColumnId);
	}
	// A drop into Done starts that card's aging clock now rather than
	// whenever the next event happens to trigger a rebuild; a drop out of
	// Done has already lost its stamp inside setPlacement().
	await reconcileAgingClocks();
	await flushDirtyPlacements();
	await pushSnapshotNow();
	return { ok: true, columnId: toColumnId, index: landedAt };
}

/**
 * The Global board's half of handleMove(): the card was dropped on a *global*
 * column, and the only thing this plugin ever stores is a home-project
 * placement, so the move has to be translated back into the project column
 * that maps to that global column. legalGlobalColumnsFor() gates it (a card
 * may only land on a global column its own project can reach) and
 * projectColumnForGlobalColumn() picks the column to write - both re-derived
 * here from the card's own project board, never read off the panel's claim.
 * @param {object} card
 * @param {object|null} cardProjectBoard
 * @param {object|null} globalBoard
 * @param {string} toColumnId
 * @param {number|null} toIndex
 */
async function handleGlobalMove(card, cardProjectBoard, globalBoard, toColumnId, toIndex) {
	const key = card.key;
	if (!cardProjectBoard) {
		// An Unmapped-lane card with no board file of its own: there is no
		// project column to write the move back to.
		return refuseMove(key, 'that project has no board file, so the global board cannot place it');
	}
	const legal = legalColumnsFor(card, cardProjectBoard, globalBoard, { global: true });
	if (legal.indexOf(toColumnId) === -1) {
		return refuseMove(key, '"' + toColumnId + '" is not a column that card\'s project can reach');
	}
	const decision = projectColumnForGlobalColumn(card, cardProjectBoard, globalBoard, toColumnId);
	if (!decision) {
		return refuseMove(key, '"' + toColumnId + '" is not a column that card\'s project can reach');
	}
	if (decision.ambiguous) {
		// The pure decision function deliberately does not log, so the forced
		// choice is recorded here - see projectColumnForGlobalColumn().
		console.warn(
			'maestro-kanban: project "' +
				card.projectPath +
				'" maps ' +
				decision.candidates.join(', ') +
				' to the global column "' +
				toColumnId +
				'"; placed ' +
				key +
				' on "' +
				decision.columnId +
				'"' +
				(decision.columnId === card.columnId ? ' (the column it was already on)' : ' (the first)')
		);
	}

	const fromColumnId = card.columnId;
	card.columnId = decision.columnId;
	setPlacement(boardFilePath(card.projectPath), key, decision.columnId);
	noteCardColumn(key, decision.columnId);
	const landedAt = await reorderGlobalColumn(card, globalBoard, toColumnId, toIndex);
	if (fromColumnId !== decision.columnId) {
		renumberOrderedCards(projectColumnMembers(card.projectPath, fromColumnId));
	}
	await reconcileAgingClocks();
	await flushDirtyPlacements();
	await pushSnapshotNow();
	return { ok: true, columnId: decision.columnId, globalColumnId: toColumnId, index: landedAt };
}

/**
 * Writes the position a drop on a *global* column implies. A stored order is
 * a position inside one home-project column, and a global column interleaves
 * several projects' columns, so the drop index cannot be stored verbatim:
 * instead the global column's post-move order is projected onto the moved
 * card's own project siblings in it, which are the only cards whose relative
 * order this plugin can actually record. The card therefore lands after every
 * sibling above the drop point and before every sibling below it, and cards
 * from other projects fall where compareCardsByOrder()'s tiebreaks put them -
 * deterministically, so the column does not reshuffle on the next snapshot.
 * Returns the clamped index within the global column.
 */
async function reorderGlobalColumn(card, globalBoard, toColumnId, toIndex) {
	const projectBoards = await loadProjectBoardsForCards();
	const built = buildGlobalBoard(globalBoard, projectBoards, cards.values(), {
		orderOf: cardOrderOf,
	});
	const column = built.columns.filter(function (candidate) {
		return candidate.id === toColumnId;
	})[0];
	const members = (column ? column.cards : []).filter(function (other) {
		return other.key !== card.key;
	});
	const at = clampDropIndex(toIndex, members.length);
	members.splice(at, 0, card);
	const siblings = members.filter(function (other) {
		return other.projectPath === card.projectPath && other.columnId === card.columnId;
	});
	for (let i = 0; i < siblings.length; i++) setCardOrder(siblings[i], i);
	return at;
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
	// A retired card's tab usually still exists (retirement never closes
	// one), so the archive is what keeps it off the board: without this it
	// would be rebuilt from tabs.list() and land back in Backlog.
	await ensureArchivedKeysLoaded(built);
	const next = new Map();
	for (const card of built) {
		if (isCardArchived(card)) continue;
		card.columnId = await resolveCardColumnId(card);
		noteCardColumn(card.key, card.columnId);
		next.set(card.key, card);
	}
	cards = next;
	// Stamp/clear the Done clocks before the flush so an aging stamp rides
	// out to storage in the same write as the placement it belongs to.
	await reconcileAgingClocks();
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

/** One card in the panel's own shape. `legalColumnIds` is only sent when the
 * answer is not simply "every writable column on this board" - that is the
 * Global board, where a card may only be dropped on a global column its home
 * project can reach - and the panel dims every other column when it is
 * present (see legalColumnIdsFor in panel.html). Omitted on a project board,
 * where every column is reachable by definition. `description`, `comments`,
 * and `lastCommentAt` are this plugin's own storage (see noteFor() above),
 * never gated by `accessGranted` - they are sent for every card, granted or
 * not, and trimToBudget() already drops them first on an oversized board the
 * same way it drops `projectPath` and `createdAt`. `messageOutcome` is the
 * last `send-message` attempt's result for this card (see
 * lastMessageOutcomes above), or `null` when nothing has ever been sent -
 * this is the only way the composer learns whether an in-flight send
 * resolved, since the panel<->sandbox bridge carries no direct reply.
 * @param {object} card
 * @param {string[]} [legalColumnIds]
 */
function cardToJson(card, legalColumnIds) {
	const note = noteFor(card.key);
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
		accessGranted: isSessionAccessGranted(card.sessionId),
		legalColumnIds: Array.isArray(legalColumnIds) ? legalColumnIds : undefined,
		description: note.description,
		comments: note.comments,
		lastCommentAt: note.lastCommentAt,
		messageOutcome: lastMessageOutcomes.get(card.key) || null,
	};
}

/**
 * The columns of one project's board: resolveColumns()'s output for the
 * project the switcher points at (or DEFAULT_COLUMNS when it points at the
 * unnamed pre-activation board), each carrying its title and wip_limit so the
 * panel never has to guess either. A card whose own columnId is not one of
 * these resolved ids - its placement predates a hand edit of the board file -
 * lands in the first column rather than being dropped. Within a column,
 * cards come out in groupCardsByColumn()'s order, which honors whatever a
 * move wrote.
 */
function buildProjectBoardColumns(active) {
	const byColumn = groupCardsByColumn(active.columns, active.cards);
	return {
		columns: active.columns.map((column) => ({
			id: column.id,
			title: column.title,
			wipLimit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
			cards: (byColumn.get(column.id) || []).map((card) => cardToJson(card)),
		})),
		boardError:
			(active.projectPath !== null && active.projectResult.error) ||
			active.globalResult.error ||
			null,
		// True only when the board on screen is a real project's and it has no
		// board file at all yet (ENOENT, not a parse failure - that case is
		// already covered by boardError above). Lets the panel offer "write a
		// default board" exactly when there is a project with nothing to lose,
		// never when one merely failed to parse.
		projectBoardMissing:
			active.projectPath !== null &&
			active.projectResult.board === null &&
			active.projectResult.error === null,
		globalBoardMissing: undefined,
	};
}

/**
 * The columns of the Global board: buildGlobalBoard()'s projection of every
 * project's cards onto the global board's columns, plus the read-only
 * Unmapped lane for the cards it cannot place. Every card carries the global
 * columns its own project can reach, so the panel dims the rest during a drag
 * rather than offering a drop handleGlobalMove() would only refuse. That
 * answer depends on the card's project and not on the card, so it is
 * memoized per project path. `boardError` prefers the global board file's own
 * parse failure and falls back to the first project board that failed, since
 * on this board either one is what the user has to go fix.
 */
async function buildGlobalBoardColumns(active) {
	const globalBoard = active.globalResult.board;
	const projectBoards = await loadProjectBoardsForCards();
	const built = buildGlobalBoard(globalBoard, projectBoards, cards.values(), {
		orderOf: cardOrderOf,
	});
	const legalByProject = new Map();
	function legalFor(card) {
		const projectPath = typeof card.projectPath === 'string' ? card.projectPath : '';
		if (!legalByProject.has(projectPath)) {
			legalByProject.set(
				projectPath,
				legalColumnsFor(card, projectBoardFor(projectBoards, projectPath), globalBoard, {
					global: true,
				})
			);
		}
		return legalByProject.get(projectPath);
	}
	let boardError = active.globalResult.error;
	if (!boardError) {
		for (const result of projectBoards.values()) {
			if (result && result.error) {
				boardError = result.error;
				break;
			}
		}
	}
	return {
		columns: built.columns.map((column) => ({
			id: column.id,
			title: column.title,
			wipLimit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
			readOnly: column.readOnly === true ? true : undefined,
			cards: column.cards.map((card) => cardToJson(card, legalFor(card))),
		})),
		boardError: boardError || null,
		projectBoardMissing: false,
		// No global board file at all: every card falls into the Unmapped lane,
		// which looks broken unless the panel says why.
		globalBoardMissing: globalBoard === null && active.globalResult.error === null,
	};
}

/**
 * Builds the panel snapshot for the board the switcher points at (see
 * resolveBoardView): one project's own columns, or the Global board's
 * projection. `boards` is every board the switcher offers with its card
 * count, `boardName` is what the panel header shows, and `boardId` is echoed
 * back in a `move` post so a move aimed at a board the user has since
 * switched away from is refused. `moveRejection` carries the one refused move
 * the panel still has to be told about - see handleMove().
 *
 * `doneCardCount` is how many cards Clear Done would retire right now, in
 * the sandbox's own terms (see cardsInTerminalColumn()) rather than the
 * panel's reading of a column. It is the number the panel's confirm names,
 * and it can only reach the panel this way: the bridge carries no reply to a
 * post, so a count the panel asked for would arrive after the click it was
 * meant to describe.
 */
async function buildSnapshot() {
	const active = await resolveActiveBoard();
	// Drained, not copied: a refusal is a one-shot message to the panel, so it
	// must not ride every snapshot after the one that reports it.
	const moveRejection = pendingMoveRejection;
	pendingMoveRejection = null;
	const board =
		active.view.kind === 'global'
			? await buildGlobalBoardColumns(active)
			: buildProjectBoardColumns(active);
	const options = boardOptions();
	const doneCards = await cardsInTerminalColumn();
	return {
		updatedAt: Date.now(),
		columns: board.columns,
		boardError: board.boardError,
		globalBoardMissing: board.globalBoardMissing,
		activeProjectPath: active.projectPath,
		projectBoardMissing: board.projectBoardMissing,
		boardId: currentBoardId(),
		boardName: currentBoardName(),
		boards: options.boards,
		boardsHidden: options.hiddenCount > 0 ? options.hiddenCount : undefined,
		moveRejection: moveRejection,
		historyExcerpt: historyExcerptSnapshot(),
		doneCardCount: doneCards.length,
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
			// Kept: without it every column looks legal during a drag on the
			// Global board, so a trimmed board would start offering drops the
			// sandbox refuses. A handful of column ids is worth that.
			legalColumnIds: c.legalColumnIds,
			// Kept: dropping it would make a trimmed card read as "not connected"
			// regardless of its real access state, which is the opposite of the
			// honesty this field exists for.
			accessGranted: c.accessGranted,
			// Kept: an in-flight send's only feedback channel is this field on the
			// next snapshot (see cardToJson); dropping it on a trimmed board would
			// leave the composer waiting forever on a send that already resolved.
			messageOutcome: c.messageOutcome,
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
	// agent.completed and run.completed also drive the History excerpt's
	// event-driven re-read (see onHistoryRelevantEvent) on top of the usual
	// markDirty() refresh every topic here gets.
	maestro.events.on('agent.completed', (payload) =>
		onHistoryRelevantEvent('agent.completed', payload)
	);
	maestro.events.on('agent.error', (payload) => onGenericSessionEvent('agent.error', payload));
	maestro.events.on('agent.exited', (payload) => onGenericSessionEvent('agent.exited', payload));
	maestro.events.on('run.completed', (payload) => onHistoryRelevantEvent('run.completed', payload));
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

	// Invoked by the panel's board switcher; no manifest `commands` entry is
	// needed since the palette has no way to pick which board it would mean.
	maestro.commands.register('select-board', (args) =>
		selectBoard(args && args.boardId).catch((err) => {
			console.error('maestro-kanban: select-board failed: ' + String(err));
			return safeToast('Could not switch boards.').then(() => ({ ok: false }));
		})
	);

	// Invoked by the panel's header Clear Done control, and ONLY after the
	// panel's own in-panel confirm named the count - that confirm is the whole
	// safety property of this action, which is why there is deliberately no
	// manifest `commands` entry: a palette entry would be a way to empty Done
	// without ever seeing it. The card list is recomputed here rather than
	// taken from the post (see cardsInTerminalColumn()), and `boardId` is the
	// snapshot's id echoed back so a clear aimed at a board the user has since
	// switched away from is refused.
	maestro.commands.register('clear-done', (args) => {
		const boardId =
			args && typeof args.boardId === 'string' && args.boardId !== '' ? args.boardId : null;
		return clearDoneColumn(boardId).catch((err) => {
			console.error('maestro-kanban: clear-done failed: ' + String(err));
			return safeToast('Could not clear Done: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		});
	});

	// Invoked by the detail pane's Archive Now button; no manifest `commands`
	// entry is needed since the palette has no card in hand to archive. Goes
	// through the same retireCards() the aging sweep does, so a card archived
	// by hand lands in the same file, in the same shape, and keeps its tab
	// exactly as a card that aged out does.
	maestro.commands.register('archive-card', (args) => {
		const cardKey = args && typeof args.cardKey === 'string' ? args.cardKey : undefined;
		if (!cardKey) return Promise.resolve({ ok: false, error: 'cardKey is required' });
		return archiveCardNow(cardKey).catch((err) => {
			console.error('maestro-kanban: archive-card failed: ' + String(err));
			return safeToast('Could not archive that card: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		});
	});

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

	// Invoked by the panel when Escape is pressed with no drag in flight. The
	// panel cannot dismiss itself - the bridge carries commands one way - so
	// closing is a command, and ui.closePanel() accepts it because the board
	// panel's placement is `modal`. No manifest `commands` entry: the palette
	// has no reason to offer "close the board I am not looking at".
	maestro.commands.register('close-panel', () =>
		maestro.ui
			.closePanel('board')
			.then(() => ({ ok: true }))
			.catch((err) => {
				console.error('maestro-kanban: close-panel failed: ' + String(err));
				return { ok: false };
			})
	);

	// Invoked by the panel's detail-pane "Allow Access" button via
	// parent.postMessage; no manifest `commands` entry is needed since the
	// palette has no session in hand to ask about. Asks the host for the
	// ONE-TIME confirmation sessions.requestAccess() owns; this plugin never
	// shows its own dialog and never assumes a grant the host has not
	// confirmed. Pushes a fresh snapshot either way so an approval clears the
	// card's "not connected" marker without waiting for the next poll.
	maestro.commands.register('request-access', (args) => {
		const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined;
		if (!sessionId) return Promise.resolve({ ok: false, granted: false });
		return maestro.sessions
			.requestAccess(sessionId)
			.then((result) => {
				const granted = !!(result && result.granted === true);
				if (granted) grantedSessions.add(sessionId);
				return pushSnapshotNow().then(() => ({ ok: true, granted: granted }));
			})
			.catch((err) => {
				console.error('maestro-kanban: sessions.requestAccess failed: ' + String(err));
				return safeToast('Could not request access to that agent.').then(() => ({
					ok: false,
					granted: false,
				}));
			});
	});

	// Invoked by the panel's detail pane whenever it opens on a card, or
	// switches to a different granted session, via parent.postMessage; no
	// manifest `commands` entry is needed since the palette has no session in
	// hand to read History for. This is the ONLY place this plugin calls
	// maestro.transcripts.read - never from buildSnapshot() or any other
	// repaint - so a card the user never opens the detail pane on costs this
	// plugin's rate-limited/audited budget nothing. Pushes a fresh snapshot
	// on every outcome (a cache hit, a fresh read, a denial) so the pane's
	// History section, or its access gate, catches up with no re-open needed.
	maestro.commands.register('read-history', (args) => {
		const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined;
		if (!sessionId) return Promise.resolve({ ok: false });
		openHistorySessionId = sessionId;
		if (!isSessionAccessGranted(sessionId)) {
			// The access gate already covers this card; nothing to read.
			return Promise.resolve({ ok: false, error: 'not granted' });
		}
		return readSessionHistoryExcerpt(sessionId)
			.then(() => pushSnapshotNow())
			.then(() => ({ ok: true }))
			.catch((err) => {
				console.error('maestro-kanban: read-history failed: ' + String(err));
				return { ok: false, error: errorMessage(err) };
			});
	});

	// Invoked by the panel's detail pane when it closes on a granted card
	// (Escape, the close button, or the card leaving the board), or switches
	// to an ungranted one; no manifest `commands` entry is needed for the same
	// reason as 'read-history' above. Stops the agent.completed/run.completed
	// re-read this session was getting, so a closed pane does not keep
	// spending this plugin's transcripts.read budget on History nobody is
	// looking at. No snapshot push: closing the pane is already reflected
	// locally in the panel, and nothing else about the board changed.
	maestro.commands.register('close-history', () => {
		openHistorySessionId = null;
		return Promise.resolve({ ok: true });
	});

	// Invoked by the panel's detail-pane description field (on blur) and
	// comment composer (on submit) via parent.postMessage; no manifest
	// `commands` entry is needed since the palette has no card in hand to
	// note. The panel never touches maestro.storage itself - every write
	// goes through here, on a granted or an ungranted card alike, since a
	// card's own note is not something the host's session grants gate.
	// Pushes a fresh snapshot either way so the pane shows the saved state
	// with no re-open needed.
	maestro.commands.register('card-note', (args) => {
		const cardKey = args && typeof args.cardKey === 'string' ? args.cardKey : undefined;
		const action = args && typeof args.action === 'string' ? args.action : undefined;
		if (!cardKey) return Promise.resolve({ ok: false, error: 'cardKey is required' });
		if (action === 'description') {
			const description =
				args && typeof args.description === 'string' ? args.description : undefined;
			if (description === undefined) {
				return Promise.resolve({ ok: false, error: 'description is required' });
			}
			return setCardDescription(cardKey, description)
				.then(() => pushSnapshotNow())
				.then(() => ({ ok: true }))
				.catch((err) => {
					console.error('maestro-kanban: card-note description failed: ' + String(err));
					return { ok: false, error: errorMessage(err) };
				});
		}
		if (action === 'comment') {
			const body = args && typeof args.body === 'string' ? args.body : undefined;
			if (!body || body.trim() === '') {
				return Promise.resolve({ ok: false, error: 'body is required' });
			}
			return addCardComment(cardKey, body.trim())
				.then(() => pushSnapshotNow())
				.then(() => ({ ok: true }))
				.catch((err) => {
					console.error('maestro-kanban: card-note comment failed: ' + String(err));
					return { ok: false, error: errorMessage(err) };
				});
		}
		return Promise.resolve({ ok: false, error: 'unknown action' });
	});

	// Invoked by the panel's detail-pane message composer via
	// parent.postMessage; no manifest `commands` entry is needed since the
	// palette has no card, tab, or text in hand to send. This is the only
	// place this plugin ever calls maestro.agents.dispatch. On an already-
	// granted session it dispatches straight away; on an ungranted one it
	// asks for the same one-time sessions.requestAccess() confirmation the
	// detail pane's "Allow Access" button uses, and only dispatches once that
	// resolves `{ granted: true }` - a decline leaves the prompt unsent with
	// an "access not granted" outcome rather than a guessed message. Every
	// outcome (sent, a declined request, or a dispatch denial) is recorded in
	// lastMessageOutcomes and a fresh snapshot is always pushed, since the
	// bridge carries no reply the composer could otherwise wait on. The
	// panel enforces one in-flight send per card and one in-flight
	// requestAccess per session client-side; this handler does not need its
	// own copy of that guard.
	maestro.commands.register('send-message', (args) => {
		const cardKey = args && typeof args.cardKey === 'string' ? args.cardKey : undefined;
		const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined;
		const tabId = args && typeof args.tabId === 'string' ? args.tabId : undefined;
		const prompt = args && typeof args.prompt === 'string' ? args.prompt : undefined;
		if (!cardKey || !sessionId || !tabId || !prompt || prompt.trim() === '') {
			return Promise.resolve({
				ok: false,
				error: 'cardKey, sessionId, tabId and prompt are required',
			});
		}
		const recordOutcome = (status, error) => {
			lastMessageOutcomes.set(cardKey, { status: status, error: error || null, at: Date.now() });
			return pushSnapshotNow().then(() => ({ ok: status === 'sent', error: error || null }));
		};
		if (isSessionAccessGranted(sessionId)) {
			return dispatchCardMessage(sessionId, tabId, prompt).then((result) =>
				recordOutcome(result.ok ? 'sent' : 'failed', result.error)
			);
		}
		return maestro.sessions
			.requestAccess(sessionId)
			.then((accessResult) => {
				const granted = !!(accessResult && accessResult.granted === true);
				if (!granted) return recordOutcome('failed', 'access not granted');
				grantedSessions.add(sessionId);
				return dispatchCardMessage(sessionId, tabId, prompt).then((result) =>
					recordOutcome(result.ok ? 'sent' : 'failed', result.error)
				);
			})
			.catch((err) => {
				console.error(
					'maestro-kanban: sessions.requestAccess (from send-message) failed: ' + String(err)
				);
				return recordOutcome('failed', 'Could not request access to that agent.');
			});
	});

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

	// Phase 03 board selection. GLOBAL_BOARD_ID is the id the panel's switcher
	// posts back for the Global board, so a test naming that board uses this
	// rather than repeating the literal; projectDisplayName is pure and is
	// what the switcher labels a project with.
	GLOBAL_BOARD_ID: GLOBAL_BOARD_ID,
	GLOBAL_BOARD_NAME: GLOBAL_BOARD_NAME,
	projectDisplayName: projectDisplayName,

	// Phase 05 pure aging model, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). Pure like the Phase 02 and
	// Phase 03 models above: a test calls them without activate().
	agingState: agingState,
	normalizeAgingSettings: normalizeAgingSettings,
	DEFAULT_AGING_SETTINGS: DEFAULT_AGING_SETTINGS,
	AGING_OPACITY_FLOOR: AGING_OPACITY_FLOOR,

	// Phase 05 aging runtime, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). Unlike the pure model
	// above these read the runtime state and call sdk.storage, so a test must
	// call activate() with a stub SDK first.
	setBoardAgingSettings: setBoardAgingSettings,
	agingSettingsForBoard: agingSettingsForBoard,
	agingStateForCard: agingStateForCard,

	// Phase 05 archive storage, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). archiveFilePath(),
	// readStoredArchiveRecord() and pruneArchiveRecords() are pure; the rest
	// call sdk.fs.read/write, so a test must call activate() with a stub SDK
	// first.
	ARCHIVE_RECORD_CAP: ARCHIVE_RECORD_CAP,
	archiveFilePath: archiveFilePath,
	readStoredArchiveRecord: readStoredArchiveRecord,
	pruneArchiveRecords: pruneArchiveRecords,
	loadArchive: loadArchive,
	saveArchive: saveArchive,
	appendToArchive: appendToArchive,

	// Phase 05 retirement, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). runRetirementSweep() and
	// retireCards() read the live card model and write both the archive file
	// and the placement store, so a test calls them after activate() with a
	// stub SDK - and activate() has already run one sweep by then.
	RETIREMENT_TICK_MS: RETIREMENT_TICK_MS,
	RETIREMENT_REASON_AGED: RETIREMENT_REASON_AGED,
	runRetirementSweep: runRetirementSweep,
	retireCards: retireCards,

	// Phase 05 opt-in tab close, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). isTabStatusBusy() is pure;
	// planRetirementTabCloses() reads the live board settings and calls
	// sdk.tabs.list(), so a test calls it after activate() with a stub SDK.
	// There is deliberately no export that closes a tab on its own: the only
	// caller of closeTabsForRetiredCards() is the aging sweep.
	isTabStatusBusy: isTabStatusBusy,
	planRetirementTabCloses: planRetirementTabCloses,

	// Phase 05 manual Done maintenance, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). Both read the live card
	// model and write the archive, so a test calls them after activate() with
	// a stub SDK - normally through the `clear-done` / `archive-card` commands
	// the panel posts, which is the only way a user reaches them.
	RETIREMENT_REASON_CLEARED: RETIREMENT_REASON_CLEARED,
	RETIREMENT_REASON_ARCHIVED: RETIREMENT_REASON_ARCHIVED,
	cardsInTerminalColumn: cardsInTerminalColumn,
	clearDoneColumn: clearDoneColumn,
	archiveCardNow: archiveCardNow,

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
		// Before seed(), so the first snapshot already renders the board the
		// user left instead of flashing the active project's board first, and
		// already carries every card's stored description/comments.
		await loadSelectedBoard();
		await loadCardNotes();
		await loadBoardSettings();
		await seed();
		await prunePlacements();
		// Retirement runs at activate and then on its own low-frequency tick,
		// never on a refresh or a panel open: a card that aged out while the app
		// was closed retires on the way in, and nothing else has to watch the
		// clock. Retires nothing (and pushes no snapshot) when aging is off.
		await runRetirementSweep();
		startRetirementTicks();
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
		selectedBoardId = null;
		placementCache.clear();
		dirtyPlacementBoards.clear();
		pendingMoveRejection = null;
		cardNotes = new Map();
		boardSettings = new Map();
		stopRetirementTicks();
		cardColumnTrail.clear();
		archivedCardKeys.clear();
		// The host clears its own grant bookkeeping when the sandbox stops; this
		// mirrors that so a reactivated plugin never assumes a grant it has not
		// seen confirmed again.
		grantedSessions.clear();
		historyCache.clear();
		openHistorySessionId = null;
		lastMessageOutcomes.clear();
		if (sdk) {
			return sdk.events.unsubscribe().catch(() => {});
		}
		return undefined;
	},
};
