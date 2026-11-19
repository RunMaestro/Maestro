/**
 * Query mode's Dry run: what a statement is, and what it would change,
 * before it is run for real.
 *
 * With the tab's editing unlock on, a dry run (`SqliteQueryRequest.dryRun`,
 * `maestro-cli sqlite query --dry-run`) answers two questions:
 *
 *   - What kind of statement is this? `classifySqliteStatement()` reads the
 *     verb and the object it names from the text (past any `WITH` clause),
 *     and takes whether it writes from SQLite's own prepare
 *     (`isSqliteWriteStatement()` over `stmt.readonly`), so a write behind a
 *     read keyword is never called a read.
 *   - What would it change? Main tries the statement once in the SQLite child
 *     process inside `BEGIN IMMEDIATE`, counts the rows it changed and the
 *     rows its triggers and foreign-key actions changed, compares the schema
 *     before and after (`sqliteSchemaChanges()`), and ROLLS BACK. The counts
 *     are exact for the database as it is at that moment, which is why they
 *     are an estimate of the real run: a change made in between can move them.
 *
 * A read is classified and not run: it changes nothing. VACUUM and a PRAGMA
 * that writes are classified and not tried: SQLite runs them outside any
 * transaction (`SQLITE_UNTRANSACTED_KEYWORDS`), so there is nothing to roll
 * back.
 *
 * Shared by main (which builds the result), the Query panel, and the CLI
 * (which refuse a dry run without editing or with Plan before anything
 * starts, and say what it found with `formatSqliteDryRun()`).
 */

import { formatCount } from '../formatters';
import { sqliteLeadingKeyword } from './query';
import { sqliteTokenName, sqliteTokens, type SqliteToken } from './tokens';
import type { SqliteDryRun, SqliteSchemaChange, SqliteStatementKind } from './types';

/** A statement's kind, verb, and the object it names: what a dry run says before any count. */
export interface SqliteStatementClassification {
	kind: SqliteStatementKind;
	/** Upper case, after any `WITH` clause: `DELETE`, `CREATE UNIQUE INDEX`, `PRAGMA`. */
	verb: string;
	/** The table or object the text names (`users`, `main.users`), unquoted, or null. */
	target: string | null;
}

/** A dry run was asked for without the tab's editing unlock. */
export const SQLITE_DRY_RUN_NEEDS_EDITING_MESSAGE =
	'A dry run tries the statement and rolls it back, so it needs editing enabled. Turn on "Enable editing" first.';

/** A dry run was asked for with the Plan toggle on. */
export const SQLITE_DRY_RUN_PLAN_MESSAGE =
	'A dry run tries the statement itself, so it does not take Plan. Switch to Rows.';

/** Why a read is not run by a dry run. */
export const SQLITE_DRY_RUN_READ_MESSAGE =
	'It only reads, so it changes nothing and the dry run did not run it. Run shows its rows.';

/** Why VACUUM, or a PRAGMA that writes, is not tried by a dry run. */
export function sqliteDryRunUntransactedMessage(keyword: string): string {
	return `SQLite runs ${keyword} outside any transaction, so a dry run cannot try it and roll it back. Run applies it.`;
}

/** A dry run was asked for inside an open transaction, which holds the file's write lock. */
export const SQLITE_DRY_RUN_IN_TRANSACTION_MESSAGE =
	'A transaction is open, so a dry run cannot take the write lock it needs. Run the statement in the transaction instead: Roll back takes it back.';

/**
 * Why a dry run cannot start, judged before any process does, or null. The
 * statement's own text is judged as a run judges it, by the editing rules
 * (`sqliteEditingQueryRefusal()`). `transaction`: the tab has a transaction
 * open, whose write lock a trial would wait on.
 */
export function sqliteDryRunRefusal(options: {
	editing: boolean;
	plan: boolean;
	transaction?: boolean;
}): string | null {
	if (!options.editing) return SQLITE_DRY_RUN_NEEDS_EDITING_MESSAGE;
	if (options.plan) return SQLITE_DRY_RUN_PLAN_MESSAGE;
	if (options.transaction) return SQLITE_DRY_RUN_IN_TRANSACTION_MESSAGE;
	return null;
}

const DATA_VERBS: ReadonlySet<string> = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE']);
const SCHEMA_VERBS: ReadonlySet<string> = new Set(['CREATE', 'DROP', 'ALTER']);
/** The verbs a `WITH` clause leads to. */
const WITH_VERBS: ReadonlySet<string> = new Set([...DATA_VERBS, 'SELECT', 'VALUES']);
const OBJECT_TYPES: ReadonlySet<string> = new Set(['TABLE', 'INDEX', 'VIEW', 'TRIGGER']);

function upperWord(token: SqliteToken | undefined): string | null {
	return token?.kind === 'word' ? token.text.toUpperCase() : null;
}

