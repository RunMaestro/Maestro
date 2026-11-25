/**
 * The SQL editor's grammar: `@codemirror/lang-sql` in its SQLite dialect,
 * with completion built from the open database's column catalog
 * (`sqlite:readColumns`).
 *
 * Completion comes from three sources, merged in one popup:
 *
 *  - Keywords, from the dialect (upper case, the way SQL is usually written).
 *  - Table and view names, and `table.` / `alias.` column names, from
 *    lang-sql's own schema completion fed with the catalog.
 *  - Bare column names (`SELECT na|`), which lang-sql cannot offer without a
 *    single default table. `sqliteColumnCompletionSource()` offers the columns
 *    of every table the CURRENT statement names, so `SELECT ... FROM users`
 *    completes `users`' columns and a join completes both sides'.
 *
 * Every inserted name is spelled the way a person would type it: bare when it
 * is a plain identifier, quoted (`"order items"`, `"select"`) otherwise, via
 * `sqliteIdentifierForSql()`. lang-sql would quote with backticks and leave a
 * `"` inside a name unescaped, so the catalog hands it ready-made completions.
 *
 * This module imports lang-sql statically. Load it with `import()` so the
 * grammar stays out of the main bundle until a query editor opens.
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { SQLite, sql, type SQLNamespace } from '@codemirror/lang-sql';
import type { EditorState, Extension } from '@codemirror/state';

import { sqliteIdentifierForSql } from '../../../shared/sqlite/sql';
import type { SqliteCatalogObject, SqliteColumnCatalog } from '../../../shared/sqlite/types';

/** A node of lang-sql's syntax tree (`@lezer/common` is not a direct dependency). */
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/** Ranks user objects above `sqlite_*` and shadow tables in the popup. */
const INTERNAL_BOOST = -10;

/** Nodes inside which no name is completed. */
const NO_COMPLETION_NODES = new Set(['String', 'LineComment', 'BlockComment', 'QuotedIdentifier']);

/** Whether `node` is a (possibly quoted) identifier token. */
function isIdentifierNode(node: SyntaxNode): boolean {
	return node.name === 'Identifier' || node.name === 'QuotedIdentifier';
}

/** A quoted identifier's name: quotes removed, a doubled quote read as one. */
export function unquoteSqlIdentifier(text: string): string {
	const quote = text[0];
	if ((quote === '"' || quote === '`') && text.length >= 2 && text.endsWith(quote)) {
		return text
			.slice(1, -1)
			.split(quote + quote)
			.join(quote);
	}
	return text;
}

function columnDetail(declaredType: string, owners: readonly string[]): string {
	const where = owners.join(', ');
	return declaredType ? `${declaredType} - ${where}` : where;
}

/** A table or view as a completion option. */
function objectCompletion(object: SqliteCatalogObject): Completion {
	return {
		label: object.name,
		apply: sqliteIdentifierForSql(object.name),
		type: object.kind === 'view' ? 'class' : 'type',
		detail: object.kind,
		...(object.internal ? { boost: INTERNAL_BOOST } : {}),
	};
}

/**
 * The catalog in lang-sql's `SQLNamespace` shape: one entry per table or
 * view, carrying its own completion and its columns'. A dot in a name is
 * escaped, since lang-sql reads an unescaped one as a schema separator.
 */
export function sqliteCompletionNamespace(catalog: SqliteColumnCatalog): SQLNamespace {
	const namespace: Record<string, SQLNamespace> = {};
	for (const object of catalog.objects) {
		namespace[object.name.replace(/\./g, '\\.')] = {
			self: objectCompletion(object),
			children: object.columns.map((column) => ({
				label: column.name,
				apply: sqliteIdentifierForSql(column.name),
				type: 'property',
				detail: columnDetail(column.declaredType, [object.name]),
			})),
		};
	}
	return namespace;
}

/**
 * The catalog objects a statement names, matched case-insensitively (SQLite
 * names are). `names` are identifier tokens already unquoted. When the
 * statement names none and the database has exactly one user table or view,
 * that one is assumed, so `SELECT |` completes before FROM is written.
 */
