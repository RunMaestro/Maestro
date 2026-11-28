/**
 * The SQL editor's schema-aware completion, against the real lang-sql parser:
 * bare columns of the tables a statement names, `table.` / `alias.` columns
 * from lang-sql's schema source, names spelled the way a person types them,
 * and silence inside strings and after a statement ends.
 */

import { describe, expect, it } from 'vitest';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';

import {
	buildSqliteSqlLanguage,
	columnCompletions,
	referencedCatalogObjects,
	sqliteColumnCompletionSource,
	sqliteCompletionNamespace,
	unquoteSqlIdentifier,
} from '../../../../renderer/components/SqliteViewer/sqliteSqlLanguage';
import type { SqliteColumnCatalog } from '../../../../shared/sqlite/types';

const catalog: SqliteColumnCatalog = {
	objects: [
		{
			name: 'users',
			kind: 'table',
			internal: false,
			columns: [
				{ name: 'id', declaredType: 'INTEGER' },
				{ name: 'email', declaredType: 'TEXT' },
				{ name: 'order', declaredType: '' },
			],
		},
		{
			name: 'order items',
			kind: 'table',
			internal: false,
			columns: [
				{ name: 'id', declaredType: 'INTEGER' },
				{ name: 'user_id', declaredType: 'INTEGER' },
			],
		},
		{ name: 'recent', kind: 'view', internal: false, columns: [] },
		{
			name: 'sqlite_master',
			kind: 'table',
			internal: true,
			columns: [{ name: 'name', declaredType: 'TEXT' }],
		},
	],
};

const language = buildSqliteSqlLanguage(catalog);

/** Editor state for `doc`, where `|` marks the cursor. */
function at(doc: string): { state: EditorState; pos: number } {
	const pos = doc.indexOf('|');
	const state = EditorState.create({ doc: doc.replace('|', ''), extensions: [language] });
	ensureSyntaxTree(state, state.doc.length, 5_000);
	return { state, pos };
}

/** What the bare-column source offers at `|`, as `label=>insert`. */
function bareColumns(doc: string, explicit = false): string[] | null {
	const { state, pos } = at(doc);
	const result = sqliteColumnCompletionSource(catalog)(
		new CompletionContext(state, pos, explicit)
	) as CompletionResult | null;
	return result ? result.options.map((option) => `${option.label}=>${option.apply}`) : null;
}

/** Every non-keyword option any completion source offers at `|`. */
async function allNames(doc: string, explicit = false): Promise<string[]> {
	const { state, pos } = at(doc);
	const labels: string[] = [];
	for (const source of state.languageDataAt<unknown>('autocomplete', pos)) {
		if (typeof source !== 'function') continue;
		const result = (await source(
			new CompletionContext(state, pos, explicit)
		)) as CompletionResult | null;
		for (const option of result?.options ?? []) {
			if (option.type !== 'keyword') labels.push(option.label);
		}
	}
	return labels;
}

describe('unquoteSqlIdentifier', () => {
	it('strips double quotes and backticks, reading a doubled quote as one', () => {
		expect(unquoteSqlIdentifier('"order items"')).toBe('order items');
		expect(unquoteSqlIdentifier('"we""ird"')).toBe('we"ird');
		expect(unquoteSqlIdentifier('`users`')).toBe('users');
	});

	it('leaves a bare name alone', () => {
		expect(unquoteSqlIdentifier('users')).toBe('users');
		expect(unquoteSqlIdentifier('"')).toBe('"');
	});
});

