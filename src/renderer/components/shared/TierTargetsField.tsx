/**
 * TierTargetsField - the agent's own tier targets: where a `low`, `medium` or
 * `high` task of THIS agent launches.
 *
 * Three pickers, each offering what the harness can run on this machine
 * (`buildTierTargetOptionGroups`, the list the Tier defaults table offers).
 * The first choice of each is "Harness default (<value>)": the absence of a
 * target on the agent, with the value the layers below would give the tier.
 *
 * Beside each picker is the layer the tier's value comes from as the form
 * stands (Agent, Harness default, Built-in), read through `agentTierRows`, the
 * same resolution a launch runs. A target a launch would refuse is shown with
 * the launch's own words, and a tier that does not apply (no layer maps it, or
 * only the built-in table does and the agent runs on a source) says so.
 *
 * Controlled, and it stores nothing: the host decides when a value is saved.
 *
 * CLI: `maestro-cli update-agent <id> --tier <tier>=<target>`.
 */

import { useMemo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import type { RunOnTarget } from '../../../shared/local-models/run-on';
import {
	agentTierFallthroughLabel,
	buildTierTargetOptionGroups,
} from '../../../shared/local-models/tier-options';
import {
	agentTierRows,
	formatTierTargetSpec,
	parseTierTargetSpec,
	TIER_NOT_MAPPED_LABEL,
	TIER_TARGET_SOURCE_LABELS,
	tierHarnessProblem,
	tierTargetLabel,
	type ModelTier,
	type TierTargets,
} from '../../../shared/modelTiers';
import { useHarnessTierOptions, useLocalModelsHardware } from '../../hooks/localModels';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme, ToolType } from '../../types';
import { AssignmentOptionElements } from '../Settings/tabs/LocalModelsTab/AssignmentOptionElements';
import { FormFieldLabel } from '../ui/FormFieldLabel';
import { MiniBadge } from '../ui/MiniBadge';

export interface TierTargetsFieldProps {
	theme: Theme;
	/** The agent's provider, e.g. `claude-code`. */
	toolType: ToolType;
	/** The agent's own targets. A tier it does not hold follows the harness default. */
	value: TierTargets;
	onChange: (next: TierTargets) => void;
	/**
	 * The form's Run on target. The built-in table names the provider's own
	 * models, so it does not apply to an agent that runs on a source.
	 */
	runOn: RunOnTarget;
	/** A save error from the host. */
	error?: string;
	testId?: string;
}

/** The block's heading and sentence, shared by every state it can be in. */
function TiersFrame({
	theme,
	testId,
	children,
}: {
	theme: Theme;
	testId: string;
	children: ReactNode;
}) {
	return (
		<div className="w-full space-y-2" data-testid={testId}>
			<div>
				<div
					className="block text-xs font-bold opacity-70 uppercase mb-1"
					style={{ color: theme.colors.textMain }}
				>
					Tiers
				</div>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Where a task that asks for a tier launches: an Auto Run model marker, or a tier on a Cue
					subscription. A tier left on Harness default follows{' '}
					{modelsSettingsLocation('system-two')} &gt; Tier defaults.
				</p>
			</div>
			{children}
		</div>
	);
}

