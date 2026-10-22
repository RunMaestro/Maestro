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

/** How close to its horizon a card has to be before the board stops relying
 * on faintness alone and draws a distinct marker. One day, so the warning
 * lands on the last render the user is likely to see before the sweep
 * retires it. */
const AGING_SOON_DAYS = 1;

/** The faintest a card is allowed to RENDER while it is still on the board.
 *
 * AGING_OPACITY_FLOOR (0.1) is the MODEL's floor and is deliberately almost
 * invisible: it describes how far along the decay a card is, and a card that
 * has run its whole horizon is as good as gone. It is not a drawing
 * instruction. A card still on the board is still clickable, still draggable
 * and still has a composer behind it, so rendering its title at 0.1 would
 * leave a live hit target nobody can read - the opposite of what the fade is
 * for. agingRenderState() therefore re-maps the same linear decay onto
 * [AGING_RENDER_OPACITY_FLOOR, 1]: the ramp still runs across the whole
 * horizon and still ends at its faintest on the last day, but the faintest
 * it ever gets is a value the panel's 13px title is readable at. The card
 * disappears by being retired, never by fading past legibility. */
const AGING_RENDER_OPACITY_FLOOR = 0.4;

/**
 * What the panel needs in order to DRAW one card's decay, or null when there
 * is nothing to draw (aging off for this board, or the card is not in the
 * terminal column). Pure, and deliberately numbers only: the sentence a
 * person reads is the panel's copy to write (see agingLabel/agingTooltip in
 * panel.html), the same split every other card field holds.
 *
 * `daysRemaining` counts down to the horizon and bottoms out at 0 for a card
 * the next sweep will retire; `expiringSoon` is the distinct-marker flag, and
 * is true for an expired card too - a card past its horizon that the sweep
 * has not reached yet is the most urgent version of "about to go", not a
 * card that stops warning.
 *
 * @param {ReturnType<typeof agingState>} state
 * @returns {{ opacity: number, elapsedDays: number, horizonDays: number, daysRemaining: number, expiringSoon: boolean, expired: boolean }|null}
 */
