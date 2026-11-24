/**
 * SQL text helpers for the SQLite viewer.
 *
 * Values always travel as bound parameters. Identifiers (table and column
 * names) cannot be bound, so they are the one thing the viewer splices into
 * SQL text, and they go through `quoteSqliteIdentifier()` without exception.
 * `sqliteIdentifierForSql()` is the readable spelling for SQL a PERSON writes
 * (editor completion), never for SQL the viewer runs on its own.
 */

/**
 * Quote a table, index, or column name for use in SQL text.
 *
 * Wraps the name in double quotes and doubles any double quote inside it,
 * which is SQLite's own rule for delimited identifiers. Any name, including
 * one with spaces, quotes, semicolons, or a keyword's spelling, comes out as
 * exactly one identifier.
 */
export function quoteSqliteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * SQLite's reserved words, from https://www.sqlite.org/lang_keywords.html.
 * A name spelled like one of these must be quoted to be read as a name.
 */
const SQLITE_KEYWORDS: ReadonlySet<string> = new Set(
	(
		'ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE ' +
		'BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE ' +
		'CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE ' +
		'DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE ' +
		'EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP ' +
		'GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT ' +
		'INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING ' +
		'NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING ' +
		'PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE ' +
		'RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN ' +
		'TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL ' +
		'WHEN WHERE WINDOW WITH WITHOUT'
	).split(' ')
);

/** Whether `name` is one of SQLite's reserved words, in any letter case. */
export function isSqliteKeyword(name: string): boolean {
	return SQLITE_KEYWORDS.has(name.toUpperCase());
}

/**
 * A name as a person would type it into SQL: bare when it is a plain
 * identifier (letters, digits, underscores, not starting with a digit, not a
 * reserved word), quoted through `quoteSqliteIdentifier()` otherwise. For text
 * a person reads and edits, such as an editor completion; SQL the viewer
 * builds itself always quotes.
 */
export function sqliteIdentifierForSql(name: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isSqliteKeyword(name)
		? name
		: quoteSqliteIdentifier(name);
}
