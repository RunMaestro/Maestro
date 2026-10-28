/**
 * TierDefaultsSection - the harness tier defaults: which model a `low`,
 * `medium` or `high` task launches on, per harness.
 *
 * One row per installed harness that can select a model, three pickers per
 * row. A picker offers the harness's own catalogue and, for a harness with a
 * Run on recipe, every model the sources list (`buildTierTargetOptionGroups`).
 * Beside each picker is the layer the value comes from: Harness default (set
 * here) or Built-in (Maestro's own table). An agent that sets the tier itself
 * overrides both.
 *
 * Nothing is stored until Save. Suggest fills the pickers from what the
 * harness can run (`suggestHarnessTierDefaults`) and says why under each one;
 * Reset puts every picker back on the built-in table. A document must resolve
 * the same way until someone changes the mapping, so a discovered list never
 * writes the setting by itself.
 *
 * A value the harness no longer lists is flagged (`staleTierModels`), and a
 * stored value a launch would refuse is shown with the launch's own words
 * (`harnessTierRows`), so the table cannot look healthy while a tier is broken.
 *
 * CLI: `maestro-cli models tiers list|options|suggest|set|reset`.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, RotateCcw, Save, Undo2, Wand2 } from 'lucide-react';

import type { AgentId } from '../../../../../shared/agentIds';
import { canonicalJson } from '../../../../../shared/canonicalJson';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import type { HardwareProfile } from '../../../../../shared/local-models/model-fit';
import {
	buildTierTargetOptionGroups,
	type HarnessTierOptions,
	type TierSourceProblem,
} from '../../../../../shared/local-models/tier-options';
import {
	formatTierTargetSpec,
	harnessTierRows,
	parseTierTargetsEdit,
	parseTierTargetSpec,
	staleTierModels,
	suggestHarnessTierDefaults,
	TIER_LEVELS,
	TIER_NOT_MAPPED_LABEL,
	TIER_TARGET_SOURCE_LABELS,
	tierTargetLabel,
	withHarnessTierTargets,
	type HarnessTierDefaults,
	type HarnessTierSuggestions,
	type ModelTier,
	type TierTargets,
} from '../../../../../shared/modelTiers';
import { useHarnessTierOptions, useLocalModelsHardware } from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { FormFieldLabel } from '../../../ui/FormFieldLabel';
import { MiniBadge } from '../../../ui/MiniBadge';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { AssignmentOptionElements } from './AssignmentOptionElements';
import { CardButton } from './CardButton';

/** A per-harness record with one harness taken out. */
function without<T>(
	record: Partial<Record<AgentId, T>>,
	harness: AgentId
): Partial<Record<AgentId, T>> {
	const next = { ...record };
	delete next[harness];
	return next;
}

export interface TierDefaultsSectionProps {
	theme: Theme;
	/** The saved sources, to name a source target. The tab's one endpoints list. */
	endpoints: readonly LocalModelEndpoint[];
}