function agingRenderState(state) {
	if (!state || state.enabled !== true) return null;
	// Re-derived from the model's own opacity rather than recomputed from the
	// elapsed time, so the two ramps can never drift apart: both are linear in
	// the same progress, and reading it back out of `opacity` means there is
	// exactly one place the decay curve is defined.
	const progress = Math.min(1, Math.max(0, (1 - state.opacity) / (1 - AGING_OPACITY_FLOOR)));
	const daysRemaining = Math.max(0, state.horizonDays - state.elapsedDays);
	return {
		opacity: roundOpacity(1 - progress * (1 - AGING_RENDER_OPACITY_FLOOR)),
		elapsedDays: Math.round(state.elapsedDays * 100) / 100,
		horizonDays: state.horizonDays,
		daysRemaining: Math.round(daysRemaining * 100) / 100,
		expiringSoon: daysRemaining <= AGING_SOON_DAYS,
		expired: state.expired === true,
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
		// transcripts.read refused: a revoked grant drops the session; any other failure becomes the
		// excerpt's own error line.
		const message = errorMessage(err);
		if (isGrantDenial(message)) {
			grantedSessions.delete(sessionId);
			historyCache.delete(sessionId);
			scheduleReachSync();
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
			// The event-driven History re-read failed; the pane keeps the excerpt it already has.
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
		// agents.dispatch refused: a revoked grant drops the session; every other denial (unsigned, no
		// unattended consent, the rate cap, an unknown tab) is returned verbatim.
		const message = errorMessage(err);
		if (isGrantDenial(message)) {
			grantedSessions.delete(sessionId);
			historyCache.delete(sessionId);
			scheduleReachSync();
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
		// Board file read failed: ENOENT means "no file yet, use defaults"; anything else is reported.
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
		// The board YAML did not parse, or names another project: reported, never silently defaulted.
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
		// Only ENOENT is survivable here (nothing to protect); any other read failure aborts the write.
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
		// Only ENOENT means "no board yet"; any other read failure bubbles rather than overwriting.
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
		// storage.get refused: this board falls back to deriveColumn() placements for the session.
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
			// storage.set refused: the move holds on screen but is not remembered across a restart.
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
			// storage.delete refused: a stale placement key survives; the board is already cleared.
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
		// storage.get refused: cards start this session with no description and no comments.
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
		// storage.set refused: the note shows on screen but is not remembered across a restart.
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
		// storage.get refused: this board runs on the default settings for the session.
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
		// storage.set refused: the setting holds on screen but is not remembered across a restart.
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

/** @type {Map<string, object>} card key -> the `aging` payload cardToJson
 * stamps on that card, as of the last refreshAgingSnapshot(). Recomputed
 * once per snapshot rather than per card so a board full of Done cards costs
 * one terminal-column read per distinct project, not one per card, and so
 * every card in a single push is measured against the same clock reading -
 * two cards that entered Done in the same millisecond must not render at
 * different opacities because the loop took a tick to get to the second. */
let agingByCard = new Map();

/** Recomputes agingByCard for every live card. Called from buildSnapshot()
 * before the columns are built, so the payload the panel draws from is
 * always the same age as the board it rides on.
 *
 * A card with no project path has no board file, no terminal column and
 * therefore no clock (the same exclusion cardsInTerminalColumn() makes), and
 * a card aging says nothing about gets no entry at all rather than a
 * null-filled one - an absent field is what the panel reads as "draw this
 * card the way Phase 04 drew it".
 * @param {number} [now] */
async function refreshAgingSnapshot(now) {
	const at = typeof now === 'number' && isFinite(now) ? now : Date.now();
	/** @type {Map<string, string|null>} project path -> terminal column id */
	const terminalByProject = new Map();
	const next = new Map();
	for (const card of cards.values()) {
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		if (!terminalByProject.has(card.projectPath)) {
			terminalByProject.set(card.projectPath, await terminalColumnIdForProject(card.projectPath));
		}
		const render = agingRenderState(
			agingStateForCard(card, terminalByProject.get(card.projectPath), at)
		);
		if (render) next.set(card.key, render);
	}
	agingByCard = next;
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
		// Archive read failed: ENOENT is an empty archive; anything else is reported, never
		// written over.
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
		// The archive JSON did not parse: reported, so saveArchive() refuses to overwrite it.
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

/**
 * Takes records back out of one board's archive and writes it back. The
 * inverse of appendToArchive() and the only one there is: Restore is the
 * only thing that ever un-archives a card, which is why nothing else in
 * this plugin calls it. Throws through saveArchive() when the existing file
 * is unreadable, so a restore never destroys the archive it is reading from.
 * Resolves to the records removed, which is empty when none of the keys was
 * in the file (a record someone else already restored).
 * @param {string} boardId
 * @param {string[]} keys
 * @returns {Promise<ArchiveRecord[]>}
 */
async function removeFromArchive(boardId, keys) {
	const wanted = new Set(Array.isArray(keys) ? keys : []);
	const existing = await loadArchive(boardId);
	if (existing.error) {
		throw new Error(
			'Refusing to rewrite an unreadable archive at ' +
				archiveFilePath(boardId) +
				': ' +
				existing.error.message
		);
	}
	const removed = existing.records.filter(function (record) {
		return wanted.has(record.key);
	});
	if (removed.length === 0) return [];
	await saveArchive(
		boardId,
		existing.records.filter(function (record) {
			return !wanted.has(record.key);
		})
	);
	return removed;
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
		// That board now has an archive file, which is how the Global board's
		// archive view finds it again once this project's tabs are all closed.
		await noteArchiveBoard(boardId);
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
			await recordActivity(
				boardId,
				ACTIVITY_TYPE_RETIRED,
				card.key,
				'retired card ' +
					card.key +
					' ("' +
					archiveString(card.title) +
					'"): ' +
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
			// A sweep that threw must not take the interval down with it; the next tick retries.
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
		// tabs.list refused: null is never read as "not busy", so no tab is closed on this sweep.
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
			// tabs.close refused (stale tab id, or the host declined): the card is archived either way.
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
// Phase 05 archive view: the half of "aging is never destructive" the user
// can actually see. Retirement writes a record; this is what reads it back,
// as a second mode of the same panel (there is one panel in plugin.json, and
// a board that opens a second window to show its own archive would be a
// worse board).
//
// Six properties worth knowing:
//
//   1. The payload rides in the snapshot, and ONLY while the view is open.
//      The panel posts `archive-view` to open, close, and re-filter; the
//      sandbox holds that state and `buildSnapshot()` attaches
//      `archive: null` the rest of the time. Same shape as the Phase 04
//      History excerpt, and for the same reason: the bridge carries no reply
//      to a post, so the only way an answer reaches the panel is the next
//      snapshot.
//   2. The FILTER runs here, not in the panel. The alternative - shipping
//      every record and filtering in the DOM - would put 500 records with
//      their comment threads through a 56 KB snapshot budget. Filtering in
//      the sandbox means the text search covers the whole archive while only
//      the newest ARCHIVE_VIEW_LIMIT matches ride out, each one trimmed to
//      what the view draws.
//   3. "Which archived cards still have a live tab" is read from
//      `tabs.list()` on every build, never from the record's own `tabId`: a
//      record is a ledger entry written days ago and the tab behind it may
//      well be gone. A read the host refuses is reported as `tabsUnknown`
//      rather than guessed either way.
//   4. Restore is the inverse of retirement and nothing more: the record
//      comes out of the archive file, the card's key comes out of the
//      archived-key set, and the next rebuild finds its tab in `tabs.list()`
//      and draws the card again. It lands in whichever column
//      deriveColumn() puts it (its placement was removed when it retired),
//      and it keeps its description and comment thread, because retirement
//      never deleted them.
//   5. A card whose tab is gone CANNOT be restored, because there would be
//      nothing to restore it from - a card is a projection of a live AI tab
//      (see rebuildCardsFromTabs). So that record stays in the archive as a
//      read-only entry, the view says so on the row, and the sandbox refuses
//      the post as well rather than trusting the panel's reading of it.
//   6. Which boards the view lists is the board selection's answer, not a
//      directory listing: this plugin has no capability to enumerate
//      `~/.maestro/kanban-archive`, so a project board shows its own archive
//      and the Global board merges the archives of every board it knows
//      about - the projects with live cards, plus the ones remembered in the
//      `archive-boards` index that retirement maintains. Without that index
//      a project whose tabs are all closed would have an invisible archive.
// ===========================================================================

/** Storage key for the set of board ids that have an archive file. */
const ARCHIVE_BOARDS_STORAGE_KEY = 'archive-boards';

/** How many archived records ride in one snapshot. The filter runs over
 * every record (see buildArchiveView), so this caps the PAYLOAD and not the
 * search: the newest matches are the ones a person is looking for, and the
 * view says how many older ones it is not showing. */
const ARCHIVE_VIEW_LIMIT = 50;

/** How many of a record's comments ride out with it, newest last, and how
 * long a piece of its text may be. The archive view is a list, not a reader:
 * it shows enough of a record to recognize the card, and the full thread
 * comes back with the card itself when it is restored. */
const ARCHIVE_VIEW_COMMENT_CAP = 2;
const ARCHIVE_VIEW_TEXT_CAP = 160;

/** Whether the panel is showing the archive instead of the board. False
 * means `buildSnapshot()` sends no archive payload at all, so a board nobody
 * is browsing the archive of costs no fs reads. */
let archiveViewOpen = false;

/** The text the archive view is filtered by, as the panel last posted it. */
let archiveViewFilter = '';

/** @type {Set<string>} every board id known to have an archive file.
 * Retirement adds to it; the Global board's archive view reads it, so a
 * project whose tabs are all closed still has a findable archive. Union'd
 * with the live cards' projects on every build, which is what makes an
 * archive written before this index existed show up anyway. */
const archiveBoardIndex = new Set();

/** Restores the remembered archive-board index. Called once from activate(),
 * beside loadBoardSettings(). A storage failure degrades to "only the boards
 * with live cards", which is a smaller archive view and not a broken one. */
async function loadArchiveBoardIndex() {
	try {
		const raw = await sdk.storage.get(ARCHIVE_BOARDS_STORAGE_KEY);
		const parsed = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : [];
		if (Array.isArray(parsed)) {
			for (const id of parsed) {
				if (typeof id === 'string' && id !== '') archiveBoardIndex.add(id);
			}
		}
	} catch (err) {
		// storage.get refused: the index degrades to "no board has an archive" for this session.
		console.error('maestro-kanban: failed to read the archive board index: ' + String(err));
	}
	return archiveBoardIndex;
}

/** Remembers that a board now has an archive file. Called by retirement
 * after a successful archive write, and best-effort: losing the index costs
 * the Global board's archive view a project with no open tabs, which is not
 * worth failing a retirement over.
 * @param {string} boardId
 */
async function noteArchiveBoard(boardId) {
	if (typeof boardId !== 'string' || boardId === '') return;
	if (archiveBoardIndex.has(boardId)) return;
	archiveBoardIndex.add(boardId);
	try {
		await sdk.storage.set(
			ARCHIVE_BOARDS_STORAGE_KEY,
			JSON.stringify(Array.from(archiveBoardIndex))
		);
	} catch (err) {
		// storage.set refused: this board's archive file is still written, only the index forgets it.
		console.error('maestro-kanban: failed to remember the archive board index: ' + String(err));
	}
}

/**
 * Whose archives the view lists: one project board shows its own, and the
 * Global board (or the unnamed pre-activation board, which also shows
 * everything) merges every archive this plugin knows a path to - the
 * remembered index, plus every project a live card or a live SESSION names.
 * The sessions matter on their own: a project whose cards have all been
 * retired has no cards left to name it, and its archive is exactly the one a
 * user goes looking for. Sorted, so the merged read order is stable between
 * pushes.
 * @returns {string[]}
 */
function archiveViewBoardIds() {
	const view = resolveBoardView();
	if (view.kind === 'project' && view.projectPath !== null) return [view.projectPath];
	/** @type {Set<string>} */
	const ids = new Set(archiveBoardIndex);
	for (const card of cards.values()) {
		if (typeof card.projectPath === 'string' && card.projectPath !== '') ids.add(card.projectPath);
	}
	for (const projectPath of sessionProjectPath.values()) {
		if (typeof projectPath === 'string' && projectPath !== '') ids.add(projectPath);
	}
	return Array.from(ids).sort();
}

/**
 * The card keys a rebuild would produce from the tabs that exist right now -
 * ai tabs only, keyed exactly as rebuildCardsFromTabs() keys them, so
 * "has a live tab" and "would come back as a card" are the same question
 * asked once. Null when the host refused the read, which is never read as
 * "the tab is gone".
 * @returns {Promise<Set<string>|null>}
 */
async function liveCardKeys() {
	try {
		const tabs = await sdk.tabs.list();
		/** @type {Set<string>} */
		const keys = new Set();
		for (const tab of Array.isArray(tabs) ? tabs : []) {
			if (!tab || typeof tab !== 'object') continue;
			if (tab.type !== 'ai') continue;
			if (typeof tab.sessionId !== 'string' || typeof tab.id !== 'string') continue;
			keys.add(cardKey(tab.sessionId, tab.id));
		}
		return keys;
	} catch (err) {
		// tabs.list refused: null is never read as "the tab is gone", so nothing is offered for
		// restore.
		console.error(
			'maestro-kanban: tabs.list failed while checking which archived cards still have a tab, ' +
				'so none is offered for restore: ' +
				errorMessage(err)
		);
		return null;
	}
}

/** Pure: does this record match the archive view's text filter? The filter
 * covers the card's TITLE and its COMMENTS, which is what a person
 * remembers about a card they retired; it is case-insensitive and a plain
 * substring match, never a pattern, so a filter typed with a `.` in it
 * means a `.`.
 * @param {ArchiveRecord} record
 * @param {string} needle lowercased already
 */
function archiveRecordMatches(record, needle) {
	if (needle === '') return true;
	if (archiveString(record.title).toLowerCase().indexOf(needle) !== -1) return true;
	for (const comment of Array.isArray(record.comments) ? record.comments : []) {
		if (
			comment &&
			String(comment.body || '')
				.toLowerCase()
				.indexOf(needle) !== -1
		)
			return true;
	}
	return false;
}

/** One piece of a record's text, trimmed to what the view draws. Marked with
 * a trailing ellipsis so a truncated comment never reads as the whole thing.
 * @param {unknown} value
 */
function archiveViewText(value) {
	const text = archiveString(value);
	if (text.length <= ARCHIVE_VIEW_TEXT_CAP) return text;
	return text.slice(0, ARCHIVE_VIEW_TEXT_CAP) + '...';
}

/**
 * One stored record as the view's row: its identity, what it was called,
 * where it came from, when and why it retired, and whether the tab behind it
 * is still open. `boardId` is its own project path, echoed back by a
 * `restore-card` post so the sandbox reads the right archive file.
 * @param {ArchiveRecord} record
 * @param {Set<string>|null} liveKeys
 */
function archiveViewRow(record, liveKeys) {
	const comments = Array.isArray(record.comments) ? record.comments : [];
	return {
		key: record.key,
		boardId: record.projectPath,
		title: archiveString(record.title),
		projectPath: record.projectPath,
		projectName: record.projectPath === null ? null : projectDisplayName(record.projectPath),
		agentName: record.agentName,
		retiredAt: record.retiredAt,
		reason: archiveString(record.reason),
		columnHistory: record.columnHistory,
		description: archiveViewText(record.description),
		commentCount: comments.length,
		comments: comments.slice(-ARCHIVE_VIEW_COMMENT_CAP).map(function (comment) {
			return { id: comment.id, body: archiveViewText(comment.body), createdAt: comment.createdAt };
		}),
		// null, not false: "we could not ask" is a third answer, and the row
		// says so rather than claiming the tab is gone.
		hasLiveTab: liveKeys === null ? null : liveKeys.has(record.key),
	};
}

/**
 * The archive payload for the next snapshot, or null when the view is
 * closed. Reads every scoped archive file fresh (the archive is deliberately
 * uncached - see the archive storage section), filters over the whole set,
 * sorts newest first, and sends the newest ARCHIVE_VIEW_LIMIT matches.
 *
 * An archive file that does not parse is REPORTED, never skipped silently
 * and never written over: its `errors` entry is what the view shows, and it
 * is the same read `saveArchive()` refuses on.
 * @returns {Promise<object|null>}
 */
async function buildArchiveView() {
	if (!archiveViewOpen) return null;
	const boardIds = archiveViewBoardIds();
	const needle = archiveViewFilter.trim().toLowerCase();
	/** @type {ArchiveRecord[]} */
	const matched = [];
	/** @type {{ path: string, message: string }[]} */
	const errors = [];
	let archivedTotal = 0;
	for (const boardId of boardIds) {
		const read = await loadArchive(boardId);
		if (read.error) {
			errors.push({ path: read.error.path, message: read.error.message });
			continue;
		}
		archivedTotal += read.records.length;
		for (const record of read.records) {
			if (archiveRecordMatches(record, needle)) matched.push(record);
		}
	}
	matched.sort(compareArchiveRecords);
	const liveKeys = matched.length > 0 ? await liveCardKeys() : new Set();
	const shown = matched.slice(0, ARCHIVE_VIEW_LIMIT);
	return {
		open: true,
		filter: archiveViewFilter,
		boardName: currentBoardName(),
		boardCount: boardIds.length,
		records: shown.map(function (record) {
			return archiveViewRow(record, liveKeys);
		}),
		total: matched.length,
		hidden: matched.length - shown.length,
		archivedTotal: archivedTotal,
		errors: errors,
		tabsUnknown: liveKeys === null,
	};
}

/**
 * Backs the panel's `archive-view` command: opens, closes, and re-filters
 * the archive view. The panel is the only caller (there is no palette entry:
 * "open the archive" is a mode of a panel that has to be open to have a
 * mode), and it debounces its own typing, so every post here is one the user
 * meant.
 * @param {unknown} args
 */
async function setArchiveView(args) {
	const open = !!(args && args.open === true);
	// Bounded on the way in: a filter is a substring search over every record,
	// and nothing a person types to find a card is longer than a card's text.
	const filter =
		args && typeof args.filter === 'string' ? args.filter.slice(0, ARCHIVE_VIEW_TEXT_CAP) : '';
	archiveViewOpen = open;
	// A closed view forgets its filter, so reopening it starts on the whole
	// archive rather than on a search the user typed days ago.
	archiveViewFilter = open ? filter : '';
	await pushSnapshotNow();
	return { ok: true, open: archiveViewOpen, filter: archiveViewFilter };
}

/**
 * Backs the archive view's Restore action: takes one record back out of the
 * archive so the next rebuild draws its card again. The inverse of
 * retirement, and ordered the same way round - the archive file is written
 * first and the board rebuilt second, so a write that fails leaves the card
 * archived rather than leaving it on a board it is still archived from.
 *
 * Refused, with a toast naming which, when the record is gone, when the
 * host will not say whether the tab is still open, or when it is not: a card
 * is a projection of a live AI tab, so a record whose tab has closed has
 * nothing to restore TO and stays in the archive as a read-only entry.
 * @param {unknown} cardKeyArg
 * @param {unknown} boardIdArg
 */
async function restoreArchivedCard(cardKeyArg, boardIdArg) {
	const key = typeof cardKeyArg === 'string' ? cardKeyArg : '';
	if (key === '') return { ok: false, reason: 'cardKey is required' };
	const boardIds =
		typeof boardIdArg === 'string' && boardIdArg !== '' ? [boardIdArg] : archiveViewBoardIds();
	/** @type {{ boardId: string, record: ArchiveRecord }|null} */
	let found = null;
	/** @type {{ message: string, path: string }|null} */
	let readError = null;
	for (const boardId of boardIds) {
		const read = await loadArchive(boardId);
		if (read.error) {
			readError = readError || read.error;
			continue;
		}
		const record = read.records.find(function (entry) {
			return entry.key === key;
		});
		if (record) {
			found = { boardId: boardId, record: record };
			break;
		}
	}
	if (!found) {
		// A file that would not parse is a different story from a record that
		// is genuinely gone, and the difference is the whole of what the user
		// has to go fix.
		const reason = readError
			? 'the archive at ' + readError.path + ' could not be read: ' + readError.message
			: 'that record is no longer in the archive';
		console.warn('maestro-kanban: refused Restore for "' + key + '": ' + reason);
		await safeToast('Could not restore that card: ' + reason);
		return { ok: false, reason: reason };
	}
	const title = archiveString(found.record.title) || key;

	const liveKeys = await liveCardKeys();
	if (liveKeys === null) {
		const reason = 'Maestro did not say whether that tab is still open; try again';
		await safeToast('Could not restore "' + title + '": ' + reason);
		return { ok: false, reason: reason };
	}
	if (!liveKeys.has(key)) {
		// Nothing to restore TO: a card only exists while its AI tab does.
		const reason = 'its tab is gone, so it stays in the archive as a read-only record';
		console.log('maestro-kanban: cannot restore archived card ' + key + ': ' + reason);
		await safeToast('"' + title + '" cannot come back: ' + reason + '.');
		return { ok: false, reason: reason, readOnly: true };
	}

	await removeFromArchive(found.boardId, [key]);
	const archivedKeys = archivedCardKeys.get(found.boardId);
	if (archivedKeys) archivedKeys.delete(key);
	console.log(
		'maestro-kanban: restored card ' +
			key +
			' ("' +
			title +
			'") from ' +
			archiveFilePath(found.boardId) +
			' to its board'
	);
	// A full rebuild rather than a hand-built card: the tab is the source of
	// truth for everything on it, and the card has no placement any more, so
	// it lands wherever deriveColumn() puts it. seed() pushes the snapshot.
	await seed();
	const restored = cards.get(key);
	return {
		ok: true,
		columnId: restored && typeof restored.columnId === 'string' ? restored.columnId : null,
	};
}

// ===========================================================================
// End of Phase 05 archive view.
// ===========================================================================

// ===========================================================================
// Phase 05 board settings surface: the three controls that decide whether
// aging happens at all, how fast it happens, and whether it is ever allowed
// to close a tab. The stateful half - the stored per-board map and the
// fallback chain a card reads its settings through - is the aging runtime
// section above; this is the half the panel draws and posts back to.
//
// Four properties worth knowing:
//
//   1. The payload rides on EVERY snapshot, unlike the archive view's.
//      Answering it is a Map lookup, not a filesystem read, so there is
//      nothing to gate behind an "open" post: the panel draws the real
//      values the moment the surface opens, with no round trip, and a
//      horizon change repaints the board in the very push that saves it.
//   2. A board that has never been configured says so. Because
//      agingSettingsForBoard() falls back to the Global board, a project
//      board with nothing stored of its own runs on Global's settings - so
//      the payload reports `inherited` and where the numbers came from
//      rather than presenting another board's horizon as this board's own.
//      The first change a user makes to such a board writes all three
//      fields, which is what setBoardAgingSettings()'s merge already does.
//   3. A post names the board it was drawn for, and a stale one is refused -
//      the same echo guard `move` and Clear Done carry. Switching boards
//      mid-click and landing "close tabs when cards close" on the board the
//      user just left is exactly the accident that guard exists for.
//   4. Turning aging on does not retire anything on the spot. It changes how
//      the board renders and lets the next retirement tick (or the next
//      activate) do the retiring, so one click on a checkbox never empties a
//      Done column that nobody confirmed emptying - Clear Done is the
//      control that does that, and it asks first.
// ===========================================================================

/**
 * The settings payload for the board on screen: its effective values,
 * whether they are this board's own or inherited, and the bounds the panel's
 * horizon control clamps to. Called from buildSnapshot() on every push.
 *
 * `boardId` is null only for the unnamed pre-activation board (see
 * currentBoardId()), which has no board file and nothing to store settings
 * under; the panel renders the surface read-only and says so rather than
 * offering three controls that cannot be saved.
 *
 * @returns {{ boardId: string|null, boardName: string, agingEnabled: boolean, horizonDays: number, closeTabsOnRetire: boolean, inherited: boolean, inheritedFrom: string|null, minHorizonDays: number, maxHorizonDays: number }}
 */
function boardSettingsSnapshot() {
	const boardId = currentBoardId();
	const own = storedBoardSettings(boardId);
	const effective = agingSettingsForBoard(boardId);
	// Inherited from the Global board only when that board actually has
	// stored settings AND this is not the Global board itself; otherwise the
	// values are DEFAULT_AGING_SETTINGS and there is no other board to name.
	const inheritedFrom =
		own === null && boardId !== GLOBAL_BOARD_ID && storedBoardSettings(GLOBAL_BOARD_ID) !== null
			? GLOBAL_BOARD_NAME
			: null;
	return {
		boardId: boardId,
		boardName: currentBoardName(),
		agingEnabled: effective.agingEnabled,
		horizonDays: effective.horizonDays,
		closeTabsOnRetire: effective.closeTabsOnRetire,
		inherited: own === null,
		inheritedFrom: inheritedFrom,
		minHorizonDays: MIN_HORIZON_DAYS,
		maxHorizonDays: MAX_HORIZON_DAYS,
	};
}

/** The fields of a `board-settings` post, as a patch for
 * setBoardAgingSettings(). Absent fields stay absent, so a surface that
 * posts one toggle never restates (or accidentally resets) the other two.
 * A horizon arrives as a number or as the string a number input hands over;
 * anything else is dropped rather than guessed, and the clamping itself is
 * normalizeAgingSettings()'s job.
 * @param {{ agingEnabled?: unknown, horizonDays?: unknown, closeTabsOnRetire?: unknown }} source
 * @returns {{ agingEnabled?: boolean, horizonDays?: number, closeTabsOnRetire?: boolean }} */
function boardSettingsPatchFrom(source) {
	/** @type {{ agingEnabled?: boolean, horizonDays?: number, closeTabsOnRetire?: boolean }} */
	const patch = {};
	if (source.agingEnabled !== undefined) patch.agingEnabled = source.agingEnabled === true;
	if (source.closeTabsOnRetire !== undefined) {
		patch.closeTabsOnRetire = source.closeTabsOnRetire === true;
	}
	if (source.horizonDays !== undefined) {
		const raw = source.horizonDays;
		const parsed =
			typeof raw === 'number'
				? raw
				: typeof raw === 'string' && raw.trim() !== ''
					? Number(raw)
					: Number.NaN;
		if (isFinite(parsed)) patch.horizonDays = parsed;
	}
	return patch;
}

/**
 * Backs the panel's `board-settings` command: writes one or more of the
 * three settings for the board the surface was drawn on, then pushes a fresh
 * snapshot so the board repaints at the new horizon immediately rather than
 * waiting for the next refresh.
 *
 * Refused, with a toast naming which, when there is no board to configure,
 * when the posted board is not the one on screen any more, and when the post
 * carries nothing this plugin recognizes as a change.
 * @param {unknown} args
 */
async function applyBoardSettings(args) {
	const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
	const boardId =
		typeof source.boardId === 'string' && source.boardId !== '' ? source.boardId : null;
	if (boardId === null) {
		const reason = 'there is no board on screen to configure yet';
		console.warn('maestro-kanban: refused a board-settings post: ' + reason);
		await safeToast('Could not save that setting: ' + reason);
		return { ok: false, reason: reason };
	}
	if (boardId !== currentBoardId()) {
		const reason = 'the board changed before that setting was saved; try again';
		console.warn('maestro-kanban: refused a board-settings post: ' + reason);
		await safeToast('Could not save that setting: ' + reason);
		return { ok: false, reason: reason };
	}
	const patch = boardSettingsPatchFrom(source);
	if (Object.keys(patch).length === 0) {
		const reason = 'that post named no setting this board understands';
		console.warn('maestro-kanban: refused a board-settings post: ' + reason);
		return { ok: false, reason: reason };
	}
	const before = agingSettingsForBoard(boardId);
	const settings = await setBoardAgingSettings(boardId, patch);
	// Logged at warn, with the board named, because it is the one setting in
	// this plugin that can destroy something a person cannot get back: every
	// tab this board ever closes is traceable to this line (see
	// closeTabsForRetiredCards(), which logs the closes themselves).
	if (settings.closeTabsOnRetire && !before.closeTabsOnRetire) {
		console.warn(
			'maestro-kanban: "' +
				boardId +
				'" turned ON closing a card\'s tab when it ages out of Done; retirement may now close real tabs and their transcripts'
		);
	} else {
		console.log(
			'maestro-kanban: "' +
				boardId +
				'" board settings saved: aging ' +
				(settings.agingEnabled ? 'on' : 'off') +
				', horizon ' +
				settings.horizonDays +
				'd, close tabs ' +
				(settings.closeTabsOnRetire ? 'on' : 'off')
		);
	}
	// The repaint is the point of pushing here: a shorter horizon means every
	// Done card is further along it, and the user changed the number to see
	// exactly that.
	await pushSnapshotNow();
	return { ok: true, settings: settings };
}

// ===========================================================================
// End of Phase 05 board settings surface.
// ===========================================================================

// ===========================================================================
// Phase 06 conductor configuration model: which agent, if any, a board's
// conductor runs as. This section only holds the stored choice - the same
// board-id-keyed, load-once-at-activate()/persist-on-every-change shape as
// the board settings above, and for the same reason: picking a provider is a
// click, not something to coalesce. Nothing here calls maestro.sessions;
// turning this configuration into a running conductor agent (creating its
// session, keeping its reach in sync) is Phase 06's later tasks.
//
// `agentId` names the toolType a new session would be created with
// (`maestro.sessions.create({ agentId, ... })`, per
// Phase-06-Conductor-Session-And-Reach.md) - never an existing agent
// instance id. `customModel` and `customEffort` are the same plain strings
// that call accepts. All three default to null, which means "no conductor
// configured for this board": the board's provider/model/effort choice is
// its own, with no Global-board fallback the way aging settings have one -
// a conductor is a per-board decision, not something to inherit.
// ===========================================================================

const CONDUCTOR_CONFIG_STORAGE_KEY = 'conductor-config';

/** @typedef {{ agentId: string|null, customModel: string|null, customEffort: string|null }} ConductorConfig */

/** The configuration a board with nothing stored runs under: no conductor
 * configured at all. */
const DEFAULT_CONDUCTOR_CONFIG = { agentId: null, customModel: null, customEffort: null };

/** @type {Map<string, ConductorConfig>} board id -> that board's conductor configuration */
let conductorConfigs = new Map();

/** A value from storage (or a patch from the settings surface) as a
 * non-empty trimmed string, or null for anything else - absent, blank, and
 * the wrong type all collapse to "unset" rather than throwing.
 * @param {unknown} value
 * @returns {string|null} */
function normalizedConfigString(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * Reads whatever is stored (or posted by the settings surface) into a
 * complete `ConductorConfig`. Every field falls back to unset independently,
 * so a partial patch from the settings surface and a half-written storage
 * value both land on the same safe shape.
 * @param {unknown} raw
 * @returns {ConductorConfig}
 */
function normalizeConductorConfig(raw) {
	const value =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? /** @type {{ agentId?: unknown, customModel?: unknown, customEffort?: unknown }} */ (raw)
			: {};
	return {
		agentId: normalizedConfigString(value.agentId),
		customModel: normalizedConfigString(value.customModel),
		customEffort: normalizedConfigString(value.customEffort),
	};
}

/** Restores every board's conductor configuration from storage. Called once,
 * alongside loadBoardSettings(), before activate()'s first seed(). A storage
 * failure, or a value that is not the object this plugin writes, degrades to
 * "every board has no conductor configured" rather than throwing the
 * activation. */
async function loadConductorConfigs() {
	conductorConfigs = new Map();
	try {
		const raw = await sdk.storage.get(CONDUCTOR_CONFIG_STORAGE_KEY);
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					conductorConfigs.set(key, normalizeConductorConfig(parsed[key]));
				}
			}
		}
	} catch (err) {
		// storage.get refused: every board runs on the default conductor configuration this session.
		console.error('maestro-kanban: failed to read stored conductor configuration: ' + String(err));
	}
}

/** Writes every board's conductor configuration in one call. A failed write
 * logs and moves on: the in-memory map stays authoritative for this session,
 * so the failure degrades to "forgets on restart" rather than refusing the
 * change. */
async function persistConductorConfigs() {
	const obj = {};
	for (const [boardId, config] of conductorConfigs) {
		obj[boardId] = config;
	}
	try {
		await sdk.storage.set(CONDUCTOR_CONFIG_STORAGE_KEY, JSON.stringify(obj));
	} catch (err) {
		// storage.set refused: the configuration holds on screen but is forgotten on restart.
		console.error('maestro-kanban: failed to persist conductor configuration: ' + String(err));
	}
}

/** One board's stored conductor configuration, or null when that board has
 * never had one set. Callers that want an answer either way use
 * conductorConfigForBoard() below.
 * @param {string|null} boardId */
function storedConductorConfig(boardId) {
	if (typeof boardId !== 'string' || boardId === '') return null;
	return conductorConfigs.get(boardId) || null;
}

/** The conductor configuration a board runs under: its own when it has one,
 * DEFAULT_CONDUCTOR_CONFIG (no conductor configured) otherwise.
 * @param {string|null} boardId
 * @returns {ConductorConfig} */
function conductorConfigForBoard(boardId) {
	return storedConductorConfig(boardId) || normalizeConductorConfig(DEFAULT_CONDUCTOR_CONFIG);
}

/** Records one board's conductor configuration and persists the whole map.
 * `patch` is merged over whatever that board already has, so the settings
 * surface can post a single changed field without restating the other two.
 * Returns the existing stored value, without a write, when the patch would
 * not actually change anything.
 * @param {string} boardId
 * @param {unknown} patch
 * @returns {Promise<ConductorConfig>} */
async function setConductorConfig(boardId, patch) {
	const current = conductorConfigForBoard(boardId);
	const merged = normalizeConductorConfig(
		Object.assign({}, current, patch && typeof patch === 'object' ? patch : {})
	);
	const existing = storedConductorConfig(boardId);
	if (
		existing &&
		existing.agentId === merged.agentId &&
		existing.customModel === merged.customModel &&
		existing.customEffort === merged.customEffort
	) {
		return existing;
	}
	conductorConfigs.set(boardId, merged);
	await persistConductorConfigs();
	return merged;
}

// ===========================================================================
// End of Phase 06 conductor configuration model.
// ===========================================================================

// ===========================================================================
// Phase 06 conductor settings surface: the panel section that lets a user
// pick the configuration above, see this board's resolved reach, and learn
// where the conductor's binary path, CLI args, env vars, SSH remote, and
// Claude token mode actually live (Maestro's own agent settings - a plugin
// must never set those). `conductorExists` and `conductorConnected` on the
// snapshot below read the real session this plugin created - see the
// "conductor session creation" section further down, which is the only
// place that calls maestro.sessions.create/update for it.
// ===========================================================================

/**
 * The distinct providers worth offering in the picker: one entry per
 * toolType that at least one existing agent already runs as, in the shape
 * `agents.list()` reports (plus whether that provider can take an added
 * directory at all, which a later task uses to say whether the conductor
 * will see files or only the board snapshot). A plugin cannot install a
 * provider for the user, so the picker never claims to offer one nothing is
 * running - "only providers you already run an agent for appear" is the
 * literal truth, not a hedge.
 *
 * A failed `agents.list()` degrades this one picker and nothing else, and it
 * degrades HONESTLY: the options come back empty with `error` set, because
 * an empty picker on its own reads as "you run no agents", which is a
 * different and much more discouraging statement than "Maestro would not
 * tell us". The panel renders the two differently - see renderConductorSettings.
 * @returns {Promise<{ options: { toolType: string, supportsAdditionalDirectories: boolean }[],
 * error: string|null }>}
 */
async function conductorProviderOptions() {
	let entries;
	try {
		entries = await sdk.agents.list();
	} catch (err) {
		// agents.list refused: reported to the picker as an error, never as "you run no providers".
		console.error('maestro-kanban: agents.list failed: ' + String(err));
		return { options: [], error: errorMessage(err) };
	}
	const byToolType = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry.toolType !== 'string' || entry.toolType === '') continue;
		if (byToolType.has(entry.toolType)) continue;
		byToolType.set(entry.toolType, {
			toolType: entry.toolType,
			supportsAdditionalDirectories: entry.supportsAdditionalDirectories === true,
		});
	}
	const options = Array.from(byToolType.values()).sort(function (a, b) {
		return a.toolType < b.toolType ? -1 : a.toolType > b.toolType ? 1 : 0;
	});
	return { options: options, error: null };
}

/** The fields of a `conductor-config` post, as a patch for
 * setConductorConfig(). Mirrors boardSettingsPatchFrom(): an absent field
 * stays absent, so posting one changed field never restates or resets the
 * other two. The value itself is passed through as-is - normalizeConductorConfig
 * already defends against the wrong type or a blank string, so there is
 * nothing left for this function to coerce.
 * @param {{ agentId?: unknown, customModel?: unknown, customEffort?: unknown }} source
 * @returns {{ agentId?: unknown, customModel?: unknown, customEffort?: unknown }}
 */
function conductorConfigPatchFrom(source) {
	const patch = {};
	if (source.agentId !== undefined) patch.agentId = source.agentId;
	if (source.customModel !== undefined) patch.customModel = source.customModel;
	if (source.customEffort !== undefined) patch.customEffort = source.customEffort;
	return patch;
}

/** At most this many project entries ride in each half of the conductor
 * reach lists below. Mirrors BOARD_OPTIONS_LIMIT's reasoning: the Global
 * board (or the unnamed pre-activation board, which shows every card) can
 * have far more distinct projects than the panel's byte budget affords, and
 * a quietly incomplete list is worse than one that says how much it is not
 * showing. */
const CONDUCTOR_REACH_LIMIT = 64;

/**
 * This board's project roots, split by whether Phase 04 access has already
 * been granted to at least one of its cards' sessions - the full,
 * UNCAPPED lists. A project needs only one granted session to be reachable:
 * `sessions.update()` only requires that SOME granted session resolve to the
 * path it is given, not a specific one, so approving any single card for a
 * project grants that project's whole reach. `sessionId` on an ungranted
 * entry names one representative card to request access through -
 * approving it is enough even when the project has several cards.
 *
 * Shared by conductorReachForBoard() below, which caps this for the panel's
 * byte budget, and by the conductor session creation/reach-sync code, which
 * needs the true set - a display cap must never quietly become a reach cap.
 * @returns {{ granted: { projectPath: string, name: string }[], ungranted: { projectPath: string, name: string, sessionId: string }[] }}
 */
function boardReachLists() {
	const view = resolveBoardView();
	const granted = new Set();
	const ungrantedRepresentative = new Map();
	for (const card of boardCards(view)) {
		if (typeof card.projectPath !== 'string' || card.projectPath === '') continue;
		if (granted.has(card.projectPath)) continue;
		if (isSessionAccessGranted(card.sessionId)) {
			granted.add(card.projectPath);
			ungrantedRepresentative.delete(card.projectPath);
		} else if (!ungrantedRepresentative.has(card.projectPath)) {
			ungrantedRepresentative.set(card.projectPath, card.sessionId);
		}
	}
	const byName = function (a, b) {
		return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
	};
	const grantedList = Array.from(granted)
		.map(function (projectPath) {
			return { projectPath: projectPath, name: projectDisplayName(projectPath) };
		})
		.sort(byName);
	const ungrantedList = Array.from(ungrantedRepresentative.entries())
		.map(function (entry) {
			return { projectPath: entry[0], name: projectDisplayName(entry[0]), sessionId: entry[1] };
		})
		.sort(byName);
	return { granted: grantedList, ungranted: ungrantedList };
}

/**
 * The display view of boardReachLists(): the same two lists, capped to
 * CONDUCTOR_REACH_LIMIT per side with a hidden-count, for the settings
 * surface to paint.
 * @returns {{ granted: { projectPath: string, name: string }[], grantedHidden: number, ungranted: { projectPath: string, name: string, sessionId: string }[], ungrantedHidden: number }}
 */
function conductorReachForBoard() {
	const lists = boardReachLists();
	return {
		granted: lists.granted.slice(0, CONDUCTOR_REACH_LIMIT),
		grantedHidden: Math.max(0, lists.granted.length - CONDUCTOR_REACH_LIMIT),
		ungranted: lists.ungranted.slice(0, CONDUCTOR_REACH_LIMIT),
		ungrantedHidden: Math.max(0, lists.ungranted.length - CONDUCTOR_REACH_LIMIT),
	};
}

/**
 * Whether the board's CONFIGURED provider (`config.agentId`, not the whole
 * `providers` list) can take an added directory at all - the fact the
 * settings surface's degraded-provider note is built from. Null means
 * there is nothing to say yet: no provider is configured, or the
 * configured toolType is not one of `providers` (no agent of that type is
 * currently running, so its capability cannot be read). A plugin never
 * guesses a capability it cannot observe; it says nothing instead.
 * @param {{ toolType: string, supportsAdditionalDirectories: boolean }[]} providers
 * @param {string|null} agentId
 * @returns {boolean|null}
 */
function conductorProviderSupportsDirectories(providers, agentId) {
	if (typeof agentId !== 'string' || agentId === '') return null;
	const match = (Array.isArray(providers) ? providers : []).find(function (provider) {
		return provider.toolType === agentId;
	});
	return match ? match.supportsAdditionalDirectories === true : null;
}

/**
 * Everything the settings surface paints, rebuilt fresh on every snapshot
 * the same way boardSettingsSnapshot() is - it is cheap enough, and a
 * provider picked in another window or a grant just approved from a card
 * must show up here without a dedicated round trip. `conductorId` and
 * `conductorExists` come from resolveConductorSessionId() (see "conductor
 * session creation" below), which also clears a stored id whose session is
 * gone. `conductorConnected` is false for a conductor that exists but whose
 * grant this plugin no longer holds (a restart, or a revoke in Settings) -
 * the panel's cue to show "conductor not connected" with an Allow Access
 * action, the same one a card's ungranted project already offers.
 * `providerSupportsDirectories` is the board's cue to show the
 * degraded-provider note instead of pretending the reach above means the
 * conductor can open those files: a provider with no native add-directory
 * support still gets handed the board snapshot, never the files themselves.
 * `status` is the conductor's own AI tab status (see "Phase 06 conductor
 * chat surface" below), always 'idle' when there is no conductor yet.
 * @returns {Promise<object>}
 */
async function conductorSettingsSnapshot() {
	const boardId = currentBoardId();
	const conductorId = await resolveConductorSessionId(boardId);
	const config = conductorConfigForBoard(boardId);
	const providerRead = await conductorProviderOptions();
	const providers = providerRead.options;
	return {
		boardId: boardId,
		boardName: currentBoardName(),
		config: config,
		providers: providers,
		// Non-null only when agents.list() refused, so the picker can say that
		// instead of claiming the user runs no providers (see
		// conductorProviderOptions above).
		providersError: providerRead.error,
		providerSupportsDirectories: conductorProviderSupportsDirectories(providers, config.agentId),
		reach: conductorReachForBoard(),
		conductorId: conductorId,
		conductorExists: conductorId !== null,
		conductorConnected: conductorId !== null && isSessionAccessGranted(conductorId),
		status: conductorTabStatus(conductorId),
	};
}

/**
 * Backs the panel's `conductor-config` command: writes one or more of the
 * three stored fields for the board the surface was drawn on, then pushes a
 * fresh snapshot. Mirrors applyBoardSettings()'s refusals: no board on
 * screen, a stale board id (the user switched boards before the post
 * landed), and a post naming nothing this plugin recognizes.
 * @param {unknown} args
 */
async function applyConductorConfig(args) {
	const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
	const boardId =
		typeof source.boardId === 'string' && source.boardId !== '' ? source.boardId : null;
	if (boardId === null) {
		const reason = 'there is no board on screen to configure a conductor for yet';
		console.warn('maestro-kanban: refused a conductor-config post: ' + reason);
		await safeToast('Could not save that setting: ' + reason);
		return { ok: false, reason: reason };
	}
	if (boardId !== currentBoardId()) {
		const reason = 'the board changed before that setting was saved; try again';
		console.warn('maestro-kanban: refused a conductor-config post: ' + reason);
		await safeToast('Could not save that setting: ' + reason);
		return { ok: false, reason: reason };
	}
	const patch = conductorConfigPatchFrom(source);
	if (Object.keys(patch).length === 0) {
		const reason = 'that post named no setting this board understands';
		console.warn('maestro-kanban: refused a conductor-config post: ' + reason);
		return { ok: false, reason: reason };
	}
	const config = await setConductorConfig(boardId, patch);
	await pushSnapshotNow();
	return { ok: true, config: config };
}

// ===========================================================================
// End of Phase 06 conductor settings surface.
// ===========================================================================

// ===========================================================================
// Phase 06 conductor session creation: turning the configuration above into
// a running agent. A board's conductor lives in a scratch folder this
// plugin owns, never a project folder - the ONLY way it ever sees a card's
// files is the additionalDirectories grant below.
//
// Grant state mirrors a card's: `sessions.create()` grants the new session
// to this plugin on the HOST side the instant it exists (see
// pluginSessionsCreate's comment in src/main/index.ts), and this section
// mirrors that into the local `grantedSessions` set the moment creation
// succeeds, so `isSessionAccessGranted()` reads true for it without a round
// trip. That local mirror is cleared on every restart (deactivate(), same
// as a card's), and the host's own grant can also be revoked independently
// of this plugin, in Settings' existing agent-dispatch allowlist editor.
// Either way the next snapshot reads `conductorConnected: false` - "conductor
// not connected" - and the fix is the SAME `request-access` command a card's
// ungranted project already uses, aimed at the conductor's session id
// instead: sessions.requestAccess() answers instantly with no re-prompt when
// the host still holds the grant, and only raises a real confirmation when
// it genuinely does not.
// ===========================================================================

/** Scratch space this plugin keeps every board conductor's working directory
 * under - never a project folder. */
const CONDUCTOR_SCRATCH_DIR = '~/.maestro/kanban-conductor';

/** Basename of the Global board's conductor scratch folder. Mirrors
 * GLOBAL_ARCHIVE_BASENAME's reasoning: the Global board's id is the reserved
 * GLOBAL_BOARD_ID rather than a path, so it gets a reserved basename too. */
const GLOBAL_CONDUCTOR_SCRATCH_BASENAME = 'global';

const CONDUCTOR_ID_STORAGE_KEY = 'conductor-ids';

/** @type {Map<string, string>} board id -> that board's conductor session id */
let conductorIds = new Map();

/**
 * The scratch directory one board's conductor runs in, under
 * CONDUCTOR_SCRATCH_DIR. Every other board slugs through the same
 * projectBoardSlug() its board YAML and archive file already do, so the
 * three files for one project are recognizably a set. The leading `~` is
 * left for the host to expand. Throws on anything but GLOBAL_BOARD_ID or a
 * non-empty project path.
 * @param {string} boardId
 */
function conductorScratchDir(boardId) {
	if (boardId === GLOBAL_BOARD_ID) {
		return CONDUCTOR_SCRATCH_DIR + '/' + GLOBAL_CONDUCTOR_SCRATCH_BASENAME;
	}
	if (typeof boardId !== 'string' || boardId === '') {
		throw new Error('conductorScratchDir requires a board id: a project path, or GLOBAL_BOARD_ID');
	}
	return CONDUCTOR_SCRATCH_DIR + '/' + projectBoardSlug(boardId);
}

/** Restores every board's conductor session id from storage. Called once,
 * alongside loadConductorConfigs(), before activate()'s first seed(). A
 * storage failure degrades to "no board has a conductor yet" rather than
 * throwing the activation. */
async function loadConductorIds() {
	conductorIds = new Map();
	try {
		const raw = await sdk.storage.get(CONDUCTOR_ID_STORAGE_KEY);
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					if (typeof parsed[key] === 'string' && parsed[key] !== '') {
						conductorIds.set(key, parsed[key]);
					}
				}
			}
		}
	} catch (err) {
		// storage.get refused: no board remembers its conductor this session; createConductor()
		// says so.
		console.error('maestro-kanban: failed to read stored conductor ids: ' + String(err));
	}
}

