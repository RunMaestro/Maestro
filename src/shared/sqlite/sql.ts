/**
 * SQL text helpers for the SQLite viewer.
 *
 * Values always travel as bound parameters. Identifiers (table and column
 * names) cannot be bound, so they are the one thing the viewer splices into
 * SQL text, and they go through `quoteSqliteIdentifier()` without exception.
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
