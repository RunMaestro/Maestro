import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface UtilityAgentSectionProps {
	theme: Theme;
	isOpen: boolean;
	utilityAgentId: string | null;
	setUtilityAgentId: (value: string | null) => void;
	utilityModelId: string | null;
	setUtilityModelId: (value: string | null) => void;
}

/**
 * Utility Agent settings.
 *
 * Lets the user route auxiliary/background tasks (tab naming, context grooming)
 * to a cheaper or faster agent instead of the tab's own session agent, with an
 * optional model override. When the agent is left as "Default", behavior is
 * unchanged and the session agent is used (fully backward compatible).
 */
export function UtilityAgentSection({
	theme,
	isOpen,
	utilityAgentId,
	setUtilityAgentId,
	utilityModelId,
	setUtilityModelId,
}: UtilityAgentSectionProps) {
	const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string }[]>([]);
	const [agentsLoaded, setAgentsLoaded] = useState(false);

	// Detect available agents for the dropdown, lazily when the tab opens.
	useEffect(() => {
		if (!isOpen || agentsLoaded) return;
		let cancelled = false;
		window.maestro.agents
			.detect()
			.then((agents) => {
				if (cancelled) return;
				setAvailableAgents(
					agents
						.filter((a) => a.available && !a.hidden && a.id !== 'terminal')
						.map((a) => ({ id: a.id, name: a.name }))
				);
				setAgentsLoaded(true);
			})
			.catch(() => {
				// Silently fail - the dropdown will just show the default option.
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, agentsLoaded]);

	// Only meaningful once detection has actually run - before that, an empty
	// list would flag every configured agent as missing.
	const staleAgentId =
		agentsLoaded && utilityAgentId && !availableAgents.some((a) => a.id === utilityAgentId)
			? utilityAgentId
			: null;

	return (
		<div data-setting-id="general-utility-agent">
			<SettingsSectionHeading icon={Bot}>Utility Agent</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				{/* Opacity alone, no textDim override: stacking the two multiplies the
				    dimming and drops contrast below 3:1 in most themes
				    (CLAUDE-SETTINGS.md rule 1). Descriptions inherit textMain. */}
				<div className="text-xs opacity-50">
					Route auxiliary tasks (tab naming, context grooming) to a cheaper or faster agent instead
					of the session agent. Leave as Default to keep using each tab's own agent.
				</div>
				<div>
					<label
						className="text-sm block mb-1"
						style={{ color: theme.colors.textMain }}
						htmlFor="utility-agent-select"
					>
						Agent
					</label>
					<select
						id="utility-agent-select"
						value={utilityAgentId || ''}
						onChange={(e) => setUtilityAgentId(e.target.value || null)}
						className="w-full p-2 rounded border bg-transparent outline-none text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<option value="">Default (same as session)</option>
						{availableAgents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
						{/*
						 * A persisted id whose agent is no longer installed matches no
						 * option, and a <select> with an unmatched value renders as its
						 * FIRST option - so the UI would read "Default" while auxiliary
						 * tasks kept routing to a missing binary and failing. Surface it
						 * instead, so the setting the user is actually running is the
						 * setting they can see.
						 */}
						{staleAgentId && <option value={staleAgentId}>{staleAgentId} (not installed)</option>}
					</select>
					{staleAgentId && (
						<div className="text-xs mt-1" style={{ color: theme.colors.warning }}>
							This agent is no longer available. Auxiliary tasks will fail until you pick another
							agent or return to Default.
						</div>
					)}
				</div>
				{utilityAgentId && (
					<div>
						<label
							className="text-sm block mb-1"
							style={{ color: theme.colors.textMain }}
							htmlFor="utility-model-input"
						>
							Model override
						</label>
						<input
							id="utility-model-input"
							type="text"
							value={utilityModelId || ''}
							onChange={(e) => setUtilityModelId(e.target.value || null)}
							placeholder="e.g., haiku, gpt-4o-mini (leave empty for agent default)"
							className="w-full p-2 rounded border bg-transparent outline-none text-sm"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
