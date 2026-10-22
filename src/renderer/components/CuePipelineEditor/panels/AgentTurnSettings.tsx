/**
 * AgentTurnSettings - the model and effort a Cue agent run uses.
 *
 * Two surfaces mount it: a Pipeline Graph agent node and the Scheduled Tasks
 * form. It edits `tier` OR an exact `model`, plus `effort`; the host stores
 * them on the subscription, and the engine resolves them per provider with the
 * same tables Auto Run uses, so "High" here means the provider's top model and
 * the top of its effort ladder.
 *
 * Tier options are labelled with the model they resolve to for this agent's
 * provider. A provider with no tier table (Codex, OpenCode) offers only the
 * agent default and an exact model id, because a tier there would be ignored.
 */

import { useState } from 'react';
import type { Theme } from '../../../types';
import type { CueTurnSettings } from '../../../../shared/cue/turn-settings';
import type { ToolType } from '../../../../shared/types';
import {
	TIER_LEVELS,
	asTierLevel,
	resolveEffortLevel,
	resolveTierModel,
	supportsEffortSelection,
} from '../../../../shared/modelTiers';
import { CueSelect, type CueSelectOption } from './CueSelect';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';

/** Select value for "type an exact model id". Never a tier name. */
const EXACT_MODEL = 'exact';

const LEVEL_LABELS = { low: 'Low', medium: 'Medium', high: 'High' } as const;

interface AgentTurnSettingsProps {
	/** The current choice plus the provider it runs on. An agent node's data
	 *  fits as-is. An unknown provider offers only the default and an exact id. */
	data: CueTurnSettings & { toolType?: string };
	theme: Theme;
	/** Receives the changed axes. An `undefined` value clears that axis. */
	onChange: (patch: Partial<CueTurnSettings>) => void;
}

export function AgentTurnSettings({ data, theme, onChange }: AgentTurnSettingsProps) {
	const toolType = data.toolType as ToolType;
	// Picking "Exact model" before typing leaves `model` empty, so the mode is
	// held locally rather than derived from the data alone.
	const [exactMode, setExactMode] = useState(!!data.model);

	const tierOptions: CueSelectOption[] = TIER_LEVELS.flatMap((tier) => {
		const model = resolveTierModel(toolType, tier);
		// Keep a tier the YAML already set even when this provider cannot map
		// it, so the select shows the truth instead of snapping to the default.
		if (!model && data.tier !== tier) return [];
		return [
			{ value: tier, label: `${LEVEL_LABELS[tier]} tier${model ? ` (${model})` : ' (unmapped)'}` },
		];
	});
	const modelOptions: CueSelectOption[] = [
		{ value: '', label: 'Agent default' },
		...tierOptions,
		{ value: EXACT_MODEL, label: 'Exact model...' },
	];
	const modelValue = exactMode ? EXACT_MODEL : (data.tier ?? '');

	const effortOptions: CueSelectOption[] = [
		{ value: '', label: 'Agent default' },
		...TIER_LEVELS.map((level) => {
			const mapped = resolveEffortLevel(toolType, level);
			return { value: level, label: `${LEVEL_LABELS[level]}${mapped ? ` (${mapped})` : ''}` };
		}),
	];
	const showEffort = supportsEffortSelection(toolType) || !!data.effort;

	const labelStyle = { ...getLabelStyle(theme), flex: 1, margin: 0 };
	const captionStyle = {
		fontSize: 10,
		color: theme.colors.textDim,
		marginBottom: 3,
		display: 'block',
	} as const;

	return (
		<div style={{ display: 'flex', gap: 10, flexShrink: 0 }} data-testid="agent-turn-settings">
			<div style={labelStyle}>
				<span style={captionStyle}>Model</span>
				<CueSelect
					value={modelValue}
					options={modelOptions}
					aria-label="Model"
					onChange={(value) => {
						if (value === EXACT_MODEL) {
							setExactMode(true);
							onChange({ tier: undefined });
							return;
						}
						setExactMode(false);
						onChange({ tier: asTierLevel(value), model: undefined });
					}}
					theme={theme}
				/>
			</div>
			{exactMode && (
				<label style={labelStyle}>
					<span style={captionStyle}>Model id</span>
					<input
						type="text"
						value={data.model ?? ''}
						placeholder="e.g. gpt-5.5-codex"
						spellCheck={false}
						onChange={(e) => onChange({ model: e.target.value.trim() || undefined })}
						style={{ ...getInputStyle(theme), width: '100%' }}
					/>
				</label>
			)}
			{showEffort && (
				<div style={labelStyle}>
					<span style={captionStyle}>Effort</span>
					<CueSelect
						value={data.effort ?? ''}
						options={effortOptions}
						aria-label="Effort"
						onChange={(value) => onChange({ effort: asTierLevel(value) })}
						theme={theme}
					/>
				</div>
			)}
		</div>
	);
}
