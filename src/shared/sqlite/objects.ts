/**
 * Pure helpers over the table-list rail's data, shared by the renderer's
 * SQLite viewer and `maestro-cli sqlite tables`, so both group and label the
 * same objects the same way.
 */

import { formatCount } from '../formatters';
import type { SqliteObjectKind, SqliteObjectStats, SqliteObjectSummary } from './types';

/** Rail order: what a reader opens a database for comes first. */
export const SQLITE_OBJECT_KINDS: readonly SqliteObjectKind[] = [
	'table',
	'view',
	'index',
	'trigger',
];

/** Plural section heading for each kind. */
export const SQLITE_OBJECT_KIND_LABELS: Record<SqliteObjectKind, string> = {
	table: 'Tables',
	view: 'Views',
	index: 'Indexes',
	trigger: 'Triggers',
};

/**
 * Group objects by kind in rail order, names sorted case-insensitively.
 * Internal objects are dropped unless `includeInternal` is set; every kind
 * keeps its entry (possibly empty) so callers can show a zero count.
 */
export function groupSqliteObjects(
	objects: readonly SqliteObjectSummary[],
	includeInternal: boolean
): Array<{ kind: SqliteObjectKind; objects: SqliteObjectSummary[] }> {
	return SQLITE_OBJECT_KINDS.map((kind) => ({
		kind,
		objects: objects
			.filter((object) => object.kind === kind && (includeInternal || !object.internal))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
	}));
}

/**
 * A row count as the rail shows it: `1,204`, `100,000+` when the count hit its
 * cap, or null when there is nothing to show.
 */
export function formatSqliteRowCount(
	stats: Pick<SqliteObjectStats, 'rowCount' | 'rowCountCapped'> | undefined
): string | null {
	if (!stats || stats.rowCount === null) return null;
	return `${formatCount(stats.rowCount)}${stats.rowCountCapped ? '+' : ''}`;
}

/** Short tags for an object's flavour: `virtual`, `without rowid`, `strict`, `shadow`. */
export function sqliteObjectTags(object: SqliteObjectSummary): string[] {
	const tags: string[] = [];
	if (object.tableType === 'virtual') tags.push('virtual');
	if (object.tableType === 'shadow') tags.push('shadow');
	if (object.withoutRowid) tags.push('without rowid');
	if (object.strict) tags.push('strict');
	return tags;
}

/**
 * The order objects are measured in: what the rail shows first, then the
 * internal objects it hides by default. Views and triggers have nothing to
 * measure and are left out.
 */
export function sqliteMeasurementOrder(objects: readonly SqliteObjectSummary[]): string[] {
	const visible = groupSqliteObjects(objects, false).flatMap((group) => group.objects);
	const internal = groupSqliteObjects(
		objects.filter((object) => object.internal),
		true
	).flatMap((group) => group.objects);
	return [...visible, ...internal]
		.filter((object) => object.countable || object.hasStorage)
		.map((object) => object.name);
}
