/**
 * ParquetGrid - the parquet viewer's adapter over the shared `<DataGrid>`.
 *
 * The grid itself (virtualized rows, column resize, sort headers) lives in
 * src/renderer/components/ui/DataGrid.tsx and is shared with the SQLite
 * viewer. This file only maps parquet's schema and typed cells onto it:
 * widths seeded from the column's value kind, the type badge, the alignment,
 * and the hover filter shortcut in each header.
 */

import { useCallback, useMemo } from 'react';
import { Filter } from 'lucide-react';

import type {
	ParquetCellValue,
	ParquetColumnInfo,
	ParquetSortSpec,
} from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import {
	DataGrid,
	dataGridColumnWidth,
	type DataGridCell,
	type DataGridColumn,
} from '../ui/DataGrid';
import { columnAlignment, columnTypeBadge, formatCell, quoteColumnName } from './parquetFormat';

/** Typical content width for a column of this kind, before the header is considered. */
function contentWidth(column: ParquetColumnInfo): number {
	if (column.kind === 'boolean') return 80;
	if (column.kind === 'timestamp') return 172;
	if (column.kind === 'date') return 110;
	if (column.kind === 'integer' || column.kind === 'float' || column.kind === 'decimal') return 120;
	if (column.nested || column.kind === 'json') return 260;
	return 180;
}

function toGridColumn(column: ParquetColumnInfo): DataGridColumn {
	return {
		key: column.name,
		label: column.name,
		subtitle: `${columnTypeBadge(column)}${column.optional ? '' : ' · required'}`,
		title: column.nested
			? `${column.name} - nested column, cannot be sorted`
			: `${column.name} (${column.logicalType ?? column.physicalType ?? ''}) - click to sort`,
		initialWidth: dataGridColumnWidth(column.name, contentWidth(column)),
		align: columnAlignment(column.kind),
		sortable: !column.nested,
	};
}

interface ParquetGridProps {
	columns: ParquetColumnInfo[];
	rows: ParquetCellValue[][];
	/** File row index for each loaded row, shown in the gutter. */
	rowIndexes: number[];
	theme: Theme;
	sort: ParquetSortSpec | null;
	onSortChange: (sort: ParquetSortSpec | null) => void;
	/** Open the record view for a loaded row. */
	onOpenRow: (rowPosition: number) => void;
	/** Append a clause to the filter, from a header or cell affordance. */
	onAddFilterClause: (clause: string) => void;
	/** Called when the viewport nears the end of the loaded rows. */
	onReachEnd: () => void;
	/** True while more rows are on the way, for the trailing spinner row. */
	loadingMore: boolean;
}

export function ParquetGrid({
	columns,
	rows,
	rowIndexes,
	theme,
	sort,
	onSortChange,
	onOpenRow,
	onAddFilterClause,
	onReachEnd,
	loadingMore,
}: ParquetGridProps) {
	const gridColumns = useMemo(() => columns.map(toGridColumn), [columns]);

	const getCell = useCallback(
		(rowPosition: number, columnPosition: number): DataGridCell => {
			const value = rows[rowPosition]?.[columnPosition] ?? null;
			if (value === null) return { text: 'null', placeholder: true };
			return { text: formatCell(value, columns[columnPosition].kind) };
		},
		[rows, columns]
	);

	const getRowLabel = useCallback(
		(rowPosition: number) => (rowIndexes[rowPosition] ?? rowPosition).toLocaleString(),
		[rowIndexes]
	);

	return (
		<DataGrid
			columns={gridColumns}
			rowCount={rows.length}
			getCell={getCell}
			getRowLabel={getRowLabel}
			gutterTitle="Row index within the file"
			theme={theme}
			sort={sort}
			onSortChange={onSortChange}
			onOpenRow={onOpenRow}
			renderHeaderAction={(column) => (
				<button
					type="button"
					onClick={() => onAddFilterClause(quoteColumnName(column.key))}
					className="opacity-0 group-hover:opacity-100 shrink-0 transition-opacity"
					title={`Filter on ${column.label}`}
					aria-label={`Filter on ${column.label}`}
				>
					<Filter className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}
			onReachEnd={onReachEnd}
			loadingMore={loadingMore}
			emptyMessage="No columns selected."
			testIdPrefix="parquet"
		/>
	);
}
