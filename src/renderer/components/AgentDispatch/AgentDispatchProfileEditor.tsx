/**
 * AgentDispatchProfileEditor — inline editor for an agent's dispatch profile.
 *
 * Renders the full set of dispatch-profile controls via <DispatchProfileFields />
 * and persists via window.maestro.agents.setDispatchProfile.
 *
 * Used in FleetView as an expandable row inline-editor.
 */

import { useState } from 'react';
import { X, Save, Loader } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { AgentDispatchProfile } from '../../../shared/agent-dispatch-types';
import { notifyToast } from '../../stores/notificationStore';
import { DispatchProfileFields } from './DispatchProfileFields';

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
		fleetEnabled: entry.dispatchProfile.fleetEnabled,
		runnerScriptPath: entry.dispatchProfile.runnerScriptPath,
		...(entry.dispatchProfile.suggestedDefaults
			? { suggestedDefaults: entry.dispatchProfile.suggestedDefaults }
			: {}),
	});
	const [saving, setSaving] = useState(false);

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

			<DispatchProfileFields
				profile={profile}
				onChange={setProfile}
				theme={theme}
				suggestedDefaults={entry.dispatchProfile.suggestedDefaults}
				showFleetToggle={true}
			/>

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
