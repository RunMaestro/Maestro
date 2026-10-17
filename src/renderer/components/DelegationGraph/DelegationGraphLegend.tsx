/**
 * DelegationGraphLegend - what the lines, badges and borders on the
 * Delegation Graph mean, and how much of each is on screen.
 *
 * Every sample is drawn from the table the canvas itself draws from
 * (`DELEGATION_EDGE_LINES`, `DelegationEdgeBadge`,
 * `AGENT_DELEGATION_NODE_BORDER_STYLE`), so the legend cannot show a line or a
 * border the graph does not use.
 *
 * It also ties two vocabularies together. The Peers tab of an agent's settings
 * writes the two bits as `R` and `W`; an edge writes them as `C` and `D`.
 */

import { memo } from 'react';
import { Plus, Unplug, X } from 'lucide-react';
import type { Theme } from '../../types';
import {
	describeDelegationGraphStats,
	type DelegationGraphStats,
} from '../../../shared/delegationGraph';
import {
	DELEGATION_EDGE_KIND_LABELS,
	DELEGATION_EDGE_LINES,
	DelegationEdgeBadge,
	delegationEdgeColor,
	delegationEdgeOpacity,
	type DelegationEdgeKind,
} from './edges/DelegationEdge';
import {
	AGENT_DELEGATION_NODE_BORDER_STYLE,
	AGENT_DELEGATION_SPILL_OPACITY,
	type AgentDelegationNodeState,
} from './nodes/AgentDelegationNode';

export interface DelegationGraphLegendProps {
	theme: Theme;
	stats: DelegationGraphStats;
	onClose: () => void;
	mode?: 'view' | 'edit';
}

const EDGE_KINDS: readonly DelegationEdgeKind[] = ['consult', 'delegate', 'both'];

const NODE_STATES: ReadonlyArray<{ state: AgentDelegationNodeState; label: string }> = [
	{ state: 'in-scope', label: 'In this scope' },
	{ state: 'spill', label: 'Outside it, reached by an edge' },
	{ state: 'isolated', label: 'No peers in either direction' },
	{ state: 'placed', label: 'Outside it, added by you, no edge yet' },
];

const SAMPLE_WIDTH = 34;
const SAMPLE_HEIGHT = 10;

function EdgeSample({
	kind,
	theme,
	faint,
}: {
	kind: DelegationEdgeKind;
	theme: Theme;
	faint?: boolean;
}) {
	const line = DELEGATION_EDGE_LINES[kind];
	return (
		<svg
			width={SAMPLE_WIDTH}
			height={SAMPLE_HEIGHT}
			aria-hidden="true"
			style={{ flexShrink: 0, opacity: faint ? delegationEdgeOpacity('group') : 1 }}
		>
			<line
				x1={0}
				y1={SAMPLE_HEIGHT / 2}
				x2={SAMPLE_WIDTH}
				y2={SAMPLE_HEIGHT / 2}
				stroke={delegationEdgeColor(theme)}
				strokeWidth={line.width}
				strokeDasharray={line.dash}
			/>
		</svg>
	);
}

function NodeSample({ state, theme }: { state: AgentDelegationNodeState; theme: Theme }) {
	const { colors } = theme;
	return (
		<span
			aria-hidden="true"
			style={{
				width: SAMPLE_WIDTH,
				height: 16,
				flexShrink: 0,
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				borderRadius: 4,
				borderWidth: 2,
				borderStyle: AGENT_DELEGATION_NODE_BORDER_STYLE[state],
				borderColor: state === 'isolated' ? colors.warning : colors.border,
				backgroundColor: colors.bgMain,
				color: state === 'placed' ? colors.textDim : colors.warning,
				opacity: state === 'spill' ? AGENT_DELEGATION_SPILL_OPACITY : 1,
			}}
		>
			{state === 'isolated' && <Unplug size={9} />}
			{state === 'placed' && <Plus size={9} />}
		</span>
	);
}

export const DelegationGraphLegend = memo(function DelegationGraphLegend({
	theme,
	stats,
	onClose,
	mode = 'edit',
}: DelegationGraphLegendProps) {
	const { colors } = theme;
	const heading = { color: colors.textDim };
	const text = { color: colors.textMain };

	return (
		<div
			data-testid="delegation-graph-legend"
			role="region"
			aria-label="Legend"
			className="absolute top-2 left-2 rounded-lg shadow-lg text-xs select-text"
			style={{
				width: 250,
				zIndex: 5,
				backgroundColor: `${colors.bgActivity}f5`,
				border: `1px solid ${colors.border}`,
			}}
		>
			<div
				className="flex items-center justify-between px-3 py-2 border-b"
				style={{ borderColor: colors.border }}
			>
				<span className="font-medium" style={text}>
					Legend
				</span>
				<button
					type="button"
					onClick={onClose}
					className="p-0.5 rounded hover:bg-white/10"
					style={heading}
					title="Hide the legend"
					aria-label="Hide the legend"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="px-3 py-2 space-y-3">
				<section>
					<h4 className="font-medium mb-1.5" style={heading}>
						An arrow: who may reach whom
					</h4>
					<ul className="space-y-1.5">
						{EDGE_KINDS.map((kind) => (
							<li key={kind} className="flex items-center gap-2" data-edge-kind={kind}>
								<EdgeSample kind={kind} theme={theme} />
								{mode === 'edit' && <DelegationEdgeBadge kind={kind} theme={theme} />}
								<span style={text}>{DELEGATION_EDGE_KIND_LABELS[kind]}</span>
							</li>
						))}
						<li className="flex items-center gap-2">
							<EdgeSample kind="delegate" theme={theme} faint />
							<span style={text}>Fainter: from a group or worktree grant</span>
						</li>
					</ul>
					<p className="mt-1.5" style={heading}>
						<b>C</b> is consult, the <b>R</b> box on an agent&apos;s Peers tab. <b>D</b> is
						delegate, the <b>W</b> box. Two arrows between a pair mean each can reach the other.
					</p>
				</section>

				{mode === 'edit' ? (
					<section>
						<h4 className="font-medium mb-1.5" style={heading}>
							An agent
						</h4>
						<ul className="space-y-1.5">
							{NODE_STATES.map(({ state, label }) => (
								<li key={state} className="flex items-center gap-2" data-node-state={state}>
									<NodeSample state={state} theme={theme} />
									<span style={text}>{label}</span>
								</li>
							))}
						</ul>
					</section>
				) : (
					<p style={heading}>
						Lobes groups agents by their links. Select an agent to inspect its relationships.
						Double-click an agent to show its connected cluster; Show all agents returns to the
						fleet.
					</p>
				)}

				<section data-testid="delegation-graph-stats" style={heading}>
					{describeDelegationGraphStats(stats).map((line) => (
						<div key={line}>{line}</div>
					))}
				</section>
			</div>
		</div>
	);
});
