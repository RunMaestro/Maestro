/**
 * CueInjectionScreenField - the prompt-injection screen on a Cue trigger:
 * whether a local classifier scores the untrusted text the trigger carries (a
 * comment, an issue body, a webhook payload) before a run starts, and the
 * score that blocks it.
 *
 * Drawn only under triggers that carry untrusted text (see
 * `cueEventCarriesUntrustedText`); on any other trigger there is nothing to
 * score. The CLI half is `maestro-cli cue screen`.
 *
 * Like the Gate, the screen is two halves: the setting on the subscription
 * and a model on the `injection-screen` Local Models task, which is OFF by
 * default. The readiness line says which state the task is in and what the
 * failure policy does until it is ready (a command is blocked, a prompt starts
 * unscreened with a warning; see `src/shared/cue/injection-screen.ts`).
 *
 * Controlled: the caller owns the value and folds it into the node's one
 * debounced config write.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import type { Theme } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useLocalModelTaskReadiness } from '../../../hooks/localModels';
import {
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../../../shared/local-models/tasks';
import {
	DEFAULT_CUE_INJECTION_THRESHOLD,
	cueInjectionThresholdProblem,
	type CueInjectionScreenMode,
	type CueInjectionScreenSetting,
} from '../../../../shared/cue/injection-screen';
import { CueSelect } from './CueSelect';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';

export interface CueInjectionScreenFieldProps {
	theme: Theme;
	value: CueInjectionScreenSetting;
	onChange: (next: CueInjectionScreenSetting) => void;
}

const MODE_OPTIONS: { value: CueInjectionScreenMode; label: string }[] = [
	{ value: 'auto', label: 'Automatic: screen commands that use this text' },
	{ value: 'on', label: 'Always screen' },
	{ value: 'off', label: 'Never screen' },
];

/** What happens to events while the screen cannot run, per mode and task state. */
function notReadyConsequence(mode: CueInjectionScreenMode, taskIsOff: boolean): string {
	if (mode === 'on') {
		return 'Until then, a command is blocked and a prompt starts unscreened with a warning.';
	}
	return taskIsOff
		? 'Until a classifier is assigned, nothing is screened.'
		: 'Until then, a command that uses this text is blocked.';
}

export function CueInjectionScreenField({ theme, value, onChange }: CueInjectionScreenFieldProps) {
	const fieldId = useId();
	const screens = value.mode !== 'off';
	const threshold = value.threshold ?? DEFAULT_CUE_INJECTION_THRESHOLD;

	// The box holds what was typed. A half-typed number ("0.") is not a
	// threshold yet, so it stays local until it parses to one that can be saved.
	const [thresholdText, setThresholdText] = useState(String(threshold));
	useEffect(() => {
		setThresholdText((text) => (Number(text) === threshold ? text : String(threshold)));
	}, [threshold]);

	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	// Everything the verdict depends on that the renderer can see, so a model
	// assigned while the editor is open is picked up without reopening it.
	const revision = useMemo(
		() => JSON.stringify([resolveLocalModelAssignment(assignments, 'injection-screen'), endpoints]),
		[assignments, endpoints]
	);
	const { readiness } = useLocalModelTaskReadiness(revision, 'injection-screen');
	const verdict = readiness['injection-screen'];

	const labelStyle = getLabelStyle(theme);
	const inputStyle = getInputStyle(theme);
	const noteStyle: React.CSSProperties = { fontSize: 11, lineHeight: 1.4 };

	return (
		<div
			style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
			data-testid="cue-injection-screen-field"
		>
			<label htmlFor={`${fieldId}-mode`} style={{ ...labelStyle, marginBottom: 0 }}>
				Prompt-injection screen
			</label>
			<CueSelect
				id={`${fieldId}-mode`}
				value={value.mode}
				options={MODE_OPTIONS}
				onChange={(next) => onChange({ ...value, mode: next as CueInjectionScreenMode })}
				theme={theme}
			/>
			<div style={{ ...noteStyle, color: theme.colors.textDim }}>
				This trigger carries text other people wrote. A local classifier scores the parts a prompt
				or command uses, and a score at or above the threshold blocks the run. A blocked run is
				listed in the Activity Log with the variable and the score. A clean score does not make text
				safe to put in a shell command.
			</div>

			{screens && (
				<label htmlFor={`${fieldId}-threshold`} style={{ ...labelStyle, marginBottom: 0 }}>
					Block at a score of
					<input
						id={`${fieldId}-threshold`}
						type="number"
						min={0.01}
						max={1}
						step={0.05}
						value={thresholdText}
						onChange={(e) => {
							setThresholdText(e.target.value);
							const parsed = Number(e.target.value);
							if (e.target.value !== '' && cueInjectionThresholdProblem(parsed) === null) {
								onChange({ ...value, threshold: parsed });
							}
						}}
						style={inputStyle}
						data-testid="cue-injection-threshold"
					/>
				</label>
			)}

			{screens && verdict && verdict.state === 'ready' && (
				<div
					className="flex items-start gap-1.5"
					style={{ ...noteStyle, color: theme.colors.textDim }}
					data-testid="cue-injection-screen-ready"
				>
					<Check className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
					<span>
						Screened by{' '}
						{localModelAssignmentSourceLabel(verdict.assignment, endpoints) ??
							'the assigned source'}
						.
					</span>
				</div>
			)}

			{screens && verdict && verdict.state !== 'ready' && (
				<div
					className="flex items-start gap-1.5 select-text"
					style={{
						...noteStyle,
						// Asking for a screen that cannot run is a problem. The
						// default with no classifier assigned is only a fact.
						color:
							value.mode === 'on' || verdict.state !== 'off'
								? theme.colors.warning
								: theme.colors.textDim,
					}}
					data-testid="cue-injection-screen-not-ready"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
					<span>
						{verdict.detail}
						{verdict.suggestedAction ? ` ${verdict.suggestedAction}` : ''}{' '}
						{notReadyConsequence(value.mode, verdict.state === 'off')}
					</span>
				</div>
			)}
		</div>
	);
}