export function TierDefaultsSection({ theme, endpoints }: TierDefaultsSectionProps) {
	const saved = useSettingsStore((s) => s.harnessTierDefaults);
	const setHarnessTierDefaults = useSettingsStore((s) => s.setHarnessTierDefaults);
	const { options, loading, error, refresh } = useHarnessTierOptions();
	const hardware = useLocalModelsHardware();

	// A harness is in `drafts` while its row holds edits that are not saved.
	const [drafts, setDrafts] = useState<Partial<Record<AgentId, TierTargets>>>({});
	// The last Suggest per harness, for the reason under each picker.
	const [suggestions, setSuggestions] = useState<Partial<Record<AgentId, HarnessTierSuggestions>>>(
		{}
	);
	// The last refused Save per harness, shown until the row changes again.
	const [refusals, setRefusals] = useState<Partial<Record<AgentId, string>>>({});

	const setDraft = useCallback((harness: AgentId, row: TierTargets | undefined) => {
		setDrafts((current) =>
			row === undefined ? without(current, harness) : { ...current, [harness]: row }
		);
		setRefusals((current) => without(current, harness));
	}, []);

	const save = useCallback(
		(harness: AgentId, row: TierTargets) => {
			// The saved sources are not passed: the pickers cannot produce an id
			// that names nothing, and a row whose source was removed must still
			// be able to save its other tiers.
			const edit = parseTierTargetsEdit(harness, row);
			if (!edit.ok) {
				setRefusals((current) => ({ ...current, [harness]: edit.error }));
				return;
			}
			setHarnessTierDefaults(withHarnessTierTargets(saved, harness, edit.tierTargets ?? {}));
			setDraft(harness, undefined);
		},
		[saved, setHarnessTierDefaults, setDraft]
	);

	// The sources are the same for every harness that can run on one, so a
	// source that did not answer is said once, under the table.
	const sourceProblems = useMemo(() => {
		const seen = new Map<string, TierSourceProblem>();
		for (const row of options ?? []) {
			for (const problem of row.problems) seen.set(problem.endpointId, problem);
		}
		return [...seen.values()];
	}, [options]);

	return (
		<div className="select-none space-y-3" data-testid="tier-defaults-section">
			<SectionCard theme={theme} className="space-y-4">
				<div className="flex items-start justify-between gap-3">
					<p className="text-xs opacity-70">
						A task that asks for a tier launches on the model set here. An agent that sets the tier
						itself wins. Nothing is saved until you press Save on a row.
					</p>
					<CardButton
						theme={theme}
						icon={loading ? Loader2 : RefreshCw}
						label={loading ? 'Listing...' : 'Refresh lists'}
						onClick={() => void refresh()}
						disabled={loading}
						testId="tier-defaults-refresh"
					/>
				</div>

				{error && (
					<p
						className="flex items-start gap-1.5 text-xs select-text"
						style={{ color: theme.colors.error }}
						data-testid="tier-defaults-error"
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>Could not list what each harness can run: {error}</span>
					</p>
				)}

				{options === null && !error && (
					<p className="text-xs opacity-70" data-testid="tier-defaults-loading">
						Listing what each harness can run...
					</p>
				)}

				{options !== null && options.length === 0 && (
					<p className="text-xs opacity-70" data-testid="tier-defaults-empty">
						No installed harness can be told which model to run.
					</p>
				)}

				{(options ?? []).map((row, index) => (
					<div
						key={row.harness}
						className={index === 0 ? '' : 'pt-4 border-t'}
						style={{ borderColor: theme.colors.border }}
					>
						<TierDefaultsRow
							theme={theme}
							options={row}
							saved={saved}
							draft={drafts[row.harness]}
							suggestions={suggestions[row.harness]}
							refusal={refusals[row.harness]}
							endpoints={endpoints}
							hardware={hardware.profile}
							onDraft={(next) => setDraft(row.harness, next)}
							onSuggested={(next) =>
								setSuggestions((current) =>
									next === undefined
										? without(current, row.harness)
										: { ...current, [row.harness]: next }
								)
							}
							onSave={(next) => save(row.harness, next)}
						/>
					</div>
				))}

				{sourceProblems.map((problem) => (
					<p
						key={problem.endpointId}
						className="text-xs opacity-70 select-text"
						data-testid="tier-defaults-source-problem"
					>
						{problem.name}: {problem.message}
					</p>
				))}
			</SectionCard>
		</div>
	);
}

interface TierDefaultsRowProps {
	theme: Theme;
	options: HarnessTierOptions;
	saved: HarnessTierDefaults;
	/** The row's unsaved edits, or undefined when it shows what is saved. */
	draft: TierTargets | undefined;
	suggestions: HarnessTierSuggestions | undefined;
	refusal: string | undefined;
	endpoints: readonly LocalModelEndpoint[];
	hardware: HardwareProfile | null;
	onDraft: (row: TierTargets | undefined) => void;
	onSuggested: (suggestions: HarnessTierSuggestions | undefined) => void;
	onSave: (row: TierTargets) => void;
}