/** Writes every board's conductor session id in one call. A failed write
 * logs and moves on, the same best-effort persistence persistConductorConfigs()
 * uses: the in-memory map stays authoritative for this session. */
async function persistConductorIds() {
	const obj = {};
	for (const [boardId, sessionId] of conductorIds) {
		obj[boardId] = sessionId;
	}
	try {
		await sdk.storage.set(CONDUCTOR_ID_STORAGE_KEY, JSON.stringify(obj));
	} catch (err) {
		// storage.set refused: the conductor exists but is re-created after a restart.
		console.error('maestro-kanban: failed to persist conductor ids: ' + String(err));
	}
}

/** One board's stored conductor session id, or null when it has never had
 * one (or its stored id was just cleared by resolveConductorSessionId()
 * below, because the session it named is gone).
 * @param {string|null} boardId */
function storedConductorId(boardId) {
	if (typeof boardId !== 'string' || boardId === '') return null;
	return conductorIds.get(boardId) || null;
}

/** Records (or, with `sessionId: null`, clears) one board's conductor id and
 * persists the whole map. A no-op, with no write, when the stored value
 * already matches - so resolveConductorSessionId() does not write on every
 * snapshot it is asked for.
 * @param {string} boardId @param {string|null} sessionId */
async function setConductorId(boardId, sessionId) {
	const existing = conductorIds.get(boardId) || null;
	if (existing === sessionId) return;
	if (sessionId === null) conductorIds.delete(boardId);
	else conductorIds.set(boardId, sessionId);
	await persistConductorIds();
}

/**
 * The board's conductor session id, or null when it has none. Treats a
 * stored id whose session no longer exists as "no conductor" rather than an
 * error, clearing the stale id (and this plugin's local grant mirror for it)
 * so neither keeps answering for a session that is gone for good. A
 * transient `sessions.get()` failure degrades to "no conductor for this
 * render" WITHOUT touching storage, so a passing glitch cannot make the
 * plugin forget a conductor that is actually still there.
 * @param {string|null} boardId
 * @returns {Promise<string|null>}
 */
async function resolveConductorSessionId(boardId) {
	const id = storedConductorId(boardId);
	if (!id) return null;
	let session;
	try {
		session = await sdk.sessions.get(id);
	} catch (err) {
		// sessions.get refused (grant revoked, or the id is stale): treated as "no conductor".
		console.error('maestro-kanban: sessions.get (conductor) failed: ' + String(err));
		return null;
	}
	if (!session) {
		await setConductorId(boardId, null);
		grantedSessions.delete(id);
		return null;
	}
	return id;
}

/** The additionalDirectories entries this board's conductor should hold
 * right now: one read-only entry per granted project root. Deliberately
 * uncapped, unlike conductorReachForBoard()'s display lists - a panel byte
 * budget must never become a reach limit.
 * @returns {{ path: string, read: true, write: false }[]} */
function conductorDirectoryGrants() {
	return boardReachLists().granted.map(function (entry) {
		return { path: entry.projectPath, read: true, write: false };
	});
}

/** Writes the one file this plugin ever puts in a conductor's scratch folder
 * directly - `maestro.fs.write` creates the folder itself, so there is
 * nothing to create first.
 * @param {string} boardId */
async function writeConductorReadme(boardId) {
	const text =
		"# Kanban Conductor Scratch Space\n\nThis folder is this board's Kanban conductor working " +
		"directory. It holds only the conductor's own scratch space and plan files - the Kanban " +
		'Board plugin never writes anything else here.\n';
	await sdk.fs.write(conductorScratchDir(boardId) + '/README.md', text);
}

/**
 * Backs the panel's `create-conductor` command. Refuses the same way
 * applyConductorConfig() does: no board on screen, or a stale board id (the
 * user switched boards before the post landed). A conductor that already
 * resolves for this board is left alone rather than recreated. Otherwise:
 * writes the scratch folder's README, creates the session with this board's
 * configured provider (and model/effort when set), mirrors the host's grant
 * locally, stores the new id, and hands the session this board's granted
 * project roots as read-only added directories. A failure after the README
 * is written (sessions.create rejecting, say) leaves that README in place -
 * harmless scratch content in an unused folder - rather than attempting a
 * cleanup that could itself fail.
 * @param {unknown} args
 */
async function createConductor(args) {
	const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
	const boardId =
		typeof source.boardId === 'string' && source.boardId !== '' ? source.boardId : null;
	if (boardId === null) {
		const reason = 'there is no board on screen to create a conductor for yet';
		console.warn('maestro-kanban: refused create-conductor: ' + reason);
		await safeToast('Could not create a conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	if (boardId !== currentBoardId()) {
		const reason = 'the board changed before the conductor could be created; try again';
		console.warn('maestro-kanban: refused create-conductor: ' + reason);
		await safeToast('Could not create a conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	const existingId = await resolveConductorSessionId(boardId);
	if (existingId) {
		await pushSnapshotNow();
		return { ok: true, conductorId: existingId };
	}
	const config = conductorConfigForBoard(boardId);
	if (!config.agentId) {
		const reason = "pick a provider for this board's conductor first";
		console.warn('maestro-kanban: refused create-conductor: ' + reason);
		await safeToast('Could not create a conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	try {
		await writeConductorReadme(boardId);
	} catch (err) {
		// The conductor scratch folder could not be written: no agent is created without one.
		console.error('maestro-kanban: writing the conductor README failed: ' + String(err));
		await safeToast('Could not create a conductor: could not write its scratch folder.');
		return { ok: false, reason: errorMessage(err) };
	}
	const createParams = {
		agentId: config.agentId,
		title: 'Conductor: ' + currentBoardName(),
		cwd: conductorScratchDir(boardId),
	};
	if (config.customModel) createParams.customModel = config.customModel;
	if (config.customEffort) createParams.customEffort = config.customEffort;
	let created;
	try {
		created = await sdk.sessions.create(createParams);
	} catch (err) {
		// sessions.create refused: no conductor exists, and the reason is handed back to the panel.
		console.error('maestro-kanban: sessions.create (conductor) failed: ' + String(err));
		await safeToast('Could not create the conductor agent.');
		return { ok: false, reason: errorMessage(err) };
	}
	const conductorId = created && typeof created.id === 'string' ? created.id : null;
	if (!conductorId) {
		console.error('maestro-kanban: sessions.create (conductor) returned no id');
		await safeToast('Could not create the conductor agent.');
		return { ok: false, reason: 'sessions.create returned no id' };
	}
	// The host already granted this plugin the session it just made (see
	// pluginSessionsCreate); mirror that locally so isSessionAccessGranted()
	// reads true for it without a round trip.
	grantedSessions.add(conductorId);
	await setConductorId(boardId, conductorId);
	// The conductor's initial grant is itself a reach change (from nothing to
	// whatever is granted right now), so it goes through the same
	// syncConductorReach() the rest of this section's triggers use rather than
	// a separate sessions.update() call here - that is what gets it logged,
	// and what seeds lastSyncedReach so the very next trigger does not
	// re-detect this same grant as a fresh change. `boardId === currentBoardId()`
	// is already guaranteed by the refusal above, which is the one precondition
	// syncConductorReach() relies on to know which board it is syncing.
	const result = await syncConductorReach();
	if (result.changed && !result.ok) {
		await safeToast("Conductor created, but could not grant it this board's projects yet.");
	}
	await pushSnapshotNow();
	return { ok: true, conductorId: conductorId };
}

// ===========================================================================
// End of Phase 06 conductor session creation.
// ===========================================================================

// ===========================================================================
// Phase 06 conductor reach sync: once a board has a conductor, this section
// is what keeps maestro.sessions.update()'s additionalDirectories matching
// boardReachLists().granted for the board currently on screen - the same
// board createConductor() and the settings surface already scope every
// reach read to (see currentBoardId()). A board nobody is looking at is not
// watched between visits; the invariant is simply restored the moment the
// user switches back to it (see onSessionActivated()/selectBoard()'s hook
// below), which is cheap enough to run on every switch and keeps a board's
// conductor from staying stale for longer than the user is away from it.
//
// Every trigger this section answers to - a card appearing or disappearing
// (rebuildCardsFromTabs(), onSessionRemoved()), a session's grant being
// approved or found revoked (the two grantedSessions.add() call sites and
// the two isGrantDenial() call sites), and a board switch - calls the same
// debounced scheduleReachSync() rather than syncConductorReach() directly,
// so a burst of these events (a tabs.list() rebuild touching a dozen
// sessions, several grants approved in a row, ...) produces exactly one
// sessions.update() call and one log entry, never one per event.
//
// syncConductorReach() only calls sessions.update() when
// conductorDirectoryGrants() actually differs from the set it last
// confirmed with the host (lastSyncedReach) - never on a sync that finds the
// same set it already pushed, the same "push only on an actual change" rule
// runRetirementSweep() follows. A denial because the conductor's OWN grant
// was revoked (isGrantDenial()) drops it out of grantedSessions, the same
// recovery readSessionHistoryExcerpt()/dispatchCardMessage() already do for
// a card, so the next snapshot reads "conductor not connected" instead of a
// generic error.
//
// A reach change is recorded through recordActivity() (Phase 07 board
// activity feed, below this file's own Phase 07 plan sections) rather than a
// log of its own: this section used to keep a dedicated reach-change log,
// and that log's own doc comments said as much - "Phase 07's board activity
// feed folds reach changes from Phase 06 into a single unified log". This is
// that folding; recordReachChange() is the one place this section writes to
// it.
// ===========================================================================

/** How long a burst of the events this section answers to is allowed to
 * settle before syncConductorReach() runs once for all of them. */
const REACH_SYNC_DEBOUNCE_MS = 400;

/** @type {Map<string, string[]>} board id -> the project-path set this plugin
 * last confirmed with sessions.update() for that board's conductor.
 * In-memory only, like lastMessageOutcomes above - a restart (or a fresh
 * sandbox) re-derives it from scratch the first time syncConductorReach()
 * runs for a board, which, finding no prior entry, treats the conductor's
 * actual sessions.update() state as unknown and re-sends the current set
 * once rather than assuming it already matches. */
let lastSyncedReach = new Map();

let reachSyncTimer = null;

/** Appends one reach-change entry to the board's activity feed (Phase 07
 * board activity feed, above - recordActivity() caps and persists it). No
 * cardKey: a reach change is about the conductor's own directory grants, not
 * about one card.
 * @param {string} boardId
 * @param {string[]} added
 * @param {string[]} removed */
async function recordReachChange(boardId, added, removed) {
	const parts = [];
	if (added.length > 0) parts.push('granted ' + added.join(', '));
	if (removed.length > 0) parts.push('revoked ' + removed.join(', '));
	await recordActivity(
		boardId,
		ACTIVITY_TYPE_REACH_CHANGED,
		null,
		'conductor reach changed: ' + (parts.length > 0 ? parts.join('; ') : 'no change')
	);
}

/**
 * Recomputes the board on screen's granted directory set and, only when it
 * actually differs from what was last confirmed with the host, pushes it
 * through sessions.update() and records the change. A no-op (`changed:
 * false`) when the board on screen has no conductor, or has one this plugin
 * cannot currently reach (not yet granted), or when nothing in the granted
 * set has actually moved since the last sync - there is nothing to push in
 * any of those cases. Never throws: a sessions.update() denial is handled
 * the same way every other grant denial in this plugin is (see the section
 * comment above), and any other failure is logged and left for the next
 * sync to retry; either is reported back as `{ changed: true, ok: false }`
 * so a caller like createConductor() can decide whether to tell the user.
 * @returns {Promise<{ changed: boolean, ok: boolean }>}
 */
async function syncConductorReach() {
	const boardId = currentBoardId();
	if (boardId === null) return { changed: false, ok: false };
	const conductorId = await resolveConductorSessionId(boardId);
	if (conductorId === null) return { changed: false, ok: false };
	if (!isSessionAccessGranted(conductorId)) return { changed: false, ok: false };
	const directories = conductorDirectoryGrants();
	const grantedPaths = directories.map(function (entry) {
		return entry.path;
	});
	const previous = lastSyncedReach.get(boardId) || [];
	const previousSet = new Set(previous);
	const grantedSet = new Set(grantedPaths);
	const added = grantedPaths.filter(function (path) {
		return !previousSet.has(path);
	});
	const removed = previous.filter(function (path) {
		return !grantedSet.has(path);
	});
	if (added.length === 0 && removed.length === 0) return { changed: false, ok: false };
	try {
		await sdk.sessions.update(conductorId, { additionalDirectories: directories });
	} catch (err) {
		// sessions.update refused: a revoked grant drops the conductor; the reach is left unchanged.
		const message = errorMessage(err);
		if (isGrantDenial(message)) {
			grantedSessions.delete(conductorId);
		} else {
			console.error(
				'maestro-kanban: sessions.update (conductor reach sync) failed: ' + String(err)
			);
		}
		return { changed: true, ok: false };
	}
	lastSyncedReach.set(boardId, grantedPaths);
	await recordReachChange(boardId, added, removed);
	return { changed: true, ok: true };
}

/** Debounces syncConductorReach() so a burst of the events this section
 * answers to produces exactly one sessions.update() call and one log entry,
 * never one per event. */
function scheduleReachSync() {
	if (reachSyncTimer) return;
	reachSyncTimer = setTimeout(function () {
		reachSyncTimer = null;
		syncConductorReach().catch(function (err) {
			// A reach sync that threw must not take the debounce timer down with it.
			console.error('maestro-kanban: syncConductorReach failed: ' + String(err));
		});
	}, REACH_SYNC_DEBOUNCE_MS);
}

// ===========================================================================
// End of Phase 06 conductor reach sync.
// ===========================================================================

// ===========================================================================
// Phase 06 conductor chat surface: once a conductor exists, it is a normal
// agent in the Left Bar (see "Phase 06 conductor session creation" above),
// so nudging it reaches it directly with nothing of this plugin's in the
// way. Open Conductor therefore needs no command of its own - the panel
// posts the exact same 'focus' command a card's own Open action already
// posts (see registerCommands() below), aimed at the conductor's session id
// with no tabId, which is exactly maestro.sessions.focus(conductorId).
//
// The live status line does need something new: the conductor's current AI
// tab status, which only maestro.tabs.list() carries. Rather than a
// dedicated RPC on every conductorSettingsSnapshot() push, this reuses the
// exact tabs.list() response rebuildCardsFromTabs() already reads on every
// refresh the cards use - "refreshed on the same session events the cards
// use" falls out of sharing that one read rather than scheduling a second
// one just for the conductor.
// ===========================================================================

/** The most recent maestro.tabs.list() response, kept warm by
 * rebuildCardsFromTabs() below so conductorTabStatus() can answer
 * synchronously from the same read the card model already took, instead of
 * issuing its own RPC on every settings-surface snapshot. Reset on
 * deactivate() like every other module-level cache. */
let latestTabs = [];

/**
 * Pure lookup: the conductor session's own AI tab status out of one
 * tabs.list() response. 'idle' is the default - both for a conductorId of
 * null (no conductor) and for a conductorId with no matching tab yet (one
 * just created, before the next refresh has seen it) - the same "assume
 * ready rather than unknown" rule rebuildCardsFromTabs() applies to an
 * ordinary card's tab.
 * @param {unknown} tabs
 * @param {string|null} conductorId
 * @returns {string}
 */
function conductorTabStatusFrom(tabs, conductorId) {
	if (typeof conductorId !== 'string' || conductorId === '') return 'idle';
	for (const tab of Array.isArray(tabs) ? tabs : []) {
		if (!tab || typeof tab !== 'object') continue;
		if (tab.type !== 'ai' || tab.sessionId !== conductorId) continue;
		return typeof tab.status === 'string' && tab.status ? tab.status : 'idle';
	}
	return 'idle';
}

/** Stateful wrapper over conductorTabStatusFrom() above: reads the warm
 * cache rebuildCardsFromTabs() keeps rather than taking a tabs argument, so
 * conductorSettingsSnapshot() can call it without an RPC of its own. */
function conductorTabStatus(conductorId) {
	return conductorTabStatusFrom(latestTabs, conductorId);
}

// ===========================================================================
// End of Phase 06 conductor chat surface.
// ===========================================================================

// ===========================================================================
// Phase 07 plan settings: the three per-board facts that decide how much a
// conductor's plan is allowed to do to this board. Deliberately its own
// store rather than extra keys on Phase 05's board settings: those describe
// how cards age, these describe how much authority the conductor has, and a
// halt that rode along in the aging settings would be merged through
// normalizeAgingSettings(), which does not know about it and would drop it.
//
// Nothing here is inherited from the Global board, unlike
// agingSettingsForBoard(). A halt is a statement about one board, and a
// project board quietly inheriting the Global board's halt (or its fully
// automatic mode) would be the most surprising possible reading of either
// switch.
// ===========================================================================

const PLAN_SETTINGS_STORAGE_KEY = 'plan-settings';

/** Plan and approve: every plan waits for a person. The default. */
const PLAN_MODE_APPROVE = 'plan-approve';
/** Fully automatic: the identical plan pipeline with the approval gate
 * skipped. Still bound by legality, the WIP cap, and the halt. */
const PLAN_MODE_AUTO = 'auto';

/** Small on purpose. The cap is how many distinct cards one execution may
 * act on, so the blast radius of a single misread plan is three cards rather
 * than the whole board. */
const DEFAULT_PLAN_WIP_CAP = 3;
const MIN_PLAN_WIP_CAP = 1;
const MAX_PLAN_WIP_CAP = 25;

const DEFAULT_PLAN_SETTINGS = {
	wipCap: DEFAULT_PLAN_WIP_CAP,
	mode: PLAN_MODE_APPROVE,
	halted: false,
	haltedAt: null,
};

/** @typedef {{ wipCap: number, mode: string, halted: boolean, haltedAt: number|null }} PlanSettings */

/** @type {Map<string, PlanSettings>} board id -> that board's plan settings */
let planSettings = new Map();

/**
 * Reads whatever is stored (or posted by the panel) into a complete
 * `PlanSettings`. Every field falls back to its default independently, the
 * same way normalizeAgingSettings() handles a partial patch: `wipCap` is
 * rounded and clamped rather than rejected, an unrecognized `mode` becomes
 * plan-and-approve (the safe one, never the automatic one), and `haltedAt`
 * is dropped unless the board is actually halted, so a cleared halt cannot
 * leave a timestamp behind for a banner to read.
 * @param {unknown} raw
 * @returns {PlanSettings}
 */
function normalizePlanSettings(raw) {
	const value =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? /** @type {{ wipCap?: unknown, mode?: unknown, halted?: unknown, haltedAt?: unknown }} */ (
					raw
				)
			: {};
	let wipCap = DEFAULT_PLAN_SETTINGS.wipCap;
	if (typeof value.wipCap === 'number' && isFinite(value.wipCap)) {
		wipCap = Math.min(MAX_PLAN_WIP_CAP, Math.max(MIN_PLAN_WIP_CAP, Math.round(value.wipCap)));
	}
	const halted = value.halted === true;
	return {
		wipCap: wipCap,
		mode: value.mode === PLAN_MODE_AUTO ? PLAN_MODE_AUTO : PLAN_MODE_APPROVE,
		halted: halted,
		haltedAt: halted ? finiteTimestamp(value.haltedAt) : null,
	};
}

/** Restores every board's plan settings from storage. Called once, alongside
 * loadBoardSettings(), before activate()'s first seed(): a halt has to
 * survive a restart, so it must be in hand before anything can execute. A
 * storage failure degrades to "every board runs on the defaults", which is
 * the conservative mode but does drop a halt, which is why it is logged
 * rather than swallowed. */
async function loadPlanSettings() {
	planSettings = new Map();
	try {
		const raw = await sdk.storage.get(PLAN_SETTINGS_STORAGE_KEY);
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					planSettings.set(key, normalizePlanSettings(parsed[key]));
				}
			}
		}
	} catch (err) {
		// storage.get refused: every board runs on the default plan settings for the session.
		console.error('maestro-kanban: failed to read stored plan settings: ' + String(err));
	}
}

/** Writes every board's plan settings in one call. Unlike the other stores
 * in this plugin the outcome is returned rather than only logged: the write
 * that matters most here is a halt, and a halt the user believes is
 * persisted but is not would come back cleared after a restart.
 * @returns {Promise<boolean>} whether the write landed */
async function persistPlanSettings() {
	const obj = {};
	for (const [boardId, settings] of planSettings) {
		obj[boardId] = settings;
	}
	try {
		await sdk.storage.set(PLAN_SETTINGS_STORAGE_KEY, JSON.stringify(obj));
		return true;
	} catch (err) {
		// storage.set refused: reported to the caller, which refuses the setting rather than faking it.
		console.error('maestro-kanban: failed to persist plan settings: ' + String(err));
		return false;
	}
}

/** The plan settings a board runs under: its own when it has them, the
 * defaults otherwise (never the Global board's - see this section's header).
 * @param {string|null} boardId
 * @returns {PlanSettings} */
function planSettingsForBoard(boardId) {
	if (typeof boardId !== 'string' || boardId === '') {
		return normalizePlanSettings(DEFAULT_PLAN_SETTINGS);
	}
	return planSettings.get(boardId) || normalizePlanSettings(DEFAULT_PLAN_SETTINGS);
}

/** Merges `patch` over one board's plan settings and persists the whole map,
 * stamping `haltedAt` when this is the write that halts the board and
 * carrying the existing stamp when the board was already halted. Returns the
 * settings now in force plus whether the write landed, so a caller can tell
 * the user that a halt did not persist.
 * @param {string} boardId
 * @param {unknown} patch
 * @returns {Promise<{ settings: PlanSettings, persisted: boolean }>} */
async function setPlanSettings(boardId, patch) {
	const current = planSettingsForBoard(boardId);
	const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
	const merged = normalizePlanSettings(Object.assign({}, current, source));
	if (merged.halted && merged.haltedAt === null) {
		merged.haltedAt = current.halted ? current.haltedAt || Date.now() : Date.now();
	}
	planSettings.set(boardId, merged);
	const persisted = await persistPlanSettings();
	return { settings: merged, persisted: persisted };
}

/** Whether a board refuses to execute anything right now: the first question
 * every execution path asks.
 * @param {string|null} boardId */
function isBoardHalted(boardId) {
	return planSettingsForBoard(boardId).halted === true;
}

/** The plan settings surface's view of one board - its WIP cap, mode, halt
 * state, and the bounds its number input should enforce - the same shape
 * boardSettingsSnapshot()/conductorSettingsSnapshot() hand back for their
 * own surfaces.
 * @param {string|null} boardId
 * @returns {{ boardId: string|null, wipCap: number, mode: string, halted: boolean, haltedAt: number|null, minWipCap: number, maxWipCap: number }} */
function planSettingsSnapshot(boardId) {
	const settings = planSettingsForBoard(boardId);
	return {
		boardId: boardId,
		wipCap: settings.wipCap,
		mode: settings.mode,
		halted: settings.halted,
		haltedAt: settings.haltedAt,
		minWipCap: MIN_PLAN_WIP_CAP,
		maxWipCap: MAX_PLAN_WIP_CAP,
	};
}

/** The fields of a `plan-settings` post, as a patch for setPlanSettings().
 * Absent fields stay absent, so toggling Halt never also restates (or
 * accidentally resets) the WIP cap or the mode, and vice versa - the same
 * reasoning boardSettingsPatchFrom() applies to aging's three independent
 * fields. A cap arrives as a number or as the string a number input hands
 * over; anything unparseable is dropped rather than guessed. `mode` is
 * normalized the same way normalizePlanSettings() normalizes it: anything
 * other than the literal auto value becomes plan-and-approve, the safe one,
 * never guessed into the automatic one.
 * @param {{ wipCap?: unknown, halted?: unknown, mode?: unknown }} source
 * @returns {{ wipCap?: number, halted?: boolean, mode?: string }} */
function planSettingsPatchFrom(source) {
	/** @type {{ wipCap?: number, halted?: boolean, mode?: string }} */
	const patch = {};
	if (source.halted !== undefined) patch.halted = source.halted === true;
	if (source.mode !== undefined) {
		patch.mode = source.mode === PLAN_MODE_AUTO ? PLAN_MODE_AUTO : PLAN_MODE_APPROVE;
	}
	if (source.wipCap !== undefined) {
		const raw = source.wipCap;
		const parsed =
			typeof raw === 'number'
				? raw
				: typeof raw === 'string' && raw.trim() !== ''
					? Number(raw)
					: Number.NaN;
		if (isFinite(parsed)) patch.wipCap = parsed;
	}
	return patch;
}

/**
 * Backs the panel's `plan-settings` command: writes this board's WIP cap,
 * halt flag, and/or mode, then pushes a fresh snapshot so the Halt control,
 * the halted banner, and the mode switch all repaint immediately. Refused,
 * with a toast naming why, the same way applyBoardSettings() refuses - no
 * board on screen, a board that changed since the post, or a post naming
 * nothing this plugin reads.
 *
 * A halt flip is logged (at warn when it is *armed*) with the board named,
 * the same spirit as applyBoardSettings()'s close-tabs warning: it is the
 * one flip on this surface that stops every card on the board from moving
 * or being messaged until a person clears it, and is also recorded to the
 * board's activity feed (Phase 07 board activity feed) - "halts" is one of
 * that feed's own named entry types. A mode change is logged and recorded
 * the same way: this is "the mode change" the auto-mode switch task called
 * for logging "to the activity feed", now writing to the real feed rather
 * than the console-only stopgap that task left behind.
 * @param {unknown} args
 */
async function applyPlanSettings(args) {
	const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
	const boardId =
		typeof source.boardId === 'string' && source.boardId !== '' ? source.boardId : null;
	if (boardId === null) {
		const reason = 'there is no board on screen to configure yet';
		console.warn('maestro-kanban: refused a plan-settings post: ' + reason);
		await safeToast('Could not save that setting: ' + reason);
		return { ok: false, reason: reason };
	}
	if (boardId !== currentBoardId()) {
		const reason = 'the board changed before that setting was saved; try again';
		console.warn('maestro-kanban: refused a plan-settings post: ' + reason);
		await safeToast('Could not save that setting: ' + reason);
		return { ok: false, reason: reason };
	}
	const patch = planSettingsPatchFrom(source);
	if (Object.keys(patch).length === 0) {
		const reason = 'that post named no setting this board understands';
		console.warn('maestro-kanban: refused a plan-settings post: ' + reason);
		return { ok: false, reason: reason };
	}
	const before = planSettingsForBoard(boardId);
	const outcome = await setPlanSettings(boardId, patch);
	const settings = outcome.settings;
	if (settings.halted && !before.halted) {
		console.warn(
			'maestro-kanban: "' +
				boardId +
				'" halted; no card will move or be messaged on it until the halt is cleared'
		);
		await recordActivity(
			boardId,
			ACTIVITY_TYPE_HALT_CHANGED,
			null,
			'board halted; no card will move or be messaged until the halt is cleared'
		);
	} else if (!settings.halted && before.halted) {
		console.log('maestro-kanban: "' + boardId + '" halt cleared');
		await recordActivity(boardId, ACTIVITY_TYPE_HALT_CHANGED, null, 'board halt cleared');
	}
	if (settings.mode !== before.mode) {
		console.log(
			'maestro-kanban: "' +
				boardId +
				'" plan mode set to ' +
				(settings.mode === PLAN_MODE_AUTO
					? 'fully auto (plans execute without approval, still bound by the WIP cap and halt; access requests still wait for a person)'
					: 'plan and approve')
		);
		await recordActivity(
			boardId,
			ACTIVITY_TYPE_MODE_CHANGED,
			null,
			'plan mode set to ' + (settings.mode === PLAN_MODE_AUTO ? 'fully auto' : 'plan and approve')
		);
	}
	if (!outcome.persisted) {
		await safeToast('That setting did not save; it may not survive a restart.');
	}
	await pushSnapshotNow();
	return { ok: true, settings: settings, persisted: outcome.persisted };
}

// ===========================================================================
// End of Phase 07 plan settings.
// ===========================================================================

// ===========================================================================
// Phase 07 plan contract: the only thing a conductor is ever allowed to
// propose, and the only shape this plugin will read back.
//
// Every line below treats the conductor's answer as adversarial input rather
// than as an API response - not because the conductor is hostile, but
// because a plan that half-parses is how a board quietly moves eleven cards
// nobody asked for. Two halves:
//
//   renderPlanPrompt() renders the board as text: the columns and what they
//   mean, every card with the facts a plan could need, the WIP cap, the halt
//   state, and the rules stated as rules. It names a fresh planId and the
//   ONE file the plan may be written to.
//
//   parsePlan() reads that file back and validates every entry
//   independently, re-deriving legality from legalColumnsFor() rather than
//   trusting the prompt's own "may move to" list, which the conductor has
//   had every opportunity to ignore.
//
// Why a file and not the reply: maestro.transcripts.read projects an agent's
// History entries (see the Phase 04 History excerpt section above), not the
// text the model wrote, so a plan read out of History is a summary of a plan.
// The conductor already runs in a scratch folder this plugin owns and can
// read (see Phase 06 conductor session creation), so the plan travels as a
// file in that folder: `plans/<planId>.json`. The planId inside the file has
// to match the one the prompt asked for, which is what stops a leftover plan
// from an earlier run being read as the answer to this one.
//
// Nothing outside `moves` and `messages` is executable. `rationale` is
// display text and is never read as an instruction. An unknown top-level key
// is not ignored but rejected: a model that invents `"cards": [...]` has to
// fail loudly, rather than have its invention silently dropped while the
// rest of its plan runs anyway.
// ===========================================================================

/** The contract version this plugin speaks. A plan that says anything else
 * is refused whole: the version is the one field that says whether the rest
 * of the keys mean what this parser thinks they mean. */
const PLAN_CONTRACT_VERSION = 1;

/** Subfolder of the conductor's own scratch directory that plans are written
 * to, one file per plan, named for its planId. */
const PLAN_DIR_BASENAME = 'plans';

/** A plan id this plugin generated: lowercase, digits and hyphens, short.
 * Every path built out of a plan id is checked against this first, so a plan
 * id can never be a way to reach a file outside the plans folder. */
const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PLAN_KNOWN_TOP_LEVEL_KEYS = ['version', 'planId', 'rationale', 'moves', 'messages'];
const PLAN_KNOWN_MOVE_KEYS = ['cardKey', 'toColumnId', 'why'];
const PLAN_KNOWN_MESSAGE_KEYS = ['cardKey', 'prompt', 'why'];

/** Hard ceiling on the plan file this plugin will even attempt to parse. A
 * conductor that writes a quarter of a megabyte of JSON has not written a
 * plan. */
const PLAN_FILE_MAX_CHARS = 256 * 1024;
/** Hard ceiling on entries per list, independent of the WIP cap. The cap
 * decides what executes; this decides what is read at all, so a plan with
 * ten thousand moves cannot become ten thousand rejection reasons that then
 * have to be rendered, logged and stored. */
const PLAN_ENTRY_CAP = 100;
/** Longest prompt one message may carry. Longer than this is a document,
 * not a message. */
const PLAN_MESSAGE_PROMPT_MAX_CHARS = 4000;
/** `rationale` and `why` are display text, so they are clipped rather than
 * rejected: a long one costs the panel bytes and nothing else. */
const PLAN_RATIONALE_MAX_CHARS = 2000;
const PLAN_WHY_MAX_CHARS = 400;
/** How much of an unreadable answer is shown back to the user verbatim. */
const PLAN_RAW_PREVIEW_CHARS = 2000;
/** How much of a rejected entry is kept, as text, beside its reason. */
const PLAN_ENTRY_PREVIEW_CHARS = 300;

/** Budget for the rendered prompt. Cards past it are dropped with a line
 * that says so - the same honesty trimToBudget() applies to the panel
 * snapshot, because the alternative is a model confidently planning around
 * cards that were silently withheld from it. */
const PLAN_PROMPT_BUDGET_CHARS = 24 * 1024;
/** Per-field caps inside one card's block of the prompt. */
const PLAN_PROMPT_DESCRIPTION_CHARS = 400;
const PLAN_PROMPT_COMMENT_CHARS = 200;
const PLAN_PROMPT_COMMENT_LIMIT = 3;
const PLAN_PROMPT_HISTORY_LIMIT = 4;
const PLAN_PROMPT_HISTORY_CHARS = 160;
/** At most this many sessions get a History read for one plan prompt. The
 * excerpt is a courtesy, and transcripts.read is rate limited and audited: a
 * board of two hundred granted cards must not cost two hundred reads. */
const PLAN_HISTORY_SESSION_LIMIT = 8;

/** A fresh plan id: the current time plus 32 bits of randomness, both in
 * base36, so it sorts roughly by age, is unique enough within one board's
 * plans folder, and is safe as a filename. Same spirit as nextCommentId(). */
function newPlanId() {
	return (
		'plan-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0x100000000).toString(36)
	);
}

/** The path a plan is written to, relative to the conductor's working
 * directory - exactly what the prompt tells the conductor to write. Throws
 * on an id this plugin did not generate rather than building a path out of
 * it.
 * @param {string} planId */
function planFileRelativePath(planId) {
	if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) {
		throw new Error('planFileRelativePath requires a plan id this plugin generated');
	}
	return PLAN_DIR_BASENAME + '/' + planId + '.json';
}

