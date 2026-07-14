import { memo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { RefreshCw, Music } from 'lucide-react';
import type { Theme } from '../../../types';
import type { ActiveContribution } from '../../../../shared/symphony-types';
import { ActiveContributionCard } from '../components/ActiveContributionCard';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSessionStore } from '../../../stores/sessionStore';

type SessionDisplay = { name: string; accountName?: string };

function sessionDisplayMapEquality(
	a: Map<string, SessionDisplay>,
	b: Map<string, SessionDisplay>
): boolean {
	if (a === b) return true;
	if (a.size !== b.size) return false;
	for (const [id, display] of a) {
		const other = b.get(id);
		if (!other || other.name !== display.name || other.accountName !== display.accountName) {
			return false;
		}
	}
	return true;
}

export interface ActiveTabProps {
	theme: Theme;
	activeContributions: ActiveContribution[];
	prStatusMessage: string | null;
	isCheckingPRStatuses: boolean;
	syncingContributionId: string | null;
	onCheckPRStatuses: () => void;
	onSyncContribution: (contributionId: string) => void;
	onFinalize: (contributionId: string) => void;
	onSwitchToProjects: () => void;
	onSelectSession: (sessionId: string) => void;
	onCloseModal: () => void;
}

export const ActiveTab = memo(function ActiveTab({
	theme,
	activeContributions,
	prStatusMessage,
	isCheckingPRStatuses,
	syncingContributionId,
	onCheckPRStatuses,
	onSyncContribution,
	onFinalize,
	onSwitchToProjects,
	onSelectSession,
	onCloseModal,
}: ActiveTabProps) {
	const virtuososEnabled = useSettingsStore((s) => s.encoreFeatures.virtuosos);
	// Narrow id-to-display map so streaming logs do not re-render this tab.
	const sessionDisplays = useStoreWithEqualityFn(
		useSessionStore,
		(s) => {
			const map = new Map<string, SessionDisplay>();
			for (const sess of s.sessions) {
				map.set(sess.id, { name: sess.name, accountName: sess.accountName });
			}
			return map;
		},
		sessionDisplayMapEquality
	);
	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header with refresh button */}
			<div
				className="px-4 py-2 border-b flex items-center justify-between"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-sm" style={{ color: theme.colors.textMain }}>
					{activeContributions.length} active contribution
					{activeContributions.length !== 1 ? 's' : ''}
				</span>
				<div className="flex items-center gap-2">
					{prStatusMessage && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{prStatusMessage}
						</span>
					)}
					<button
						onClick={onCheckPRStatuses}
						disabled={isCheckingPRStatuses}
						className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
						}}
						title="Check for merged or closed PRs"
					>
						<RefreshCw className={`w-3 h-3 ${isCheckingPRStatuses ? 'animate-spin' : ''}`} />
						Check PR Status
					</button>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-4">
				{activeContributions.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-64">
						<Music className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
						<p className="text-sm mb-1" style={{ color: theme.colors.textMain }}>
							No active contributions
						</p>
						<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
							Start a contribution from the Projects tab
						</p>
						<button
							onClick={onSwitchToProjects}
							className="px-3 py-1.5 rounded text-sm"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Browse Projects
						</button>
					</div>
				) : (
					<div className="grid grid-cols-2 gap-4">
						{activeContributions.map((contribution) => {
							const sessionDisplay = sessionDisplays.get(contribution.sessionId);
							const sessionName = sessionDisplay?.name ?? null;
							const hasSession = !!sessionDisplay;
							return (
								<ActiveContributionCard
									key={contribution.id}
									contribution={contribution}
									theme={theme}
									onFinalize={() => onFinalize(contribution.id)}
									onSync={() => onSyncContribution(contribution.id)}
									isSyncing={syncingContributionId === contribution.id}
									sessionName={sessionName}
									accountName={virtuososEnabled ? sessionDisplay?.accountName : undefined}
									onNavigateToSession={() => {
										if (hasSession) {
											onSelectSession(contribution.sessionId);
											onCloseModal();
										}
									}}
								/>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
});
