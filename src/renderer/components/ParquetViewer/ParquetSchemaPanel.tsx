/**
 * ParquetSchemaPanel - the column rail beside the grid.
 *
 * Parquet carries far more about a column than a header cell can show: its
 * physical and logical type, whether it is nullable, how many nulls it
 * actually has, the min/max the writer recorded, the codec, and how many bytes
 * it costs. All of that comes out of the footer for free, and it answers the
 * questions people actually open a parquet file to ask - which column is
 * enormous, which is mostly null, what range does this cover.
 *
 * Every row is also a control: the eye hides the column from the grid (which
 * skips decoding it entirely on the next page), and clicking the name drops a
 * clause into the filter so the schema doubles as the filter's discovery
 * surface.
 */

import { Eye, EyeOff, Ruler } from 'lucide-react';

import type { ParquetColumnInfo, ParquetFileInfo } from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import { formatCount, formatSize } from '../../../shared/formatters';
import { columnTypeBadge, formatCell, quoteColumnName } from './parquetFormat';

interface ParquetSchemaPanelProps {
	info: ParquetFileInfo;
	hiddenColumns: Set<string>;
	onToggleColumn: (name: string) => void;
	onFilterOnColumn: (clause: string) => void;
	theme: Theme;
}

/** Statistics line for one column, or a note when the writer omitted them. */
function StatsLine({ column, theme }: { column: ParquetColumnInfo; theme: Theme }) {
	if (column.nested) {
		return (
			<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
				nested - rendered as JSON
			</span>
		);
	}
	if (column.stats.min === null && column.stats.max === null) {
		return (
			<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
				no statistics recorded
			</span>
		);
	}
	return (
		<span className="text-[10px] truncate block" style={{ color: theme.colors.textDim }}>
			{formatCell(column.stats.min, column.kind)} … {formatCell(column.stats.max, column.kind)}
			{column.stats.partial ? ' (partial)' : ''}
		</span>
	);
}

export function ParquetSchemaPanel({
	info,
	hiddenColumns,
	onToggleColumn,
	onFilterOnColumn,
	theme,
}: ParquetSchemaPanelProps) {
	// Size bars are relative to the widest column, so the rail answers "what is
	// making this file big" at a glance rather than after arithmetic.
	const largestColumn = Math.max(1, ...info.columns.map((column) => column.compressedBytes));

	return (
		<div
			className="h-full overflow-y-auto shrink-0 select-none"
			style={{
				width: 268,
				borderRight: `1px solid ${theme.colors.border}`,
				backgroundColor: theme.colors.bgSidebar,
			}}
			data-testid="parquet-schema-panel"
		>
			<div
				className="px-3 py-2 sticky top-0 z-10 flex items-center gap-2"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderBottom: `1px solid ${theme.colors.border}`,
				}}
			>
				<Ruler className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
					Schema
				</span>
				<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
					{info.columns.length} columns
				</span>
			</div>

			{info.columns.map((column) => {
				const hidden = hiddenColumns.has(column.name);
				const nullShare =
					column.stats.nullCount !== null && info.totalRows > 0
						? column.stats.nullCount / info.totalRows
						: null;
				return (
					<div
						key={column.name}
						className="px-3 py-2 group"
						style={{
							borderBottom: `1px solid ${theme.colors.border}40`,
							opacity: hidden ? 0.45 : 1,
						}}
					>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => onFilterOnColumn(`${quoteColumnName(column.name)} = `)}
								className="flex-1 min-w-0 text-left"
								title={`Filter on ${column.name}`}
							>
								<span
									className="text-xs font-mono truncate block"
									style={{ color: theme.colors.textMain }}
								>
									{column.name}
								</span>
							</button>
							<button
								type="button"
								onClick={() => onToggleColumn(column.name)}
								title={hidden ? `Show ${column.name}` : `Hide ${column.name}`}
								aria-label={hidden ? `Show ${column.name}` : `Hide ${column.name}`}
								className="shrink-0"
								data-testid={`parquet-column-toggle-${column.name}`}
							>
								{hidden ? (
									<EyeOff className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								) : (
									<Eye className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								)}
							</button>
						</div>

						<div className="flex items-center gap-2 mt-0.5">
							<span
								className="text-[10px] px-1 rounded font-mono shrink-0"
								style={{
									backgroundColor: `${theme.colors.accent}22`,
									color: theme.colors.accentText,
								}}
							>
								{columnTypeBadge(column)}
							</span>
							{!column.optional && (
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									required
								</span>
							)}
							{nullShare !== null && nullShare > 0 && (
								<span
									className="text-[10px]"
									style={{ color: nullShare > 0.5 ? theme.colors.warning : theme.colors.textDim }}
									title={`${formatCount(column.stats.nullCount ?? 0)} null values`}
								>
									{nullShare >= 0.995
										? '~100'
										: (nullShare * 100).toFixed(nullShare < 0.01 ? 2 : 0)}
									% null
								</span>
							)}
						</div>

						<div className="mt-1">
							<StatsLine column={column} theme={theme} />
						</div>

						<div className="mt-1.5 flex items-center gap-2">
							<div
								className="flex-1 h-1 rounded"
								style={{ backgroundColor: `${theme.colors.border}` }}
							>
								<div
									className="h-1 rounded"
									style={{
										width: `${Math.max(2, (column.compressedBytes / largestColumn) * 100)}%`,
										backgroundColor: theme.colors.accent,
									}}
								/>
							</div>
							<span
								className="text-[10px] shrink-0 tabular-nums"
								style={{ color: theme.colors.textDim }}
								title={`${formatSize(column.compressedBytes)} compressed, ${formatSize(column.uncompressedBytes)} raw${column.compression ? ` (${column.compression})` : ''}`}
							>
								{formatSize(column.compressedBytes)}
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}