/** The same path this plugin reads the plan back from: inside the board's own
 * conductor scratch folder, which is the only place it holds fs permission
 * for anyway.
 * @param {string} boardId @param {string} planId */
function planFilePath(boardId, planId) {
	return conductorScratchDir(boardId) + '/' + planFileRelativePath(planId);
}

/** One-line display text: whitespace collapsed, clipped with an explicit
 * marker so a reader can tell a clipped field from a short one. Used for
 * every free-text field that rides in a prompt or in a rejection reason.
 * @param {unknown} value @param {number} max */
function planClip(value, max) {
	const text = String(value === undefined || value === null ? '' : value)
		.replace(/\s+/g, ' ')
		.trim();
	return text.length <= max ? text : text.slice(0, max) + ' ... (clipped)';
}

/** `"a", "b" and "c"`: how a list of keys or columns reads inside a reason.
 * @param {string[]} values */
function planQuoteList(values) {
	const quoted = (Array.isArray(values) ? values : []).map(function (value) {
		return JSON.stringify(String(value));
	});
	if (quoted.length === 0) return 'nothing';
	if (quoted.length === 1) return quoted[0];
	return quoted.slice(0, -1).join(', ') + ' and ' + quoted[quoted.length - 1];
}

/** What a value IS, for a reason a person reads: its JSON when that is
 * short, its type otherwise. Never the value itself unbounded.
 * @param {unknown} value */
function planDescribeValue(value) {
	if (value === undefined) return 'nothing';
	let json;
	try {
		json = JSON.stringify(value);
	} catch {
		// A value JSON.stringify refuses (a cycle, a BigInt) can still be
		// described by its type, which is all this reason needs.
		json = undefined;
	}
	if (typeof json === 'string' && json.length <= 60) return json;
	return Array.isArray(value) ? 'an array' : 'a ' + typeof value;
}

/** What the conductor wrote, for the user to read when it could not be
 * parsed. Deliberately NOT planClip(): this one keeps the text exactly as
 * written, newlines and all, and only truncates, because the whole point of
 * showing it is to let someone see the thing that failed to parse. A plan
 * file with its whitespace collapsed is unreadable as JSON.
 * @param {string} text */
function planRawPreview(text) {
	const raw = typeof text === 'string' ? text : '';
	return raw.length <= PLAN_RAW_PREVIEW_CHARS
		? raw
		: raw.slice(0, PLAN_RAW_PREVIEW_CHARS) + '\n... (truncated)';
}

/** A rejected entry, as the capped text shown beside its reason.
 * @param {unknown} entry */
function planEntryPreview(entry) {
	let json;
	try {
		json = JSON.stringify(entry);
	} catch {
		// Same as planDescribeValue(): the reason beside this preview is the
		// real message, so an unserializable entry degrades to String().
		json = undefined;
	}
	return planClip(typeof json === 'string' ? json : String(entry), PLAN_ENTRY_PREVIEW_CHARS);
}

/** Relative age in words, for the prompt's `last activity` line. The model
 * gets the ISO timestamp too; this is what makes "stalled for three days"
 * legible without arithmetic.
 * @param {unknown} timestamp @param {number} now */
