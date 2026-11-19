/**
 * SqliteSchemaPanel - the structure of the object selected in the SQLite
 * viewer's rail.
 *
 * A table or view shows its columns: declared type, the affinity SQLite
 * derives from it (a preference, not a constraint, unless the table is
 * STRICT), nullability, default, primary key position, and the foreign keys
 * each column takes part in. An index shows its key columns. Every object
 * ends with its original `CREATE` statement from `sqlite_master`, verbatim.
 *
 * The schema is read on selection over `sqlite:readSchema`. It is metadata
 * only, so it answers at once; a stale reply from an earlier selection is
 * dropped rather than shown under the wrong name.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';

import type {
	SqliteColumnSchema,
	SqliteObjectSchema,
	SqliteObjectSummary,
} from '../../../shared/sqlite/types';
import {
	SQLITE_INDEX_ORIGIN_LABELS,
	formatSqliteColumnReferences,
	formatSqliteForeignKey,
	formatSqliteIndexColumn,
	sqliteMissingSqlNote,
} from '../../../shared/sqlite/schema';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { SkeletonBox } from '../ui/SkeletonBox';
import { PrismHighlightedCode } from '../Markdown/components/PrismCodeBlock';

interface SqliteSchemaPanelProps {
	handle: string;
	object: SqliteObjectSummary;
	theme: Theme;
}

type SchemaState =
	| { status: 'loading' }
	| { status: 'ready'; schema: SqliteObjectSchema }
	| { status: 'error'; message: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function Section({ title, theme, children }: { title: string; theme: Theme; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-1.5">
			<h3
				className="text-xs font-semibold uppercase tracking-wide"
				style={{ color: theme.colors.textDim }}
			>
				{title}
			</h3>
			{children}
		</section>
	);
}

function Th({ children, theme }: { children: ReactNode; theme: Theme }) {
	return (
		<th
			className="text-left font-medium px-2 py-1 whitespace-nowrap"
			style={{ color: theme.colors.textDim, borderBottom: `1px solid ${theme.colors.border}` }}
		>
			{children}
		</th>
	);
}

function Td({
	children,
	theme,
	mono = false,
	dim = false,
}: {
	children: ReactNode;
	theme: Theme;
	mono?: boolean;
	dim?: boolean;
}) {
	return (
		<td
			className={`px-2 py-1 align-top ${mono ? 'font-mono' : ''}`}
			style={{
				color: dim ? theme.colors.textDim : theme.colors.textMain,
				borderBottom: `1px solid ${theme.colors.border}`,
			}}
		>
			{children}
		</td>
	);
}

function ColumnRow({ column, theme }: { column: SqliteColumnSchema; theme: Theme }) {
	const references = formatSqliteColumnReferences(column);
	return (
		<tr data-testid="sqlite-schema-column">
			<Td theme={theme} mono>
				<span className="inline-flex items-center gap-1.5 flex-wrap">
					{column.primaryKeyPosition > 0 ? (
						<KeyRound
							className="w-3 h-3 shrink-0"
							style={{ color: theme.colors.accent }}
							aria-label={`Primary key, position ${column.primaryKeyPosition}`}
						/>
					) : null}
					{column.name}
					{column.generated && <MiniBadge label={`generated ${column.generated}`} theme={theme} />}
					{column.hidden && <MiniBadge label="hidden" theme={theme} color={theme.colors.textDim} />}
				</span>
			</Td>
			<Td theme={theme} mono dim={column.declaredType === ''}>
				{column.declaredType || 'none'}
			</Td>
			<Td theme={theme} mono>
				{column.affinity}
			</Td>
			<Td theme={theme} dim={!column.notNull}>
				{column.notNull ? 'NOT NULL' : 'nullable'}
			</Td>
			<Td theme={theme} mono dim={column.defaultValue === null}>
				{column.defaultValue ?? '-'}
			</Td>
			<Td theme={theme} mono dim={column.primaryKeyPosition === 0}>
				{column.primaryKeyPosition > 0 ? column.primaryKeyPosition : '-'}
			</Td>
			<Td theme={theme} mono dim={references === ''}>
				{references || '-'}
			</Td>
		</tr>
	);
}

function SchemaBody({ schema, theme }: { schema: SqliteObjectSchema; theme: Theme }) {
	const missingSql = sqliteMissingSqlNote(schema);
	return (
		<div className="flex flex-col gap-4" data-testid="sqlite-schema">
			{schema.error && (
				<div className="text-xs" style={{ color: theme.colors.warning }}>
					Columns could not be read: {schema.error}
				</div>
			)}

			{schema.columns.length > 0 && (
				<Section title={`Columns (${schema.columns.length})`} theme={theme}>
					<div className="overflow-x-auto">
						<table className="text-xs border-collapse min-w-full">
							<thead>
								<tr>
									<Th theme={theme}>Name</Th>
									<Th theme={theme}>Declared type</Th>
									<Th theme={theme}>Affinity</Th>
									<Th theme={theme}>Null</Th>
									<Th theme={theme}>Default</Th>
									<Th theme={theme}>PK</Th>
									<Th theme={theme}>References</Th>
								</tr>
							</thead>
							<tbody>
								{schema.columns.map((column) => (
									<ColumnRow key={column.name} column={column} theme={theme} />
								))}
							</tbody>
						</table>
					</div>
				</Section>
			)}

			{schema.foreignKeys.length > 0 && (
				<Section title={`Foreign keys (${schema.foreignKeys.length})`} theme={theme}>
					<ul className="flex flex-col gap-0.5 text-xs font-mono">
						{schema.foreignKeys.map((key, position) => (
							<li
								key={position}
								style={{ color: theme.colors.textMain }}
								data-testid="sqlite-schema-foreign-key"
							>
								{formatSqliteForeignKey(key)}
							</li>
						))}
					</ul>
				</Section>
			)}

			{schema.index && (
				<Section title={`Key columns (${schema.index.columns.length})`} theme={theme}>
					<div className="flex items-center gap-1.5 flex-wrap">
						{schema.index.unique && <MiniBadge label="unique" theme={theme} />}
						{schema.index.partial && <MiniBadge label="partial" theme={theme} />}
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							from {SQLITE_INDEX_ORIGIN_LABELS[schema.index.origin]}
						</span>
					</div>
					<div className="overflow-x-auto">
						<table className="text-xs border-collapse min-w-full">
							<thead>
								<tr>
									<Th theme={theme}>Column</Th>
									<Th theme={theme}>Order</Th>
									<Th theme={theme}>Collation</Th>
								</tr>
							</thead>
							<tbody>
								{schema.index.columns.map((column, position) => (
									<tr key={position} data-testid="sqlite-schema-index-column">
										<Td theme={theme} mono dim={column.name === null}>
											{formatSqliteIndexColumn(column)}
										</Td>
										<Td theme={theme} mono>
											{column.descending ? 'DESC' : 'ASC'}
										</Td>
										<Td theme={theme} mono>
											{column.collation}
										</Td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Section>
			)}

			<Section title="CREATE statement" theme={theme}>
				{missingSql ? (
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{missingSql}
					</div>
				) : (
					<PrismHighlightedCode
						code={schema.sql ?? ''}
						language="sql"
						theme={theme}
						codeBlockStyle={{ margin: '0', fontSize: '0.8em', padding: '0.75em' }}
					/>
				)}
			</Section>
		</div>
	);
}

export function SqliteSchemaPanel({ handle, object, theme }: SqliteSchemaPanelProps) {
	const [state, setState] = useState<SchemaState>({ status: 'loading' });
	const { name, kind } = object;

	useEffect(() => {
		let cancelled = false;
		setState({ status: 'loading' });
		window.maestro.sqlite
			.readSchema(handle, name, kind)
			.then((schema) => {
				if (!cancelled) setState({ status: 'ready', schema });
			})
			.catch((error: unknown) => {
				if (!cancelled) setState({ status: 'error', message: errorText(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [handle, name, kind]);

	if (state.status === 'error') {
		return (
			<div
				className="text-xs"
				style={{ color: theme.colors.warning }}
				data-testid="sqlite-schema-error"
			>
				Could not read the schema of {name}: {state.message}
			</div>
		);
	}
	if (state.status === 'loading') {
		return (
			<div className="flex flex-col gap-2" data-testid="sqlite-schema-loading">
				<SkeletonBox theme={theme} className="h-4 w-1/3" />
				<SkeletonBox theme={theme} className="h-24 w-full" />
			</div>
		);
	}
	return <SchemaBody schema={state.schema} theme={theme} />;
}
