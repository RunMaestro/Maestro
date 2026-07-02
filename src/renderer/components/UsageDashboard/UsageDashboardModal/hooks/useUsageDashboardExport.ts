import { useCallback, useState } from 'react';
import type { StatsTimeRange } from '../../../../../shared/stats-types';
import { logger } from '../../../../utils/logger';

export function useUsageDashboardExport(timeRange: StatsTimeRange) {
	const [isExporting, setIsExporting] = useState(false);

	const handleExport = useCallback(async () => {
		setIsExporting(true);
		try {
			const defaultFilename = `maestro-usage-${timeRange}-${new Date().toISOString().split('T')[0]}.csv`;
			const filePath = await window.maestro.dialog.saveFile({
				defaultPath: defaultFilename,
				filters: [{ name: 'CSV Files', extensions: ['csv'] }],
				title: 'Export Usage Data',
			});

			if (!filePath) {
				return;
			}

			const csv = await window.maestro.stats.exportCsv(timeRange);
			await window.maestro.fs.writeFile(filePath, csv);
		} catch (err) {
			logger.error('Failed to export CSV:', undefined, err);
		} finally {
			setIsExporting(false);
		}
	}, [timeRange]);

	return { isExporting, handleExport };
}
