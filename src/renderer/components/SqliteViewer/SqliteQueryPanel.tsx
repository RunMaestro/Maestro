/**
 * SqliteQueryPanel - the SQLite viewer's SQL editor.
 *
 * The shared CodeMirror editor (`MarkdownEditor` in code-editor mode, the
 * same one the file editor uses) with the SQLite dialect and completion built
 * from the open database: keywords, table and view names, `table.` and
 * `alias.` columns, and the bare columns of the tables a statement names (see
 * `sqliteSqlLanguage.ts`).
 *
 * The column catalog is read once per open database over
 * `sqlite:readColumns` (schema metadata only, instant on any size). The
 * grammar module is loaded with `import()` so lang-sql stays out of the main
 * bundle until a query editor opens. Until both arrive, the editor runs on
 * the plain SQL grammar the language loader provides, so typing never waits
 * on them; a catalog that fails to load leaves keyword completion and says so.
 *
 * The query text is owned by the viewer (`value` / `onChange`), so switching
 * to Browse and back keeps what was typed.
 */

import { useEffect, useState } from 'react';
import type { Extension } from '@codemirror/state';

import type { Theme } from '../../types';
import { MarkdownEditor } from '../FilePreview/markdownEditor';

interface SqliteQueryPanelProps {
	handle: string;
	value: string;
	onChange: (value: string) => void;
	theme: Theme;
}

/**
 * The editor's host keydown hook. Passing one is what lets an open
 * completion popup keep Escape, Enter, and the arrows from the file preview
 * (see `editorClaimsKey`); the panel itself claims no key.
 */
const leaveKeysToEditor = (): boolean => false;

export function SqliteQueryPanel({ handle, value, onChange, theme }: SqliteQueryPanelProps) {
	const [language, setLanguage] = useState<Extension | undefined>(undefined);
	const [catalogError, setCatalogError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLanguage(undefined);
		setCatalogError(null);
		Promise.all([window.maestro.sqlite.readColumns(handle), import('./sqliteSqlLanguage')])
			.then(([catalog, grammar]) => {
				if (!cancelled) setLanguage(grammar.buildSqliteSqlLanguage(catalog));
			})
			.catch((error: unknown) => {
				if (!cancelled) setCatalogError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [handle]);

	return (
		<div className="flex flex-col h-full min-h-0" data-testid="sqlite-query-panel">
			<div className="flex-1 min-h-0">
				<MarkdownEditor
					value={value}
					onChange={onChange}
					language="sql"
					languageExtension={language}
					theme={theme}
					codeEditing
					completion="typing"
					showLineNumbers
					wrap
					placeholder="SELECT * FROM ..."
					onKeyDown={leaveKeysToEditor}
				/>
			</div>
			<div
				className="shrink-0 px-3 py-1.5 text-xs-plus flex gap-3 flex-wrap select-none"
				style={{ borderTop: `1px solid ${theme.colors.border}`, color: theme.colors.textDim }}
				data-testid="sqlite-query-status"
			>
				{catalogError ? (
					<span style={{ color: theme.colors.warning }} data-testid="sqlite-query-catalog-error">
						Completing keywords only. The table and column names could not be read: {catalogError}
					</span>
				) : (
					<span>
						Completes keywords, table names, and the columns of the tables a statement names.
						Ctrl+Space asks for suggestions.
					</span>
				)}
			</div>
		</div>
	);
}
