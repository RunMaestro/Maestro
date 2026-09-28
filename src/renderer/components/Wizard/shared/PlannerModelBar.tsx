import type { Theme, ToolType } from '../../../types';
import { getConversationProviderName } from '../screens/ConversationScreen/utils/providerName';

interface PlannerModelBarProps {
	theme: Theme;
	selectedAgent: ToolType | null;
	/** What the run is actually about to use, already resolved. */
	effectiveModel: string | null;
	/** Top-tier model for this provider, when Maestro knows one. */
	topTierModel: string | null;
	/** True once the user has overridden the agent's configured model. */
	isOverridden?: boolean;
	/** Omit both handlers to render the line read-only (mid-generation). */
	onUseTopTier?: () => void;
	onUseAgentDefault?: () => void;
}

/**
 * Who is doing the planning, and on what.
 *
 * The discovery conversation and the playbook it produces both run on a model
 * the user never saw named, which is how someone ends up paying for a plan
 * written by a model they would not have chosen (issue #1225). This says it out
 * loud, and where Maestro can name the provider's top tier, offers it in one
 * click for this run only.
 */
export function PlannerModelBar({
	theme,
	selectedAgent,
	effectiveModel,
	topTierModel,
	isOverridden,
	onUseTopTier,
	onUseAgentDefault,
}: PlannerModelBarProps): JSX.Element {
	const providerName = getConversationProviderName(selectedAgent) || 'Your agent';
	const canOfferTopTier = !!onUseTopTier && !!topTierModel && topTierModel !== effectiveModel;

	return (
		<div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
			<span>
				Planning with <strong style={{ color: theme.colors.textMain }}>{providerName}</strong>
				{effectiveModel ? (
					<>
						{' '}
						on{' '}
						<code
							className="px-1.5 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						>
							{effectiveModel}
						</code>
					</>
				) : (
					<> on its configured model</>
				)}
			</span>

			{canOfferTopTier && (
				<button
					onClick={onUseTopTier}
					className="underline underline-offset-2 focus:outline-none focus:ring-1 rounded px-1"
					style={{
						color: theme.colors.accent,
						['--tw-ring-color' as any]: theme.colors.accent,
					}}
					title="Only for this wizard run. The agent keeps its own model afterwards."
				>
					Use {topTierModel}
				</button>
			)}

			{isOverridden && onUseAgentDefault && (
				<button
					onClick={onUseAgentDefault}
					className="underline underline-offset-2 focus:outline-none focus:ring-1 rounded px-1"
					style={{
						color: theme.colors.textDim,
						['--tw-ring-color' as any]: theme.colors.accent,
					}}
				>
					Reset
				</button>
			)}
		</div>
	);
}
