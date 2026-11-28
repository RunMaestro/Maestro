import { Crown } from 'lucide-react';
import { useSessionStore } from '../../../../../stores/sessionStore';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';

interface PrimaryAgentSectionProps {
	theme: Theme;
	primaryAgentId: string | null;
	setPrimaryAgentId: (value: string | null) => void;
}

/**
 * The Primary Agent (#2050): the app-level default receiver of the user's
 * input. Features such as Quick Chat use it when they have no agent of their
 * own. It grants no peer access (see src/shared/primaryAgent.ts).
 */
export function PrimaryAgentSection({
	theme,
	primaryAgentId,
	setPrimaryAgentId,
}: PrimaryAgentSectionProps) {
	const agents = useSessionStore((s) => s.sessions).filter((s) => s.toolType !== 'terminal');
	// A stored id that matches no <option> makes the select show its first
	// option ("None") while the id is still stored. Show the gap instead.
	const missing = !!primaryAgentId && !agents.some((a) => a.id === primaryAgentId);

	return (
		<div data-setting-id="general-primary-agent">
			<SettingsSectionHeading
				icon={Crown}
				description="The agent you treat as your right hand. Features such as Quick Chat send to it when you name no agent, unless that feature has its own agent set. It gives no other agent access to it."
			>
				Primary Agent
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<select
					value={primaryAgentId ?? ''}
					onChange={(e) => setPrimaryAgentId(e.target.value || null)}
					aria-label="Primary Agent"
					className="w-full p-2 rounded border bg-transparent outline-none text-sm"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<option value="">None</option>
					{agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
					{missing && <option value={primaryAgentId}>{primaryAgentId} (agent removed)</option>}
				</select>
				{missing && (
					<div className="text-xs mt-1" style={{ color: theme.colors.warning }}>
						This agent no longer exists, so features fall back to their own defaults. Pick another
						agent or choose None.
					</div>
				)}
			</SectionCard>
		</div>
	);
}
