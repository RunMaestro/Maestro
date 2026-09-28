import { useCallback, useState } from 'react';
import type { StatsTimeRange, UsageExportFormat } from '../../../../../shared/stats-types';
import { fileTimestampSlug, formatNumber } from '../../../../../shared/formatters';
import { notifyToast } from '../../../../stores/notificationStore';
import { logger } from '../../../../utils/logger';

const SAVE_DIALOG: Record<UsageExportFormat, { extension: string; filterName: string }> = {
	json: { extension: 'json', filterName: 'JSON' },
	csv: { extension: 'zip', filterName: 'Zip of CSV files' },
};

export function useUsageDashboardExport(timeRange: StatsTimeRange) {
	const [isExporting, setIsExporting] = useState(false);

	const handleExport = useCallback(
		async (format: UsageExportFormat) => {
			const { extension, filterName } = SAVE_DIALOG[format];
			setIsExporting(true);
			try {
				const filePath = await window.maestro.dialog.saveFile({
					defaultPath: `maestro-usage-${timeRange}-${fileTimestampSlug()}.${extension}`,
					filters: [{ name: filterName, extensions: [extension] }],
					title: 'Export Usage Data',
				});

				if (!filePath) {
					return;
				}

				const result = await window.maestro.stats.exportUsage(timeRange, format, filePath);
				const rows = Object.values(result.rowCounts).reduce((sum, count) => sum + count, 0);
				notifyToast({
					color: 'green',
					title: 'Usage Data Exported',
					message: [`${formatNumber(rows)} rows saved to ${result.path}.`, ...result.notes].join(
						' '
					),
				});
			} catch (err) {
				logger.error('Failed to export usage data:', undefined, err);
				notifyToast({
					color: 'red',
					title: 'Could Not Export Usage Data',
					message: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setIsExporting(false);
			}
		},
		[timeRange]
	);

	return { isExporting, handleExport };
}
