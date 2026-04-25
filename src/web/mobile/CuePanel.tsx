/**
 * CuePanel component for Maestro mobile web interface
 *
 * Displays a Cue automation dashboard with subscription management
 * and activity monitoring in a tab-based layout.
 */

import { useState, useCallback, useMemo } from 'react';
import { X, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import type { CueSubscriptionInfo, CueActivityEntry } from '../hooks/useCue';
import { formatElapsedTime as formatDuration } from '../../shared/formatters';

export interface CuePanelProps {
	/** Close the panel */
	onClose: () => void;
	/** Cue subscriptions */
	subscriptions: CueSubscriptionInfo[];
	/** Cue activity entries */
	activity: CueActivityEntry[];
	/** Whether data is loading */
	isLoading: boolean;
	/** Toggle a subscription */
	onToggleSubscription: (subscriptionId: string, enabled: boolean) => void;
	/** Refresh data */
	onRefresh: () => void;
}

type Tab = 'subscriptions' | 'activity';

const EVENT_TYPE_COLORS: Record<string, string> = {
	file: '#3b82f6',
	schedule: '#8b5cf6',
	pr: '#f59e0b',
	issue: '#ef4444',
	task: '#10b981',
	agent_complete: '#6366f1',
};

function getEventTypeColor(eventType: string): string {
	return EVENT_TYPE_COLORS[eventType] ?? '#6b7280';
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
	triggered: { bg: '#fbbf2420', text: '#fbbf24' },
	running: { bg: '#3b82f620', text: '#3b82f6' },
	completed: { bg: '#10b98120', text: '#10b981' },
	failed: { bg: '#ef444420', text: '#ef4444' },
};

/**
 * CuePanel component
 */
export function CuePanel({
	onClose,
	subscriptions,
	activity,
	isLoading,
	onToggleSubscription,
	onRefresh,
}: CuePanelProps) {
	const colors = useThemeColors();
	const [activeTab, setActiveTab] = useState<Tab>('subscriptions');
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const [expandedActivities, setExpandedActivities] = useState<Set<string>>(new Set());

	const groupedSubscriptions = useMemo(() => {
		const groups = new Map<string, { sessionName: string; items: CueSubscriptionInfo[] }>();
		for (const sub of subscriptions) {
			const key = sub.sessionId;
			if (!groups.has(key)) {
				groups.set(key, { sessionName: sub.sessionName, items: [] });
			}
			groups.get(key)!.items.push(sub);
		}
		return groups;
	}, [subscriptions]);

	const toggleGroup = useCallback((sessionId: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(sessionId)) {
				next.delete(sessionId);
			} else {
				next.add(sessionId);
			}
			return next;
		});
	}, []);

	const toggleActivityExpanded = useCallback((activityId: string) => {
		setExpandedActivities((prev) => {
			const next = new Set(prev);
			if (next.has(activityId)) {
				next.delete(activityId);
			} else {
				next.add(activityId);
			}
			return next;
		});
	}, []);

	const handleTouchRefresh = useCallback(() => {
		onRefresh();
	}, [onRefresh]);

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
					Maestro Cue
				</h2>
				<div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
					<button
						onClick={handleTouchRefresh}
						disabled={isLoading}
						style={{
							background: 'none',
							border: 'none',
							color: colors.textDim,
							cursor: isLoading ? 'not-allowed' : 'pointer',
							padding: '8px',
							borderRadius: '8px',
							display: 'flex',
							alignItems: 'center',
							opacity: isLoading ? 0.5 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Refresh"
					>
						<RefreshCw
							size={18}
							style={{
								animation: isLoading ? 'spin 1s linear infinite' : 'none',
							}}
						/>
					</button>
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
			</div>

			{/* Tab Bar */}
			<div
				style={{
					display: 'flex',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				{(['subscriptions', 'activity'] as Tab[]).map((tab) => (
					<button
						key={tab}
						onClick={() => setActiveTab(tab)}
						style={{
							flex: 1,
							padding: '10px 16px',
							background: 'none',
							border: 'none',
							borderBottom:
								activeTab === tab ? `2px solid ${colors.accent}` : '2px solid transparent',
							color: activeTab === tab ? colors.accent : colors.textDim,
							fontSize: '14px',
							fontWeight: 500,
							cursor: 'pointer',
							textTransform: 'capitalize',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
					>
						{tab === 'subscriptions'
							? `Subscriptions (${subscriptions.length})`
							: `Activity (${activity.length})`}
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
				{activeTab === 'subscriptions' ? (
					subscriptions.length === 0 ? (
						<div
							style={{
								textAlign: 'center',
								padding: '40px 20px',
								color: colors.textDim,
								fontSize: '14px',
							}}
						>
							No Cue subscriptions configured
						</div>
					) : (
						<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
							{Array.from(groupedSubscriptions.entries()).map(([sessionId, group]) => {
								const isCollapsed = collapsedGroups.has(sessionId);
								return (
									<div key={sessionId}>
										{/* Session group header */}
										<button
											onClick={() => toggleGroup(sessionId)}
											style={{
												display: 'flex',
												alignItems: 'center',
												gap: '6px',
												width: '100%',
												padding: '6px 0',
												background: 'none',
												border: 'none',
												color: colors.textDim,
												fontSize: '12px',
												fontWeight: 600,
												textTransform: 'uppercase',
												letterSpacing: '0.5px',
												cursor: 'pointer',
												touchAction: 'manipulation',
												WebkitTapHighlightColor: 'transparent',
											}}
										>
											{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
											{group.sessionName}
											<span style={{ marginLeft: 'auto', fontWeight: 400 }}>
												{group.items.length}
											</span>
										</button>

										{/* Subscription cards */}
										{!isCollapsed && (
											<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
												{group.items.map((sub) => (
													<div
														key={sub.id}
														style={{
															display: 'flex',
															alignItems: 'center',
															padding: '12px',
															backgroundColor: colors.bgSidebar,
															borderRadius: '12px',
															border: `1px solid ${colors.border}`,
														}}
													>
														{/* Left content */}
														<div style={{ flex: 1, minWidth: 0 }}>
															<div
																style={{
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																	marginBottom: '4px',
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
																	}}
																>
																	{sub.name}
																</span>
																<span
																	style={{
																		fontSize: '11px',
																		fontWeight: 500,
																		padding: '2px 6px',
																		borderRadius: '4px',
																		backgroundColor: `${getEventTypeColor(sub.eventType)}20`,
																		color: getEventTypeColor(sub.eventType),
																		flexShrink: 0,
																	}}
																>
																	{sub.eventType}
																</span>
															</div>
															<div
																style={{
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																	fontSize: '12px',
																	color: colors.textDim,
																}}
															>
																<span>
																	{sub.lastTriggered
																		? formatRelativeTime(sub.lastTriggered)
																		: 'Never'}
																</span>
																{sub.triggerCount > 0 && (
																	<span
																		style={{
																			fontSize: '11px',
																			padding: '1px 5px',
																			borderRadius: '8px',
																			backgroundColor: `${colors.textDim}20`,
																		}}
																	>
																		{sub.triggerCount}x
																	</span>
																)}
															</div>
														</div>

														{/* Toggle switch */}
														<button
															role="switch"
															aria-checked={sub.enabled}
															aria-label={`${sub.enabled ? 'Disable' : 'Enable'} ${sub.name}`}
															onClick={() => onToggleSubscription(sub.id, !sub.enabled)}
															style={{
																background: 'none',
																border: 'none',
																padding: '4px',
																cursor: 'pointer',
																flexShrink: 0,
																touchAction: 'manipulation',
																WebkitTapHighlightColor: 'transparent',
															}}
														>
															<div
																style={{
																	width: '44px',
																	height: '26px',
																	borderRadius: '13px',
																	backgroundColor: sub.enabled
																		? colors.accent
																		: `${colors.textDim}30`,
																	padding: '2px',
																	transition: 'background-color 0.2s ease',
																	display: 'flex',
																	alignItems: 'center',
																}}
															>
																<div
																	style={{
																		width: '22px',
																		height: '22px',
																		borderRadius: '11px',
																		backgroundColor: 'white',
																		transition: 'transform 0.2s ease',
																		transform: sub.enabled ? 'translateX(18px)' : 'translateX(0)',
																		boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
																	}}
																/>
															</div>
														</button>
													</div>
												))}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)
				) : activity.length === 0 ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						No recent Cue activity
					</div>
				) : (
					<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
						{/* Pull-to-refresh hint */}
						{isLoading && (
							<div
								style={{
									textAlign: 'center',
									padding: '8px',
									color: colors.textDim,
									fontSize: '12px',
								}}
							>
								Refreshing...
							</div>
						)}
						{activity.map((entry) => {
							const statusColor = STATUS_COLORS[entry.status] ?? STATUS_COLORS.triggered;
							const isExpanded = expandedActivities.has(entry.id);
							return (
								<button
									key={entry.id}
									onClick={() => entry.result && toggleActivityExpanded(entry.id)}
									style={{
										display: 'flex',
										flexDirection: 'column',
										padding: '12px',
										backgroundColor: colors.bgSidebar,
										borderRadius: '12px',
										border: `1px solid ${colors.border}`,
										width: '100%',
										textAlign: 'left',
										background: colors.bgSidebar,
										cursor: entry.result ? 'pointer' : 'default',
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
									}}
								>
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: '8px',
											width: '100%',
										}}
									>
										{/* Event type + name */}
										<div style={{ flex: 1, minWidth: 0 }}>
											<div
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '8px',
													marginBottom: '4px',
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
													}}
												>
													{entry.subscriptionName}
												</span>
												<span
													style={{
														fontSize: '11px',
														fontWeight: 500,
														padding: '2px 6px',
														borderRadius: '4px',
														backgroundColor: `${getEventTypeColor(entry.eventType)}20`,
														color: getEventTypeColor(entry.eventType),
														flexShrink: 0,
													}}
												>
													{entry.eventType}
												</span>
											</div>
											<div
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '8px',
													fontSize: '12px',
													color: colors.textDim,
												}}
											>
												<span>{formatRelativeTime(entry.timestamp)}</span>
												{entry.duration != null && <span>{formatDuration(entry.duration)}</span>}
											</div>
										</div>

										{/* Status badge */}
										<span
											style={{
												fontSize: '11px',
												fontWeight: 500,
												padding: '3px 8px',
												borderRadius: '6px',
												backgroundColor: statusColor.bg,
												color: statusColor.text,
												flexShrink: 0,
												...(entry.status === 'running'
													? { animation: 'pulse 2s ease-in-out infinite' }
													: {}),
											}}
										>
											{entry.status}
										</span>
									</div>

									{/* Expandable result */}
									{isExpanded && entry.result && (
										<div
											style={{
												marginTop: '8px',
												padding: '8px',
												borderRadius: '6px',
												backgroundColor: `${colors.textDim}10`,
												fontSize: '12px',
												color: colors.textDim,
												fontFamily: 'monospace',
												whiteSpace: 'pre-wrap',
												wordBreak: 'break-word',
											}}
										>
											{entry.result.length > 200
												? entry.result.slice(0, 200) + '...'
												: entry.result}
										</div>
									)}
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* CSS animations */}
			<style>{`
				@keyframes spin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
				@keyframes pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.5; }
				}
			`}</style>
		</div>
	);
}

export default CuePanel;
