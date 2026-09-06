/**
 * TurnSettingPills - read-only badges naming the model and effort a turn ran under.
 *
 * The transcript counterpart to the composer's interactive `ModelEffortPills`:
 * same icons and same color roles (accent for model, warning for effort), but
 * static, because a finished turn's configuration is a fact, not a control.
 * Rendered in the message footer beside the Claude token-source pill so a user
 * who changes model or effort mid-conversation can read back which
 * configuration produced each response.
 *
 * Values come from the entry's send-time stamp (`LogEntry.turnModel` /
 * `turnEffort`). An unset value means the agent's own default was in force, and
 * that pill is omitted rather than labeled with a guess.
 */

import { memo } from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import type { Theme } from '../../types';

export interface TurnSettingPillsProps {
	theme: Theme;
	/** Model the turn ran under, or undefined for the agent default. */
	model?: string;
	/** Effort/reasoning level the turn ran under, or undefined for the default. */
	effort?: string;
}

export const TurnSettingPills = memo(function TurnSettingPills({
	theme,
	model,
	effort,
}: TurnSettingPillsProps) {
	if (!model && !effort) return null;

	return (
		<>
			{model && (
				<span
					className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded max-w-[12rem]"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
						opacity: 0.7,
					}}
					title={`Model: ${model}`}
					data-testid="turn-model-pill"
				>
					<Sparkles className="w-2.5 h-2.5 shrink-0" />
					<span className="truncate">{model}</span>
				</span>
			)}
			{effort && (
				<span
					className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded max-w-[12rem]"
					style={{
						backgroundColor: `${theme.colors.warning}20`,
						color: theme.colors.warning,
						opacity: 0.7,
					}}
					title={`Effort: ${effort}`}
					data-testid="turn-effort-pill"
				>
					<Gauge className="w-2.5 h-2.5 shrink-0" />
					<span className="truncate">{effort}</span>
				</span>
			)}
		</>
	);
});

export default TurnSettingPills;
