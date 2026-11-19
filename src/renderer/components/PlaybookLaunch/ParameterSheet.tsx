/**
 * ParameterSheet - the form that answers a playbook's parameters before a run.
 *
 * One row per `PlaybookParamSpec`, with the control its type calls for, the
 * help text under the label, a provenance badge (You, Detected, Default,
 * Unresolved), and inline validation from `validatePlaybookParamValue`. Every
 * answer is saved to the playbook record as the user types, so the form can
 * be closed and reopened (or the run resumed from the CLI) without losing it.
 *
 * Mounted in two places: the Playbook Exchange's configure step after Install
 * and Run, and the standalone `PlaybookConfigureModal`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import {
	collectUnresolvedRequired,
	describeMissingRequiredParams,
	describePlaybookParamProvenance,
	mergeProposedParamValues,
	resolvePlaybookParamSpecs,
	splitMultiEnumValue,
	validatePlaybookParamValue,
	type PlaybookParamProposals,
	type PlaybookParamProvenance,
	type PlaybookParamSpec,
	type PlaybookParamValues,
} from '../../../shared/playbookParams';
import type { Playbook } from '../../../shared/types';
import { usePlaybookParamAnswers } from '../../hooks/batch/usePlaybookParamAnswers';
import type { Theme } from '../../types';
import { FormInput } from '../ui/FormInput';
import { MiniBadge } from '../ui/MiniBadge';
import { ToggleChipGroup } from '../ui/ToggleChipGroup';

export interface ParameterSheetProps {
	theme: Theme;
	/** The agent whose playbook store holds the record. */
	sessionId: string;
	playbook: Playbook;
	/** Values found for unanswered parameters (facts pack, guided interview). */
	proposals?: PlaybookParamProposals;
	/** Label of the primary button. */
	runLabel?: string;
	/** Icon of the primary button. Defaults to a play triangle. */
	runIcon?: ReactNode;
	/** Rendered at the left of the footer, such as a Back button. */
	secondaryAction?: ReactNode;
	/**
	 * Called with the user's answers (blank answers included) on mount and on
	 * every change, so a parent that unmounts the sheet can remount it on them.
	 */
	onAnswersChange?: (answers: PlaybookParamValues) => void;
	/**
	 * Called with the answers the run uses (stored answers plus proposals),
	 * after every pending save has been written.
	 */
	onRun: (values: PlaybookParamValues) => void | Promise<void>;
}

const PROVENANCE_LABEL: Record<PlaybookParamProvenance, string> = {
	you: 'You',
	detected: 'Detected',
	default: 'Default',
	unresolved: 'Unresolved',
};

const TYPE_LABEL: Record<PlaybookParamSpec['type'], string> = {
	string: 'Text',
	url: 'URL',
	number: 'Number',
	'multi-enum': 'Choice',
};

function provenanceColor(
	theme: Theme,
	provenance: PlaybookParamProvenance,
	required: boolean
): string {
	switch (provenance) {
		case 'you':
			return theme.colors.accent;
		case 'detected':
			return theme.colors.success;
		case 'default':
			return theme.colors.textDim;
		case 'unresolved':
			return required ? theme.colors.warning : theme.colors.textDim;
	}
}

/** The row's state, derived once per render from the spec, answers, and proposals. */
interface ParameterRowModel {
	spec: PlaybookParamSpec;
	provenance: PlaybookParamProvenance;
	/** The user has answered this name (possibly with a blank). */
	answered: boolean;
	/** What the control shows: the answer, else a proposal, else empty (the default is the placeholder). */
	shown: string;
	/** The value the run resolves to, validated as such. */
	effective: string;
	error: string | null;
	evidence?: string;
}

function buildRowModel(
	spec: PlaybookParamSpec,
	answers: PlaybookParamValues,
	proposals: PlaybookParamProposals | undefined
): ParameterRowModel {
	const provenance = describePlaybookParamProvenance(spec, answers, proposals);
	const answered = Object.prototype.hasOwnProperty.call(answers, spec.name);
	const proposal = proposals?.[spec.name];
	const shown = answered ? answers[spec.name] : provenance === 'detected' ? proposal!.value : '';
	const effective = shown.trim() !== '' ? shown : (spec.default ?? '');
	return {
		spec,
		provenance,
		answered,
		shown,
		effective,
		error: validatePlaybookParamValue(spec, effective),
		evidence: provenance === 'detected' ? proposal?.evidence : undefined,
	};
}

