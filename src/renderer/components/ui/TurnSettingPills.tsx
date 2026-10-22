/**
 * TurnSettingPills - read-only badges naming a turn's provider, model and effort.
 *
 * The transcript counterpart to the composer's interactive `ModelEffortPills`:
 * same icons and same color roles (accent for model, warning for effort), but
 * static, because a finished turn's configuration is a fact, not a control.
 * Rendered in the message footer beside the Claude token-source pill so a user
 * who changes model or effort mid-conversation can read back which
 * configuration produced each response.
 *
 * Values come from the entry's send-time stamp. An unset provider is unknown;
 * unset model/effort mean the provider's defaults. Omit them instead of guessing.
 *
 * A turn that ran on a Run on source (`LogEntry.turnRunOn`) names the model and
 * the source in the model pill's place (`qwen3:latest · Ollama`): the agent's
 * own model was not the one asked, so it is not the one shown.
 *
 * A turn sent on the Auto model (`LogEntry.turnAuto`) gets one pill in the model
 * pill's place that says what the router decided and where the turn ran
 * (`Auto → medium · sonnet`, `Auto (router off)`, `Auto (no decision)`). Its
 * tooltip names the router. A queued message on Auto passes the stamp
 * `queuedTurnPills()` builds, which has no target yet.
 *
 * Both pills carry `data-turn-setting-pill`, which the phone block in
 * `index.css` hides: they are readouts, and on a 390px screen they were sharing
 * a row with the Force Send button and the queued card's control cluster, which
 * has no room to give and overlapped them instead.
 */

import { memo } from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import type { Theme } from '../../types';
import { autoTurnDetail, autoTurnLabel, type AutoTurnStamp } from '../../../shared/autoTurn';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type { ToolType } from '../../../shared/types';

export interface TurnSettingPillsProps {
	theme: Theme;
	/** Captured owner, supplied only where a provider readout is needed. */
	provider?: ToolType;
	/** Model the turn ran under, or undefined for the agent default. */
	model?: string;
	/** Effort/reasoning level the turn ran under, or undefined for the default. */
	effort?: string;
	/** The model and source a Run on turn ran on. Takes the model pill's place. */
	runOn?: string;
	/** Set for a turn sent on the Auto model. Takes the model pill's place too. */
	auto?: AutoTurnStamp;
}

export const TurnSettingPills = memo(function TurnSettingPills({
	theme,
	provider,
	model,
	effort,
	runOn,
	auto,
}: TurnSettingPillsProps) {
	if (!provider && !model && !effort && !runOn && !auto) return null;

	return (
		<>
			{provider && (
				<span
					className="text-2xs px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
						opacity: 0.7,
					}}
					title={`Provider: ${getAgentDisplayName(provider)}`}
					data-testid="turn-provider-pill"
					data-turn-setting-pill
				>
					{getAgentDisplayName(provider)}
				</span>
			)}
			{auto && (
				<span
					className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded max-w-[20rem]"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
						opacity: 0.7,
					}}
					title={autoTurnDetail(auto)}
					data-testid="turn-auto-pill"
					data-turn-setting-pill
				>
					<Sparkles className="w-2.5 h-2.5 shrink-0" />
					<span className="truncate">{autoTurnLabel(auto, runOn ?? model)}</span>
				</span>
			)}
			{!auto && runOn && (
				<span
					className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded max-w-[16rem]"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
						opacity: 0.7,
					}}
					title={`Ran on: ${runOn}`}
					data-testid="turn-run-on-pill"
					data-turn-setting-pill
				>
					<Sparkles className="w-2.5 h-2.5 shrink-0" />
					<span className="truncate">{runOn}</span>
				</span>
			)}
			{!auto && !runOn && model && (
				<span
					className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded max-w-[12rem]"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
						opacity: 0.7,
					}}
					title={`Model: ${model}`}
					data-testid="turn-model-pill"
					data-turn-setting-pill
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
					data-turn-setting-pill
				>
					<Gauge className="w-2.5 h-2.5 shrink-0" />
					<span className="truncate">{effort}</span>
				</span>
			)}
		</>
	);
});

export default TurnSettingPills;