/** The name starting at `index`, schema-qualified (`main.users`) when written so, or null. */
function nameAt(tokens: readonly SqliteToken[], index: number): string | null {
	const first = tokens[index];
	const name = first ? sqliteTokenName(first) : null;
	if (name === null) return null;
	const dot = tokens[index + 1];
	const second = tokens[index + 2];
	if (dot?.kind === 'symbol' && dot.text === '.' && second) {
		const qualified = sqliteTokenName(second);
		if (qualified !== null) return `${name}.${qualified}`;
	}
	return name;
}

/**
 * Where the statement's verb is: the first token, or, past a `WITH` clause,
 * the first data or read verb outside parentheses (a CTE's body and column
 * list are inside them). 0 when a `WITH` leads to none.
 */
function verbIndex(tokens: readonly SqliteToken[]): number {
	if (upperWord(tokens[0]) !== 'WITH') return 0;
	let depth = 0;
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.kind === 'symbol' && token.text === '(') depth++;
		else if (token.kind === 'symbol' && token.text === ')') depth = Math.max(0, depth - 1);
		else if (depth === 0 && WITH_VERBS.has(upperWord(token) ?? '')) return index;
	}
	return 0;
}

/** CREATE / DROP / ALTER: the object type joins the verb, then `IF [NOT] EXISTS` is skipped. */
function schemaVerb(
	tokens: readonly SqliteToken[],
	root: string,
	start: number
): { verb: string; target: string | null } {
	const words = [root];
	let next = start;
	for (;;) {
		const word = upperWord(tokens[next]);
		if (word === 'TEMP' || word === 'TEMPORARY') next++;
		else if (word === 'UNIQUE' || word === 'VIRTUAL') {
			words.push(word);
			next++;
		} else break;
	}
	const type = upperWord(tokens[next]);
	if (type && OBJECT_TYPES.has(type)) {
		words.push(type);
		next++;
	}
	if (upperWord(tokens[next]) === 'IF') {
		next += upperWord(tokens[next + 1]) === 'NOT' ? 3 : 2;
	}
	return { verb: words.join(' '), target: nameAt(tokens, next) };
}

function kindOf(root: string, writes: boolean): SqliteStatementKind {
	if (!writes) return 'read';
	if (DATA_VERBS.has(root)) return 'data';
	if (SCHEMA_VERBS.has(root)) return 'schema';
	if (root === 'PRAGMA') return 'setting';
	return 'maintenance';
}

/**
 * What a statement is: its kind, verb, and the object it names. `writes` is
 * SQLite's answer (`isSqliteWriteStatement()` over the prepared statement's
 * `readonly`), so the kind never rests on the text alone; the verb and target
 * are read from the text the way SQLite's tokenizer splits it (quoted names
 * unquoted, comments skipped). A text this does not recognize keeps its
 * leading keyword as the verb and names no target.
 */
export function classifySqliteStatement(
	sql: string,
	writes: boolean
): SqliteStatementClassification {
	const tokens = sqliteTokens(sql);
	const at = verbIndex(tokens);
	const root = upperWord(tokens[at]) ?? sqliteLeadingKeyword(sql);
	let next = at + 1;
	let verb = root;
	let target: string | null = null;
	switch (root) {
		case 'INSERT':
		case 'UPDATE':
			// `INSERT OR REPLACE`, `UPDATE OR IGNORE`.
			if (upperWord(tokens[next]) === 'OR') next += 2;
			if (upperWord(tokens[next]) === 'INTO') next++;
			target = nameAt(tokens, next);
			break;
		case 'REPLACE':
			if (upperWord(tokens[next]) === 'INTO') next++;
			target = nameAt(tokens, next);
			break;
		case 'DELETE':
			if (upperWord(tokens[next]) === 'FROM') next++;
			target = nameAt(tokens, next);
			break;
		case 'CREATE':
		case 'DROP':
		case 'ALTER':
			({ verb, target } = schemaVerb(tokens, root, next));
			break;
		case 'VACUUM':
		case 'REINDEX':
		case 'ANALYZE':
		case 'PRAGMA':
			target = nameAt(tokens, next);
			break;
		default:
			break;
	}
	return { kind: kindOf(root, writes), verb, target };
}

/** A dry run that ran nothing: a read, or a statement SQLite runs outside any transaction. */
export function sqliteDryRunNotTried(
	classification: SqliteStatementClassification,
	reason: string
): SqliteDryRun {
	return {
		...classification,
		tried: false,
		untriedReason: reason,
		changes: null,
		otherChanges: null,
		schemaChanges: [],
	};
}

/** A dry run whose trial ran and was rolled back. */
export function sqliteDryRunTried(
	classification: SqliteStatementClassification,
	trial: { changes: number; otherChanges: number; schemaChanges: SqliteSchemaChange[] }
): SqliteDryRun {
	return { ...classification, tried: true, untriedReason: null, ...trial };
}

