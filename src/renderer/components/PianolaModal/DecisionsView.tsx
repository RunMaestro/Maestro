import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';
import { ACTION_META, RISK_COLOR, type DecisionFilter } from './shared';

interface DecisionsViewProps {
	theme: Theme;
	decisions: PianolaDecisionRecord[];
	filter: DecisionFilter;
	onFilterChange: (f: DecisionFilter) => void;
	loading: boolean;
}

export function DecisionsView({
	theme,
	decisions,
	filter,
	onFilterChange,
	loading,
}: DecisionsViewProps) {
	return (
		<div className="p-4 space-y-3">
			<div className="flex items-center gap-1">
				{(
					[
						['all', 'All'],
						['escalate', 'Escalations'],
						['auto_answer', 'Auto-answered'],
					] as const
				).map(([id, label]) => (
					<button
						key={id}
						onClick={() => onFilterChange(id)}
						className="px-2.5 py-1 text-xs rounded-md transition-colors"
						style={{
							backgroundColor: filter === id ? theme.colors.accent + '22' : 'transparent',
							color: filter === id ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${filter === id ? theme.colors.accent + '55' : theme.colors.border}`,
						}}
					>
						{label}
					</button>
				))}
			</div>

			{decisions.length === 0 ? (
				<div className="text-sm text-center py-12" style={{ color: theme.colors.textDim }}>
					{loading ? 'Loading...' : 'No decisions recorded yet.'}
				</div>
			) : (
				<div className="space-y-2 select-text">
					{decisions.map((d) => {
						const meta = ACTION_META[d.decision.action];
						return (
							<div
								key={d.id}
								className="rounded-lg border p-3"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
								}}
							>
								<div className="flex items-center justify-between gap-3">
									<div className="flex items-center gap-2 min-w-0">
										<meta.Icon className="w-4 h-4 shrink-0" style={{ color: meta.color }} />
										<span className="text-sm font-medium" style={{ color: meta.color }}>
											{meta.label}
										</span>
										<span
											className="text-xs px-1.5 py-0.5 rounded shrink-0"
											style={{
												backgroundColor: RISK_COLOR[d.classification.risk] + '22',
												color: RISK_COLOR[d.classification.risk],
											}}
										>
											{d.classification.kind} / {d.classification.risk}
										</span>
										{d.dryRun && (
											<span
												className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
												style={{
													backgroundColor: theme.colors.border,
													color: theme.colors.textDim,
												}}
											>
												dry-run
											</span>
										)}
									</div>
									<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
										{new Date(d.timestamp).toLocaleString()}
									</span>
								</div>

								{d.classification.topic && (
									<div className="mt-1.5 text-sm" style={{ color: theme.colors.textMain }}>
										{d.classification.topic}
									</div>
								)}

								<div className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
									{d.decision.reason}
									{d.decision.action === 'auto_answer' && (
										<>
											{' '}
											&rarr; replied:{' '}
											<span style={{ color: theme.colors.textMain }}>
												&ldquo;{d.decision.answer}&rdquo;
											</span>
										</>
									)}
								</div>

								<div
									className="mt-1.5 flex items-center gap-3 text-[11px]"
									style={{ color: theme.colors.textDim }}
								>
									<span>agent: {d.agentId}</span>
									<span>tab: {d.tabId}</span>
									{d.decision.action === 'auto_answer' && (
										<span style={{ color: d.dispatched ? '#22c55e' : '#ef4444' }}>
											{d.dispatched ? 'sent' : 'not sent'}
										</span>
									)}
								</div>

								{d.error && (
									<div
										className="mt-1.5 flex items-center gap-1.5 text-xs"
										style={{ color: '#ef4444' }}
									>
										<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
										{d.error}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
