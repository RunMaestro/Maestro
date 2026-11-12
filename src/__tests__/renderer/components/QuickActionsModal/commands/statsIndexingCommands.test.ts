import { describe, expect, it, vi } from 'vitest';
import { buildStatsIndexingCommands } from '../../../../../renderer/components/QuickActionsModal/commands/statsIndexingCommands';

describe('buildStatsIndexingCommands', () => {
	it('offers nothing while no scan is running', () => {
		expect(
			buildStatsIndexingCommands({
				scanActive: false,
				showScanProgress: vi.fn(),
				setQuickActionOpen: vi.fn(),
			})
		).toEqual([]);
	});

	it('brings the progress back and closes the palette', () => {
		const showScanProgress = vi.fn();
		const setQuickActionOpen = vi.fn();
		const [command] = buildStatsIndexingCommands({
			scanActive: true,
			showScanProgress,
			setQuickActionOpen,
		});

		expect(command.label).toBe('Show Usage Data Scan Progress');
		command.action();
		expect(showScanProgress).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});
});
