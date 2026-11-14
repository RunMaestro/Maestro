/**
 * CueGateField - the Gate on a Cue subscription: a condition in plain language
 * that a local model checks before an event starts a run.
 *
 * One field for every surface that authors a gate (the trigger panel in the
 * pipeline editor, the Scheduled Task form), so they cannot drift on the help
 * text, the length rule, or what they say when no model is assigned. The CLI
 * halves are `maestro-cli cue gate` and `cue schedule --gate`.
 *
 * A gate is two halves: the condition, stored on the subscription, and a model
 * on the `cue-gate` Local Models task, which is OFF by default. A condition
 * with no model checks nothing, and the engine fails open (the run starts, with
 * a warning), so a gate typed here would otherwise look live while screening
 * no event. The readiness line under the field says which state the task is
 * in, resolved by the main process, and what the policy does until it is ready.
 *
 * Controlled: the caller owns the value. The trigger panel batches it into the
 * node's debounced config write, and the form holds it until Save.
 */

import { useId, useMemo } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import type { Theme } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useLocalModelTaskReadiness } from '../../../hooks/localModels';
import {
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../../../shared/local-models/tasks';
import {
	CUE_GATE_MAX_CONDITION_LENGTH,
	type CueGateOnUnavailable,
} from '../../../../shared/cue/gate';
import { CueSelect } from './CueSelect';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';

/** What the caller stores: the condition as typed, and the policy. */
export interface CueGateFieldValue {
	condition: string;
	onUnavailable: CueGateOnUnavailable;
}

export interface CueGateFieldProps {
	theme: Theme;
	value: CueGateFieldValue;
	onChange: (next: CueGateFieldValue) => void;
	/**
	 * `panel` matches the trigger panel's compact fields, `form` the Scheduled
	 * Task form's. Only the type size and padding differ.
	 */
	variant?: 'panel' | 'form';
}

const POLICY_OPTIONS: { value: CueGateOnUnavailable; label: string }[] = [
	{ value: 'run', label: 'Start the run and warn me' },
	{ value: 'skip', label: 'Skip the event' },
];

/** What happens to events while the gate cannot be checked, per policy. */
function unavailableConsequence(policy: CueGateOnUnavailable): string {
	return policy === 'skip'
		? 'Until then, every event is skipped.'
		: 'Until then, every event starts a run unchecked.';
}

export function CueGateField({ theme, value, onChange, variant = 'panel' }: CueGateFieldProps) {
	const fieldId = useId();
	const hasGate = value.condition.trim().length > 0;

	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	// Everything the verdict depends on that the renderer can see, so a model
	// assigned while the editor is open is picked up without reopening it.
	const revision = useMemo(
		() => JSON.stringify([resolveLocalModelAssignment(assignments, 'cue-gate'), endpoints]),
		[assignments, endpoints]
	);
	const { readiness } = useLocalModelTaskReadiness(revision, 'cue-gate');
	const verdict = readiness['cue-gate'];

	const isForm = variant === 'form';
	const labelStyle: React.CSSProperties = isForm
		? { ...getLabelStyle(theme), fontSize: 12 }
		: getLabelStyle(theme);
	const inputStyle: React.CSSProperties = isForm
		? { ...getInputStyle(theme), padding: '6px 8px', fontSize: 14 }
		: getInputStyle(theme);
	const noteStyle: React.CSSProperties = { fontSize: isForm ? 12 : 11, lineHeight: 1.4 };

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="cue-gate-field">
			<label htmlFor={`${fieldId}-condition`} style={{ ...labelStyle, marginBottom: 0 }}>
				Gate (optional)
			</label>
			<textarea
				id={`${fieldId}-condition`}
				value={value.condition}
				onChange={(e) => onChange({ ...value, condition: e.target.value })}
				rows={2}
				maxLength={CUE_GATE_MAX_CONDITION_LENGTH}
				placeholder="The comment asks for a code change or reports a bug"
				className="resize-y"
				style={inputStyle}
				data-testid="cue-gate-condition"
			/>
			<div style={{ ...noteStyle, color: theme.colors.textDim }}>
				A condition in plain language. A local model reads each event and starts a run only when the
				event meets it. A skipped event is listed in the Activity Log as gated, with the reason.
				Manual runs are not gated. This saves agent turns; it is not a security control.
			</div>

			{hasGate && (
				<>
					<label htmlFor={`${fieldId}-policy`} style={{ ...labelStyle, marginBottom: 0 }}>
						If no model can answer
					</label>
					<CueSelect
						id={`${fieldId}-policy`}
						value={value.onUnavailable}
						options={POLICY_OPTIONS}
						onChange={(next) => onChange({ ...value, onUnavailable: next as CueGateOnUnavailable })}
						theme={theme}
					/>
				</>
			)}

			{hasGate && verdict && verdict.state === 'ready' && (
				<div
					className="flex items-start gap-1.5"
					style={{ ...noteStyle, color: theme.colors.textDim }}
					data-testid="cue-gate-ready"
				>
					<Check className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
					<span>
						Checked by{' '}
						{localModelAssignmentSourceLabel(verdict.assignment, endpoints) ??
							'the assigned source'}
						.
					</span>
				</div>
			)}

			{hasGate && verdict && verdict.state !== 'ready' && (
				<div
					className="flex items-start gap-1.5 select-text"
					style={{ ...noteStyle, color: theme.colors.warning }}
					data-testid="cue-gate-not-ready"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
					<span>
						{verdict.detail}
						{verdict.suggestedAction ? ` ${verdict.suggestedAction}` : ''}{' '}
						{unavailableConsequence(value.onUnavailable)}
					</span>
				</div>
			)}
		</div>
	);
}