describe('sqliteCompletionNamespace', () => {
	it('gives each object its own completion and quotes names that need it', () => {
		const namespace = sqliteCompletionNamespace(catalog) as unknown as Record<
			string,
			{ self: { label: string; apply: string; boost?: number }; children: Array<{ apply: string }> }
		>;
		expect(namespace['order items'].self).toMatchObject({
			label: 'order items',
			apply: '"order items"',
		});
		expect(namespace.users.children.map((column) => column.apply)).toEqual([
			'id',
			'email',
			'"order"',
		]);
		expect(namespace.sqlite_master.self.boost).toBeLessThan(0);
		expect(namespace.users.self.boost).toBeUndefined();
	});

	it('escapes a dot so lang-sql does not read it as a schema separator', () => {
		const namespace = sqliteCompletionNamespace({
			objects: [{ name: 'a.b', kind: 'table', internal: false, columns: [] }],
		});
		expect(Object.keys(namespace)).toEqual(['a\\.b']);
	});
});

describe('referencedCatalogObjects', () => {
	it('matches statement names to catalog objects case-insensitively, once each', () => {
		expect(
			referencedCatalogObjects(['SELECT', 'USERS', 'users', 'order items'], catalog).map(
				(object) => object.name
			)
		).toEqual(['users', 'order items']);
	});

	it('assumes the only user table when the statement names none', () => {
		const single: SqliteColumnCatalog = {
			objects: [catalog.objects[0], catalog.objects[3]],
		};
		expect(referencedCatalogObjects([], single).map((object) => object.name)).toEqual(['users']);
		expect(referencedCatalogObjects([], catalog)).toEqual([]);
	});
});

describe('columnCompletions', () => {
	it('offers a shared column once, naming every owner', () => {
		const options = columnCompletions([catalog.objects[0], catalog.objects[1]]);
		const id = options.find((option) => option.label === 'id');
		expect(id?.detail).toBe('users, order items');
		expect(options.find((option) => option.label === 'email')?.detail).toBe('TEXT - users');
		expect(options.map((option) => option.label)).toEqual(['id', 'email', 'order', 'user_id']);
	});
});

describe('sqliteColumnCompletionSource', () => {
	it("completes the columns of the statement's table, before FROM is even reached", () => {
		expect(bareColumns('SELECT em| FROM users')).toEqual([
			'id=>id',
			'email=>email',
			'order=>"order"',
		]);
	});

	it('completes both sides of a join', () => {
		expect(bareColumns('SELECT * FROM users JOIN "order items" ON u|')).toEqual([
			'id=>id',
			'email=>email',
			'order=>"order"',
			'user_id=>user_id',
		]);
	});

	it('completes in the whitespace after an unterminated statement on request', () => {
		expect(bareColumns('SELECT * FROM users WHERE |', true)).toContain('email=>email');
		expect(bareColumns('SELECT * FROM users WHERE |')).toBeNull();
	});

	it('does not carry tables over from a statement that has ended', () => {
		expect(bareColumns('SELECT * FROM users; SELECT i|')).toBeNull();
	});

	it('leaves dotted positions to the schema source and stays out of strings', () => {
		expect(bareColumns('SELECT users.e|')).toBeNull();
		expect(bareColumns("SELECT 'em|' FROM users")).toBeNull();
	});

	it('does not count the word being typed as a table name', () => {
		expect(bareColumns('SELECT * FROM users|')).toBeNull();
	});
});

describe('buildSqliteSqlLanguage', () => {
	it('completes table and view names at the top level', async () => {
		const names = await allNames('SELECT * FROM r|');
		expect(names).toEqual(expect.arrayContaining(['users', 'order items', 'recent']));
	});

	it('completes table. and alias. columns through lang-sql', async () => {
		expect(await allNames('SELECT users.|')).toEqual(['id', 'email', 'order']);
		expect(await allNames('SELECT oi.| FROM "order items" oi')).toEqual(['id', 'user_id']);
	});

	it('offers upper-case keywords', async () => {
		const { state, pos } = at('sel|');
		const keywords: string[] = [];
		for (const source of state.languageDataAt<unknown>('autocomplete', pos)) {
			if (typeof source !== 'function') continue;
			const result = (await source(
				new CompletionContext(state, pos, false)
			)) as CompletionResult | null;
			for (const option of result?.options ?? []) {
				if (option.type === 'keyword') keywords.push(option.label);
			}
		}
		expect(keywords).toContain('SELECT');
	});
});