function planAgeLabel(timestamp, now) {
	const at = finiteTimestamp(timestamp);
	if (at === null) return 'unknown';
	const minutes = Math.round(Math.max(0, now - at) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
	const hours = Math.round(minutes / 60);
	if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
	const days = Math.round(hours / 24);
	return days + (days === 1 ? ' day ago' : ' days ago');
}

/** An ISO timestamp, or `unknown` for a value that is not a clock reading.
 * @param {unknown} timestamp */
function planIsoTime(timestamp) {
	const at = finiteTimestamp(timestamp);
	return at === null ? 'unknown' : new Date(at).toISOString();
}

// ---------------------------------------------------------------------------
// The prompt. Pure: everything it renders is already in the snapshot
// buildPlanSnapshot() hands it, so a test can render a board that never
// existed without a stub SDK.
// ---------------------------------------------------------------------------

/** One column, as the prompt's column list shows it: its id (what a move has
 * to name), its title, and every meaning the board model gives it.
 * @param {object} column */
function renderPlanColumnLine(column) {
	const notes = [];
	if (column.terminal === true) {
		notes.push('terminal: a card parked here is finished, and the board may archive it');
	}
	if (typeof column.wipLimit === 'number') {
		notes.push('work in progress limit ' + column.wipLimit);
	}
	if (typeof column.mapsTo === 'string' && column.mapsTo !== '') {
		notes.push('shows up on the Global board as "' + column.mapsTo + '"');
	}
	if (column.readOnly === true) {
		notes.push('read only: no card may be moved into or out of it');
	}
	notes.push(
		column.cardCount === 1 ? '1 card right now' : String(column.cardCount) + ' cards right now'
	);
	return '- `' + column.id + '` "' + column.title + '" (' + notes.join('; ') + ')';
}

/** One card's block of the prompt: everything a plan could need about that
 * card and nothing else. No session id and no tab id - a plan names cards by
 * their key and this plugin resolves the rest itself - and a History excerpt
 * only when the user has granted this plugin access to that agent.
 * @param {object} card @param {number} now */
function renderPlanCardBlock(card, now) {
	const lines = [];
	lines.push('### `' + card.key + '`');
	lines.push('- title: ' + planClip(card.title, 200));
	lines.push('- agent: ' + (card.agentId ? card.agentId : 'unknown'));
	lines.push(
		'- project: ' +
			(card.projectName
				? card.projectName + ' (' + card.projectPath + ')'
				: 'none (this card has no project folder)')
	);
	lines.push('- column: `' + (card.columnId ? card.columnId : 'none') + '`');
	lines.push('- status: ' + (card.status ? card.status : 'idle'));
	lines.push(
		'- last activity: ' +
			planIsoTime(card.lastActivityAt) +
			' (' +
			planAgeLabel(card.lastActivityAt, now) +
			')'
	);
	lines.push(
		'- messaging: ' +
			(card.accessGranted === true
				? 'granted, so a message for this card can be sent'
				: 'NOT granted, so a message for this card waits until a person approves access to this agent')
	);
	lines.push(
		'- may move to: ' +
			(card.movableTo.length > 0
				? card.movableTo
						.map(function (id) {
							return '`' + id + '`';
						})
						.join(', ')
				: 'nothing (this card cannot change column)')
	);
	if (card.description) {
		lines.push('- description: ' + planClip(card.description, PLAN_PROMPT_DESCRIPTION_CHARS));
	}
	for (const comment of card.comments || []) {
		lines.push(
			'- comment (' +
				planIsoTime(comment.createdAt) +
				'): ' +
				planClip(comment.body, PLAN_PROMPT_COMMENT_CHARS)
		);
	}
	for (const row of card.history || []) {
		lines.push(
			'- History (' +
				planIsoTime(row.timestamp) +
				'): ' +
				planClip(row.summary, PLAN_PROMPT_HISTORY_CHARS)
		);
	}
	return lines.join('\n');
}

/**
 * The rendered board, as the prompt the conductor is dispatched. Pure: a
 * snapshot in, text out, no host calls and no module state.
 *
 * The card list is the one part with a budget. Cards are rendered until
 * PLAN_PROMPT_BUDGET_CHARS is reached and the rest are counted in a line
 * that says so, so the conductor is told it is looking at part of a board.
 * @param {object} snapshot buildPlanSnapshot()'s `snapshot`
 * @returns {string}
 */
function renderPlanPrompt(snapshot) {
	const now = finiteTimestamp(snapshot.now) || Date.now();
	const head = [];
	head.push(
		'You are the conductor of the "' +
			snapshot.boardName +
			'" Kanban board in Maestro. Read the board below and answer with a plan.'
	);
	head.push('');
	head.push(
		'Every card on this board is one AI tab that is already open in Maestro. A plan can do exactly two things to a card: move it to another column, and send its agent one message. That is the whole of your authority. You never act on the board yourself - this plugin executes your plan, and on this board ' +
			(snapshot.mode === PLAN_MODE_AUTO
				? 'it executes without asking anyone first, so propose only what you are willing to have happen unreviewed.'
				: 'a person approves or rejects each line of it first.')
	);
	head.push('');
	head.push('Clock: ' + planIsoTime(now));
	head.push('Board id: `' + String(snapshot.boardId) + '`');
	if (snapshot.global === true) {
		head.push(
			'This is the Global board: it aggregates the cards of every open project, and a card moves on it only between the global columns its own project can reach.'
		);
	}
	if (snapshot.boardError) {
		head.push('Board file problem a person has to fix: ' + planClip(snapshot.boardError, 300));
	}
	head.push('');
	head.push('## Columns');
	head.push('');
	for (const column of snapshot.columns || []) {
		head.push(renderPlanColumnLine(column));
	}
	head.push('');
	head.push('## Rules');
	head.push('');
	head.push(
		'- At most ' +
			(snapshot.wipCap === 1 ? '1 card' : snapshot.wipCap + ' cards') +
			' may be acted on in one execution. A card you both move and message counts once. Anything past the cap is held as pending rather than run, so a plan longer than the cap is not an error: it just does not all happen at once.'
	);
	head.push(
		'- At most one move and one message per card. A second entry for the same card is rejected.'
	);
	head.push(
		'- You may move a card only to a column listed as "may move to" for that card. Every other column is rejected, including a column that exists on another project board.'
	);
	head.push(
		'- You may never create a card and never create an agent. A card exists only because a person opened an AI tab, and nothing you write can make one.'
	);
	head.push(
		'- You may message only the agents this board already reaches. A message to a card whose messaging is NOT granted is kept rather than discarded, and waits for a person to approve access to that agent.'
	);
	if (snapshot.halted === true) {
		head.push(
			'- THIS BOARD IS HALTED (since ' +
				planIsoTime(snapshot.haltedAt) +
				'). Nothing will execute until a person clears the halt, so an empty plan is the only useful answer right now.'
		);
	}
	head.push('');
	head.push('## Cards');
	head.push('');

	const tail = [];
	tail.push('');
	tail.push('## Your answer');
	tail.push('');
	tail.push(
		'Write your plan to `' +
			snapshot.planFile +
			'`, relative to your own working directory, creating the folder if it is not there. That file is the only thing this board reads: do not paste the plan into your reply, and do not write it anywhere else.'
	);
	tail.push('');
	tail.push('One JSON object, exactly this shape:');
	tail.push('');
	tail.push('```json');
	tail.push('{');
	tail.push('  "version": ' + PLAN_CONTRACT_VERSION + ',');
	tail.push('  "planId": ' + JSON.stringify(snapshot.planId) + ',');
	tail.push('  "rationale": "one short paragraph, for the person reading this plan",');
	tail.push(
		'  "moves": [{ "cardKey": "<a key from above>", "toColumnId": "<a column that card may move to>", "why": "one sentence" }],'
	);
	tail.push(
		'  "messages": [{ "cardKey": "<a key from above>", "prompt": "<what to send that agent>", "why": "one sentence" }]'
	);
	tail.push('}');
	tail.push('```');
	tail.push('');
	tail.push(
		'- `planId` must be exactly ' +
			JSON.stringify(snapshot.planId) +
			'. A plan carrying any other id is read as the answer to a different request and discarded.'
	);
	tail.push(
		'- No other top-level keys. A key this contract does not list makes the whole plan unreadable, so there is no way to smuggle in an instruction: `rationale` and `why` are shown to a person and never executed.'
	);
	tail.push(
		'- `moves` and `messages` may both be empty. An empty plan is a valid answer, and a better one than a move you cannot justify.'
	);
	tail.push(
		'- A `cardKey` must be one of the keys above, copied exactly. An invented key is rejected.'
	);
	tail.push(
		'- Every message `prompt` is sent verbatim to that agent, in its own tab, as if a person had typed it. Keep it under ' +
			PLAN_MESSAGE_PROMPT_MAX_CHARS +
			' characters.'
	);

	const headText = head.join('\n');
	const tailText = tail.join('\n');
	const blocks = (snapshot.cards || []).map(function (card) {
		return renderPlanCardBlock(card, now);
	});
	let used = headText.length + tailText.length;
	const kept = [];
	for (let i = 0; i < blocks.length; i++) {
		if (kept.length > 0 && used + blocks[i].length > PLAN_PROMPT_BUDGET_CHARS) break;
		kept.push(blocks[i]);
		used += blocks[i].length + 2;
	}
	const omitted = blocks.length - kept.length;
	const cardsText =
		kept.length > 0
			? kept.join('\n\n') +
				(omitted > 0
					? '\n\n' +
						omitted +
						' further card(s) are on this board but did not fit in this prompt. You are looking at part of the board, so do not plan for a card you cannot see here.'
					: '')
			: 'This board has no cards right now. The only correct plan is an empty one.';
	return headText + '\n' + cardsText + '\n' + tailText + '\n';
}

// ---------------------------------------------------------------------------
// The parser. Also pure: a board context and a card list in, a plan out. It
// re-derives every legality question through legalColumnsFor() rather than
// from the prompt it rendered, so a conductor that ignores the "may move to"
// list is caught here and not at the point of a write.
// ---------------------------------------------------------------------------

/** Extracts the JSON value out of whatever the conductor wrote: the bare
 * object when the whole file is one, otherwise exactly one fenced block.
 * Several blocks is a rejection rather than a guess - picking "the first
 * one" or "the longest one" would be this plugin deciding which of two plans
 * the conductor meant.
 * @param {string} text
 * @returns {{ value?: unknown, error: string|null }} */
function extractPlanJson(text) {
	const raw = typeof text === 'string' ? text : '';
	const trimmed = raw.trim();
	if (trimmed === '') return { error: 'the plan file is empty' };
	if (raw.length > PLAN_FILE_MAX_CHARS) {
		return {
			error:
				'the plan file is ' +
				raw.length +
				' characters, more than the ' +
				PLAN_FILE_MAX_CHARS +
				' this board will read',
		};
	}
	if (trimmed.charAt(0) === '{') {
		try {
			return { value: JSON.parse(trimmed), error: null };
		} catch {
			// Not a bare object after all. Fall through to the fenced-block
			// search rather than reporting a parse error here: prose can begin
			// with a brace, and a real fenced plan may still be further down.
		}
	}
	const fence = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	const candidates = [];
	let match = fence.exec(raw);
	while (match !== null) {
		const body = match[2].trim();
		if (body !== '' && body.charAt(0) === '{') {
			candidates.push({ info: match[1].trim().toLowerCase(), body: body });
		}
		match = fence.exec(raw);
	}
	const tagged = candidates.filter(function (candidate) {
		return candidate.info === 'json';
	});
	const usable = tagged.length > 0 ? tagged : candidates;
	if (usable.length === 0) {
		return {
			error:
				trimmed.charAt(0) === '{'
					? 'the plan file is not valid JSON'
					: 'there is no JSON plan in what the conductor wrote',
		};
	}
	if (usable.length > 1) {
		return {
			error:
				'the conductor wrote ' +
				usable.length +
				' JSON blocks, and a plan has to be exactly one, so there is no way to tell which one is the plan',
		};
	}
	try {
		return { value: JSON.parse(usable[0].body), error: null };
	} catch (err) {
		// The fenced block is not JSON after all: reported as the plan's own parse failure.
		return { error: 'the plan is not valid JSON: ' + errorMessage(err) };
	}
}

/** The board facts parsePlan() answers legality from, normalized once per
 * parse: the card index, the boards legalColumnsFor() needs, and the cap.
 * @param {unknown} board `{ global, globalBoard, projectBoards, wipCap }`
 * @param {Iterable<object>|Map<string, object>} cards */
function planParseContext(board, cards) {
	const source =
		board && typeof board === 'object' && !Array.isArray(board)
			? /** @type {{ global?: unknown, globalBoard?: unknown, projectBoards?: unknown, wipCap?: unknown }} */ (
					board
				)
			: {};
	const byKey = new Map();
	const iterable =
		cards && typeof (/** @type {Map<string, object>} */ (cards).get) === 'function'
			? /** @type {Map<string, object>} */ (cards).values()
			: cards;
	for (const card of iterable || []) {
		if (!card || typeof card.key !== 'string' || card.key === '') continue;
		byKey.set(card.key, card);
	}
	let wipCap = DEFAULT_PLAN_WIP_CAP;
	if (typeof source.wipCap === 'number' && isFinite(source.wipCap)) {
		wipCap = Math.max(MIN_PLAN_WIP_CAP, Math.round(source.wipCap));
	}
	return {
		global: source.global === true,
		globalBoard: /** @type {object|null} */ (source.globalBoard || null),
		projectBoards:
			/** @type {Map<string, object>|Record<string, object>|null} */ (source.projectBoards) || null,
		wipCap: wipCap,
		cardsByKey: byKey,
		legalCache: /** @type {Map<string, string[]>} */ (new Map()),
	};
}

/** The columns one card may legally occupy, through legalColumnsFor() and
 * nothing else. Memoized on the pair the answer actually depends on (the
 * card's project and its current column), since a board of fifty cards in
 * four projects asks this question fifty times about four answers.
 * @param {ReturnType<typeof planParseContext>} context @param {object} card
 * @returns {string[]} */
function planLegalColumnsFor(context, card) {
	const projectPath = typeof card.projectPath === 'string' ? card.projectPath : '';
	const columnId = typeof card.columnId === 'string' ? card.columnId : '';
	// NUL, not a space: a project path and a column id can both contain one,
	// and "/a b" + "c" must not share a cache entry with "/a" + "b c".
	const cacheKey = projectPath + '\u0000' + columnId;
	const cached = context.legalCache.get(cacheKey);
	if (cached) return cached;
	const legal = legalColumnsFor(
		card,
		projectBoardFor(context.projectBoards, projectPath),
		context.globalBoard,
		{ global: context.global }
	);
	context.legalCache.set(cacheKey, legal);
	return legal;
}

/** Every key an entry carries that this contract does not name, or null when
 * it carries none. Entries are checked as strictly as the plan object
 * itself: `{ cardKey, toColumnId, createCard: true }` has to fail, not
 * quietly become a plain move.
 * @param {object} entry @param {string[]} known @returns {string[]|null} */
function planUnknownEntryKeys(entry, known) {
	const unknown = Object.keys(entry).filter(function (key) {
		return known.indexOf(key) === -1;
	});
	return unknown.length === 0 ? null : unknown;
}

/** A whole-plan failure: `ok: false`, the reason, and what the conductor
 * actually wrote, so the user can read that rather than being told "the plan
 * was empty" about an answer that was not.
 * @param {string} reason @param {string} raw
 * @param {ReturnType<typeof planParseContext>} context */
function planParseFailure(reason, raw, context) {
	return {
		ok: false,
		error: reason,
		raw: planRawPreview(raw),
		planId: null,
		version: null,
		rationale: '',
		moves: [],
		messages: [],
		rejected: [],
		cardsTouched: 0,
		deferredCount: 0,
		wipCap: context.wipCap,
	};
}

/**
 * Reads one plan file into the entries this board is willing to execute.
 *
 * `ok: false` means nothing parsed: no JSON, more than one JSON block,
 * malformed JSON, not an object, an unknown top-level key, the wrong
 * contract version, or a planId that answers a different request. The
 * verbatim text comes back in `raw` for the user to look at, and the result
 * is never an empty plan, because "the conductor proposed nothing" and "this
 * plugin could not read what the conductor proposed" are different states
 * and have to read differently.
 *
 * `ok: true` means a plan parsed, and then every entry stands or falls on
 * its own: `moves` and `messages` hold what this board will execute, and
 * `rejected` holds the rest with a reason each. An entry past the WIP cap is
 * neither executed nor rejected - it rides in `moves`/`messages` with
 * `overCap: true` and its own `capReason`, and is held as pending, because
 * silently dropping work the conductor proposed is how a board loses track
 * of what it was asked to do. The executable subset is therefore the entries
 * with `overCap: false`.
 *
 * A message to a card whose agent is not granted is not a rejection either:
 * it is marked `needsAccess`, and Phase 04's one-time access request is what
 * resolves it at execution time.
 *
 * @param {string} text the plan file's contents
 * @param {string} expectedPlanId the planId this run asked for
 * @param {unknown} board `{ global, globalBoard, projectBoards, wipCap }`
 * @param {Iterable<object>|Map<string, object>} cards cards carrying `key`,
 *   `columnId`, `projectPath`, `sessionId`, `tabId` and `accessGranted`
 * @returns {object}
 */
function parsePlan(text, expectedPlanId, board, cards) {
	const raw = typeof text === 'string' ? text : '';
	const context = planParseContext(board, cards);
	if (typeof expectedPlanId !== 'string' || expectedPlanId === '') {
		return planParseFailure('this board did not ask for a plan', raw, context);
	}
	const extracted = extractPlanJson(raw);
	if (extracted.error) return planParseFailure(extracted.error, raw, context);
	const value = extracted.value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return planParseFailure(
			'a plan has to be a single JSON object, and this is ' + planDescribeValue(value),
			raw,
			context
		);
	}
	const plan = /** @type {Record<string, any>} */ (value);
	const unknownKeys = Object.keys(plan).filter(function (key) {
		return PLAN_KNOWN_TOP_LEVEL_KEYS.indexOf(key) === -1;
	});
	if (unknownKeys.length > 0) {
		return planParseFailure(
			'this plan carries ' +
				planQuoteList(unknownKeys) +
				', which this board does not read; a plan may only carry ' +
				planQuoteList(PLAN_KNOWN_TOP_LEVEL_KEYS),
			raw,
			context
		);
	}
	if (plan.version !== PLAN_CONTRACT_VERSION) {
		return planParseFailure(
			'this board reads plan version ' +
				PLAN_CONTRACT_VERSION +
				', and this plan says ' +
				planDescribeValue(plan.version),
			raw,
			context
		);
	}
	if (typeof plan.planId !== 'string' || plan.planId === '') {
		return planParseFailure(
			'a plan has to carry the planId it was asked for, and this one carries ' +
				planDescribeValue(plan.planId),
			raw,
			context
		);
	}
	if (plan.planId !== expectedPlanId) {
		return planParseFailure(
			'this plan answers ' +
				JSON.stringify(plan.planId) +
				', not the ' +
				JSON.stringify(expectedPlanId) +
				' this board asked for, so it is a plan for a different request',
			raw,
			context
		);
	}
	if (plan.moves !== undefined && !Array.isArray(plan.moves)) {
		return planParseFailure(
			'`moves` has to be an array, and this plan has ' + planDescribeValue(plan.moves),
			raw,
			context
		);
	}
	if (plan.messages !== undefined && !Array.isArray(plan.messages)) {
		return planParseFailure(
			'`messages` has to be an array, and this plan has ' + planDescribeValue(plan.messages),
			raw,
			context
		);
	}

	const moves = [];
	const messages = [];
	const rejected = [];
	// Cap accounting. `touched` is every card an accepted entry has already
	// counted, so a card that is both moved and messaged costs one; `deferred`
	// is the cards that arrived once the cap was full, so a card's SECOND
	// entry is deferred whenever its first one was.
	const touched = new Set();
	const deferred = new Set();
	const overCapReason =
		'held as pending: this board executes ' + context.wipCap + ' cards at a time';
	/** Counts one accepted entry's card against the cap, and reports whether
	 * that entry is over it. @param {string} cardKey */
	function countAgainstCap(cardKey) {
		if (deferred.has(cardKey)) return true;
		if (touched.has(cardKey)) return false;
		if (touched.size >= context.wipCap) {
			touched.add(cardKey);
			deferred.add(cardKey);
			return true;
		}
		touched.add(cardKey);
		return false;
	}
	/** @param {string} kind @param {unknown} cardKey @param {string} reason @param {unknown} entry */
	function reject(kind, cardKey, reason, entry) {
		rejected.push({
			kind: kind,
			cardKey: typeof cardKey === 'string' && cardKey !== '' ? cardKey : null,
			reason: reason,
			entry: planEntryPreview(entry),
		});
	}
	/** The card an entry names, or null with a rejection already recorded.
	 * Shared by both lists so "a message with no card" and "a move with no
	 * card" read the same.
	 * @param {string} kind @param {any} entry @param {string[]} known */
	function resolveEntryCard(kind, entry, known) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			reject(kind, null, 'a ' + kind + ' has to be an object', entry);
			return null;
		}
		const unknown = planUnknownEntryKeys(entry, known);
		if (unknown) {
			reject(
				kind,
				entry.cardKey,
				'this ' +
					kind +
					' carries ' +
					planQuoteList(unknown) +
					', which this board does not read; a ' +
					kind +
					' may only carry ' +
					planQuoteList(known),
				entry
			);
			return null;
		}
		if (typeof entry.cardKey !== 'string' || entry.cardKey === '') {
			reject(
				kind,
				null,
				'this ' + kind + ' names no card (`cardKey` was ' + planDescribeValue(entry.cardKey) + ')',
				entry
			);
			return null;
		}
		const card = context.cardsByKey.get(entry.cardKey);
		if (!card) {
			reject(
				kind,
				entry.cardKey,
				'there is no card ' +
					JSON.stringify(entry.cardKey) +
					' on this board, so there is nothing to act on',
				entry
			);
			return null;
		}
		return card;
	}

	const rawMoves = Array.isArray(plan.moves) ? plan.moves : [];
	for (let i = 0; i < rawMoves.length; i++) {
		const entry = rawMoves[i];
		if (i >= PLAN_ENTRY_CAP) {
			reject(
				'move',
				entry && typeof entry.cardKey === 'string' ? entry.cardKey : null,
				'this plan proposes more than ' +
					PLAN_ENTRY_CAP +
					' moves, which is more than this board reads at once',
				entry
			);
			continue;
		}
		const card = resolveEntryCard('move', entry, PLAN_KNOWN_MOVE_KEYS);
		if (!card) continue;
		if (typeof entry.toColumnId !== 'string' || entry.toColumnId === '') {
			reject(
				'move',
				card.key,
				'this move names no column (`toColumnId` was ' + planDescribeValue(entry.toColumnId) + ')',
				entry
			);
			continue;
		}
		const already = moves.some(function (move) {
			return move.cardKey === card.key;
		});
		if (already) {
			reject('move', card.key, 'this plan already moves that card; one move per card', entry);
			continue;
		}
		if (entry.toColumnId === card.columnId) {
			reject(
				'move',
				card.key,
				'that card is already in `' + entry.toColumnId + '`, so there is nothing to move',
				entry
			);
			continue;
		}
		const legal = planLegalColumnsFor(context, card);
		if (legal.indexOf(entry.toColumnId) === -1) {
			reject(
				'move',
				card.key,
				'that card may not be moved to `' +
					entry.toColumnId +
					'`; it may only go to ' +
					(legal.length > 0 ? planQuoteList(legal) : 'no column at all'),
				entry
			);
			continue;
		}
		const overCap = countAgainstCap(card.key);
		moves.push({
			cardKey: card.key,
			fromColumnId: typeof card.columnId === 'string' ? card.columnId : null,
			toColumnId: entry.toColumnId,
			why: planClip(entry.why, PLAN_WHY_MAX_CHARS),
			overCap: overCap,
			capReason: overCap ? overCapReason : null,
		});
	}

	const rawMessages = Array.isArray(plan.messages) ? plan.messages : [];
	for (let i = 0; i < rawMessages.length; i++) {
		const entry = rawMessages[i];
		if (i >= PLAN_ENTRY_CAP) {
			reject(
				'message',
				entry && typeof entry.cardKey === 'string' ? entry.cardKey : null,
				'this plan proposes more than ' +
					PLAN_ENTRY_CAP +
					' messages, which is more than this board reads at once',
				entry
			);
			continue;
		}
		const card = resolveEntryCard('message', entry, PLAN_KNOWN_MESSAGE_KEYS);
		if (!card) continue;
		const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
		if (prompt === '') {
			reject(
				'message',
				card.key,
				'this message has no prompt to send (`prompt` was ' + planDescribeValue(entry.prompt) + ')',
				entry
			);
			continue;
		}
		if (prompt.length > PLAN_MESSAGE_PROMPT_MAX_CHARS) {
			reject(
				'message',
				card.key,
				'that prompt is ' +
					prompt.length +
					' characters, more than the ' +
					PLAN_MESSAGE_PROMPT_MAX_CHARS +
					' one message may carry',
				entry
			);
			continue;
		}
		const already = messages.some(function (message) {
			return message.cardKey === card.key;
		});
		if (already) {
			reject(
				'message',
				card.key,
				'this plan already messages that card; one message per card',
				entry
			);
			continue;
		}
		if (typeof card.sessionId !== 'string' || typeof card.tabId !== 'string') {
			reject('message', card.key, 'that card has no agent tab left to send to', entry);
			continue;
		}
		const overCap = countAgainstCap(card.key);
		messages.push({
			cardKey: card.key,
			sessionId: card.sessionId,
			tabId: card.tabId,
			prompt: prompt,
			why: planClip(entry.why, PLAN_WHY_MAX_CHARS),
			needsAccess: card.accessGranted !== true,
			overCap: overCap,
			capReason: overCap ? overCapReason : null,
		});
	}

	return {
		ok: true,
		error: null,
		raw: null,
		planId: expectedPlanId,
		version: PLAN_CONTRACT_VERSION,
		// Display only: clipped, never parsed, never executed. A conductor
		// cannot reach the board through prose.
		rationale:
			typeof plan.rationale === 'string' ? planClip(plan.rationale, PLAN_RATIONALE_MAX_CHARS) : '',
		moves: moves,
		messages: messages,
		rejected: rejected,
		cardsTouched: touched.size - deferred.size,
		deferredCount: deferred.size,
		wipCap: context.wipCap,
	};
}

// ---------------------------------------------------------------------------
// The snapshot. The one stateful piece: it reads the live board, its cards,
// their notes, their grants, and - for granted cards only - their History
// excerpt, and hands back both the display-facing snapshot the prompt
// renders from and the context parsePlan() answers legality from.
// ---------------------------------------------------------------------------

/**
 * Builds everything one plan run needs: a fresh planId, the rendered-board
 * snapshot, the parse context, and the plan-facing card list.
 *
 * History is read only for granted cards, at most PLAN_HISTORY_SESSION_LIMIT
 * sessions, most recently active first, through the same cached
 * readSessionHistoryExcerpt() the detail pane uses - so a board whose cards
 * the user has been reading costs no extra reads at all, and an ungranted
 * card contributes nothing.
 * @param {{ planId?: string, now?: number }} [options]
 * @returns {Promise<{ planId: string, snapshot: object, board: object, cards: object[] }>}
 */
async function buildPlanSnapshot(options) {
	const planId =
		options && typeof options.planId === 'string' && PLAN_ID_PATTERN.test(options.planId)
			? options.planId
			: newPlanId();
	const now = (options && finiteTimestamp(options.now)) || Date.now();
	const active = await resolveActiveBoard();
	const boardId = currentBoardId();
	const settings = planSettingsForBoard(boardId);
	const global = active.view.kind === 'global';
	const globalBoard = active.globalResult.board;
	const projectBoards = global
		? await loadProjectBoardsForCards()
		: new Map(active.projectPath !== null ? [[active.projectPath, active.projectResult]] : []);
	const parseBoard = {
		global: global,
		globalBoard: globalBoard,
		projectBoards: projectBoards,
		wipCap: settings.wipCap,
	};
	// Reused for its legality memo only; the card index is filled by the
	// caller's own parsePlan() call later, off the list built below.
	const context = planParseContext(parseBoard, []);

	// Columns and their card lists in the board's own display order, through
	// the same two builders the panel snapshot renders from, so a plan reads
	// the board the user is looking at.
	const columns = [];
	const ordered = [];
	if (global) {
		const built = buildGlobalBoard(globalBoard, projectBoards, active.cards, {
			orderOf: cardOrderOf,
		});
		for (const column of built.columns) {
			columns.push({
				id: column.id,
				title: column.title,
				terminal: column.terminal === true,
				wipLimit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
				readOnly: column.readOnly === true,
				cardCount: column.cards.length,
			});
			for (const card of column.cards) ordered.push(card);
		}
	} else {
		const byColumn = groupCardsByColumn(active.columns, active.cards);
		for (const column of active.columns) {
			const members = byColumn.get(column.id) || [];
			columns.push({
				id: column.id,
				title: column.title,
				terminal: column.terminal === true,
				wipLimit: typeof column.wip_limit === 'number' ? column.wip_limit : undefined,
				readOnly: false,
				mapsTo: typeof column.maps_to === 'string' ? column.maps_to : undefined,
				cardCount: members.length,
			});
			for (const card of members) ordered.push(card);
		}
	}

	// One History read per granted SESSION, not per card: History belongs to
	// the agent, and two tabs of one agent are two cards.
	const historyBySession = new Map();
	const historySessions = [];
	const byRecency = ordered.slice().sort(function (a, b) {
		return (finiteTimestamp(b.lastActivityAt) || 0) - (finiteTimestamp(a.lastActivityAt) || 0);
	});
	for (const card of byRecency) {
		if (historySessions.length >= PLAN_HISTORY_SESSION_LIMIT) break;
		if (!isSessionAccessGranted(card.sessionId)) continue;
		if (historyBySession.has(card.sessionId)) continue;
		historyBySession.set(card.sessionId, []);
		historySessions.push(card.sessionId);
	}
	for (const sessionId of historySessions) {
		const entry = await readSessionHistoryExcerpt(sessionId);
		const rows = entry && Array.isArray(entry.rows) ? entry.rows : [];
		historyBySession.set(sessionId, rows.slice(0, PLAN_PROMPT_HISTORY_LIMIT));
	}

	const planCards = ordered.map(function (card) {
		const note = noteFor(card.key);
		const legal = planLegalColumnsFor(context, card);
		const granted = isSessionAccessGranted(card.sessionId);
		return {
			key: card.key,
			sessionId: card.sessionId,
			tabId: card.tabId,
			title: card.title,
			agentId: card.agentId || null,
			projectPath: card.projectPath || null,
			projectName:
				typeof card.projectPath === 'string' && card.projectPath !== ''
					? projectDisplayName(card.projectPath)
					: null,
			columnId: card.columnId,
			status: card.status,
			lastActivityAt: card.lastActivityAt,
			accessGranted: granted,
			legalColumnIds: legal,
			// What the prompt offers, which is never the current column: a move
			// to the column a card already sits in is a no-op parsePlan()
			// rejects, so inviting one would be inviting a rejection.
			movableTo: legal.filter(function (id) {
				return id !== card.columnId;
			}),
			description: note.description,
			comments: note.comments.slice(-PLAN_PROMPT_COMMENT_LIMIT),
			history: granted ? historyBySession.get(card.sessionId) || [] : [],
		};
	});

	// The same preference buildGlobalBoardColumns()/buildProjectBoardColumns()
	// apply: on the Global board the global file's own failure first and then
	// the first project that would not parse, on a project board that
	// project's failure first. Whichever it is, it is a file a person has to
	// go fix, and the conductor is told so rather than left to plan around
	// columns that are missing for a reason.
	let boardError = global ? active.globalResult.error : active.projectResult.error;
	if (!boardError && global) {
		for (const result of projectBoards.values()) {
			if (result && result.error) {
				boardError = result.error;
				break;
			}
		}
	}
	const snapshot = {
		planId: planId,
		now: now,
		boardId: boardId,
		boardName: currentBoardName(),
		global: global,
		wipCap: settings.wipCap,
		mode: settings.mode,
		halted: settings.halted,
		haltedAt: settings.haltedAt,
		planFile: planFileRelativePath(planId),
		boardError: boardError || active.globalResult.error || null,
		columns: columns,
		cards: planCards,
	};
	return { planId: planId, snapshot: snapshot, board: parseBoard, cards: planCards };
}

/** One plan run's request: the snapshot, the prompt to dispatch, and the two
 * arguments the eventual parsePlan() call needs. The run loop holds `board`
 * and `cards` for the completion it is waiting on, so a plan is validated
 * against the board it was asked about rather than whatever that board has
 * become by the time the conductor answers.
 * @param {{ planId?: string, now?: number }} [options]
 * @returns {Promise<{ planId: string, snapshot: object, prompt: string, board: object, cards: object[] }>} */
async function buildPlanRequest(options) {
	const built = await buildPlanSnapshot(options);
	return {
		planId: built.planId,
		snapshot: built.snapshot,
		prompt: renderPlanPrompt(built.snapshot),
		board: built.board,
		cards: built.cards,
	};
}

// ===========================================================================
// End of Phase 07 plan contract.
// ===========================================================================

// ===========================================================================
// Phase 07 plan run loop: turns a dispatched prompt into a parsed plan with
// no polling anywhere in the path. askConductor() is the only place this
// plugin ever calls maestro.agents.dispatch on a conductor's session; from
// there the run is driven entirely by the agent.completed/run.completed
// events every card's History excerpt already answers to (see "Phase 04
// History excerpt" above) - never by reading session or tab status, which
// can report idle mid-turn (a tool call between model turns, say) well
// before the conductor has actually finished and written its plan.
//
// One run per board at a time, held in `planRuns`: askConductor() refuses a
// fresh ask while the board's last one is still 'running', so a board never
// has two plans racing to read the same scratch folder. The run itself
// carries the exact `board`/`cards` context buildPlanRequest() built it
// from, so parsePlan() answers legality from the board the conductor was
// actually asked about, not whatever that board has become by the time it
// replies.
//
// A run ends in exactly one of three states, and every one of them is a
// specific, named failure rather than an empty plan: 'parsed' (parsePlan()
// returned `ok: true`, including a plan with nothing but rejected entries -
// a plan is still a plan if it says nothing is possible), 'failed' (a
// dispatch error, a plan file this plugin could not read or could not parse,
// or a timeout), or 'not-connected' (the dispatch itself was denied because
// the conductor's grant was revoked in Settings - the same recovery
// dispatchCardMessage() already applies to a card's own send, so the next
// snapshot's conductorSettingsSnapshot() reads `conductorConnected: false`
// and the settings surface offers Allow Access instead of a generic error).
// ===========================================================================

