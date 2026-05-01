/**
 * DispatchProfileFields — shared field set for editing an AgentDispatchProfile.
 *
 * Renders:
 *   - Fleet member toggle (fleetEnabled)
 *   - Auto-pickup toggle (autoPickupEnabled)
 *   - Max concurrent claims (numeric input)
 *   - Capability tags (chip list with add/remove)
 *   - Runner script path (text input)
 *   - Suggested defaults preview with "Reset to defaults" button
 *
 * Consumed by:
 *   - AgentDispatchProfileEditor (FleetView inline editor)
 *   - EditAgentModal (per-agent settings dialog)
 *
 * The component is purely controlled — callers own the profile state and
 * pass `onChange` to receive updates.
 */

import { useState, useRef } from 'react';
import { X, Plus, RotateCcw } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	AgentDispatchProfile,
	AgentDispatchSuggestedDefaults,
} from '../../../shared/agent-dispatch-types';

export interface DispatchProfileFieldsProps {
	profile: AgentDispatchProfile;
	onChange: (updated: AgentDispatchProfile) => void;
	theme: Theme;
	/**
	 * Suggested defaults sourced from the AgentDefinition (read-only preview).
	 * When provided, a "Suggested defaults" row is shown and a "Reset" button
	 * lets the user restore tags / maxConcurrentClaims to those values.
	 */
	suggestedDefaults?: AgentDispatchSuggestedDefaults;
	/** When true, the fleet-member toggle is shown. Defaults to true. */
	showFleetToggle?: boolean;
}

