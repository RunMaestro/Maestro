/**
 * NodeConfigPanel — Bottom panel for configuring selected trigger or agent nodes.
 *
 * Thin dispatcher shell: routes to TriggerConfig or AgentConfigPanel based on
 * node type, and provides header chrome (expand/collapse, delete).
 */

import { useState } from 'react';
import { Trash2, Zap, ChevronsUp, ChevronsDown, Play, Loader2 } from 'lucide-react';
import type { Theme } from '../../../types';
import type {
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
	CuePipeline,
	IncomingTriggerEdgeInfo,
} from '../../../../shared/cue-pipeline-types';
import { EVENT_ICONS, EVENT_LABELS } from '../cueEventConstants';
import { TriggerConfig } from './triggers';
import { AgentConfigPanel } from './AgentConfigPanel';

export type { IncomingTriggerEdgeInfo } from '../../../../shared/cue-pipeline-types';

interface NodeConfigPanelProps {
	selectedNode: PipelineNode | null;
	theme: Theme;
	pipelines: CuePipeline[];
	hasOutgoingEdge?: boolean;
	/** Whether the selected agent has incoming edges from other agents (not triggers) */
	hasIncomingAgentEdges?: boolean;
	/** Incoming trigger edges for the selected agent node (for per-edge prompts) */
	incomingTriggerEdges?: IncomingTriggerEdgeInfo[];
	onUpdateNode: (nodeId: string, data: Partial<TriggerNodeData | AgentNodeData>) => void;
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

export function NodeConfigPanel({
	selectedNode,
	theme,
	pipelines,
	hasOutgoingEdge,
	hasIncomingAgentEdges,
	incomingTriggerEdges,
	onUpdateNode,
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
	const triggerData = isTrigger ? (selectedNode.data as TriggerNodeData) : null;
	const agentData = !isTrigger ? (selectedNode.data as AgentNodeData) : null;

	const Icon = triggerData ? (EVENT_ICONS[triggerData.eventType] ?? Zap) : null;
	const ExpandIcon = expanded ? ChevronsDown : ChevronsUp;

	const collapsedHeight = isTrigger ? 'auto' : 240;

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
					{!isTrigger && agentData && (
						<>
							<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
								{agentData.sessionName}
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

			{/* Content */}
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
				{!isTrigger && (
					<AgentConfigPanel
						node={selectedNode}
						theme={theme}
						pipelines={pipelines}
						hasOutgoingEdge={hasOutgoingEdge}
						hasIncomingAgentEdges={hasIncomingAgentEdges}
						incomingTriggerEdges={incomingTriggerEdges}
						onUpdateNode={onUpdateNode}
						onUpdateEdgePrompt={onUpdateEdgePrompt}
						onSwitchToAgent={onSwitchToAgent}
						expanded={expanded}
					/>
				)}
			</div>
		</div>
	);
}
