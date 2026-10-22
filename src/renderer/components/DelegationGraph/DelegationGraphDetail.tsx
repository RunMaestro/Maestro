/**
 * DelegationGraphDetail - the selected agent's relationships, in words.
 *
 * The canvas shows the shape of the team. This panel answers the two questions
 * about one agent that a picture makes the reader trace by eye: who can it
 * reach, and who can reach it. It reads the same model the canvas draws, so
 * the two cannot disagree, and it is where the graph hands off to the place
 * the relationships are edited: the Peers tab of the agent's settings.
 *
 * The panel is text a user may want to copy, so it is `select-text` inside a
 * surface that is otherwise click-driven.
 */

import { memo, useMemo } from 'react';
import { Users, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { DelegationGraphEdge, DelegationGraphModel } from '../../../shared/delegationGraph';
import { PEER_GRANT_LABELS } from '../../../shared/peerAgents';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { DelegationEdgeBadge, delegationEdgeKind } from './edges/DelegationEdge';
import { removedAgentLabel } from './nodes/AgentDelegationNode';

export interface DelegationGraphDetailProps {
	theme: Theme;
	model: DelegationGraphModel;
	/** The selected agent. */
	sessionId: string;
	/** Open the Peers tab of this agent's settings. */
	onOpenPeers: (sessionId: string) => void;
	onClose: () => void;
}

interface RelationListProps {
	theme: Theme;
	title: string;
	emptyText: string;
	edges: readonly DelegationGraphEdge[];
	/** Which end of each edge is the OTHER agent. */
	peerOf: (edge: DelegationGraphEdge) => string;
	nameOf: (sessionId: string) => string;
	testId: string;
}

function RelationList({
	theme,
	title,
	emptyText,
	edges,
	peerOf,
	nameOf,
	testId,
}: RelationListProps) {
	const { colors } = theme;
	return (
		<section data-testid={testId}>
			<h4 className="font-medium mb-1" style={{ color: colors.textDim }}>
				{title}
			</h4>
			{edges.length === 0 ? (
				<p style={{ color: colors.textDim }}>{emptyText}</p>
			) : (
				<ul className="space-y-1">
					{edges.map((edge) => {
						const kind = delegationEdgeKind(edge);
						if (!kind) return null;
						return (
							<li key={edge.id} className="flex items-start gap-2">
								<span className="mt-0.5 shrink-0">
									<DelegationEdgeBadge kind={kind} theme={theme} />
								</span>
								<span className="min-w-0">
									<span className="block break-words" style={{ color: colors.textMain }}>
										{nameOf(peerOf(edge))}
									</span>
									{edge.source !== 'explicit' && (
										<span className="block" style={{ color: colors.textDim }}>
											{PEER_GRANT_LABELS[edge.source]}
										</span>
									)}
									{edge.description && (
										<span className="block break-words" style={{ color: colors.textDim }}>
											{edge.description}
										</span>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

export const DelegationGraphDetail = memo(function DelegationGraphDetail({
	theme,
	model,
	sessionId,
	onOpenPeers,
	onClose,
}: DelegationGraphDetailProps) {
	const { colors } = theme;

	// The model is rebuilt on every rename, so its names are live.
	const { nameOf, outbound, inbound } = useMemo(() => {
		const names = new Map(model.nodes.map((node) => [node.sessionId, node.name]));
		return {
			nameOf: (id: string) => names.get(id) ?? removedAgentLabel(id),
			outbound: model.edges.filter((edge) => edge.sourceId === sessionId),
			inbound: model.edges.filter((edge) => edge.targetId === sessionId),
		};
	}, [model, sessionId]);

	return (
		<div
			data-testid="delegation-graph-detail"
			role="region"
			aria-label="Selected agent"
			className="absolute top-2 right-2 rounded-lg shadow-lg text-xs select-text"
			style={{
				width: 260,
				maxHeight: 'calc(100% - 16px)',
				overflowY: 'auto',
				zIndex: 5,
				backgroundColor: `${colors.bgActivity}f5`,
				border: `1px solid ${colors.border}`,
			}}
		>
			<div
				className="flex items-center justify-between gap-2 px-3 py-2 border-b"
				style={{ borderColor: colors.border }}
			>
				<span className="font-medium break-words min-w-0" style={{ color: colors.textMain }}>
					{nameOf(sessionId)}
				</span>
				<button
					type="button"
					onClick={onClose}
					className="p-0.5 rounded hover:bg-white/10 shrink-0"
					style={{ color: colors.textDim }}
					title="Clear the selection"
					aria-label="Clear the selection"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="px-3 py-2 space-y-3">
				<RelationList
					theme={theme}
					title="Can reach"
					emptyText="Nobody."
					edges={outbound}
					peerOf={(edge) => edge.targetId}
					nameOf={nameOf}
					testId="delegation-graph-detail-outbound"
				/>
				<RelationList
					theme={theme}
					title="Reachable by"
					emptyText="Nobody."
					edges={inbound}
					peerOf={(edge) => edge.sourceId}
					nameOf={nameOf}
					testId="delegation-graph-detail-inbound"
				/>
				<HeaderActionButton
					theme={theme}
					onClick={() => onOpenPeers(sessionId)}
					icon={<Users />}
					title="Edit who this agent can reach"
					testId="delegation-graph-detail-open-peers"
				>
					Open Peers tab
				</HeaderActionButton>
			</div>
		</div>
	);
});
