/**
 * AgentDispatchProfileEditor — inline editor for an agent's dispatch profile.
 *
 * Allows editing:
 *   - Capability tags (add / remove)
 *   - maxConcurrentClaims (numeric toggle)
 *   - autoPickupEnabled toggle
 *
 * Saves via window.maestro.agents.setDispatchProfile.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Plus, Save, Loader } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { AgentDispatchProfile } from '../../../shared/agent-dispatch-types';
import { notifyToast } from '../../stores/notificationStore';

export interface AgentDispatchProfileEditorProps {
	entry: AgentDispatchFleetEntry;
	theme: Theme;
	onClose: () => void;
}

export function AgentDispatchProfileEditor({
	entry,
	theme,
	onClose,
}: AgentDispatchProfileEditorProps) {
	const [profile, setProfile] = useState<AgentDispatchProfile>({
		autoPickupEnabled: entry.dispatchProfile.autoPickupEnabled,
		capabilityTags: [...entry.dispatchProfile.capabilityTags],
		maxConcurrentClaims: entry.dispatchProfile.maxConcurrentClaims,
	});
	const [newTag, setNewTag] = useState('');
	const [saving, setSaving] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus the tag input when the editor opens.
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const addTag = useCallback(() => {
		const trimmed = newTag.trim().toLowerCase();
		if (!trimmed || profile.capabilityTags.includes(trimmed)) {
			setNewTag('');
			return;
		}
		setProfile((prev) => ({ ...prev, capabilityTags: [...prev.capabilityTags, trimmed] }));
		setNewTag('');
	}, [newTag, profile.capabilityTags]);

	const removeTag = useCallback((tag: string) => {
		setProfile((prev) => ({
			...prev,
			capabilityTags: prev.capabilityTags.filter((t) => t !== tag),
		}));
	}, []);

	const handleSave = async () => {
		setSaving(true);
		try {
			await window.maestro.agents.setDispatchProfile(entry.agentId, profile);
			notifyToast({
				color: 'green',
				title: 'Profile saved',
				message: `Dispatch profile updated for ${entry.displayName}.`,
			});
			onClose();
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Save failed',
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSaving(false);
		}
	};

	const inputStyle = {
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	} as const;

	return (
		<div
			className="rounded border p-3 text-sm flex flex-col gap-3"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			<div className="flex items-center justify-between">
				<span
					className="font-medium text-xs uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Dispatch Profile — {entry.displayName}
				</span>
				<button
					className="p-0.5 rounded hover:opacity-70"
					style={{ color: theme.colors.textDim }}
					onClick={onClose}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Auto-pickup toggle */}
			<label className="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					className="rounded"
					checked={profile.autoPickupEnabled}
					onChange={(e) => setProfile((prev) => ({ ...prev, autoPickupEnabled: e.target.checked }))}
				/>
				<span style={{ color: theme.colors.textMain }}>Auto-pickup enabled</span>
			</label>

			{/* Max concurrent claims */}
			<div className="flex items-center gap-2">
				<label
					className="text-xs"
					style={{ color: theme.colors.textDim }}
					htmlFor={`max-claims-${entry.agentId}`}
				>
					Max concurrent claims
				</label>
				<input
					id={`max-claims-${entry.agentId}`}
					type="number"
					min={1}
					max={20}
					className="w-16 px-2 py-0.5 text-xs rounded border"
					style={inputStyle}
					value={profile.maxConcurrentClaims}
					onChange={(e) => {
						const v = parseInt(e.target.value, 10);
						if (!isNaN(v) && v >= 1) {
							setProfile((prev) => ({ ...prev, maxConcurrentClaims: v }));
						}
					}}
				/>
			</div>

			{/* Capability tags */}
			<div className="flex flex-col gap-1.5">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Capability tags
				</span>

				{/* Tag list */}
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

				{/* Tag add row */}
				<div className="flex gap-1.5">
					<input
						ref={inputRef}
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
			</div>

			{/* Suggested defaults hint */}
			{entry.dispatchProfile.suggestedDefaults?.capabilityTags &&
				entry.dispatchProfile.suggestedDefaults.capabilityTags.length > 0 && (
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Suggested:{' '}
						{entry.dispatchProfile.suggestedDefaults.capabilityTags.map((tag, i) => (
							<span key={tag}>
								{i > 0 && ', '}
								<button
									className="underline underline-offset-1 hover:opacity-70"
									style={{ color: theme.colors.accent }}
									onClick={() => {
										if (!profile.capabilityTags.includes(tag)) {
											setProfile((prev) => ({
												...prev,
												capabilityTags: [...prev.capabilityTags, tag],
											}));
										}
									}}
								>
									{tag}
								</button>
							</span>
						))}
					</div>
				)}

			{/* Save / Cancel */}
			<div className="flex justify-end gap-2 pt-1">
				<button
					className="text-xs px-3 py-1 rounded hover:opacity-70 transition-opacity"
					style={{ color: theme.colors.textDim }}
					onClick={onClose}
					disabled={saving}
				>
					Cancel
				</button>
				<button
					className="flex items-center gap-1.5 text-xs px-3 py-1 rounded transition-opacity hover:opacity-80 disabled:opacity-40"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					onClick={handleSave}
					disabled={saving}
				>
					{saving ? <Loader className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
					Save
				</button>
			</div>
		</div>
	);
}
