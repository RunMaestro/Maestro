import type { ReactNode } from 'react';
import type { AgentSubagent } from '../../../../shared/agent-runtime-features';
import type { LogEntry, Theme } from '../../../types';

interface OmpTurnFabricProps {
	logs: LogEntry[];
	theme: Theme;
	isLive: boolean;
	subagents?: AgentSubagent[] | null;
	renderLog: (log: LogEntry, index: number) => ReactNode;
}

interface Turn {
	start: LogEntry;
	entries: Array<{ log: LogEntry; index: number }>;
}

function turnsFrom(logs: LogEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;
	for (let index = 0; index < logs.length; index++) {
		const log = logs[index];
		if (
			log.source === 'user' &&
			(!log.deliveryIntent ||
				((log.deliveryIntent === 'follow_up' || log.deliveryIntent === 'abort_and_prompt') &&
					log.deliveryState === 'consumed'))
		) {
			current = { start: log, entries: [{ log, index }] };
			turns.push(current);
			continue;
		}
		if (!current) {
			current = { start: log, entries: [] };
			turns.push(current);
		}
		current.entries.push({ log, index });
	}
	return turns;
}

function durationLabel(start: number, end: number): string | null {
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	const seconds = Math.max(0, Math.round((end - start) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function OmpTurnFabric({ logs, theme, isLive, subagents, renderLog }: OmpTurnFabricProps) {
	const turns = turnsFrom(logs);
	return (
		<div className="flex flex-col gap-2 px-2 py-2" data-testid="omp-turn-fabric">
			{turns.map((turn, turnIndex) => {
				const isCurrent = turnIndex === turns.length - 1 && isLive;
				const replacementTurn =
					turn.start.deliveryIntent === 'abort_and_prompt' &&
					turn.start.deliveryState === 'consumed';
				const toolCount = turn.entries.filter(({ log }) => log.source === 'tool').length;
				const lastTimestamp = turn.entries.at(-1)?.log.timestamp ?? turn.start.timestamp;
				const duration = durationLabel(turn.start.timestamp, lastTimestamp);
				return (
					<div key={turn.start.id}>
						{replacementTurn && (
							<div
								className="my-1 flex items-center gap-2 text-[11px]"
								style={{ color: theme.colors.error }}
							>
								<span className="h-px flex-1 border-t border-dashed" />
								Superseded
								<span className="h-px flex-1 border-t border-dashed" />
							</div>
						)}
						<section
							aria-label={isCurrent ? 'Active OMP turn' : 'Completed OMP turn'}
							className="min-w-0 border-l-2 pl-2"
							style={{ borderColor: isCurrent ? theme.colors.accent : theme.colors.border }}
						>
							{turn.entries.map(({ log, index }) => {
								if (log.deliveryIntent === 'steer') {
									return (
										<div key={log.id} className="my-1 flex min-w-0 items-center gap-2 text-xs">
											<span
												className="shrink-0 rounded-full border px-1.5 py-0.5"
												style={{
													borderColor: `${theme.colors.accent}80`,
													color: theme.colors.accent,
												}}
											>
												Steered
											</span>
											<span
												className="min-w-0 break-words"
												style={{ color: theme.colors.textMain }}
											>
												{log.text}
											</span>
										</div>
									);
								}
								if (log.deliveryIntent === 'follow_up' && log.deliveryState === 'queued') {
									return (
										<div
											key={log.id}
											className="my-1 rounded border border-dashed px-2 py-1 text-xs"
											style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
										>
											Queued follow-up · {log.text}
										</div>
									);
								}
								return <div key={log.id}>{renderLog(log, index)}</div>;
							})}
							{isCurrent && subagents && subagents.length > 0 && (
								<div
									className="ml-3 my-1 border-l border-dashed pl-2"
									style={{ borderColor: theme.colors.accent }}
								>
									{subagents.map((agent) => (
										<div
											key={agent.id}
											className="text-[11px]"
											style={{ color: theme.colors.textDim }}
										>
											<span style={{ color: theme.colors.accent }}>{agent.label}</span> ·{' '}
											{agent.status}
											{agent.detail ? ` · ${agent.detail}` : ''}
										</div>
									))}
								</div>
							)}
							{!isCurrent && (
								<div
									className="mt-1 inline-flex max-w-full flex-wrap gap-x-2 rounded-full border px-2 py-0.5 text-[10px]"
									style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								>
									{duration && <span>{duration}</span>}
									{toolCount > 0 && (
										<span>
											{toolCount} tool{toolCount === 1 ? '' : 's'}
										</span>
									)}
								</div>
							)}
						</section>
					</div>
				);
			})}
		</div>
	);
}