/** Generous on purpose: a conductor's turn can read every granted card's
 * History and reason over a whole board before it ever writes a plan file,
 * and a timeout's only job is to stop this plugin waiting forever, not to
 * race a model that is still thinking. */
const PLAN_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** @typedef {{
 *   planId: string,
 *   conductorSessionId: string,
 *   status: 'running'|'parsed'|'failed'|'not-connected',
 *   board: object,
 *   cards: object[],
 *   startedAt: number,
 *   finishedAt: number|null,
 *   result: object|null,
 *   timeoutTimer: ReturnType<typeof setTimeout>|null,
 *   decisions: Map<string, boolean>,
 *   decidedAt: number|null,
 *   execution: Map<string, { status: 'moved'|'sent'|'pending-cap'|'declined-access'|'failed', reason: string|null }>,
 *   executedAt: number|null,
 * }} PlanRun */

/** @type {Map<string, PlanRun>} boardId -> that board's most recent (or
 * still in-flight) plan run. Cleared on deactivate() like every other
 * in-memory cache; a run in flight at shutdown is simply gone, the same as a
 * card's own in-flight send (lastMessageOutcomes) never surviving a restart. */
let planRuns = new Map();

/** Cancels a run's timeout, if it still has one. Safe to call on a run that
 * never got one (a dispatch denial, say) or whose timer already fired. */
function clearPlanRunTimer(run) {
	if (run.timeoutTimer) {
		clearTimeout(run.timeoutTimer);
		run.timeoutTimer = null;
	}
}

/** Builds the `ok: false` shape parsePlan() itself returns for an unreadable
 * plan, reusing its own planParseFailure() so a run that never got as far as
 * a parse (a missing file, a dispatch failure, a timeout) still comes back
 * in the exact shape a parsed-but-rejected plan would, for whatever renders
 * `result` next. There is no raw text to show back in any of these cases, so
 * `raw` is the empty string rather than a guess at what the conductor wrote.
 * @param {PlanRun} run @param {string} reason */
function planRunFailure(run, reason) {
	return planParseFailure(reason, '', planParseContext(run.board, run.cards));
}

/** One sentence describing how a run ended, for the activity feed: how many
 * moves and messages a parsed plan accepted and rejected, or the reason a
 * run never got that far (a dispatch failure, an unreadable or unparseable
 * plan file, a timeout, or a revoked grant).
 * @param {PlanRun} run */
function planResultSummary(run) {
	const result = run.result;
	if (!result || result.ok !== true) {
		const reason = (result && result.error) || 'unknown reason';
		return 'plan ' + run.planId + ' did not run: ' + reason;
	}
	const rejectedCount = Array.isArray(result.rejected) ? result.rejected.length : 0;
	return (
		'plan ' +
		run.planId +
		' parsed: ' +
		result.moves.length +
		' move(s) and ' +
		result.messages.length +
		' message(s) accepted, ' +
		rejectedCount +
		' rejected'
	);
}

/** Settles a run: cancels its timeout, records the result and status, stamps
 * `finishedAt`, and logs the outcome to the board's activity feed (Phase 07
 * board activity feed) - the single place a run is ever closed out is the
 * single place its result is ever recorded, so "plan requests" (askConductor,
 * below) and "parsed plans with their accepted and rejected entries" can
 * never drift out of step with the run map itself. `statusOverride` names the
 * two failure states that are not simply "parsePlan said no" - 'not-connected'
 * and (from onPlanRunTimeout) 'timeout' folds into 'failed', since a run that
 * timed out and a run whose plan file never parsed are the same thing to
 * everything downstream: a failure with a reason, not a plan to approve.
 * @param {string} boardId @param {PlanRun} run @param {object} result
 * @param {'not-connected'=} statusOverride */
async function finishPlanRun(boardId, run, result, statusOverride) {
	clearPlanRunTimer(run);
	run.result = result;
	run.status = statusOverride || (result.ok ? 'parsed' : 'failed');
	run.finishedAt = Date.now();
	await recordActivity(boardId, ACTIVITY_TYPE_PLAN_RESULT, null, planResultSummary(run));
}

/**
 * Reads the plan file this run's planId names and hands it to parsePlan().
 * Guards against a run that was already settled by onPlanRunTimeout() while
 * this read was in flight - whichever of the two gets there first wins, and
 * the other becomes a no-op, so a late completion event can never overwrite
 * a run the timeout already closed out.
 * @param {string} boardId @param {PlanRun} run
 */
async function settlePlanRun(boardId, run) {
	let text;
	try {
		text = await sdk.fs.read(planFilePath(boardId, run.planId));
	} catch (err) {
		// The plan file could not be read: ENOENT means the conductor never wrote one.
		if (run.status !== 'running') return;
		const reason = isFileNotFoundError(err)
			? 'the conductor finished without writing this plan'
			: "could not read the conductor's plan: " + errorMessage(err);
		await finishPlanRun(boardId, run, planRunFailure(run, reason));
		await pushSnapshotNow();
		return;
	}
	if (run.status !== 'running') return;
	await finishPlanRun(boardId, run, parsePlan(text, run.planId, run.board, run.cards));
	// Fully auto's own trigger: a plan that just parsed ok on a board whose
	// mode is PLAN_MODE_AUTO executes itself, with no person in between. See
	// autoExecuteIfNeeded()'s own doc comment (Phase 07 plan execution,
	// below) for what it does and does not decide on its own.
	await autoExecuteIfNeeded(boardId, run);
	await pushSnapshotNow();
}

/** The agent.completed/run.completed handler: finds every board whose
 * in-flight run belongs to the session this event is about (there is at most
 * one, since a session is one board's conductor) and settles it. A session
 * with no running plan - every card's agent, or a conductor between runs -
 * matches nothing here and this is a no-op, same as onHistoryRelevantEvent's
 * own cache check for a session nothing is reading History for.
 * @param {string} topic @param {unknown} payload */
function onPlanRunEvent(topic, payload) {
	const sessionId = sessionIdForEvent(topic, payload);
	if (!sessionId) return;
	for (const [boardId, run] of planRuns) {
		if (run.status !== 'running' || run.conductorSessionId !== sessionId) continue;
		settlePlanRun(boardId, run).catch(function (err) {
			// Settling a plan run must not throw out of the event handler that noticed the turn ended.
			console.error(
				'maestro-kanban: settling the plan run for ' + boardId + ' failed: ' + String(err)
			);
		});
	}
}

/** Fires PLAN_RUN_TIMEOUT_MS after a successful dispatch. Guarded the same
 * way settlePlanRun() is guarded against it: whichever of the two settles the
 * run first wins. @param {string} boardId @param {PlanRun} run */
async function onPlanRunTimeout(boardId, run) {
	if (run.status !== 'running') return;
	await finishPlanRun(
		boardId,
		run,
		planRunFailure(run, 'the conductor did not finish this plan within the time this board allows')
	);
	await pushSnapshotNow();
}

/**
 * Backs the panel's `ask-conductor` action: `{ boardId }`. Refuses the same
 * way createConductor() does - no board on screen, a stale board id, a
 * halted board - plus two refusals of its own: a run already in flight for
 * this board, and no conductor to ask at all. Otherwise builds a fresh plan
 * request, records the run as 'running' *before* dispatching (so an event
 * that arrives while the dispatch promise is still resolving is never missed
 * - see sessions.create()'s own grant-mirrors-first ordering for the same
 * reason), and dispatches. A dispatch denied for a revoked grant settles the
 * run as 'not-connected' rather than a generic failure and leaves the actual
 * "Allow Access" affordance to conductorSettingsSnapshot(), which already
 * reads that denial through grantedSessions.
 * @param {unknown} args
 */
