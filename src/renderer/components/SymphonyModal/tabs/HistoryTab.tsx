import { memo } from 'react';
import { Music } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CompletedContribution } from '../../../../shared/symphony-types';
import { CompletedContributionCard } from '../components/CompletedContributionCard';
import { STATUS_COLORS } from '../helpers/statusInfo';

export interface HistoryTabStats {
	totalContributions: number;
	totalMerged: number;
	totalTasksCompleted: number;
}

export interface HistoryTabProps {
	theme: Theme;
	stats: HistoryTabStats | null;
	formattedTotalTokens: string;
	formattedTotalCost: string;
	completedContributions: CompletedContribution[];
}

export const HistoryTab = memo(function HistoryTab({
	theme,
	stats,
	formattedTotalTokens,
	formattedTotalCost,
	completedContributions,
}: HistoryTabProps) {
	return (
		<div className="flex-1 overflow-y-auto">
			{/* Stats summary */}
			{stats && stats.totalContributions > 0 && (
				<div
					className="grid grid-cols-5 gap-4 p-4 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="text-center">
						<p className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
							{stats.totalContributions}
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							PRs Created
						</p>
					</div>
					<div className="text-center">
						<p className="text-2xl font-semibold" style={{ color: STATUS_COLORS.running }}>
							{stats.totalMerged}
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Merged
						</p>
					</div>
					<div className="text-center">
						<p className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
							{stats.totalTasksCompleted}
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Tasks
						</p>
					</div>
					<div className="text-center">
						<p className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
							{formattedTotalTokens}
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Tokens
						</p>
					</div>
					<div className="text-center">
						<p className="text-2xl font-semibold" style={{ color: theme.colors.accent }}>
							{formattedTotalCost}
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Value
						</p>
					</div>
				</div>
			)}

			{/* Completed contributions */}
			<div className="p-4">
				{completedContributions.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-48">
						<Music className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
						<p className="text-sm mb-1" style={{ color: theme.colors.textMain }}>
							No completed contributions
						</p>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Your contribution history will appear here
						</p>
					</div>
				) : (
					<div className="grid grid-cols-2 gap-4">
						{completedContributions.map((contribution) => (
							<CompletedContributionCard
								key={contribution.id}
								contribution={contribution}
								theme={theme}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
});
