/**
 * CsvRowDetailModal - the record view for a CSV/TSV row.
 *
 * A thin adapter over the shared `<RecordDetailModal>`: it turns a positional
 * CSV row into the field/value list every tabular preview shows, and supplies
 * the CSV surface's own modal priority, remembered size, and test ids.
 *
 * The mapping is the only CSV-specific part. Rows in a delimited file can be
 * short, so fields are generated from the file's widest row rather than from
 * this row's own length, and a blank header cell falls back to a positional
 * name so the record view never shows an unlabelled value.
 */

import { useMemo } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { RecordDetailModal, type RecordDetailField } from './ui/RecordDetailModal';

interface CsvRowDetailModalProps {
	/** Header cells from the first CSV row, used as field names */
	headers: string[];
	/** Cells of the row being inspected */
	row: string[];
	/** Total column count across the file (rows may be short) */
	columnCount: number;
	/** 0-based position of this row within the displayed rows */
	index: number;
	/** How many rows the table is currently displaying */
	total: number;
	/** Move to another displayed row (already clamped by the caller) */
	onNavigate: (nextIndex: number) => void;
	onClose: () => void;
	theme: Theme;
}

export function CsvRowDetailModal({
	headers,
	row,
	columnCount,
	index,
	total,
	onNavigate,
	onClose,
	theme,
}: CsvRowDetailModalProps) {
	const fields = useMemo<RecordDetailField[]>(
		() =>
			Array.from({ length: columnCount }, (_, i) => ({
				key: headers[i]?.trim() || `Column ${i + 1}`,
				value: row[i] ?? '',
			})),
		[headers, row, columnCount]
	);

	return (
		<RecordDetailModal
			fields={fields}
			index={index}
			total={total}
			onNavigate={onNavigate}
			onClose={onClose}
			theme={theme}
			priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
			resizeKey="csv-row-detail"
			testIdPrefix="csv-row-detail"
		/>
	);
}