export function TierTargetsField(props: TierTargetsFieldProps) {
	const { theme, toolType, testId = 'tier-targets-field' } = props;
	// A tier picks a model, so a harness that cannot be told which model to run
	// has none. Said here, and the harness is not asked for a list it lacks.
	const problem = tierHarnessProblem(toolType);
	if (problem) {
		return (
			<TiersFrame theme={theme} testId={testId}>
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-unsupported`}
				>
					{problem}
				</p>
			</TiersFrame>
		);
	}
	return <TierTargetPickers {...props} testId={testId} />;
}

function TierTargetPickers({
	theme,
	toolType,
	value,
	onChange,
	runOn,
	error,
	testId = 'tier-targets-field',
}: TierTargetsFieldProps) {
	const harnessDefaults = useSettingsStore((s) => s.harnessTierDefaults);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	const hardware = useLocalModelsHardware();
	const { options, loading, error: listError } = useHarnessTierOptions(toolType);
	// The last answer may be another harness's, while this one is being asked.
	const row = useMemo(
		() => options?.find((candidate) => candidate.harness === toolType),
		[options, toolType]
	);

	// Each tier as a launch would resolve it with the form as it stands, and as
	// it would resolve with no target on the agent (the first choice's value).
	const resolved = useMemo(
		() => agentTierRows({ toolType, tierTargets: value, runOn }, harnessDefaults),
		[toolType, value, runOn, harnessDefaults]
	);
	const fallthrough = useMemo(
		() => agentTierRows({ toolType, runOn }, harnessDefaults),
		[toolType, runOn, harnessDefaults]
	);

	const choose = (tier: ModelTier, spec: string) => {
		const parsed = parseTierTargetSpec(spec);
		if (!parsed.ok) return;
		const next: TierTargets = { ...value };
		if (parsed.target) next[tier] = parsed.target;
		else delete next[tier];
		onChange(next);
	};

	return (
		<TiersFrame theme={theme} testId={testId}>
			{!row && !listError && (
				<p
					className="text-xs"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-loading`}
				>
					Listing what {getAgentDisplayName(toolType)} can run...
				</p>
			)}
			{!row && listError && (
				<p
					className="flex items-start gap-1.5 text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid={`${testId}-list-error`}
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>
						Could not list what {getAgentDisplayName(toolType)} can run: {listError}
					</span>
				</p>
			)}

			{row && (
				<div className="grid grid-cols-3 gap-3">
					{resolved.map((entry, index) => {
						const { tier } = entry;
						const target = value[tier];
						const selectId = `${testId}-${tier}`;
						const groups = buildTierTargetOptionGroups({
							options: row,
							current: target,
							fallthroughLabel: agentTierFallthroughLabel(fallthrough[index], endpoints),
							endpoints,
							hardware: hardware.profile,
						});
						const sourceLabel = entry.source
							? TIER_TARGET_SOURCE_LABELS[entry.source]
							: TIER_NOT_MAPPED_LABEL;
						return (
							<div key={tier} className="min-w-0 space-y-1">
								<div className="flex items-center justify-between gap-1">
									<FormFieldLabel theme={theme} htmlFor={selectId}>
										{tier}
									</FormFieldLabel>
									<MiniBadge
										label={sourceLabel}
										theme={theme}
										color={entry.source === 'agent' ? theme.colors.accent : theme.colors.textDim}
										title={
											entry.target
												? `${tierTargetLabel(entry.target, endpoints)}, from: ${sourceLabel}`
												: sourceLabel
										}
										testId={`${selectId}-source`}
									/>
								</div>
								<select
									id={selectId}
									value={formatTierTargetSpec(target)}
									onChange={(e) => choose(tier, e.target.value)}
									disabled={loading}
									className="w-full p-1.5 rounded border bg-transparent outline-none text-xs disabled:opacity-40"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										backgroundColor: theme.colors.bgMain,
									}}
									data-testid={selectId}
								>
									<AssignmentOptionElements groups={groups} />
								</select>
								{entry.problem && (
									<p
										className="text-xs select-text"
										style={{ color: theme.colors.error }}
										data-testid={`${selectId}-problem`}
									>
										{entry.problem}
									</p>
								)}
								{entry.note && (
									<p
										className="text-xs select-text"
										style={{ color: theme.colors.textDim }}
										data-testid={`${selectId}-note`}
									>
										{entry.note}
									</p>
								)}
							</div>
						);
					})}
				</div>
			)}

			{row && !row.runOn.supported && (
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-no-run-on`}
				>
					Provider models only. {row.runOn.reason}
				</p>
			)}
			{row?.problems.map((sourceProblem) => (
				<p
					key={sourceProblem.endpointId}
					className="text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={`${testId}-source-problem`}
				>
					{sourceProblem.name}: {sourceProblem.message}
				</p>
			))}
			{error && (
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid={`${testId}-error`}
				>
					{error}
				</p>
			)}
		</TiersFrame>
	);
}

export default TierTargetsField;
