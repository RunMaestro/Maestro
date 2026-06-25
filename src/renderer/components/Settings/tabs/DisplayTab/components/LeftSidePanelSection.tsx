import { PanelLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';
import { WorktreePill } from '../../../../ui/WorktreePill';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface LeftSidePanelSectionProps {
	theme: Theme;
	maestroCueEnabled: boolean;
	showStarredSessionsSection: boolean;
	setShowStarredSessionsSection: (enabled: boolean) => void;
	showLeftPanelGroupMemberCount: boolean;
	setShowLeftPanelGroupMemberCount: (enabled: boolean) => void;
	leftPanelCollapsedPillsPerRow: number;
	setLeftPanelCollapsedPillsPerRow: (value: number) => void;
	showLeftPanelLocationPills: boolean;
	setShowLeftPanelLocationPills: (enabled: boolean) => void;
	showLeftPanelGitIndicator: boolean;
	setShowLeftPanelGitIndicator: (enabled: boolean) => void;
	showLeftPanelCueIndicator: boolean;
	setShowLeftPanelCueIndicator: (enabled: boolean) => void;
	showLeftPanelStartupCommandIndicator: boolean;
	setShowLeftPanelStartupCommandIndicator: (enabled: boolean) => void;
	showGroupLabelInBookmarks: boolean;
	setShowGroupLabelInBookmarks: (enabled: boolean) => void;
	showFullGroupLabelInBookmarks: boolean;
	setShowFullGroupLabelInBookmarks: (enabled: boolean) => void;
	showWorktreePill: boolean;
	setShowWorktreePill: (enabled: boolean) => void;
	showWorktreeBranchName: boolean;
	setShowWorktreeBranchName: (enabled: boolean) => void;
}

function MonoExample({ children }: { children: ReactNode }) {
	return <span className="font-mono">{children}</span>;
}

export function LeftSidePanelSection({
	theme,
	maestroCueEnabled,
	showStarredSessionsSection,
	setShowStarredSessionsSection,
	showLeftPanelGroupMemberCount,
	setShowLeftPanelGroupMemberCount,
	leftPanelCollapsedPillsPerRow,
	setLeftPanelCollapsedPillsPerRow,
	showLeftPanelLocationPills,
	setShowLeftPanelLocationPills,
	showLeftPanelGitIndicator,
	setShowLeftPanelGitIndicator,
	showLeftPanelCueIndicator,
	setShowLeftPanelCueIndicator,
	showLeftPanelStartupCommandIndicator,
	setShowLeftPanelStartupCommandIndicator,
	showGroupLabelInBookmarks,
	setShowGroupLabelInBookmarks,
	showFullGroupLabelInBookmarks,
	setShowFullGroupLabelInBookmarks,
	showWorktreePill,
	setShowWorktreePill,
	showWorktreeBranchName,
	setShowWorktreeBranchName,
}: LeftSidePanelSectionProps) {
	const pillPercentage = ((leftPanelCollapsedPillsPerRow - 5) / 45) * 100;

	return (
		<div data-setting-id="display-left-side-panel">
			<SettingsSectionHeading icon={PanelLeft}>Left Side Panel</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div data-setting-id="display-left-panel-starred-sessions">
					<ToggleSettingRow
						theme={theme}
						title="Show Starred Sessions section"
						description="Display a Starred Sessions section at the top of the left side bar listing every starred AI tab across all agents."
						checked={showStarredSessionsSection}
						onChange={setShowStarredSessionsSection}
						ariaLabel="Show Starred Sessions section in left side bar"
					/>
				</div>
				<ToggleSettingRow
					theme={theme}
					title="Show group member count"
					description={
						<>
							Display the number of agents in parentheses after each group name in the left side bar
							(e.g. &quot;UNGROUPED AGENTS (24)&quot;).
						</>
					}
					checked={showLeftPanelGroupMemberCount}
					onChange={setShowLeftPanelGroupMemberCount}
					ariaLabel="Show group member count in left side bar"
					borderTop
				/>

				<div className="pt-3 border-t" style={{ borderColor: theme.colors.border }}>
					<p className="text-sm" style={{ color: theme.colors.textMain }}>
						Collapsed group pills per row
					</p>
					<p className="text-xs opacity-50 mt-0.5 mb-2">
						When a group is collapsed, its agents render as a row of activity pills. Pills wrap to a
						new row once this many are shown, so large groups stay readable instead of condensing
						into invisible slivers.
					</p>
					<div className="flex items-center gap-3">
						<input
							type="range"
							min={5}
							max={50}
							step={5}
							value={leftPanelCollapsedPillsPerRow}
							onChange={(event) => setLeftPanelCollapsedPillsPerRow(Number(event.target.value))}
							className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
							style={{
								background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${pillPercentage}%, ${theme.colors.bgActivity} ${pillPercentage}%, ${theme.colors.bgActivity} 100%)`,
							}}
							aria-label="Collapsed group pills per row"
						/>
						<span
							className="text-sm font-mono w-8 text-right"
							style={{ color: theme.colors.textMain }}
						>
							{leftPanelCollapsedPillsPerRow}
						</span>
					</div>
				</div>

				<ToggleSettingRow
					theme={theme}
					title="Show location pills"
					description="Display the REMOTE / LOCAL / GIT badges next to each agent in the left side bar. Turn off to simplify the agent rows."
					checked={showLeftPanelLocationPills}
					onChange={setShowLeftPanelLocationPills}
					ariaLabel="Show location pills in left side bar"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show git change indicator"
					description="Display the branch icon and dirty file count next to git repository agents."
					checked={showLeftPanelGitIndicator}
					onChange={setShowLeftPanelGitIndicator}
					ariaLabel="Show git change indicator in left side bar"
					borderTop
				/>
				{maestroCueEnabled && (
					<ToggleSettingRow
						theme={theme}
						title="Show Cue indicator"
						description="Display the lightning-bolt indicator next to agents with active Maestro Cue subscriptions."
						checked={showLeftPanelCueIndicator}
						onChange={setShowLeftPanelCueIndicator}
						ariaLabel="Show Cue indicator in left side bar"
						borderTop
					/>
				)}
				<ToggleSettingRow
					theme={theme}
					title="Show terminal startup-command indicator"
					description={
						<>
							Display the <MonoExample>{'>_'}</MonoExample> glyph next to agents that have at least
							one terminal tab with a saved startup command.
						</>
					}
					checked={showLeftPanelStartupCommandIndicator}
					onChange={setShowLeftPanelStartupCommandIndicator}
					ariaLabel="Show terminal startup-command indicator in left side bar"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show group label on bookmarked agents"
					description={
						<>
							Display the group badge (e.g. <MonoExample>CCS</MonoExample>) next to bookmarked
							agents. Turn off to hide the group pill entirely.
						</>
					}
					checked={showGroupLabelInBookmarks}
					onChange={setShowGroupLabelInBookmarks}
					ariaLabel="Show group label on bookmarked agents in left side bar"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show full group label on bookmarked agents"
					description={
						<>
							Display the full group name (e.g. <MonoExample>[2] CASE/CONTENT-SYSTEM</MonoExample>)
							instead of the abbreviated badge (e.g. <MonoExample>CCS</MonoExample>) next to
							bookmarked agents. Long names are truncated with the full value on hover.
						</>
					}
					checked={showFullGroupLabelInBookmarks}
					onChange={setShowFullGroupLabelInBookmarks}
					ariaLabel="Show full group label on bookmarked agents in left side bar"
					disabled={!showGroupLabelInBookmarks}
					className={`pt-2 pl-4 transition-opacity ${
						showGroupLabelInBookmarks ? '' : 'opacity-40'
					}`}
				/>
				<ToggleSettingRow
					theme={theme}
					title={
						<span className="flex items-center gap-2">
							Show <WorktreePill theme={theme} /> pill in subagent list
						</span>
					}
					description="Display the worktree badge next to worktree child agents in the left panel."
					checked={showWorktreePill}
					onChange={setShowWorktreePill}
					ariaLabel="Show worktree pill in left panel agent list"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show worktree branch name in subagent list"
					description="Display the worktree branch name beneath the agent name in the left panel."
					checked={showWorktreeBranchName}
					onChange={setShowWorktreeBranchName}
					ariaLabel="Show branch name in left panel agent list"
					borderTop
				/>
			</SectionCard>
		</div>
	);
}