function TierDefaultsRow({
	theme,
	options,
	saved,
	draft,
	suggestions,
	refusal,
	endpoints,
	hardware,
	onDraft,
	onSuggested,
	onSave,
}: TierDefaultsRowProps) {
	const { harness, name } = options;
	const savedRow = useMemo<TierTargets>(() => saved[harness] ?? {}, [saved, harness]);
	const row = draft ?? savedRow;
	const dirty = draft !== undefined && canonicalJson(draft) !== canonicalJson(savedRow);

	// The table as it would be stored, so every line under a picker is what a
	// launch would do with the row on screen, saved or not.
	const shown = useMemo(() => withHarnessTierTargets(saved, harness, row), [saved, harness, row]);
	const resolved = useMemo(() => harnessTierRows(harness, shown), [harness, shown]);
	const stale = useMemo(
		() => staleTierModels(harness, options.catalog, shown),
		[harness, options.catalog, shown]
	);

	const choose = (tier: ModelTier, spec: string) => {
		const parsed = parseTierTargetSpec(spec);
		if (!parsed.ok) return;
		const next: TierTargets = { ...row };
		if (parsed.target) next[tier] = parsed.target;
		else delete next[tier];
		onDraft(next);
	};

	const suggest = () => {
		const next = suggestHarnessTierDefaults(harness, options.catalog, options.sources);
		const filled: TierTargets = { ...row };
		// A tier Suggest names nothing for keeps the value it has.
		for (const tier of TIER_LEVELS) {
			const target = next[tier].target;
			if (target) filled[tier] = target;
		}
		onSuggested(next);
		onDraft(filled);
	};

	const reset = () => {
		onSuggested(undefined);
		onDraft({});
	};

	const discard = () => {
		onSuggested(undefined);
		onDraft(undefined);
	};

	return (
		<div className="space-y-2" data-testid={`tier-defaults-row-${harness}`}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{name}
					</span>
					{dirty && (
						<MiniBadge
							label="Not saved"
							theme={theme}
							color={theme.colors.warning}
							testId={`tier-defaults-unsaved-${harness}`}
						/>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					<CardButton
						theme={theme}
						icon={Wand2}
						label="Suggest"
						onClick={suggest}
						disabled={false}
						testId={`tier-defaults-suggest-${harness}`}
					/>
					<CardButton
						theme={theme}
						icon={RotateCcw}
						label="Reset"
						onClick={reset}
						disabled={Object.keys(row).length === 0}
						testId={`tier-defaults-reset-${harness}`}
					/>
					{dirty && (
						<CardButton
							theme={theme}
							icon={Undo2}
							label="Discard"
							onClick={discard}
							disabled={false}
							testId={`tier-defaults-discard-${harness}`}
						/>
					)}
					<CardButton
						theme={theme}
						icon={Save}
						label="Save"
						onClick={() => onSave(row)}
						disabled={!dirty}
						primary
						testId={`tier-defaults-save-${harness}`}
					/>
				</div>
			</div>

			<div className="grid grid-cols-3 gap-3">
				{resolved.map((entry) => {
					const { tier } = entry;
					const target = row[tier];
					const selectId = `tier-defaults-${harness}-${tier}`;
					const groups = buildTierTargetOptionGroups({
						options,
						current: target,
						fallthroughLabel: `${TIER_TARGET_SOURCE_LABELS['built-in']} (${
							entry.builtIn ?? TIER_NOT_MAPPED_LABEL.toLowerCase()
						})`,
						endpoints,
						hardware,
					});
					const sourceLabel = entry.source
						? TIER_TARGET_SOURCE_LABELS[entry.source]
						: TIER_NOT_MAPPED_LABEL;
					const staleEntry = stale.find((candidate) => candidate.tier === tier);
					const suggestion = suggestions?.[tier];
					// A reason describes the value Suggest put there. Once the picker
					// holds something else, the reason is about a value not on screen.
					const suggestionShown =
						suggestion &&
						(suggestion.target === null ||
							formatTierTargetSpec(suggestion.target) === formatTierTargetSpec(target));
					return (
						<div key={tier} className="min-w-0 space-y-1">
							<div className="flex items-center justify-between gap-1">
								<FormFieldLabel theme={theme} htmlFor={selectId}>
									{tier}
								</FormFieldLabel>
								<MiniBadge
									label={sourceLabel}
									theme={theme}
									color={
										entry.source === 'harness-default' ? theme.colors.accent : theme.colors.textDim
									}
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
								className="w-full p-1.5 rounded border bg-transparent outline-none text-xs"
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
							{staleEntry && (
								<p
									className="flex items-start gap-1 text-xs select-text"
									style={{ color: theme.colors.warning }}
									data-testid={`${selectId}-stale`}
								>
									<AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
									<span>
										{staleEntry.model} is not in {name}'s catalogue.
										{staleEntry.replacement ? ` Suggest would use ${staleEntry.replacement}.` : ''}
									</span>
								</p>
							)}
							{suggestionShown && (
								<p
									className="text-xs opacity-70 select-text"
									data-testid={`${selectId}-suggestion`}
								>
									{suggestion.target ? `Suggested: ${suggestion.reason}` : suggestion.reason}
								</p>
							)}
						</div>
					);
				})}
			</div>

			{!options.runOn.supported && (
				<p
					className="text-xs opacity-70 select-text"
					data-testid={`tier-defaults-no-run-on-${harness}`}
				>
					Provider models only. {options.runOn.reason}
				</p>
			)}
			{refusal && (
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid={`tier-defaults-refusal-${harness}`}
				>
					Not saved. {refusal}
				</p>
			)}
		</div>
	);
}