/** One row of `sqlite_schema` as a dry run compares it. */
export interface SqliteSchemaEntry {
	type: string;
	name: string;
	/** NULL for the automatic indexes SQLite makes for UNIQUE and PRIMARY KEY. */
	sql: string | null;
}

const CHANGE_ORDER: Record<SqliteSchemaChange['change'], number> = {
	created: 0,
	dropped: 1,
	altered: 2,
};

/**
 * What changed between two reads of `sqlite_schema`: an object by type and
 * name only in `after` was created, only in `before` was dropped, and one in
 * both whose SQL differs was altered (`ALTER TABLE ... ADD COLUMN`, an index
 * whose table was renamed). A renamed table is a drop and a create. Created
 * first, then dropped, then altered, each by type and name.
 */
export function sqliteSchemaChanges(
	before: readonly SqliteSchemaEntry[],
	after: readonly SqliteSchemaEntry[]
): SqliteSchemaChange[] {
	const key = (entry: SqliteSchemaEntry) => `${entry.type}\u0000${entry.name}`;
	const was = new Map(before.map((entry) => [key(entry), entry]));
	const now = new Map(after.map((entry) => [key(entry), entry]));
	const changes: SqliteSchemaChange[] = [];
	for (const [entryKey, entry] of now) {
		const old = was.get(entryKey);
		if (!old) changes.push({ change: 'created', type: entry.type, name: entry.name });
		else if (old.sql !== entry.sql) {
			changes.push({ change: 'altered', type: entry.type, name: entry.name });
		}
	}
	for (const [entryKey, entry] of was) {
		if (!now.has(entryKey)) changes.push({ change: 'dropped', type: entry.type, name: entry.name });
	}
	return changes.sort(
		(a, b) =>
			CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] ||
			a.type.localeCompare(b.type) ||
			a.name.localeCompare(b.name)
	);
}

/** "changes rows", "changes the schema", ...: what a kind of statement does. */
export function sqliteStatementKindLabel(kind: SqliteStatementKind): string {
	switch (kind) {
		case 'read':
			return 'reads only';
		case 'data':
			return 'changes rows';
		case 'schema':
			return 'changes the schema';
		case 'setting':
			return 'changes a database setting';
		case 'maintenance':
			return 'database maintenance';
	}
}

function rowsText(count: number): string {
	return `${formatCount(count)} ${count === 1 ? 'row' : 'rows'}`;
}

/**
 * "create table logs, index logs_at", "drop view v": the schema part of a
 * dry run's sentence, one part per kind of change. With `past`, "created
 * ...", as an open transaction reports what it did.
 */
export function sqliteSchemaChangesText(
	changes: readonly SqliteSchemaChange[],
	past = false
): string[] {
	const words: Record<SqliteSchemaChange['change'], string> = past
		? { created: 'created', dropped: 'dropped', altered: 'altered' }
		: { created: 'create', dropped: 'drop', altered: 'alter' };
	const parts: string[] = [];
	for (const change of ['created', 'dropped', 'altered'] as const) {
		const objects = changes.filter((entry) => entry.change === change);
		if (objects.length === 0) continue;
		parts.push(
			`${words[change]} ${objects.map((entry) => `${entry.type} ${entry.name}`).join(', ')}`
		);
	}
	return parts;
}

/**
 * One sentence for what a dry run found, shared by the Query panel's status
 * line and the CLI: "DELETE on users (changes rows) would change 3 rows; its
 * triggers and foreign-key actions would change 2 other rows. Tried in a
 * transaction and rolled back: nothing was changed." A dry run that tried
 * nothing says why instead.
 */
export function formatSqliteDryRun(dryRun: SqliteDryRun): string {
	const subject = `${dryRun.target ? `${dryRun.verb} on ${dryRun.target}` : dryRun.verb} (${sqliteStatementKindLabel(dryRun.kind)})`;
	if (!dryRun.tried) return `${subject}: ${dryRun.untriedReason ?? 'not tried.'}`;
	const changes = dryRun.changes ?? 0;
	const others = dryRun.otherChanges ?? 0;
	const parts: string[] = [];
	if (dryRun.kind !== 'schema' || changes > 0) parts.push(`change ${rowsText(changes)}`);
	parts.push(...sqliteSchemaChangesText(dryRun.schemaChanges));
	const what = parts.length > 0 ? parts.join(' and ') : 'change nothing';
	const triggered =
		others > 0
			? `; its triggers and foreign-key actions would change ${formatCount(others)} other ${others === 1 ? 'row' : 'rows'}`
			: '';
	return `${subject} would ${what}${triggered}. Tried in a transaction and rolled back: nothing was changed.`;
}