export function ParameterSheet({
	theme,
	sessionId,
	playbook,
	proposals,
	runLabel = 'Run',
	runIcon,
	secondaryAction,
	onAnswersChange,
	onRun,
}: ParameterSheetProps) {
	const specs = useMemo(
		() => resolvePlaybookParamSpecs(playbook.prompt, playbook.parameterOverlay),
		[playbook.prompt, playbook.parameterOverlay]
	);
	const { answers, setAnswer, flush } = usePlaybookParamAnswers({
		sessionId,
		playbookId: playbook.id,
		initialAnswers: playbook.parameterValues,
	});
	useEffect(() => {
		onAnswersChange?.(answers);
	}, [answers, onAnswersChange]);
	// A required row says it is empty only once the user has been in it; until
	// then its Unresolved badge carries that news without shouting.
	const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
	const [running, setRunning] = useState(false);

	const rows = useMemo(
		() => specs.map((spec) => buildRowModel(spec, answers, proposals)),
		[specs, answers, proposals]
	);
	const effectiveValues = useMemo(
		() => mergeProposedParamValues(answers, proposals),
		[answers, proposals]
	);
	const missing = useMemo(
		() => collectUnresolvedRequired(specs, effectiveValues),
		[specs, effectiveValues]
	);
	const invalidCount = rows.filter((row) => row.error !== null).length;
	const runBlockedReason =
		missing.length > 0
			? describeMissingRequiredParams(missing)
			: invalidCount > 0
				? `Fix ${invalidCount === 1 ? 'the highlighted parameter' : `${invalidCount} highlighted parameters`} first.`
				: null;

	const change = (name: string, value: string) => {
		setAnswer(name, value);
		setTouched((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
	};

	const handleRun = async () => {
		if (runBlockedReason || running) return;
		setRunning(true);
		try {
			await flush();
			await onRun(effectiveValues);
		} finally {
			setRunning(false);
		}
	};

	return (
		<div className="flex flex-col h-full min-h-0" data-testid="parameter-sheet">
			<div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
				{rows.length === 0 ? (
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						This playbook has no parameters to answer.
					</p>
				) : (
					rows.map((row) => (
						<ParameterRow
							key={row.spec.name}
							theme={theme}
							row={row}
							showRequiredError={touched.has(row.spec.name)}
							onChange={(value) => change(row.spec.name, value)}
						/>
					))
				)}
			</div>

			<div
				className="flex items-center gap-3 px-4 py-3 border-t shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				{secondaryAction}
				{/* Always rendered: it is the spacer that keeps the primary button right. */}
				<span
					className="flex-1 min-w-0 text-xs text-right select-text"
					style={{ color: theme.colors.textDim }}
					data-testid={runBlockedReason ? 'parameter-sheet-blocked' : undefined}
				>
					{runBlockedReason}
				</span>
				<button
					type="button"
					onClick={() => void handleRun()}
					disabled={runBlockedReason !== null || running}
					title={runBlockedReason ?? undefined}
					className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					data-testid="parameter-sheet-run"
				>
					{runIcon ?? <Play className="w-3.5 h-3.5" aria-hidden="true" />}
					{runLabel}
				</button>
			</div>
		</div>
	);
}

interface ParameterRowProps {
	theme: Theme;
	row: ParameterRowModel;
	showRequiredError: boolean;
	onChange: (value: string) => void;
}

function ParameterRow({ theme, row, showRequiredError, onChange }: ParameterRowProps) {
	const { spec, provenance, shown, error, evidence } = row;
	const label = spec.label && spec.label !== spec.name ? spec.label : spec.name;
	// "is required" waits for a touch; every other message shows at once.
	const visibleError = error && (provenance !== 'unresolved' || showRequiredError) ? error : null;
	const testId = `parameter-row-${spec.name}`;
	const placeholder = spec.default ?? (spec.options?.[0] ? `e.g. ${spec.options[0]}` : undefined);

	let control: ReactNode;
	if (spec.type === 'multi-enum' && spec.options && spec.options.length > 0) {
		// Untouched, the default's chips show as on; once the user has answered,
		// even by turning every chip off, the chips show exactly their answer.
		const selected = splitMultiEnumValue(row.answered || shown !== '' ? shown : row.effective);
		control = (
			<ToggleChipGroup
				theme={theme}
				ariaLabel={label}
				options={spec.options.map((option) => ({ value: option, label: option }))}
				selected={selected}
				onChange={(next) => onChange(next.join(', '))}
				invalid={Boolean(visibleError)}
				testId={`${testId}-chips`}
			/>
		);
	} else {
		control = (
			<FormInput
				theme={theme}
				value={shown}
				onChange={onChange}
				type={spec.type === 'number' ? 'number' : spec.type === 'url' ? 'url' : 'text'}
				min={spec.type === 'number' ? spec.min : undefined}
				max={spec.type === 'number' ? spec.max : undefined}
				step={spec.type === 'number' ? 'any' : undefined}
				placeholder={placeholder}
				error={visibleError ?? undefined}
				monospace={spec.type !== 'string'}
				heightClass="py-2"
				testId={`${testId}-input`}
			/>
		);
	}

	const hints =
		spec.type !== 'multi-enum' && spec.options && spec.options.length > 0
			? `Examples: ${spec.options.join(', ')}`
			: null;

	return (
		<div data-testid={testId} data-provenance={provenance}>
			<div className="flex items-center gap-2 mb-1">
				<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					{label}
				</span>
				{spec.required && (
					<span
						className="text-sm"
						style={{ color: theme.colors.error }}
						title="Required"
						aria-label="required"
					>
						*
					</span>
				)}
				<MiniBadge label={TYPE_LABEL[spec.type]} theme={theme} color={theme.colors.textDim} />
				<span className="flex-1" />
				<MiniBadge
					label={PROVENANCE_LABEL[provenance]}
					theme={theme}
					color={provenanceColor(theme, provenance, spec.required)}
					title={
						provenance === 'detected'
							? (evidence ?? 'Found on this machine')
							: provenance === 'default'
								? `The playbook's default: ${spec.default}`
								: undefined
					}
					testId={`${testId}-provenance`}
				/>
			</div>
			{label !== spec.name && (
				<div className="text-2xs font-mono mb-1" style={{ color: theme.colors.textDim }}>
					{spec.name}
				</div>
			)}
			{spec.help && (
				<p className="text-xs mb-2 select-text" style={{ color: theme.colors.textDim }}>
					{spec.help}
				</p>
			)}
			{control}
			{spec.type === 'multi-enum' && visibleError && (
				<p className="mt-1 text-xs select-text" style={{ color: theme.colors.error }}>
					{visibleError}
				</p>
			)}
			{hints && (
				<p className="mt-1 text-2xs select-text" style={{ color: theme.colors.textDim }}>
					{hints}
				</p>
			)}
		</div>
	);
}
