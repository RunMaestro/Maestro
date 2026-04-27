/**
 * NodeConfigPanel — Bottom panel for configuring selected trigger or agent nodes.
 *
 * Thin dispatcher shell: routes to TriggerConfig or AgentConfigPanel based on
 * node type, and provides header chrome (expand/collapse, delete).
 */

import React, { useState } from 'react';
import { Trash2, Zap, ChevronsUp, ChevronsDown, Play, Loader2 } from 'lucide-react';
import type { Theme } from '../../../types';
import type {
	PipelineNode,
	PipelineEdge,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
	CuePipeline,
	CuePipelineSessionInfo as SessionInfo,
	IncomingTriggerEdgeInfo,
	IncomingAgentEdgeInfo,
} from '../../../../shared/cue-pipeline-types';
import { EVENT_ICONS, EVENT_LABELS } from '../cueEventConstants';
import { TriggerConfig } from './triggers';
import { AgentConfigPanel } from './AgentConfigPanel';
import { CommandConfigPanel } from './CommandConfigPanel';

export type { IncomingTriggerEdgeInfo } from '../../../../shared/cue-pipeline-types';

interface NodeConfigPanelProps {
	selectedNode: PipelineNode | null;
	theme: Theme;
	pipelines: CuePipeline[];
	/** Available sessions — used by CommandConfigPanel's owning-session picker when
	 *  the command node was dropped without a pre-bound session. */
	sessions?: SessionInfo[];
	hasOutgoingEdge?: boolean;
	/** Whether the selected agent has incoming edges from other agents (not triggers) */
	hasIncomingAgentEdges?: boolean;
	/** Count of incoming agent edges (for fan-in configuration) */
	incomingAgentEdgeCount?: number;
	/** Incoming agent edges with source info (for per-edge upstream output toggles) */
	incomingAgentEdges?: IncomingAgentEdgeInfo[];
	/** Incoming trigger edges for the selected agent node (for per-edge prompts) */
	incomingTriggerEdges?: IncomingTriggerEdgeInfo[];
	onUpdateNode: (
		nodeId: string,
		data: Partial<TriggerNodeData | AgentNodeData | CommandNodeData>
	) => void;
	onUpdateEdge?: (edgeId: string, updates: Partial<PipelineEdge>) => void;
	onUpdateEdgePrompt?: (edgeId: string, prompt: string) => void;
	onDeleteNode: (nodeId: string) => void;
	onSwitchToAgent?: (sessionId: string) => void;
	triggerDrawerOpen?: boolean;
	agentDrawerOpen?: boolean;
	/** Callback to manually trigger the pipeline this trigger belongs to */
	onTriggerPipeline?: (pipelineName: string) => void;
	/** Pipeline name for the selected trigger's pipeline */
	pipelineName?: string;
	/** Whether the pipeline config is saved */
	isSaved?: boolean;
	/** Whether this pipeline is currently running */
	isRunning?: boolean;
}

