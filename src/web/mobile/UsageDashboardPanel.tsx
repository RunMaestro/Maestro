/**
 * UsageDashboardPanel component for Maestro mobile web interface
 *
 * Displays usage analytics with token/cost summary cards,
 * a CSS-based daily usage bar chart, and session breakdown list.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';

// Re-define the types locally to avoid importing from main process
interface UsageDashboardData {
	totalTokensIn: number;
	totalTokensOut: number;
	totalCost: number;
	sessionBreakdown: Array<{
		sessionId: string;
		sessionName: string;
		tokensIn: number;
		tokensOut: number;
		cost: number;
	}>;
	dailyUsage: Array<{
		date: string;
		tokensIn: number;
		tokensOut: number;
		cost: number;
	}>;
}

type TimeRange = 'day' | 'week' | 'month' | 'all';

export interface UsageDashboardPanelProps {
	onClose: () => void;
	sendRequest: <T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number
	) => Promise<T>;
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}K`;
	}
	return String(count);
}

function formatCostUsd(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

function formatDateLabel(dateStr: string): string {
	// dateStr is expected to be YYYY-MM-DD
	const parts = dateStr.split('-');
	if (parts.length === 3) {
		return `${parts[1]}/${parts[2]}`;
	}
	return dateStr;
}

export function UsageDashboardPanel({ onClose, sendRequest }: UsageDashboardPanelProps) {
	const colors = useThemeColors();
	const [timeRange, setTimeRange] = useState<TimeRange>('week');
	const [data, setData] = useState<UsageDashboardData | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(
		async (range: TimeRange) => {
			setIsLoading(true);
			setError(null);
			try {
				const result = await sendRequest<{ data: UsageDashboardData }>(
					'get_usage_dashboard',
					{ timeRange: range },
					15000
				);
				setData(result.data);
			} catch {
				setError('Failed to load usage data');
			} finally {
				setIsLoading(false);
			}
		},
		[sendRequest]
	);

	useEffect(() => {
		fetchData(timeRange);
	}, [fetchData, timeRange]);

	const handleTimeRangeChange = useCallback((range: TimeRange) => {
		setTimeRange(range);
	}, []);

	const sortedSessions = useMemo(() => {
		if (!data) return [];
		return [...data.sessionBreakdown].sort((a, b) => b.cost - a.cost);
	}, [data]);

	const maxSessionCost = useMemo(() => {
		if (sortedSessions.length === 0) return 0;
		return sortedSessions[0].cost;
	}, [sortedSessions]);

	const maxDailyTokens = useMemo(() => {
		if (!data) return 0;
		return Math.max(...data.dailyUsage.map((d) => d.tokensIn + d.tokensOut), 1);
	}, [data]);

	const TIME_RANGES: { value: TimeRange; label: string }[] = [
		{ value: 'day', label: 'Day' },
		{ value: 'week', label: 'Week' },
		{ value: 'month', label: 'Month' },
		{ value: 'all', label: 'All' },
	];

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 1000,
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				<h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: colors.textMain }}>
					Usage Dashboard
				</h2>
				<button
					onClick={onClose}
					style={{
						background: 'none',
						border: 'none',
						color: colors.textDim,
						cursor: 'pointer',
						padding: '8px',
						borderRadius: '8px',
						display: 'flex',
						alignItems: 'center',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
					}}
					aria-label="Close"
				>
					<X size={20} />
				</button>
			</div>

			{/* Time Range Selector */}
			<div
				style={{
					display: 'flex',
					gap: '6px',
					padding: '10px 16px',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				{TIME_RANGES.map((range) => (
					<button
						key={range.value}
						onClick={() => handleTimeRangeChange(range.value)}
						style={{
							flex: 1,
							padding: '8px 12px',
							borderRadius: '8px',
							border: 'none',
							backgroundColor: timeRange === range.value ? colors.accent : `${colors.textDim}15`,
							color: timeRange === range.value ? 'white' : colors.textDim,
							fontSize: '13px',
							fontWeight: 600,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							transition: 'all 0.15s ease',
						}}
					>
						{range.label}
					</button>
				))}
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					padding: '12px 16px',
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{isLoading ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						Loading usage data...
					</div>
				) : error ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.error,
							fontSize: '14px',
						}}
					>
						{error}
					</div>
				) : !data ||
				  (data.totalTokensIn === 0 && data.totalTokensOut === 0 && data.totalCost === 0) ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						No usage data available
					</div>
				) : (
					<>
						{/* Summary Cards — tiered grid: 1 col phone, 2 col tablet (≥600px), 3 col desktop (≥960px) */}
						<div className="grid grid-cols-1 min-[600px]:grid-cols-2 min-[960px]:grid-cols-3 gap-[10px] mb-[20px]">
							<SummaryCard
								label="Tokens In"
								value={formatTokenCount(data.totalTokensIn)}
								colors={colors}
							/>
							<SummaryCard
								label="Tokens Out"
								value={formatTokenCount(data.totalTokensOut)}
								colors={colors}
							/>
							<SummaryCard label="Cost" value={formatCostUsd(data.totalCost)} colors={colors} />
						</div>

						{/* Daily Usage Chart */}
						{data.dailyUsage.length > 0 && (
							<div style={{ marginBottom: '20px' }}>
								<h3
									style={{
										fontSize: '14px',
										fontWeight: 600,
										color: colors.textMain,
										margin: '0 0 12px 0',
									}}
								>
									Daily Usage
								</h3>
								<div
									style={{
										display: 'flex',
										alignItems: 'flex-end',
										gap: '4px',
										height: '120px',
										padding: '0 0 24px 0',
										position: 'relative',
									}}
								>
									{data.dailyUsage.map((day) => {
										const totalTokens = day.tokensIn + day.tokensOut;
										const heightPercent = (totalTokens / maxDailyTokens) * 100;
										return (
											<div
												key={day.date}
												style={{
													flex: 1,
													display: 'flex',
													flexDirection: 'column',
													alignItems: 'center',
													height: '100%',
													justifyContent: 'flex-end',
													position: 'relative',
												}}
											>
												<div
													style={{
														width: '100%',
														maxWidth: '32px',
														height: `${Math.max(heightPercent, 2)}%`,
														backgroundColor: colors.accent,
														borderRadius: '4px 4px 0 0',
														minHeight: '2px',
														transition: 'height 0.3s ease',
													}}
												/>
												<span
													style={{
														position: 'absolute',
														bottom: '-20px',
														fontSize: '10px',
														color: colors.textDim,
														whiteSpace: 'nowrap',
													}}
												>
													{formatDateLabel(day.date)}
												</span>
											</div>
										);
									})}
								</div>
							</div>
						)}

						{/* Session Breakdown */}
						{sortedSessions.length > 0 && (
							<div>
								<h3
									style={{
										fontSize: '14px',
										fontWeight: 600,
										color: colors.textMain,
										margin: '0 0 10px 0',
									}}
								>
									Session Breakdown
								</h3>
								<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
									{sortedSessions.map((session) => (
										<div
											key={session.sessionId}
											style={{
												padding: '12px',
												backgroundColor: colors.bgSidebar,
												borderRadius: '10px',
												border: `1px solid ${colors.border}`,
											}}
										>
											<div
												style={{
													display: 'flex',
													justifyContent: 'space-between',
													alignItems: 'center',
													marginBottom: '6px',
												}}
											>
												<span
													style={{
														fontSize: '14px',
														fontWeight: 500,
														color: colors.textMain,
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
														flex: 1,
														marginRight: '8px',
													}}
												>
													{session.sessionName || session.sessionId.slice(0, 8)}
												</span>
												<span
													style={{
														fontSize: '13px',
														fontWeight: 600,
														color: colors.accent,
														flexShrink: 0,
													}}
												>
													{formatCostUsd(session.cost)}
												</span>
											</div>
											<div
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '8px',
													marginBottom: '6px',
												}}
											>
												<span
													style={{
														fontSize: '12px',
														color: colors.textDim,
													}}
												>
													{formatTokenCount(session.tokensIn)} in /{' '}
													{formatTokenCount(session.tokensOut)} out
												</span>
											</div>
											{/* Proportional bar */}
											<div
												style={{
													width: '100%',
													height: '4px',
													borderRadius: '2px',
													backgroundColor: `${colors.textDim}20`,
													overflow: 'hidden',
												}}
											>
												<div
													style={{
														width:
															maxSessionCost > 0
																? `${(session.cost / maxSessionCost) * 100}%`
																: '0%',
														height: '100%',
														borderRadius: '2px',
														backgroundColor: colors.accent,
														transition: 'width 0.3s ease',
													}}
												/>
											</div>
										</div>
									))}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/** Summary card sub-component */
function SummaryCard({
	label,
	value,
	colors,
}: {
	label: string;
	value: string;
	colors: ReturnType<typeof useThemeColors>;
}) {
	return (
		<div
			style={{
				padding: '14px 16px',
				backgroundColor: colors.bgSidebar,
				borderRadius: '12px',
				border: `1px solid ${colors.border}`,
			}}
		>
			<div
				style={{
					fontSize: '12px',
					color: colors.textDim,
					fontWeight: 500,
					marginBottom: '4px',
				}}
			>
				{label}
			</div>
			<div
				style={{
					fontSize: '22px',
					fontWeight: 700,
					color: colors.textMain,
				}}
			>
				{value}
			</div>
		</div>
	);
}

export default UsageDashboardPanel;