export function referencedCatalogObjects(
	names: readonly string[],
	catalog: SqliteColumnCatalog
): SqliteCatalogObject[] {
	const byName = new Map<string, SqliteCatalogObject>();
	for (const object of catalog.objects) {
		const folded = object.name.toLowerCase();
		if (!byName.has(folded)) byName.set(folded, object);
	}
	const found = new Map<string, SqliteCatalogObject>();
	for (const name of names) {
		const folded = name.toLowerCase();
		const object = byName.get(folded);
		if (object && !found.has(folded)) found.set(folded, object);
	}
	if (found.size > 0) return [...found.values()];
	const visible = catalog.objects.filter((object) => !object.internal);
	return visible.length === 1 ? visible : [];
}

/**
 * Bare column completions for the given objects. A column name several of
 * them share is offered once, its detail naming every owner.
 */
export function columnCompletions(objects: readonly SqliteCatalogObject[]): Completion[] {
	const byName = new Map<string, { name: string; declaredType: string; owners: string[] }>();
	for (const object of objects) {
		for (const column of object.columns) {
			const folded = column.name.toLowerCase();
			const entry = byName.get(folded);
			if (entry) entry.owners.push(object.name);
			else
				byName.set(folded, {
					name: column.name,
					declaredType: column.declaredType,
					owners: [object.name],
				});
		}
	}
	return [...byName.values()].map((entry) => ({
		label: entry.name,
		apply: sqliteIdentifierForSql(entry.name),
		type: 'property',
		detail: columnDetail(entry.owners.length === 1 ? entry.declaredType : '', entry.owners),
		// Above keywords and table names: inside a statement that names its
		// tables, a column is the likeliest next word.
		boost: 1,
	}));
}

/**
 * The statement the cursor at `pos` is writing, or null. A statement owns its
 * closing `;`, so a cursor after one is in the next statement; a cursor in the
 * whitespace after an unterminated statement is still in it (`... FROM users |`).
 */
function statementAt(state: EditorState, pos: number): SyntaxNode | null {
	let found: SyntaxNode | null = null;
	for (
		let child = syntaxTree(state).topNode.firstChild;
		child && child.from <= pos;
		child = child.nextSibling
	) {
		if (child.name !== 'Statement') continue;
		const ended = state.sliceDoc(child.to - 1, child.to) === ';';
		found = pos < child.to || !ended ? child : null;
	}
	return found;
}

/** Every identifier token in `statement`, unquoted, except the one being typed. */
function statementIdentifiers(
	context: CompletionContext,
	statement: SyntaxNode,
	typingFrom: number
): string[] {
	const names: string[] = [];
	const cursor = statement.cursor();
	do {
		if (isIdentifierNode(cursor.node) && cursor.from !== typingFrom) {
			names.push(unquoteSqlIdentifier(context.state.sliceDoc(cursor.from, cursor.to)));
		}
	} while (cursor.next() && cursor.from < statement.to);
	return names;
}

/**
 * Completion source for bare column names: the columns of the tables and
 * views the statement under the cursor names. Leaves `table.` positions to
 * lang-sql's schema source, and stays quiet inside strings, comments, and
 * quoted names.
 */
export function sqliteColumnCompletionSource(catalog: SqliteColumnCatalog) {
	return (context: CompletionContext): CompletionResult | null => {
		const word = context.matchBefore(/[A-Za-z_][\w$]*$/);
		if (!word && !context.explicit) return null;
		const from = word ? word.from : context.pos;
		if (from > 0 && context.state.sliceDoc(from - 1, from) === '.') return null;

		const node = syntaxTree(context.state).resolveInner(context.pos, -1);
		if (NO_COMPLETION_NODES.has(node.name)) return null;

		const statement = statementAt(context.state, context.pos);
		const names = statement ? statementIdentifiers(context, statement, from) : [];
		const options = columnCompletions(referencedCatalogObjects(names, catalog));
		if (options.length === 0) return null;
		return { from, options, validFor: /^[\w$]*$/ };
	};
}

/**
 * The SQL editor's language extension for one database: the SQLite dialect,
 * keyword completion, schema completion from `catalog`, and bare column
 * completion for the tables each statement names.
 */
export function buildSqliteSqlLanguage(catalog: SqliteColumnCatalog): Extension {
	return [
		sql({
			dialect: SQLite,
			schema: sqliteCompletionNamespace(catalog),
			upperCaseKeywords: true,
		}),
		SQLite.language.data.of({ autocomplete: sqliteColumnCompletionSource(catalog) }),
	];
}