function NodeConfigPanelInner({
	selectedNode,
	theme,
	pipelines,
	sessions,
	hasOutgoingEdge,
	hasIncomingAgentEdges,
	incomingAgentEdgeCount,
	incomingAgentEdges,
	incomingTriggerEdges,
	onUpdateNode,
	onUpdateEdge,
	onUpdateEdgePrompt,
	onDeleteNode,
	onSwitchToAgent,
	triggerDrawerOpen,
	agentDrawerOpen,
	onTriggerPipeline,
	pipelineName,
	isSaved,
	isRunning,
}: NodeConfigPanelProps) {
	const [expanded, setExpanded] = useState(false);
	const isVisible = selectedNode !== null;

	if (!isVisible) return null;

	const isTrigger = selectedNode.type === 'trigger';
	const isCommand = selectedNode.type === 'command';
	const isAgent = selectedNode.type === 'agent';
	const triggerData = isTrigger ? (selectedNode.data as TriggerNodeData) : null;
	const agentData = isAgent ? (selectedNode.data as AgentNodeData) : null;
	const commandData = isCommand ? (selectedNode.data as CommandNodeData) : null;

	const Icon = triggerData ? (EVENT_ICONS[triggerData.eventType] ?? Zap) : null;
	const ExpandIcon = expanded ? ChevronsDown : ChevronsUp;

	const hasFanIn = (incomingAgentEdgeCount ?? 0) > 1;
	const hasUpstreamAgents = hasIncomingAgentEdges === true;
	const triggerEdgeCount = incomingTriggerEdges?.length ?? 0;
	const hasMultipleTriggers = triggerEdgeCount > 1;

	// Collapsed-height policy:
	//   - Single trigger, no upstream agents: tight (~280) — input + output prompts
	//     have plenty of room and the panel doesn't dominate the canvas.
	//   - Single trigger with upstream agents: a bit taller for the
	//     "auto-include upstream output" checkbox row.
	//   - Multi-trigger: needs room for ~2 visible EdgePromptRows side-by-side
	//     with the output box. The left rail scrolls past the visible cap
	//     (handled inside AgentConfigPanel) so we don't grow indefinitely.
	//   - Fan-in: extra height for the fan-in settings card.
	// This replaces the previous hard-coded ladder that left the output box
	// undersized in multi-trigger collapsed mode and wasted space in
	// single-trigger collapsed mode.
	const collapsedHeight = (() => {
		if (isTrigger) return 'auto' as const;
		// Collapsed mode stays compact — the content wrapper scrolls when
		// upstream-sources / fan-in cards don't fit. Expanded mode (80%) is
		// where the user gets full breathing room.
		if (isCommand) return commandData?.mode === 'cli' ? 320 : 280;
		const base = hasUpstreamAgents ? 300 : 280;
		const fanInBoost = hasFanIn ? 60 : 0;
		const triggerBoost = hasMultipleTriggers ? Math.min(120, (triggerEdgeCount - 1) * 60) : 0;
		return base + fanInBoost + triggerBoost;
	})();

	return (
		<div
			style={{
				position: 'absolute',
				bottom: 0,
				left: triggerDrawerOpen ? 220 : 0,
				right: agentDrawerOpen ? 240 : 0,
				height: expanded ? '80%' : collapsedHeight,
				backgroundColor: theme.colors.bgMain,
				borderTop: `1px solid ${theme.colors.border}`,
				borderLeft: `1px solid ${theme.colors.border}`,
				borderRight: `1px solid ${theme.colors.border}`,
				borderRadius: '8px 8px 0 0',
				boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
				display: 'flex',
				flexDirection: 'column',
				zIndex: 10,
				animation: 'slideUp 0.15s ease-out',
				transition: isTrigger ? undefined : 'height 0.2s ease-out',
			}}
		>
			<style>{`
				@keyframes slideUp {
					from { transform: translateY(100%); }
					to { transform: translateY(0); }
				}
			`}</style>

			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '8px 16px',
					borderBottom: `1px solid ${theme.colors.bgActivity}`,
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					{isTrigger && Icon && (
						<>
							<Icon size={14} style={{ color: theme.colors.warning }} />
							<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
								Configure Trigger
							</span>
							<span
								style={{
									fontSize: 10,
									color: theme.colors.textDim,
									backgroundColor: theme.colors.bgActivity,
									padding: '1px 6px',
									borderRadius: 4,
								}}
							>
								{EVENT_LABELS[triggerData!.eventType]}
							</span>
						</>
					)}
					{isCommand && (
						<>
							<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
								{commandData?.name || 'command'}
							</span>
							<span
								style={{
									fontSize: 10,
									color: theme.colors.textDim,
									backgroundColor: theme.colors.bgActivity,
									padding: '1px 6px',
									borderRadius: 4,
								}}
							>
								{commandData?.mode === 'cli' ? 'cli send' : 'shell'}
							</span>
						</>
					)}
					{isAgent && agentData && (
						<>
							<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
								{agentData.sessionName}
								{(() => {
									// Mirror the canvas's "(N)" suffix that AgentNode shows
									// when multiple visual instances share a sessionId
									// within the owning pipeline (see pipelineGraph.ts:254-257).
									// Without this, the panel header shows just "Pedsidian"
									// while the canvas node shows "Pedsidian (5)" — making
									// it ambiguous which instance the user is editing.
									const owningPipeline = pipelines.find((p) =>
										p.nodes.some((n) => n.id === selectedNode.id)
									);
									if (!owningPipeline) return '';
									const sameSessionAgents = owningPipeline.nodes.filter(
										(n) =>
											n.type === 'agent' &&
											(n.data as AgentNodeData).sessionId === agentData.sessionId
									);
									if (sameSessionAgents.length <= 1) return '';
									const idx = sameSessionAgents.findIndex((n) => n.id === selectedNode.id);
									return idx >= 0 ? ` (${idx + 1})` : '';
								})()}
							</span>
							<span
								style={{
									fontSize: 10,
									color: theme.colors.textDim,
									backgroundColor: theme.colors.bgActivity,
									padding: '1px 6px',
									borderRadius: 4,
								}}
							>
								{agentData.toolType}
							</span>
						</>
					)}
				</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
					{isTrigger && isSaved && onTriggerPipeline && pipelineName && (
						<button
							onClick={() => !isRunning && onTriggerPipeline(pipelineName)}
							disabled={isRunning}
							style={{
								display: 'flex',
								alignItems: 'center',
								padding: 4,
								color: isRunning ? theme.colors.success : theme.colors.textDim,
								backgroundColor: 'transparent',
								border: 'none',
								borderRadius: 4,
								cursor: isRunning ? 'default' : 'pointer',
							}}
							onMouseEnter={(e) => {
								if (!isRunning) e.currentTarget.style.color = theme.colors.success;
							}}
							onMouseLeave={(e) => {
								if (!isRunning) e.currentTarget.style.color = theme.colors.textDim;
							}}
							title={isRunning ? 'Running...' : 'Run now'}
						>
							{isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
						</button>
					)}
					{!isTrigger && (
						<button
							onClick={() => setExpanded((v) => !v)}
							style={{
								display: 'flex',
								alignItems: 'center',
								padding: 4,
								color: theme.colors.textDim,
								backgroundColor: 'transparent',
								border: 'none',
								borderRadius: 4,
								cursor: 'pointer',
							}}
							onMouseEnter={(e) => (e.currentTarget.style.color = theme.colors.textMain)}
							onMouseLeave={(e) => (e.currentTarget.style.color = theme.colors.textDim)}
							title={expanded ? 'Collapse panel' : 'Expand panel'}
						>
							<ExpandIcon size={14} />
						</button>
					)}
					<button
						onClick={() => onDeleteNode(selectedNode.id)}
						style={{
							display: 'flex',
							alignItems: 'center',
							padding: 4,
							color: theme.colors.textDim,
							backgroundColor: 'transparent',
							border: 'none',
							borderRadius: 4,
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => (e.currentTarget.style.color = theme.colors.error)}
						onMouseLeave={(e) => (e.currentTarget.style.color = theme.colors.textDim)}
						title="Delete node"
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>

			{/* Content — scrollable for both triggers and agents. Agents need
			 *  `overflow: auto` so upstream-sources and fan-in cards below the
			 *  prompts row are reachable even when the panel is collapsed. */}
			<div
				style={{
					flex: isTrigger ? undefined : 1,
					overflow: 'auto',
					padding: '12px 16px',
					display: 'flex',
					flexDirection: 'column',
					minHeight: 0,
				}}
			>
				{isTrigger && (
					<TriggerConfig node={selectedNode} theme={theme} onUpdateNode={onUpdateNode} />
				)}
				{isCommand && (
					<CommandConfigPanel
						key={selectedNode.id}
						node={selectedNode}
						theme={theme}
						sessions={sessions}
						onUpdateNode={onUpdateNode}
						onSwitchToAgent={onSwitchToAgent}
					/>
				)}
				{isAgent && (
					<AgentConfigPanel
						key={selectedNode.id}
						node={selectedNode}
						theme={theme}
						pipelines={pipelines}
						hasOutgoingEdge={hasOutgoingEdge}
						hasIncomingAgentEdges={hasIncomingAgentEdges}
						incomingAgentEdgeCount={incomingAgentEdgeCount}
						incomingAgentEdges={incomingAgentEdges}
						incomingTriggerEdges={incomingTriggerEdges}
						onUpdateNode={onUpdateNode}
						onUpdateEdge={onUpdateEdge}
						onUpdateEdgePrompt={onUpdateEdgePrompt}
						onSwitchToAgent={onSwitchToAgent}
						expanded={expanded}
					/>
				)}
			</div>
		</div>
	);
}

// Phase 14B — memoized so the panel does not re-render on unrelated canvas ticks.
export const NodeConfigPanel = React.memo(NodeConfigPanelInner);
