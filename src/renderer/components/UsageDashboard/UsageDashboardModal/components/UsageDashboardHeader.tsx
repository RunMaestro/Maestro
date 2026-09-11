import { useCallback, useRef, useState } from 'react';
import { BarChart3, Calendar, ChevronDown, Download, X } from 'lucide-react';
import type { StatsTimeRange, UsageExportFormat } from '../../../../../shared/stats-types';
import { useClickOutside } from '../../../../hooks/ui/useClickOutside';
import { usePhoneLayout } from '../../../../hooks/ui/useViewportBreakpoint';
import { AchievementShareButton } from '../../../AchievementShareButton';
import { TIME_RANGE_OPTIONS } from '../constants';
import type { UsageDashboardModalProps } from '../types';

const EXPORT_OPTIONS: { format: UsageExportFormat; label: string; detail: string }[] = [
	{ format: 'json', label: 'JSON', detail: 'Every table and the dashboard totals, one file' },
	{ format: 'csv', label: 'CSV', detail: 'One CSV per table, in a .zip' },
];

interface UsageDashboardHeaderProps {
	theme: UsageDashboardModalProps['theme'];
	showNewDataIndicator: boolean;
	timeRange: StatsTimeRange;
	onTimeRangeChange: (timeRange: StatsTimeRange) => void;
	onExport: (format: UsageExportFormat) => void;
	isExporting: boolean;
	onClose: () => void;
	autoRunStats: UsageDashboardModalProps['autoRunStats'];
	globalStats: UsageDashboardModalProps['globalStats'];
	usageStats: UsageDashboardModalProps['usageStats'];
	handsOnTimeMs: UsageDashboardModalProps['handsOnTimeMs'];
	leaderboardRegistration: UsageDashboardModalProps['leaderboardRegistration'];
}

export function UsageDashboardHeader({
	theme,
	showNewDataIndicator,
	timeRange,
	onTimeRangeChange,
	onExport,
	isExporting,
	onClose,
	autoRunStats,
	globalStats,
	usageStats,
	handsOnTimeMs,
	leaderboardRegistration,
}: UsageDashboardHeaderProps) {
	// Phone: the title stays on one line, the export button keeps only its
	// icon, and the controls drop to a second row under the title. On one row
	// the select, export, share and close buttons left the title no width at
	// all: it truncated to nothing and even the icon was clipped.
	const phone = usePhoneLayout();
	const [exportMenuOpen, setExportMenuOpen] = useState(false);
	const exportMenuRef = useRef<HTMLDivElement>(null);
	const closeExportMenu = useCallback(() => setExportMenuOpen(false), []);
	// mousedown, not click: the dashboard dialog stops click propagation, so a
	// document click listener would never hear a click elsewhere in the modal.
	useClickOutside(exportMenuRef, closeExportMenu, exportMenuOpen);
	const closeButton = (
		<button
			onClick={onClose}
			className="p-1.5 rounded row-hover transition-colors shrink-0"
			style={{ color: theme.colors.textDim }}
			onMouseEnter={(event) =>
				(event.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
			}
			onMouseLeave={(event) => (event.currentTarget.style.backgroundColor = 'transparent')}
			title="Close (Esc)"
		>
			<X className="w-4 h-4" />
		</button>
	);
	return (
		<div
			className={`${phone ? 'px-3 py-2 gap-2 flex-wrap' : 'px-6 py-4'} border-b flex items-center justify-between flex-shrink-0`}
			style={{ borderColor: theme.colors.border }}
		>
			<div className={`flex items-center min-w-0 ${phone ? 'flex-1 gap-2' : 'gap-3'}`}>
				<BarChart3 className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
				<h2
					className={`font-semibold whitespace-nowrap truncate ${phone ? 'text-base' : 'text-lg'}`}
					style={{ color: theme.colors.textMain }}
				>
					Usage Dashboard
				</h2>
				{showNewDataIndicator && (
					<div
						className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
							animation: 'pulse-fade 3s ease-out forwards',
						}}
						data-testid="new-data-indicator"
					>
						<span
							className="w-2 h-2 rounded-full"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'pulse-dot 1s ease-in-out 3',
							}}
						/>
						Updated
					</div>
				)}
			</div>

			{phone && closeButton}

			<div className={`flex items-center ${phone ? 'basis-full gap-1.5' : 'shrink-0 gap-3'}`}>
				<div className="relative flex items-center">
					<Calendar
						className="w-4 h-4 absolute left-2.5 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
					<select
						value={timeRange}
						onChange={(event) => onTimeRangeChange(event.target.value as StatsTimeRange)}
						aria-label="Time range"
						className="pl-8 pr-6 py-1.5 rounded text-sm border cursor-pointer outline-none appearance-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						{TIME_RANGE_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<div
						className="absolute right-2 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					>
						<svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
							<path
								d="M1 1L5 5L9 1"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								fill="none"
							/>
						</svg>
					</div>
				</div>

				<div className="relative" ref={exportMenuRef}>
					<button
						onClick={() => setExportMenuOpen((open) => !open)}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm row-hover transition-colors"
						style={{
							color: theme.colors.textMain,
							backgroundColor: `${theme.colors.accent}15`,
						}}
						onMouseEnter={(event) =>
							(event.currentTarget.style.backgroundColor = `${theme.colors.accent}25`)
						}
						onMouseLeave={(event) =>
							(event.currentTarget.style.backgroundColor = `${theme.colors.accent}15`)
						}
						disabled={isExporting}
						aria-label="Export"
						aria-haspopup="menu"
						aria-expanded={exportMenuOpen}
						title="Export usage data"
					>
						<Download className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
						{!phone && 'Export'}
						{!phone && <ChevronDown className="w-3 h-3" />}
					</button>

					{exportMenuOpen && (
						<div
							role="menu"
							className="absolute right-0 top-full mt-1 p-1.5 rounded-lg shadow-xl z-50"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							{EXPORT_OPTIONS.map((option) => (
								<button
									key={option.format}
									role="menuitem"
									onClick={() => {
										setExportMenuOpen(false);
										onExport(option.format);
									}}
									className="w-full flex flex-col items-start gap-0.5 px-3 py-2 rounded text-left whitespace-nowrap hover:bg-white/10 transition-colors"
								>
									<span className="text-sm" style={{ color: theme.colors.textMain }}>
										{option.label}
									</span>
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										{option.detail}
									</span>
								</button>
							))}
						</div>
					)}
				</div>

				{autoRunStats && (
					<AchievementShareButton
						theme={theme}
						autoRunStats={autoRunStats}
						globalStats={globalStats}
						usageStats={usageStats}
						handsOnTimeMs={handsOnTimeMs}
						leaderboardRegistration={leaderboardRegistration}
						variant="header"
						title="Share achievements"
					/>
				)}

				{!phone && closeButton}
			</div>
		</div>
	);
}
