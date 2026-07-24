import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { Theme } from '../../../../../types';

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

	return (
		<div data-setting-id="general-utility-agent">
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Bot className="w-3 h-3" />
				Utility Agent
			</div>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="text-xs opacity-50" style={{ color: theme.colors.textDim }}>
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
					</select>
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