export function DispatchProfileFields({
	profile,
	onChange,
	theme,
	suggestedDefaults,
	showFleetToggle = true,
}: DispatchProfileFieldsProps) {
	const [newTag, setNewTag] = useState('');
	const tagInputRef = useRef<HTMLInputElement>(null);

	const inputStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	} as const;

	// ── helpers ────────────────────────────────────────────────────────────────

	const addTag = () => {
		const trimmed = newTag.trim().toLowerCase();
		if (!trimmed || profile.capabilityTags.includes(trimmed)) {
			setNewTag('');
			return;
		}
		onChange({ ...profile, capabilityTags: [...profile.capabilityTags, trimmed] });
		setNewTag('');
	};

	const removeTag = (tag: string) => {
		onChange({ ...profile, capabilityTags: profile.capabilityTags.filter((t) => t !== tag) });
	};

	const applyTag = (tag: string) => {
		if (!profile.capabilityTags.includes(tag)) {
			onChange({ ...profile, capabilityTags: [...profile.capabilityTags, tag] });
		}
	};

	const resetToDefaults = () => {
		if (!suggestedDefaults) return;
		onChange({
			...profile,
			capabilityTags: suggestedDefaults.capabilityTags ?? profile.capabilityTags,
			maxConcurrentClaims: suggestedDefaults.maxConcurrentClaims ?? profile.maxConcurrentClaims,
		});
	};

	// ── render ─────────────────────────────────────────────────────────────────

	return (
		<div className="flex flex-col gap-3">
			{/* Fleet member toggle */}
			{showFleetToggle && (
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						className="rounded"
						checked={profile.fleetEnabled ?? false}
						onChange={(e) => onChange({ ...profile, fleetEnabled: e.target.checked })}
					/>
					<span className="text-sm" style={{ color: theme.colors.textMain }}>
						Fleet member
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						(eligible to receive dispatch work items)
					</span>
				</label>
			)}

			{/* Auto-pickup toggle */}
			<label className="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					className="rounded"
					checked={profile.autoPickupEnabled}
					onChange={(e) => onChange({ ...profile, autoPickupEnabled: e.target.checked })}
				/>
				<span className="text-sm" style={{ color: theme.colors.textMain }}>
					Auto-pickup enabled
				</span>
			</label>

			{/* Max concurrent claims */}
			<div className="flex items-center gap-2">
				<label
					className="text-xs shrink-0"
					style={{ color: theme.colors.textDim }}
					htmlFor="dispatch-max-claims"
				>
					Max concurrent claims
				</label>
				<input
					id="dispatch-max-claims"
					type="number"
					min={1}
					max={20}
					className="w-16 px-2 py-0.5 text-xs rounded border"
					style={inputStyle}
					value={profile.maxConcurrentClaims}
					onChange={(e) => {
						const v = parseInt(e.target.value, 10);
						if (!isNaN(v) && v >= 1) {
							onChange({ ...profile, maxConcurrentClaims: v });
						}
					}}
				/>
			</div>

			{/* Capability tags */}
			<div className="flex flex-col gap-1.5">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Capability tags
				</span>

				{/* Tag chips */}
				<div className="flex flex-wrap gap-1.5 min-h-[1.5rem]">
					{profile.capabilityTags.length === 0 && (
						<span className="text-xs italic" style={{ color: theme.colors.textDim }}>
							No tags — agent accepts any work.
						</span>
					)}
					{profile.capabilityTags.map((tag) => (
						<span
							key={tag}
							className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: theme.colors.accentDim,
								color: theme.colors.accentText,
							}}
						>
							{tag}
							<button
								className="hover:opacity-60 transition-opacity"
								onClick={() => removeTag(tag)}
								title={`Remove ${tag}`}
							>
								<X className="w-3 h-3" />
							</button>
						</span>
					))}
				</div>

				{/* Add tag row */}
				<div className="flex gap-1.5">
					<input
						ref={tagInputRef}
						type="text"
						className="flex-1 px-2 py-0.5 text-xs rounded border"
						style={inputStyle}
						placeholder="Add tag…"
						value={newTag}
						onChange={(e) => setNewTag(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								addTag();
							}
						}}
					/>
					<button
						className="p-1 rounded hover:opacity-70 transition-opacity"
						style={{
							backgroundColor: theme.colors.accent + '20',
							color: theme.colors.accent,
						}}
						onClick={addTag}
						title="Add tag"
					>
						<Plus className="w-3.5 h-3.5" />
					</button>
				</div>

				{/* Suggested defaults row */}
				{suggestedDefaults?.capabilityTags && suggestedDefaults.capabilityTags.length > 0 && (
					<div className="flex items-start gap-1.5 flex-wrap">
						<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
							Suggested:
						</span>
						{suggestedDefaults.capabilityTags.map((tag, i) => (
							<span key={tag}>
								{i > 0 && (
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										,{' '}
									</span>
								)}
								<button
									className="text-xs underline underline-offset-1 hover:opacity-70"
									style={{ color: theme.colors.accent }}
									onClick={() => applyTag(tag)}
								>
									{tag}
								</button>
							</span>
						))}
					</div>
				)}
			</div>

			{/* Runner script path */}
			<div className="flex flex-col gap-1">
				<label
					className="text-xs"
					style={{ color: theme.colors.textDim }}
					htmlFor="dispatch-runner-script"
				>
					Runner script path
				</label>
				<input
					id="dispatch-runner-script"
					type="text"
					className="w-full px-2 py-1 text-xs rounded border font-mono"
					style={inputStyle}
					placeholder="/path/to/run.sh"
					value={profile.runnerScriptPath ?? ''}
					onChange={(e) =>
						onChange({
							...profile,
							runnerScriptPath: e.target.value || undefined,
						})
					}
				/>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					External script invoked when this agent claims a work item. Leave blank to use the Auto
					Run playbook trigger instead.
				</p>
			</div>

			{/* Suggested defaults preview + Reset button */}
			{suggestedDefaults && (
				<div
					className="flex items-center justify-between rounded p-2 text-xs"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<div style={{ color: theme.colors.textDim }}>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Agent defaults:
						</span>{' '}
						{suggestedDefaults.maxConcurrentClaims !== undefined && (
							<span>max {suggestedDefaults.maxConcurrentClaims} claims</span>
						)}
						{suggestedDefaults.capabilityTags && suggestedDefaults.capabilityTags.length > 0 && (
							<span> · {suggestedDefaults.capabilityTags.join(', ')}</span>
						)}
					</div>
					<button
						className="flex items-center gap-1 ml-2 px-2 py-0.5 rounded hover:opacity-70 transition-opacity shrink-0"
						style={{
							backgroundColor: theme.colors.accent + '20',
							color: theme.colors.accent,
						}}
						onClick={resetToDefaults}
						title="Reset capability tags and max claims to agent defaults"
					>
						<RotateCcw className="w-3 h-3" />
						Reset to defaults
					</button>
				</div>
			)}
		</div>
	);
}
