/**
 * AgentClaimList — shows the active work-item claims for a fleet entry with
 * release and force-release actions.
 */

import { useState } from 'react';
import { X, AlertTriangle, Loader } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { WorkItemClaim } from '../../../shared/work-graph-types';
import { agentDispatchService } from '../../services/agentDispatch';
import { notifyToast } from '../../stores/notificationStore';
import { formatRelativeTime } from '../../../shared/formatters';

export interface AgentClaimListProps {
	entry: AgentDispatchFleetEntry;
	theme: Theme;
	/** Called after a claim action completes so the parent can close/refresh. */
	onDone: () => void;
}

function ClaimRow({
	claim,
	entry,
	theme,
	onReleased,
}: {
	claim: WorkItemClaim;
	entry: AgentDispatchFleetEntry;
	theme: Theme;
	onReleased: () => void;
}) {
	const [pendingAction, setPendingAction] = useState<'release' | 'force' | null>(null);

	const handleRelease = async (force: boolean) => {
		const action = force ? 'force' : 'release';
		setPendingAction(action);
		try {
			await agentDispatchService.releaseClaim({
				workItemId: claim.workItemId,
				claimId: claim.id,
				owner: claim.owner,
				note: force ? 'Force-released by user' : 'Released by user',
			});
			notifyToast({
				color: 'green',
				title: force ? 'Force-released' : 'Released',
				message: `Claim on ${claim.workItemId} released.`,
			});
			onReleased();
		} catch (err) {
			notifyToast({
				color: 'red',
				title: force ? 'Force-release failed' : 'Release failed',
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setPendingAction(null);
		}
	};

	const isOwner = claim.owner.agentId === entry.agentId || claim.owner.id === entry.agentId;
	// Non-owners can only force-release.
	const canRelease = isOwner;

	const relativeTime = formatRelativeTime(new Date(claim.claimedAt).getTime());

	return (
		<tr className="border-b text-xs" style={{ borderColor: theme.colors.border + '60' }}>
			{/* Work item ID */}
			<td
				className="py-1.5 pr-3 font-mono"
				style={{ color: theme.colors.textMain }}
				title={claim.workItemId}
			>
				{claim.workItemId.slice(0, 8)}…
			</td>

			{/* Claim source */}
			<td className="py-1.5 pr-3" style={{ color: theme.colors.textDim }}>
				{claim.source === 'auto-pickup' ? 'auto' : 'manual'}
			</td>

			{/* Claimed time */}
			<td className="py-1.5 pr-3" style={{ color: theme.colors.textDim }}>
				{relativeTime}
			</td>

			{/* Owner name */}
			<td className="py-1.5 pr-3" style={{ color: theme.colors.textDim }}>
				{claim.owner.name ?? claim.owner.id.slice(0, 8)}
			</td>

			{/* Actions */}
			<td className="py-1.5 text-right">
				<div className="flex items-center justify-end gap-1.5">
					{canRelease && (
						<button
							className="flex items-center gap-1 px-2 py-0.5 rounded hover:opacity-70 transition-opacity disabled:opacity-40"
							style={{
								backgroundColor: theme.colors.warning + '20',
								color: theme.colors.warning,
							}}
							onClick={() => handleRelease(false)}
							disabled={pendingAction !== null}
							title="Release this claim"
						>
							{pendingAction === 'release' ? (
								<Loader className="w-3 h-3 animate-spin" />
							) : (
								<X className="w-3 h-3" />
							)}
							Release
						</button>
					)}
					<button
						className="flex items-center gap-1 px-2 py-0.5 rounded hover:opacity-70 transition-opacity disabled:opacity-40"
						style={{
							backgroundColor: theme.colors.error + '20',
							color: theme.colors.error,
						}}
						onClick={() => handleRelease(true)}
						disabled={pendingAction !== null}
						title="Force-release (ignores ownership)"
					>
						{pendingAction === 'force' ? (
							<Loader className="w-3 h-3 animate-spin" />
						) : (
							<AlertTriangle className="w-3 h-3" />
						)}
						Force
					</button>
				</div>
			</td>
		</tr>
	);
}

export function AgentClaimList({ entry, theme, onDone }: AgentClaimListProps) {
	const activeClaims = entry.currentClaims.filter((c): c is WorkItemClaim => c.status === 'active');

	if (activeClaims.length === 0) {
		return (
			<div className="text-xs py-2" style={{ color: theme.colors.textDim }}>
				No active claims.
			</div>
		);
	}

	return (
		<div className="rounded border overflow-hidden" style={{ borderColor: theme.colors.border }}>
			<table className="w-full">
				<thead>
					<tr
						className="text-xs border-b"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<th className="text-left py-1.5 px-2 font-medium">Item</th>
						<th className="text-left py-1.5 px-2 font-medium">Source</th>
						<th className="text-left py-1.5 px-2 font-medium">Claimed</th>
						<th className="text-left py-1.5 px-2 font-medium">Owner</th>
						<th className="py-1.5 px-2 text-right font-medium">Actions</th>
					</tr>
				</thead>
				<tbody>
					{activeClaims.map((claim) => (
						<ClaimRow
							key={claim.id}
							claim={claim}
							entry={entry}
							theme={theme}
							onReleased={onDone}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}