async function askConductor(args) {
	const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
	const boardId =
		typeof source.boardId === 'string' && source.boardId !== '' ? source.boardId : null;
	if (boardId === null) {
		const reason = 'there is no board on screen to ask the conductor for a plan yet';
		console.warn('maestro-kanban: refused ask-conductor: ' + reason);
		await safeToast('Could not ask the conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	if (boardId !== currentBoardId()) {
		const reason = 'the board changed before the conductor could be asked; try again';
		console.warn('maestro-kanban: refused ask-conductor: ' + reason);
		await safeToast('Could not ask the conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	if (isBoardHalted(boardId)) {
		const reason = 'this board is halted; clear the halt before asking the conductor for a plan';
		console.warn('maestro-kanban: refused ask-conductor: ' + reason);
		await safeToast('Could not ask the conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	const inFlight = planRuns.get(boardId);
	if (inFlight && inFlight.status === 'running') {
		const reason = 'this board already has a plan in flight; wait for it to finish';
		console.warn('maestro-kanban: refused ask-conductor: ' + reason);
		await safeToast('Could not ask the conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	const conductorId = await resolveConductorSessionId(boardId);
	if (conductorId === null) {
		const reason = 'this board has no conductor to ask yet';
		console.warn('maestro-kanban: refused ask-conductor: ' + reason);
		await safeToast('Could not ask the conductor: ' + reason);
		return { ok: false, reason: reason };
	}
	const request = await buildPlanRequest();
	/** @type {PlanRun} */
	const run = {
		planId: request.planId,
		conductorSessionId: conductorId,
		status: 'running',
		board: request.board,
		cards: request.cards,
		startedAt: Date.now(),
		finishedAt: null,
		result: null,
		timeoutTimer: null,
		// Fresh for every ask: a new plan is a new review, even on the same
		// board, so nothing from the last one rides along.
		decisions: new Map(),
		decidedAt: null,
		execution: new Map(),
		executedAt: null,
	};
	planRuns.set(boardId, run);
	// Logged before the dispatch is even attempted, so "a plan was requested"
	// is on the record regardless of how the run ends - the result (parsed,
	// failed, or not-connected) is finishPlanRun()'s own entry, right after.
	await recordActivity(
		boardId,
		ACTIVITY_TYPE_PLAN_REQUESTED,
		null,
		'asked the conductor for a plan (' + run.planId + ')'
	);
	try {
		await sdk.agents.dispatch(conductorId, request.prompt);
	} catch (err) {
		// agents.dispatch refused: a revoked grant drops the conductor; the run settles as
		// not-connected.
		const message = errorMessage(err);
		if (isGrantDenial(message)) {
			grantedSessions.delete(conductorId);
			scheduleReachSync();
			await finishPlanRun(
				boardId,
				run,
				planRunFailure(run, 'the conductor is no longer connected to this board'),
				'not-connected'
			);
		} else {
			console.error('maestro-kanban: agents.dispatch (conductor) failed: ' + String(err));
			await finishPlanRun(
				boardId,
				run,
				planRunFailure(run, 'could not reach the conductor: ' + message)
			);
		}
		await pushSnapshotNow();
		return { ok: false, reason: run.result.error };
	}
	run.timeoutTimer = setTimeout(function () {
		onPlanRunTimeout(boardId, run).catch(function (err) {
			// Timeout handling must not throw out of the timer that fired it.
			console.error('maestro-kanban: plan run timeout handling failed: ' + String(err));
		});
	}, PLAN_RUN_TIMEOUT_MS);
	await pushSnapshotNow();
	return { ok: true, planId: run.planId };
}

/** The board's current (or most recently finished) plan run, in the shape a
 * caller can hand to a panel without also handing it this run's internal
 * `board`/`cards` legality context. null before any ask-conductor for this
 * board since activate(). @param {string|null} boardId @returns {object|null} */
function planRunSnapshot(boardId) {
	if (typeof boardId !== 'string' || boardId === '') return null;
	const run = planRuns.get(boardId);
	if (!run) return null;
	return {
		planId: run.planId,
		conductorSessionId: run.conductorSessionId,
		status: run.status,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		result: run.result,
		// `{ "move:cardKey": true }`-shaped, never a Map: the panel is the host's
		// own JSON bridge, which cannot carry one. Empty until the approval UI's
		// Approve Selected or Reject All actually decides the plan.
		decisions: run.decisions.size > 0 ? Object.fromEntries(run.decisions) : {},
		decidedAt: run.decidedAt,
		// Same shape as `decisions`: `{ "move:cardKey": { status, reason } }`.
		// Empty until executePlanRun() has attempted at least one row - see
		// "Phase 07 plan execution" below.
		execution: run.execution.size > 0 ? Object.fromEntries(run.execution) : {},
		executedAt: run.executedAt,
	};
}

// ===========================================================================
// End of Phase 07 plan run loop.
// ===========================================================================

// ===========================================================================
// Phase 07 plan approval: lets the panel render a parsed plan as a diff the
// user checks row by row, then records their decision - never executes
// anything itself, since execution (the move/dispatch guardrails, the WIP
// cap, the halt check) is the next task's job, reading the same `decisions`
// map this leaves on the run. A row is identified by `kind + ':' + cardKey`
// (planRowKey) - a card gets at most one move and one message per plan, so
// that pair is unique - and the panel builds the identical string itself
// rather than importing anything from here, the same way it already
// duplicates every other command-id string in this file.
//
// "Approve Selected" and "Reject All" both resolve EVERY row of the plan,
// not only the ones a button's name suggests: a row left unchecked when
// Approve Selected is clicked is a row the user saw and declined, and the
// activity feed this phase adds next has to be able to show that a row was
// declined, not merely that it went unmentioned. There is no partial
// "still pending" state once a decision is recorded.
// ===========================================================================

/** Shared identifier for one row of a plan: a move or a message, named by
 * the card it is about. @param {'move'|'message'} kind @param {string} cardKey */
function planRowKey(kind, cardKey) {
	return kind + ':' + cardKey;
}

/** Every row of a parsed plan that is a candidate for approval - every move
 * and every message `parsePlan()` accepted, including one riding past the
 * WIP cap (`overCap: true`): the cap governs execution, not review, so a
 * person can still approve or decline a deferred row. Entries `parsePlan()`
 * itself rejected are never rows here; they have no action to approve.
 * @param {PlanRun} run @returns {{kind: 'move'|'message', cardKey: string}[]} */
function planRunEntries(run) {
	const moves = run.result.moves.map((move) => ({ kind: 'move', cardKey: move.cardKey }));
	const messages = run.result.messages.map((message) => ({
		kind: 'message',
		cardKey: message.cardKey,
	}));
	return moves.concat(messages);
}

/** Refuses the way every other board-scoped command here refuses: a stale
 * board, a plan that is no longer this board's current run, a run still in
 * flight, or one that never parsed into something with rows to decide.
 * Shared by 'approve-plan', 'reject-plan' and 'edit-plan-message' so the
 * three commands refuse identically rather than drifting apart.
 * @param {string} boardId @param {string} planId
 * @returns {{run: PlanRun}|{reason: string}} */
function planRunForAction(boardId, planId) {
	if (typeof boardId !== 'string' || boardId === '' || boardId !== currentBoardId()) {
		return { reason: 'the board changed before this plan could be acted on; try again' };
	}
	const run = planRuns.get(boardId);
	if (!run || run.planId !== planId) {
		return { reason: "that plan is no longer this board's current plan" };
	}
	if (run.status === 'running') {
		return { reason: 'this plan is still being written; wait for it to finish' };
	}
	if (!run.result || run.result.ok !== true) {
		return { reason: 'this plan did not parse, so there is nothing to approve' };
	}
	if (run.executedAt !== null) {
		return { reason: 'this plan has already been executed' };
	}
	return { run: run };
}

/** Records the user's row-by-row decision on a parsed plan: every row
 * (planRunEntries) is marked approved when its key is in `approvedKeys`,
 * declined otherwise - see the section banner above for why there is no
 * third "still pending" outcome. Replaces whatever decision the run already
 * carried, so re-deciding the same plan (unchecking a row and clicking
 * Approve Selected again) always reflects the latest click, never a stale
 * mix of two decisions.
 * @param {PlanRun} run @param {Set<string>} approvedKeys */
function recordPlanDecisions(run, approvedKeys) {
	const decisions = new Map();
	for (const entry of planRunEntries(run)) {
		const key = planRowKey(entry.kind, entry.cardKey);
		decisions.set(key, approvedKeys.has(key));
	}
	run.decisions = decisions;
	run.decidedAt = Date.now();
}

/** Appends one activity-feed entry per row THIS decision pass just decided -
 * called right after recordPlanDecisions() (every row gets a decision) or
 * autoDecidePlanRun() (a needsAccess row under fully auto is deliberately
 * left undecided, and is skipped here the same way). A row is logged by the
 * card it is about, so "approvals and rejections" stay filterable by card
 * the same way every other per-card entry in this feed is.
 * @param {string} boardId @param {PlanRun} run */
async function recordDecisionActivity(boardId, run) {
	for (const entry of planRunEntries(run)) {
		const key = planRowKey(entry.kind, entry.cardKey);
		const approved = run.decisions.get(key);
		if (approved === undefined) continue;
		await recordActivity(
			boardId,
			ACTIVITY_TYPE_ROW_DECIDED,
			entry.cardKey,
			entry.kind + ' for card ' + entry.cardKey + ' ' + (approved ? 'approved' : 'declined')
		);
	}
}

/** Mutates one message's prompt in place on a parsed plan, before it is
 * approved - the Edit action the approval UI offers a message row. Validated
 * the same way parsePlan() itself validates a prompt (trimmed, non-empty,
 * under PLAN_MESSAGE_PROMPT_MAX_CHARS), since an edited prompt is still a
 * prompt this plugin is about to dispatch. Clears any decision already
 * recorded for this run: an edited prompt is a materially different plan
 * than the one last approved or declined, so every row goes back to
 * "reviewed? not yet" rather than carrying a decision made about different
 * text.
 * @param {PlanRun} run @param {string} cardKey @param {string} prompt
 * @returns {{ok: true}|{ok: false, reason: string}} */
function editPlanMessage(run, cardKey, prompt) {
	const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
	if (trimmed === '') return { ok: false, reason: 'a message needs a prompt to send' };
	if (trimmed.length > PLAN_MESSAGE_PROMPT_MAX_CHARS) {
		return {
			ok: false,
			reason:
				'that prompt is ' +
				trimmed.length +
				' characters, more than the ' +
				PLAN_MESSAGE_PROMPT_MAX_CHARS +
				' one message may carry',
		};
	}
	const message = run.result.messages.find(function (candidate) {
		return candidate.cardKey === cardKey;
	});
	if (!message) return { ok: false, reason: 'that card has no proposed message in this plan' };
	message.prompt = trimmed;
	message.edited = true;
	run.decisions = new Map();
	run.decidedAt = null;
	return { ok: true };
}

// ===========================================================================
// End of Phase 07 plan approval.
// ===========================================================================

// ===========================================================================
// Phase 07 plan execution: turns an approved row into the same side effect a
// person causes by hand - handleMove()'s own placement path for a move,
// dispatchCardMessage()'s own agents:dispatch path for a message - so the
// legality re-check, the per-tab targeting, and the access/rate handling are
// exactly what a drag or a hand-typed message already goes through. Nothing
// here is a second path to either effect.
//
// Every row executePlanRun() looks at is read in this order:
//
//   1. isBoardHalted() - checked before the loop starts, and again right
//      before this row's own side effect, so a halt flipped mid-execution
//      (a second command arriving while this one is still awaiting a
//      dispatch) stops everything from that point on, immediately. A row
//      not yet reached when the halt lands is left exactly as it was:
//      approved, but not executed - there is no partial or half-applied
//      move.
//   2. overCap - parsePlan() already decided this at ask-time, against the
//      board's wipCap *then*. Execution honors that decision rather than
//      re-deriving a live count, so a plan the user is looking at never
//      executes a different set of rows than the diff they approved.
//   3. needsAccess (messages only) - sessions.requestAccess() once, the
//      same one-time confirmation the detail pane's own composer uses. A
//      decline is recorded as declined-for-access and nothing is sent;
//      this plugin never assumes a grant the host has not confirmed.
//
// Idempotency is per plan id, not per call. `run.execution` records every
// row this function has already attempted, keyed the same way `decisions`
// is (planRowKey()); a row already in that map is never attempted twice, no
// matter how many times executePlanRun() is called for this run. The whole
// run is marked `executedAt` only once every approved, in-cap row has been
// attempted with nothing left to do - a halt that cuts the loop short
// leaves `executedAt` null so the gap is visible, but even so, a repeat
// call picks up only the rows it has not already touched. There is no path
// in this file that dispatches a message or moves a card twice for the same
// plan id.
// ===========================================================================

/** Executes every row of a parsed, decided plan that was approved and is
 * not riding past the WIP cap. A no-op when this run has already finished
 * executing (`executedAt` set) or when the board is halted before a single
 * row has been attempted - neither case touches `run.execution`.
 * @param {string} boardId @param {PlanRun} run
 * @returns {Promise<void>}
 */
async function executePlanRun(boardId, run) {
	if (run.executedAt !== null) return;
	if (isBoardHalted(boardId)) return;
	let haltedMidway = false;
	for (const entry of planRunEntries(run)) {
		const key = planRowKey(entry.kind, entry.cardKey);
		if (run.execution.has(key)) continue;
		if (run.decisions.get(key) !== true) continue;
		const data =
			entry.kind === 'move'
				? run.result.moves.find((move) => move.cardKey === entry.cardKey)
				: run.result.messages.find((message) => message.cardKey === entry.cardKey);
		if (!data) continue;
		if (data.overCap) {
			run.execution.set(key, { status: 'pending-cap', reason: data.capReason });
			await recordActivity(
				boardId,
				ACTIVITY_TYPE_ROW_EXECUTED,
				entry.cardKey,
				entry.kind + ' for card ' + entry.cardKey + ' is pending: ' + data.capReason
			);
			continue;
		}
		if (isBoardHalted(boardId)) {
			haltedMidway = true;
			break;
		}
		if (entry.kind === 'move') {
			let result;
			try {
				result = await handleMove({
					cardKey: entry.cardKey,
					toColumnId: data.toColumnId,
					boardId: boardId,
				});
			} catch (err) {
				// handleMove() refused this step (WIP cap, illegal drop, stale board): recorded per step.
				result = { ok: false, reason: errorMessage(err) };
			}
			const moved = result && result.ok === true;
			run.execution.set(
				key,
				moved
					? { status: 'moved', reason: null }
					: { status: 'failed', reason: (result && result.reason) || 'that move failed' }
			);
			await recordActivity(
				boardId,
				ACTIVITY_TYPE_ROW_EXECUTED,
				entry.cardKey,
				'move for card ' +
					entry.cardKey +
					' to ' +
					data.toColumnId +
					': ' +
					(moved ? 'moved' : 'failed (' + run.execution.get(key).reason + ')')
			);
			continue;
		}
		// entry.kind === 'message': the same access dance 'send-message'
		// itself does, except a decline here is recorded on the row rather
		// than left for the composer to render.
		if (!isSessionAccessGranted(data.sessionId)) {
			let accessResult;
			try {
				accessResult = await sdk.sessions.requestAccess(data.sessionId);
			} catch (err) {
				// sessions.requestAccess refused: this step records "not connected" rather than
				// silently skipping.
				console.error(
					'maestro-kanban: sessions.requestAccess (plan execution) failed: ' + String(err)
				);
				run.execution.set(key, {
					status: 'failed',
					reason: 'could not request access to that agent',
				});
				await recordActivity(
					boardId,
					ACTIVITY_TYPE_ACCESS_REQUESTED,
					entry.cardKey,
					'access request for card ' + entry.cardKey + ' failed: could not reach Maestro'
				);
				continue;
			}
			const granted = !!(accessResult && accessResult.granted === true);
			await recordActivity(
				boardId,
				ACTIVITY_TYPE_ACCESS_REQUESTED,
				entry.cardKey,
				'access requested for card ' + entry.cardKey + ': ' + (granted ? 'granted' : 'declined')
			);
			if (!granted) {
				run.execution.set(key, { status: 'declined-access', reason: 'access not granted' });
				continue;
			}
			grantedSessions.add(data.sessionId);
			scheduleReachSync();
		}
		const sendResult = await dispatchCardMessage(data.sessionId, data.tabId, data.prompt);
		run.execution.set(
			key,
			sendResult.ok
				? { status: 'sent', reason: null }
				: { status: 'failed', reason: sendResult.error }
		);
		await recordActivity(
			boardId,
			ACTIVITY_TYPE_ROW_EXECUTED,
			entry.cardKey,
			'message for card ' +
				entry.cardKey +
				': ' +
				(sendResult.ok ? 'sent' : 'failed (' + sendResult.error + ')')
		);
	}
	// Only once the loop ran to its natural end AND every row has an actual
	// decision on file: a halt that broke out of it early leaves executedAt
	// null, so the next executePlanRun() call (once the halt is cleared)
	// still has something to finish - and so does a fully-auto plan with a
	// needsAccess row nobody has decided yet, which autoDecidePlanRun() below
	// deliberately leaves out of `run.decisions` rather than declining it. A
	// row recorded as declined still counts as decided: the person (or, for
	// the rest of a fully-auto plan, this plugin) looked at it and chose
	// nothing, which is different from never having looked at all.
	const stillPending = planRunEntries(run).some(
		(entry) => !run.decisions.has(planRowKey(entry.kind, entry.cardKey))
	);
	if (!haltedMidway && !stillPending) run.executedAt = Date.now();
}

/** Fully auto's own decision pass, run once per parsed plan in place of a
 * person's Approve Selected click: every row is approved EXCEPT a message
 * whose `needsAccess` is set, which is left out of `decisions` entirely -
 * not approved, not declined, genuinely undecided - so it stays "needs your
 * OK" until a person reviews that one row by hand through the exact same
 * approve-plan/reject-plan action the plan-and-approve surface already
 * exposes (see executePlanRun()'s `stillPending` check just above for why
 * that leftover row does not block a later approval).
 *
 * A move or a non-access message riding past the WIP cap is still approved
 * here: the cap governs execution (it lands `pending-cap`), not review, the
 * same way a person reviewing a fresh plan starts with every row checked.
 * @param {PlanRun} run
 */
function autoDecidePlanRun(run) {
	const decisions = new Map();
	for (const entry of planRunEntries(run)) {
		if (entry.kind === 'message') {
			const message = run.result.messages.find((candidate) => candidate.cardKey === entry.cardKey);
			if (message && message.needsAccess) continue;
		}
		decisions.set(planRowKey(entry.kind, entry.cardKey), true);
	}
	run.decisions = decisions;
	run.decidedAt = Date.now();
}

/**
 * Backs the auto-mode switch: the instant a plan parses ok on a board whose
 * `plan-settings` mode is PLAN_MODE_AUTO, decide what this plugin is allowed
 * to decide on its own (autoDecidePlanRun()) and execute immediately -
 * nothing here is a second pipeline, it is the identical
 * decide-then-executePlanRun() pair 'approve-plan' already drives, with only
 * the person removed from the middle. A no-op for a board still in
 * plan-and-approve mode, or a run that did not parse (nothing to decide), so
 * calling this unconditionally from settlePlanRun() is always safe.
 * @param {string} boardId @param {PlanRun} run
 */
async function autoExecuteIfNeeded(boardId, run) {
	if (run.status !== 'parsed' || !run.result || run.result.ok !== true) return;
	if (planSettingsForBoard(boardId).mode !== PLAN_MODE_AUTO) return;
	autoDecidePlanRun(run);
	await recordDecisionActivity(boardId, run);
	await executePlanRun(boardId, run);
}

// ===========================================================================
// End of Phase 07 plan execution.
// ===========================================================================

// ===========================================================================
// Phase 07 board activity feed: the one append-only ledger every other part
// of this plugin writes a line to. A board is a statement about what IS
// (its cards, its settings); this is the statement about what HAPPENED -
// every plan request and result, every row a person (or, in fully auto, this
// plugin) approved or declined, every access request and its outcome, every
// move and message actually executed, every conductor reach change (Phase
// 06), every retirement (Phase 05), and every halt or mode flip. Nothing
// here is executable: an activity entry is read-only history, the same way
// `rationale` on a plan is display only.
//
// It is deliberately ONE log per board rather than one per entry type - a
// person reading "what happened on this board" wants the order events
// actually happened in, not five separate timelines they would have to
// interleave by hand. Every writer calls the same recordActivity(), which is
// also the only thing that persists this log, so there is exactly one place
// that caps and prunes it.
//
// Like plan settings, this is per-board and never inherited from or merged
// into the Global board's own feed: an event is recorded under the board id
// its own section already scopes it to (a plan run's `boardId`, a
// retirement's `card.projectPath`), the same id planSettingsForBoard() and
// planRunSnapshot() already key their own state by. Viewing the Global
// board's activity feed shows the Global board's OWN events only (its own
// plan runs, if it has a conductor of its own), not every project's -
// exactly the same scope planRunSnapshot() already keeps.
// ===========================================================================

const ACTIVITY_LOG_STORAGE_KEY = 'activity-log';

/** At most this many entries are kept per board, oldest first pruned, so the
 * log cannot grow without bound. Generous relative to a typical plan (the
 * default WIP cap is 3) - it takes a sustained run of large plans to push
 * the oldest entries out, and when that happens it is always the oldest
 * history that goes, never the newest. */
const ACTIVITY_LOG_LIMIT_PER_BOARD = 200;

/** How many entries ride in one snapshot, newest first. The filter runs over
 * the whole per-board log (see buildActivityView), so this caps the PAYLOAD,
 * not the search - the same split buildArchiveView() already uses. */
const ACTIVITY_VIEW_LIMIT = 100;

/** How long a typed filter may be, and how long the field posts back. Plain
 * substring search, case-insensitive, same spirit as the archive's filter. */
const ACTIVITY_FILTER_MAX_CHARS = 160;

const ACTIVITY_TYPE_PLAN_REQUESTED = 'plan-requested';
const ACTIVITY_TYPE_PLAN_RESULT = 'plan-result';
const ACTIVITY_TYPE_ROW_DECIDED = 'row-decided';
const ACTIVITY_TYPE_ACCESS_REQUESTED = 'access-requested';
const ACTIVITY_TYPE_ROW_EXECUTED = 'row-executed';
const ACTIVITY_TYPE_REACH_CHANGED = 'reach-changed';
const ACTIVITY_TYPE_RETIRED = 'retired';
const ACTIVITY_TYPE_HALT_CHANGED = 'halt-changed';
const ACTIVITY_TYPE_MODE_CHANGED = 'mode-changed';

/** @typedef {{ at: number, type: string, cardKey: string|null, summary: string }} ActivityLogEntry */

/** @type {Map<string, ActivityLogEntry[]>} board id -> that board's activity
 * log, oldest first, capped at ACTIVITY_LOG_LIMIT_PER_BOARD. */
let activityLogs = new Map();

/** Restores every board's activity log from storage. Called once, alongside
 * loadConductorIds(), before activate()'s first seed(). A storage failure
 * degrades to "every board has an empty log" rather than throwing the
 * activation - losing yesterday's history is a smaller failure than refusing
 * to open at all. */
async function loadActivityLog() {
	activityLogs = new Map();
	try {
		const raw = await sdk.storage.get(ACTIVITY_LOG_STORAGE_KEY);
		if (typeof raw === 'string' && raw !== '') {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				for (const key of Object.keys(parsed)) {
					const entries = Array.isArray(parsed[key]) ? parsed[key] : [];
					activityLogs.set(
						key,
						entries.filter(function (entry) {
							return (
								entry &&
								typeof entry === 'object' &&
								typeof entry.at === 'number' &&
								typeof entry.type === 'string' &&
								typeof entry.summary === 'string'
							);
						})
					);
				}
			}
		}
	} catch (err) {
		// storage.get refused: the feed starts empty this session rather than partial.
		console.error('maestro-kanban: failed to read the stored activity log: ' + String(err));
	}
}

/** Writes every board's activity log in one call. A failed write logs and
 * moves on: the in-memory log stays authoritative for this session, the same
 * best-effort persistence persistReachLogs() used to keep before this
 * section absorbed it. */
async function persistActivityLog() {
	const obj = {};
	for (const [boardId, entries] of activityLogs) {
		obj[boardId] = entries;
	}
	try {
		await sdk.storage.set(ACTIVITY_LOG_STORAGE_KEY, JSON.stringify(obj));
	} catch (err) {
		// storage.set refused: the feed holds on screen but is not remembered across a restart.
		console.error('maestro-kanban: failed to persist the activity log: ' + String(err));
	}
}

/** One board's activity log, oldest first - a copy, so a caller cannot
 * mutate this plugin's own record by mutating the returned array.
 * @param {string|null} boardId
 * @returns {ActivityLogEntry[]} */
function activityLogForBoard(boardId) {
	if (typeof boardId !== 'string' || boardId === '') return [];
	return (activityLogs.get(boardId) || []).slice();
}

/** Appends one entry to a board's activity log and persists it, pruning the
 * oldest entry first once the board is over ACTIVITY_LOG_LIMIT_PER_BOARD.
 * The one place every other section of this file calls into: plan requests
 * and results, row decisions, access requests, executed moves and messages,
 * reach changes, retirements, and halt/mode flips.
 * @param {string|null} boardId
 * @param {string} type one of the ACTIVITY_TYPE_* constants above
 * @param {string|null} cardKey the card this entry is about, or null for a
 *   board-wide event (a halt, a mode change, a reach change)
 * @param {string} summary a sentence a person reads, not a code
 */
async function recordActivity(boardId, type, cardKey, summary) {
	if (typeof boardId !== 'string' || boardId === '') return;
	const entries = (activityLogs.get(boardId) || []).slice();
	entries.push({
		at: Date.now(),
		type: type,
		cardKey: typeof cardKey === 'string' && cardKey !== '' ? cardKey : null,
		summary: String(summary),
	});
	while (entries.length > ACTIVITY_LOG_LIMIT_PER_BOARD) entries.shift();
	activityLogs.set(boardId, entries);
	await persistActivityLog();
}

/** Pure: does this entry match the activity view's filter? Case-insensitive
 * substring over the card key and the summary text - the two things a person
 * remembers about something that happened ("what did card X do" or "when
 * did we halt").
 * @param {ActivityLogEntry} entry @param {string} needle lowercased already */
function activityEntryMatches(entry, needle) {
	if (needle === '') return true;
	if (typeof entry.cardKey === 'string' && entry.cardKey.toLowerCase().indexOf(needle) !== -1) {
		return true;
	}
	return entry.summary.toLowerCase().indexOf(needle) !== -1;
}

/** Whether the panel is showing the activity feed instead of the board. The
 * same "rides in the snapshot only while open" shape buildArchiveView()
 * uses: a board nobody is browsing the feed of costs nothing extra on a
 * repaint. */
let activityViewOpen = false;

/** The text the activity view is filtered by, as the panel last posted it. */
let activityViewFilter = '';

/**
 * The activity payload for the next snapshot, or null when the view is
 * closed. Filters the current board's own log (never merged across boards -
 * see this section's header), sorts newest first, and sends the newest
 * ACTIVITY_VIEW_LIMIT matches.
 * @returns {{ open: true, filter: string, boardName: string, entries: ActivityLogEntry[], total: number, hidden: number }|null}
 */
function buildActivityView() {
	if (!activityViewOpen) return null;
	const needle = activityViewFilter.trim().toLowerCase();
	const entries = activityLogForBoard(currentBoardId());
	const matched = entries.filter(function (entry) {
		return activityEntryMatches(entry, needle);
	});
	matched.reverse();
	const shown = matched.slice(0, ACTIVITY_VIEW_LIMIT);
	return {
		open: true,
		filter: activityViewFilter,
		boardName: currentBoardName(),
		entries: shown,
		total: matched.length,
		hidden: matched.length - shown.length,
	};
}

/**
 * Backs the panel's `activity-view` command: opens, closes, and re-filters
 * the activity feed - the same shape setArchiveView() already uses for its
 * own view. There is no manifest `commands` entry (the palette has no board
 * to show the feed of until the panel itself is open), and no capability
 * change (this reads only the in-memory log activate() already loaded).
 * @param {unknown} args
 */
async function setActivityView(args) {
	const open = !!(args && args.open === true);
	const filter =
		args && typeof args.filter === 'string' ? args.filter.slice(0, ACTIVITY_FILTER_MAX_CHARS) : '';
	activityViewOpen = open;
	// A closed view forgets its filter, so reopening it starts on the whole
	// log rather than a search typed days ago - the same rule setArchiveView()
	// follows.
	activityViewFilter = open ? filter : '';
	await pushSnapshotNow();
	return { ok: true, open: activityViewOpen, filter: activityViewFilter };
}

// ===========================================================================
// End of Phase 07 board activity feed.
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
		// storage.get refused: the board switcher falls back to the active project's board.
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
	// The board on screen just changed, so its conductor (if it has one) may
	// have gone unsynced while nobody was looking at it - see the "Phase 06
	// conductor reach sync" section above.
	scheduleReachSync();
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
	// Kept warm for conductorTabStatus() (see "Phase 06 conductor chat
	// surface" above) so it can read the conductor's live tab status without
	// a second tabs.list() RPC of its own.
	latestTabs = Array.isArray(tabs) ? tabs : [];
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
	// A full rebuild is how a card appearing or disappearing is noticed, so
	// the board on screen's conductor (if it has one) may need its reach
	// recomputed - see the "Phase 06 conductor reach sync" section above.
	scheduleReachSync();
}

// ---------------------------------------------------------------------------
// Phase 08 honest failure state: the card model's own freshness.
//
// Every other read in this plugin degrades a feature that is visible on its
// own terms - an archive that will not read says so in the archive view, a
// board file that will not parse says so in the banner. The card model is
// the one read whose failure is INVISIBLE: `cards` simply keeps whatever the
// last successful tabs.list() produced, and a board drawn from it looks
// exactly like a board where nothing has happened lately. So a refused
// sessions.list()/tabs.list() is recorded here and rides out on the snapshot
// (`cardsStale`), and the panel says the cards may be out of date rather
// than painting them as live.
// ---------------------------------------------------------------------------

/** @type {{ call: string, message: string }|null} The read that should have
 * refreshed the card model and did not. Null whenever the model is as fresh
 * as the host last reported it. */
let cardRefreshError = null;

/** @param {string} call @param {unknown} err */
function noteCardRefreshFailure(call, err) {
	cardRefreshError = { call: call, message: errorMessage(err) };
}

function clearCardRefreshFailure() {
	cardRefreshError = null;
}

/** The stale-card notice for the panel: null when the model is fresh,
 * otherwise which host read failed and the host's own reason. */
function cardRefreshSnapshot() {
	if (!cardRefreshError) return null;
	return { call: cardRefreshError.call, message: cardRefreshError.message };
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
			clearCardRefreshFailure();
			schedulePanelPush();
		})
		.catch((err) => {
			// tabs.list refused: this refresh degrades only - the cards already on
			// screen are left alone rather than wiped - but the panel is told they
			// are now older than the host, so it never paints them as live.
			console.error('maestro-kanban: tabs.list failed: ' + String(err));
			noteCardRefreshFailure('tabs.list', err);
			schedulePanelPush();
		});
}

function schedulePanelPush() {
	if (panelTimer) return;
	panelTimer = setTimeout(() => {
		panelTimer = null;
		pushSnapshotNow().catch((err) => {
			// A debounced push that threw must not take the timer down with it; the next push retries.
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
 * `aging` is agingRenderState()'s numbers for a card the terminal column is
 * currently aging (see refreshAgingSnapshot above) and is absent for every
 * other card, which is what the panel reads as "no decay to draw".
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
		aging: agingByCard.get(card.key) || undefined,
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
 *
 * `archive` is the archive view's own payload, and is null unless the panel
 * has that view open (see buildArchiveView): a board nobody is browsing the
 * archive of reads no archive file on a repaint.
 */
async function buildSnapshot() {
	const active = await resolveActiveBoard();
	// Drained, not copied: a refusal is a one-shot message to the panel, so it
	// must not ride every snapshot after the one that reports it.
	const moveRejection = pendingMoveRejection;
	pendingMoveRejection = null;
	// Before the columns, because cardToJson() reads the result: every card in
	// this push is then measured against one clock reading, and a horizon the
	// settings surface just changed is already reflected in the opacities the
	// same push carries.
	await refreshAgingSnapshot();
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
		// Non-null only when the host refused the read that would have
		// refreshed these cards - see the card-freshness section above. The
		// panel draws the cards either way; it just stops calling them live.
		cardsStale: cardRefreshSnapshot(),
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
		archive: await buildArchiveView(),
		settings: boardSettingsSnapshot(),
		conductor: await conductorSettingsSnapshot(),
		// null until this board's first Ask Conductor since activate(); see
		// planRunSnapshot() (Phase 07 plan run loop, above).
		planRun: planRunSnapshot(currentBoardId()),
		// This board's WIP cap, mode and halt state - never null, unlike
		// planRun: the Halt control and the halted banner need this even
		// before the conductor has ever been asked for a plan.
		planSettings: planSettingsSnapshot(currentBoardId()),
		// null unless the panel has the activity feed open (see
		// buildActivityView(), Phase 07 board activity feed, above) - a board
		// nobody is browsing the feed of reads no extra state on a repaint.
		activity: buildActivityView(),
	};
}

function serializedSize(snapshot) {
	try {
		return JSON.stringify(snapshot).length;
	} catch {
		// A snapshot JSON.stringify refuses cannot be posted at all, so Infinity forces the trim path.
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
			// Kept: six numbers, and only on the Done cards of a board with aging
			// on. Dropping them would render every aged card at full strength on
			// exactly the boards big enough to need the fade most, and would take
			// the "retires today" marker with it - a card about to leave the board
			// with nothing on screen saying so.
			aging: c.aging,
		}));
	}
	// Then the oldest archived records, before any card: the archive view
	// already tells the user how many older records it is not showing (see
	// buildArchiveView's `hidden`), so dropping one costs a line in a list
	// that says it is capped, where dropping a card costs an agent off the
	// board with nothing saying why.
	const archive = snapshot.archive;
	if (archive && Array.isArray(archive.records)) {
		while (serializedSize(snapshot) > PANEL_BUDGET_BYTES && archive.records.length > 0) {
			archive.records.pop();
			archive.hidden = (typeof archive.hidden === 'number' ? archive.hidden : 0) + 1;
		}
	}
	// Same reasoning for the activity feed: entries[] is already newest first
	// (see buildActivityView), so popping the end drops the oldest of the
	// shown batch, and `hidden` already says the feed is capped.
	const activity = snapshot.activity;
	if (activity && Array.isArray(activity.entries)) {
		while (serializedSize(snapshot) > PANEL_BUDGET_BYTES && activity.entries.length > 0) {
			activity.entries.pop();
			activity.hidden = (typeof activity.hidden === 'number' ? activity.hidden : 0) + 1;
		}
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
	// A refused toast is never worth failing the action that raised it.
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
		// panelPost refused (the panel is closed, or the post is oversize): the next push retries.
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
	if (removedAny) {
		schedulePanelPush();
		scheduleReachSync();
	}
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
	// activeProjectPath feeds currentBoardId() whenever nothing is explicitly
	// selected (see resolveBoardView()), so this can change which board is on
	// screen the same way selectBoard() does - see the "Phase 06 conductor
	// reach sync" section above.
	scheduleReachSync();
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
	// markDirty() refresh every topic here gets, and - a second, independent
	// registration on the same two topics - settle whichever board's plan
	// run was waiting on this session (see "Phase 07 plan run loop" above).
	// A session that is nobody's conductor, or a conductor with no run in
	// flight, matches nothing in onPlanRunEvent() and this is a no-op for it.
	maestro.events.on('agent.completed', (payload) =>
		onHistoryRelevantEvent('agent.completed', payload)
	);
	maestro.events.on('agent.completed', (payload) => onPlanRunEvent('agent.completed', payload));
	maestro.events.on('agent.error', (payload) => onGenericSessionEvent('agent.error', payload));
	maestro.events.on('agent.exited', (payload) => onGenericSessionEvent('agent.exited', payload));
	maestro.events.on('run.completed', (payload) => onHistoryRelevantEvent('run.completed', payload));
	maestro.events.on('run.completed', (payload) => onPlanRunEvent('run.completed', payload));
	maestro.events.on('usage.updated', (payload) => onGenericSessionEvent('usage.updated', payload));
}

/** Re-seed everything from sessions.list()/tabs.list() and push right away.
 * Used at activate() and by the 'refresh' command. A rejected sessions.list()
 * still lets tabs.list() run, so the board degrades rather than going blank -
 * but either refusal is recorded as the snapshot's stale-card notice (see the
 * freshness section above), because a board seeded from a read the host
 * refused is not a board with nothing on it. */
async function seed() {
	/** @type {{ call: string, err: unknown }|null} */
	let failure = null;
	try {
		const sessions = await sdk.sessions.list();
		rebuildSessionMeta(sessions);
	} catch (err) {
		// sessions.list refused: the cards still rebuild from tabs.list() below, but their titles
		// and projects are as old as the last read that worked, so this still counts as stale.
		console.error('maestro-kanban: sessions.list failed: ' + String(err));
		failure = { call: 'sessions.list', err: err };
	}
	try {
		const tabs = await sdk.tabs.list();
		await rebuildCardsFromTabs(tabs);
	} catch (err) {
		// tabs.list refused: the card model is untouched rather than wiped, and the notice names
		// this read rather than sessions.list() because it is the worse of the two failures.
		console.error('maestro-kanban: tabs.list failed: ' + String(err));
		failure = { call: 'tabs.list', err: err };
	}
	if (failure) noteCardRefreshFailure(failure.call, failure.err);
	else clearCardRefreshFailure();
	await pushSnapshotNow();
}

function registerCommands(maestro) {
	maestro.commands.register('open', () => {
		invalidateBoardCache();
		// togglePanel refused: nothing else in this command depends on it.
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
				// The default board could not be written (the path exists, or fs refused): the reason
				// is toasted.
				console.error('maestro-kanban: write-default-board failed: ' + String(err));
				return safeToast(errorMessage(err)).then(() => ({ ok: false, error: errorMessage(err) }));
			});
	});

	maestro.commands.register('clear-placements', () =>
		clearAllPlacements()
			.then(() => seed())
			.then(() => ({ ok: true }))
			.catch((err) => {
				// Clearing placements failed: the board keeps whatever arrangement it already had.
				console.error('maestro-kanban: clear-placements failed: ' + String(err));
				return { ok: false };
			})
	);

	// Invoked by the panel's board switcher; no manifest `commands` entry is
	// needed since the palette has no way to pick which board it would mean.
	maestro.commands.register('select-board', (args) =>
		selectBoard(args && args.boardId).catch((err) => {
			// The board could not be switched (its file failed to read): the switcher stays where it was.
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
			// Clear Done failed (the archive refused the write): nothing is retired, and the
			// reason is shown.
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
			// Archiving one card failed (the archive refused the write): the card stays on the board.
			console.error('maestro-kanban: archive-card failed: ' + String(err));
			return safeToast('Could not archive that card: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		});
	});

	// Invoked by the panel's Archive toggle and its filter box (which
	// debounces its own typing); no manifest `commands` entry is needed since
	// the archive is a MODE of a panel that has to already be open to have
	// one. Holding the open/filter state in the sandbox is what lets
	// buildSnapshot() attach the archive payload - the bridge carries no
	// reply to a post, so the view can only ever arrive on a snapshot.
	maestro.commands.register('archive-view', (args) =>
		setArchiveView(args).catch((err) => {
			// The archive view could not be built (an archive file failed to read): the reason is shown.
			console.error('maestro-kanban: archive-view failed: ' + String(err));
			return safeToast('Could not open the archive: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		})
	);

	// Invoked by the panel's Activity toggle and its filter box, the same
	// shape 'archive-view' uses for its own view: no manifest `commands`
	// entry (the activity feed is a MODE of a panel that has to already be
	// open), and the open/filter state lives in the sandbox because the
	// bridge carries no reply to a post - the view can only arrive on a
	// snapshot (see buildActivityView(), Phase 07 board activity feed).
	maestro.commands.register('activity-view', (args) =>
		setActivityView(args).catch((err) => {
			// The activity feed could not be built: the reason is shown rather than an empty feed.
			console.error('maestro-kanban: activity-view failed: ' + String(err));
			return safeToast('Could not open the activity feed: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		})
	);

	// Invoked by an archive row's Restore button; no manifest `commands` entry
	// is needed since the palette has no record in hand to restore. `boardId`
	// is the record's own project path, echoed back from the row so the
	// sandbox reads the right archive file, and the record is re-read here
	// rather than trusted from the post.
	maestro.commands.register('restore-card', (args) => {
		const cardKey = args && typeof args.cardKey === 'string' ? args.cardKey : undefined;
		if (!cardKey) return Promise.resolve({ ok: false, error: 'cardKey is required' });
		return restoreArchivedCard(cardKey, args && args.boardId).catch((err) => {
			// Restore failed (the archive refused the rewrite): the record stays archived.
			console.error('maestro-kanban: restore-card failed: ' + String(err));
			return safeToast('Could not restore that card: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		});
	});

	// Invoked by the panel's board settings surface, one post per control it
	// changes; no manifest `commands` entry is needed since the palette has
	// no board in hand to configure and no value to set. `boardId` is the
	// snapshot's id echoed back, so a setting aimed at a board the user has
	// since switched away from is refused rather than landing on the wrong
	// board - which matters most for `closeTabsOnRetire`, the one setting
	// here that can cost someone a tab and its transcript.
	maestro.commands.register('board-settings', (args) =>
		applyBoardSettings(args).catch((err) => {
			// The setting could not be saved: the board keeps the setting it had, and says so.
			console.error('maestro-kanban: board-settings failed: ' + String(err));
			return safeToast('Could not save that setting: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		})
	);

	// Invoked by the panel's conductor settings surface, one post per field it
	// changes; no manifest `commands` entry for the same reason board-settings
	// has none - the palette has no board in hand to configure. `boardId` is
	// the snapshot's id echoed back, refused if the user switched boards
	// before the post landed.
	maestro.commands.register('conductor-config', (args) =>
		applyConductorConfig(args).catch((err) => {
			// The conductor configuration could not be saved: the board keeps the one it had.
			console.error('maestro-kanban: conductor-config failed: ' + String(err));
			return safeToast('Could not save that setting: ' + errorMessage(err)).then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		})
	);

	// Invoked by the panel's conductor settings surface's Create Conductor
	// button; no manifest `commands` entry for the same reason
	// `conductor-config` has none - the palette has no board in hand to
	// create one for. createConductor() already catches its own failures and
	// returns `{ ok: false, reason }`; this outer catch only guards against
	// something it did not anticipate, the same belt-and-suspenders the
	// other board-scoped commands above keep.
	maestro.commands.register('create-conductor', (args) =>
		createConductor(args).catch((err) => {
			console.error('maestro-kanban: create-conductor failed: ' + String(err));
			return safeToast('Could not create the conductor agent.').then(() => ({
				ok: false,
				error: errorMessage(err),
			}));
		})
	);

	// Invoked by the panel's plan surface's WIP cap field and Halt control:
	// `{ boardId, wipCap?, halted? }`. Mirrors 'board-settings' exactly - see
	// applyPlanSettings() for the refusals and the halt log line. No manifest
	// `commands` entry is needed for the same reason 'board-settings' has
	// none - the palette has no board in hand to configure.
	maestro.commands.register('plan-settings', (args) =>
		applyPlanSettings(args).catch((err) => {
			// The plan setting could not be saved: the board keeps the setting it had, and says so.
			console.error('maestro-kanban: plan-settings failed: ' + String(err));
			return safeToast('Could not save that setting: ' + errorMessage(err)).then(() => ({
				ok: false,
				reason: errorMessage(err),
			}));
		})
	);

	// Invoked by the panel's Ask Conductor action; no manifest `commands`
	// entry is needed since the palette has no board in hand to plan for.
	// askConductor() already catches its own failures and returns
	// `{ ok: false, reason }` (including a denied dispatch, settled as the
	// run's own 'not-connected' state); this outer catch only guards against
	// something it did not anticipate.
	maestro.commands.register('ask-conductor', (args) =>
		askConductor(args).catch((err) => {
			console.error('maestro-kanban: ask-conductor failed: ' + String(err));
			return safeToast('Could not ask the conductor for a plan.').then(() => ({
				ok: false,
				reason: errorMessage(err),
			}));
		})
	);

	// Invoked by the panel's plan approval surface's Approve Selected button:
	// `{ boardId, planId, approvedKeys }`. Records every row of the board's
	// current parsed plan as approved or declined (see recordPlanDecisions()),
	// then runs executePlanRun() against exactly that decision - a move
	// through handleMove(), a message through dispatchCardMessage(), a
	// needsAccess row through one sessions.requestAccess() - and pushes a
	// fresh snapshot so the panel's diff repaints with each row's outcome; no
	// manifest `commands` entry is needed since the palette has no plan in
	// hand to approve.
	maestro.commands.register('approve-plan', (args) => {
		const boardId = args && typeof args.boardId === 'string' ? args.boardId : undefined;
		const planId = args && typeof args.planId === 'string' ? args.planId : undefined;
		const approvedKeys = args && Array.isArray(args.approvedKeys) ? args.approvedKeys : [];
		if (!boardId || !planId) {
			return Promise.resolve({ ok: false, reason: 'boardId and planId are required' });
		}
		const outcome = planRunForAction(boardId, planId);
		if (!outcome.run) {
			return safeToast('Could not approve that plan: ' + outcome.reason).then(() => ({
				ok: false,
				reason: outcome.reason,
			}));
		}
		recordPlanDecisions(
			outcome.run,
			new Set(approvedKeys.filter((key) => typeof key === 'string'))
		);
		return recordDecisionActivity(boardId, outcome.run)
			.then(() => executePlanRun(boardId, outcome.run))
			.catch((err) => {
				// Executing an approved plan threw: the run's own per-step results still reach the panel.
				console.error('maestro-kanban: executing plan ' + planId + ' failed: ' + String(err));
			})
			.then(() => pushSnapshotNow())
			.then(() => ({ ok: true }));
	});

	// Invoked by the panel's plan approval surface's Reject All button:
	// `{ boardId, planId }`. The same recordPlanDecisions() as 'approve-plan'
	// above with nothing in the approved set, so every row lands declined,
	// then the same executePlanRun() call - which, with nothing approved,
	// executes nothing and simply marks the run executed; no manifest
	// `commands` entry is needed for the same reason 'approve-plan' has none.
	maestro.commands.register('reject-plan', (args) => {
		const boardId = args && typeof args.boardId === 'string' ? args.boardId : undefined;
		const planId = args && typeof args.planId === 'string' ? args.planId : undefined;
		if (!boardId || !planId) {
			return Promise.resolve({ ok: false, reason: 'boardId and planId are required' });
		}
		const outcome = planRunForAction(boardId, planId);
		if (!outcome.run) {
			return safeToast('Could not reject that plan: ' + outcome.reason).then(() => ({
				ok: false,
				reason: outcome.reason,
			}));
		}
		recordPlanDecisions(outcome.run, new Set());
		return recordDecisionActivity(boardId, outcome.run)
			.then(() => executePlanRun(boardId, outcome.run))
			.catch((err) => {
				// Executing an auto-approved plan threw: the run's own per-step results still reach
				// the panel.
				console.error('maestro-kanban: executing plan ' + planId + ' failed: ' + String(err));
			})
			.then(() => pushSnapshotNow())
			.then(() => ({ ok: true }));
	});

	// Invoked by the panel's plan approval surface's Edit action on a message
	// row, before that row is approved: `{ boardId, planId, cardKey, prompt }`.
	// editPlanMessage() validates and applies the new prompt and clears any
	// decision already recorded for the run (see its own doc comment); no
	// manifest `commands` entry is needed for the same reason 'approve-plan'
	// has none.
	maestro.commands.register('edit-plan-message', (args) => {
		const boardId = args && typeof args.boardId === 'string' ? args.boardId : undefined;
		const planId = args && typeof args.planId === 'string' ? args.planId : undefined;
		const cardKey = args && typeof args.cardKey === 'string' ? args.cardKey : undefined;
		const prompt = args && typeof args.prompt === 'string' ? args.prompt : undefined;
		if (!boardId || !planId || !cardKey || prompt === undefined) {
			return Promise.resolve({
				ok: false,
				reason: 'boardId, planId, cardKey and prompt are required',
			});
		}
		const outcome = planRunForAction(boardId, planId);
		if (!outcome.run) {
			return safeToast('Could not edit that message: ' + outcome.reason).then(() => ({
				ok: false,
				reason: outcome.reason,
			}));
		}
		const result = editPlanMessage(outcome.run, cardKey, prompt);
		if (!result.ok) {
			return safeToast('Could not edit that message: ' + result.reason).then(() => ({
				ok: false,
				reason: result.reason,
			}));
		}
		return pushSnapshotNow().then(() => ({ ok: true }));
	});

	// Invoked by the panel when a drag ends in a drop (and, later, by its
	// keyboard move); no manifest `commands` entry is needed since it is never
	// surfaced in the command palette.
	maestro.commands.register('move', (args) =>
		handleMove(args).catch((err) => {
			// The move threw outright: refused by card key, so the panel snaps that one card back.
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
				// closePanel refused: the panel is already closed, or the host declined.
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
				if (granted) {
					grantedSessions.add(sessionId);
					scheduleReachSync();
				}
				return pushSnapshotNow().then(() => ({ ok: true, granted: granted }));
			})
			.catch((err) => {
				// sessions.requestAccess refused: the card stays "not connected" and the reason is toasted.
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
				// The History excerpt could not be read: readSessionHistoryExcerpt() stored the reason.
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
					// The description could not be saved: the panel is told and the card keeps its text.
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
					// The comment could not be saved: the panel is told and the card keeps its comments.
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
				scheduleReachSync();
				return dispatchCardMessage(sessionId, tabId, prompt).then((result) =>
					recordOutcome(result.ok ? 'sent' : 'failed', result.error)
				);
			})
			.catch((err) => {
				// sessions.requestAccess refused: the send is recorded as failed, never dropped.
				console.error(
					'maestro-kanban: sessions.requestAccess (from send-message) failed: ' + String(err)
				);
				return recordOutcome('failed', 'Could not request access to that agent.');
			});
	});

	// Invoked by the panel via parent.postMessage; no manifest `commands`
	// entry is needed since it is never surfaced in the command palette.
	// Shared by a card's own Open action and the conductor settings
	// surface's Open Conductor button (see "Phase 06 conductor chat
	// surface" above) - the latter posts only `sessionId`, so `tabId` is
	// undefined and sessions.focus() picks the conductor's own tab.
	maestro.commands.register('focus', (args) => {
		const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined;
		const tabId = args && typeof args.tabId === 'string' ? args.tabId : undefined;
		if (!sessionId) return Promise.resolve({ ok: false });
		return maestro.sessions
			.focus(sessionId, tabId)
			.then(() => ({ ok: true }))
			.catch((err) => {
				// sessions.focus refused (stale session or tab id): the user is told it did not happen.
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
	AGING_RENDER_OPACITY_FLOOR: AGING_RENDER_OPACITY_FLOOR,
	AGING_SOON_DAYS: AGING_SOON_DAYS,
	agingRenderState: agingRenderState,

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
	removeFromArchive: removeFromArchive,

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

	// Phase 05 archive view, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). archiveRecordMatches() is
	// pure; buildArchiveView() and restoreArchivedCard() read the archive
	// files and the live tab list, so a test calls them after activate() with
	// a stub SDK - normally through the `archive-view` / `restore-card`
	// commands the panel posts, which is the only way a user reaches them.
	ARCHIVE_VIEW_LIMIT: ARCHIVE_VIEW_LIMIT,
	archiveRecordMatches: archiveRecordMatches,
	buildArchiveView: buildArchiveView,
	setArchiveView: setArchiveView,
	restoreArchivedCard: restoreArchivedCard,

	// Phase 05 board settings surface, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-aging.test.ts). boardSettingsPatchFrom()
	// is pure; boardSettingsSnapshot() and applyBoardSettings() read the live
	// board selection and write plugin storage, so a test calls them after
	// activate() with a stub SDK - normally through the `board-settings`
	// command the panel posts, which is the only way a user reaches them.
	MIN_HORIZON_DAYS: MIN_HORIZON_DAYS,
	MAX_HORIZON_DAYS: MAX_HORIZON_DAYS,
	boardSettingsPatchFrom: boardSettingsPatchFrom,
	boardSettingsSnapshot: boardSettingsSnapshot,
	applyBoardSettings: applyBoardSettings,

	// Phase 06 conductor configuration model, exported for direct unit testing
	// (see src/__tests__/plugins/kanban-conductor.test.ts). This is the stored
	// per-board choice only, not the running conductor session - that is
	// Phase 06's later tasks. normalizeConductorConfig() is pure; the rest
	// read/write plugin storage, so a test calls them after activate() with a
	// stub SDK first.
	DEFAULT_CONDUCTOR_CONFIG: DEFAULT_CONDUCTOR_CONFIG,
	normalizeConductorConfig: normalizeConductorConfig,
	conductorConfigForBoard: conductorConfigForBoard,
	setConductorConfig: setConductorConfig,

	// Phase 06 conductor settings surface, exported for direct unit testing
	// (see src/__tests__/plugins/kanban-conductor-settings.test.ts).
	// conductorConfigPatchFrom() and conductorReachForBoard() are pure reads
	// of the live card/board state; conductorProviderOptions() and
	// conductorSettingsSnapshot() call sdk.agents.list(), and
	// applyConductorConfig() writes plugin storage, so a test calls them
	// after activate() with a stub SDK - normally through the
	// `conductor-config` command the panel posts, which is the only way a
	// user reaches it.
	CONDUCTOR_REACH_LIMIT: CONDUCTOR_REACH_LIMIT,
	conductorConfigPatchFrom: conductorConfigPatchFrom,
	conductorProviderOptions: conductorProviderOptions,
	conductorReachForBoard: conductorReachForBoard,
	conductorProviderSupportsDirectories: conductorProviderSupportsDirectories,
	conductorSettingsSnapshot: conductorSettingsSnapshot,
	applyConductorConfig: applyConductorConfig,

	// Phase 06 conductor session creation, exported for direct unit testing
	// (see src/__tests__/plugins/kanban-conductor.test.ts, written once
	// Phase 06's remaining tasks land). conductorScratchDir() is pure;
	// resolveConductorSessionId() and conductorDirectoryGrants() read live
	// session/card state and call sdk.sessions.get(); createConductor()
	// writes the README, creates the session, and syncs its initial reach -
	// a test calls it after activate() with a stub SDK, normally through
	// the `create-conductor` command the panel posts.
	CONDUCTOR_SCRATCH_DIR: CONDUCTOR_SCRATCH_DIR,
	conductorScratchDir: conductorScratchDir,
	resolveConductorSessionId: resolveConductorSessionId,
	conductorDirectoryGrants: conductorDirectoryGrants,
	createConductor: createConductor,

	// Phase 06 conductor reach sync, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-conductor.test.ts, written once Phase 06's
	// remaining tasks land). Every trigger in that section (a card
	// appearing/disappearing, a grant approved or found revoked, a board
	// switch) calls the unexported scheduleReachSync() debounce, which a test
	// reaches through the public command/event surface those triggers already
	// sit behind (request-access, send-message, select-board, the events
	// registerEventHandlers() subscribes to) plus fake timers; syncConductorReach()
	// itself is exported so a test can also await the underlying work
	// directly, without fighting the debounce, to assert the sessions.update()
	// payload and the resulting activity-feed entry (see recordReachChange(),
	// called only from inside syncConductorReach(), and activityLogForBoard()
	// below, Phase 07 board activity feed).
	syncConductorReach: syncConductorReach,

	// Phase 06 conductor chat surface, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-conductor-settings.test.ts).
	// conductorTabStatusFrom() is pure (a tabs.list() response in, a status
	// string out); conductorTabStatus() is the stateful wrapper
	// conductorSettingsSnapshot() actually calls, reading the cache
	// rebuildCardsFromTabs() keeps warm. Open Conductor itself adds no new
	// command - it posts the existing 'focus' command below with no tabId,
	// so there is nothing further to export for it.
	conductorTabStatusFrom: conductorTabStatusFrom,
	conductorTabStatus: conductorTabStatus,

	// Phase 07 plan settings, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-plan-parser.test.ts and the upcoming
	// kanban-auto-mode.test.ts). normalizePlanSettings() is pure;
	// planSettingsForBoard() and isBoardHalted() read the map loadPlanSettings()
	// fills at activate() time, and setPlanSettings() writes plugin storage, so
	// a test calls those after activate() with a stub SDK. planSettingsSnapshot()
	// and planSettingsPatchFrom() are pure, the same split boardSettingsSnapshot()/
	// boardSettingsPatchFrom() use; applyPlanSettings() backs the panel's
	// `plan-settings` command (the Halt control, the WIP cap field, and the
	// Mode switch) and is exported the same way applyBoardSettings() is.
	// planSettingsPatchFrom() now also accepts `mode`; see autoDecidePlanRun()
	// and autoExecuteIfNeeded() (Phase 07 plan execution, above) for what
	// PLAN_MODE_AUTO actually changes about a run.
	PLAN_MODE_APPROVE: PLAN_MODE_APPROVE,
	PLAN_MODE_AUTO: PLAN_MODE_AUTO,
	DEFAULT_PLAN_WIP_CAP: DEFAULT_PLAN_WIP_CAP,
	MIN_PLAN_WIP_CAP: MIN_PLAN_WIP_CAP,
	MAX_PLAN_WIP_CAP: MAX_PLAN_WIP_CAP,
	normalizePlanSettings: normalizePlanSettings,
	planSettingsForBoard: planSettingsForBoard,
	setPlanSettings: setPlanSettings,
	isBoardHalted: isBoardHalted,
	planSettingsSnapshot: planSettingsSnapshot,
	planSettingsPatchFrom: planSettingsPatchFrom,
	applyPlanSettings: applyPlanSettings,

	// Phase 07 plan contract, exported for direct unit testing (see
	// src/__tests__/plugins/kanban-plan-parser.test.ts). parsePlan(),
	// extractPlanJson() and renderPlanPrompt() are pure - a board context and
	// a card list in, a plan or a prompt out - so the adversarial suite calls
	// them straight through with no stub SDK at all, which is the whole reason
	// the contract is shaped as three pure functions and one stateful builder
	// rather than one method that does everything.
	//
	// planFileRelativePath() and planFilePath() are pure too; buildPlanSnapshot()
	// and buildPlanRequest() read the live board, the live cards and (for
	// granted cards only) their History excerpt, so a test calls them after
	// activate() with a stub SDK. newPlanId() is exported so a test can assert
	// the shape of an id this plugin builds paths out of.
	PLAN_CONTRACT_VERSION: PLAN_CONTRACT_VERSION,
	PLAN_ENTRY_CAP: PLAN_ENTRY_CAP,
	PLAN_FILE_MAX_CHARS: PLAN_FILE_MAX_CHARS,
	PLAN_MESSAGE_PROMPT_MAX_CHARS: PLAN_MESSAGE_PROMPT_MAX_CHARS,
	PLAN_ID_PATTERN: PLAN_ID_PATTERN,
	newPlanId: newPlanId,
	planFileRelativePath: planFileRelativePath,
	planFilePath: planFilePath,
	extractPlanJson: extractPlanJson,
	parsePlan: parsePlan,
	renderPlanPrompt: renderPlanPrompt,
	buildPlanSnapshot: buildPlanSnapshot,
	buildPlanRequest: buildPlanRequest,

	// Phase 07 plan run loop, exported for direct unit testing (see the
	// upcoming src/__tests__/plugins/kanban-auto-mode.test.ts). askConductor()
	// calls sdk.agents.dispatch and sdk.fs.read, so a test drives it with a
	// stub SDK after activate(); planRunSnapshot() is a pure read of the
	// in-memory run map it leaves behind. onPlanRunEvent() and
	// onPlanRunTimeout() are deliberately not exported: every other event
	// handler in this file is reached only through registerEventHandlers()'s
	// own registration, and a test settles a run the same way the host
	// would - by emitting 'agent.completed'/'run.completed' - rather than by
	// calling a private function the host never calls either.
	PLAN_RUN_TIMEOUT_MS: PLAN_RUN_TIMEOUT_MS,
	askConductor: askConductor,
	planRunSnapshot: planRunSnapshot,

	// Phase 07 board activity feed, exported for direct unit testing.
	// activityEntryMatches() is pure; activityLogForBoard() and
	// recordActivity() read/write the in-memory map loadActivityLog() fills
	// at activate() time, so a test calls those after activate() with a stub
	// SDK. buildActivityView() and setActivityView() are the pure read and
	// the stateful write behind the panel's `activity-view` command, the
	// same split buildArchiveView()/setArchiveView() use for their own view.
	ACTIVITY_LOG_LIMIT_PER_BOARD: ACTIVITY_LOG_LIMIT_PER_BOARD,
	ACTIVITY_VIEW_LIMIT: ACTIVITY_VIEW_LIMIT,
	ACTIVITY_TYPE_PLAN_REQUESTED: ACTIVITY_TYPE_PLAN_REQUESTED,
	ACTIVITY_TYPE_PLAN_RESULT: ACTIVITY_TYPE_PLAN_RESULT,
	ACTIVITY_TYPE_ROW_DECIDED: ACTIVITY_TYPE_ROW_DECIDED,
	ACTIVITY_TYPE_ACCESS_REQUESTED: ACTIVITY_TYPE_ACCESS_REQUESTED,
	ACTIVITY_TYPE_ROW_EXECUTED: ACTIVITY_TYPE_ROW_EXECUTED,
	ACTIVITY_TYPE_REACH_CHANGED: ACTIVITY_TYPE_REACH_CHANGED,
	ACTIVITY_TYPE_RETIRED: ACTIVITY_TYPE_RETIRED,
	ACTIVITY_TYPE_HALT_CHANGED: ACTIVITY_TYPE_HALT_CHANGED,
	ACTIVITY_TYPE_MODE_CHANGED: ACTIVITY_TYPE_MODE_CHANGED,
	activityEntryMatches: activityEntryMatches,
	activityLogForBoard: activityLogForBoard,
	recordActivity: recordActivity,
	buildActivityView: buildActivityView,
	setActivityView: setActivityView,

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
			// events.subscribe refused: the board still seeds and renders, it just stops updating itself.
			console.error('maestro-kanban: events.subscribe failed: ' + String(err));
		}
		// Before seed(), so the first snapshot already renders the board the
		// user left instead of flashing the active project's board first, and
		// already carries every card's stored description/comments.
		await loadSelectedBoard();
		await loadCardNotes();
		await loadBoardSettings();
		// Before seed() like the rest, and for one reason beyond symmetry: a
		// halt has to be in force before anything can execute, so it is read
		// on the way in rather than on the first plan run.
		await loadPlanSettings();
		await loadConductorConfigs();
		await loadConductorIds();
		// Before seed() like the rest: a reach change, a retirement, a halt, or
		// a plan result can all be recorded before the first panel open, and
		// none of them should find an empty log where there is a real one on
		// disk.
		await loadActivityLog();
		await loadArchiveBoardIndex();
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
		if (reachSyncTimer) {
			clearTimeout(reachSyncTimer);
			reachSyncTimer = null;
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
		// Dropped like every other cache, and re-read by the next activate():
		// a halt lives in storage, so clearing the mirror does not clear it.
		planSettings = new Map();
		// A run in flight at shutdown loses its timer the same way every other
		// setTimeout in this file does on deactivate(); the run itself is
		// in-memory only and was never going to survive a restart anyway.
		for (const run of planRuns.values()) clearPlanRunTimer(run);
		planRuns = new Map();
		conductorConfigs = new Map();
		conductorIds = new Map();
		// Dropped like planSettings above, and for the same reason: the log
		// lives in storage, so clearing the mirror does not clear history.
		activityLogs = new Map();
		activityViewOpen = false;
		activityViewFilter = '';
		lastSyncedReach = new Map();
		latestTabs = [];
		agingByCard = new Map();
		stopRetirementTicks();
		cardColumnTrail.clear();
		archivedCardKeys.clear();
		archiveViewOpen = false;
		archiveViewFilter = '';
		archiveBoardIndex.clear();
		// The host clears its own grant bookkeeping when the sandbox stops; this
		// mirrors that so a reactivated plugin never assumes a grant it has not
		// seen confirmed again.
		grantedSessions.clear();
		historyCache.clear();
		openHistorySessionId = null;
		lastMessageOutcomes.clear();
		if (sdk) {
			// events.unsubscribe refused on deactivate: the host tears the sandbox down regardless.
			return sdk.events.unsubscribe().catch(() => {});
		}
		return undefined;
	},
};
