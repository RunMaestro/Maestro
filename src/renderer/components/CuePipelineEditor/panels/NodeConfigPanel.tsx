/**
 * NodeConfigPanel — Bottom panel for configuring selected trigger or agent nodes.
 *
 * Thin dispatcher shell: routes to TriggerConfig or AgentConfigPanel based on
 * node type, and provides header chrome (expand/collapse, delete).
 */

import { useState } from 'react';
import { Trash2, Zap, ChevronsUp, ChevronsDown } from 'lucide-react';
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
}

export function NodeConfigPanel({
	selectedNode,
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
				backgroundColor: '#1a1a2e',
				borderTop: '1px solid #333',
				borderLeft: '1px solid #333',
				borderRight: '1px solid #333',
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
					borderBottom: '1px solid #2a2a3e',
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					{isTrigger && Icon && (
						<>
							<Icon size={14} style={{ color: '#f59e0b' }} />
							<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>
								Configure Trigger
							</span>
							<span
								style={{
									fontSize: 10,
									color: '#9ca3af',
									backgroundColor: '#2a2a3e',
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
							<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>
								{agentData.sessionName}
							</span>
							<span
								style={{
									fontSize: 10,
									color: '#9ca3af',
									backgroundColor: '#2a2a3e',
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
					{!isTrigger && (
						<button
							onClick={() => setExpanded((v) => !v)}
							style={{
								display: 'flex',
								alignItems: 'center',
								padding: 4,
								color: '#6b7280',
								backgroundColor: 'transparent',
								border: 'none',
								borderRadius: 4,
								cursor: 'pointer',
							}}
							onMouseEnter={(e) => (e.currentTarget.style.color = '#e4e4e7')}
							onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
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
							color: '#6b7280',
							backgroundColor: 'transparent',
							border: 'none',
							borderRadius: 4,
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
						onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
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
				{isTrigger && <TriggerConfig node={selectedNode} onUpdateNode={onUpdateNode} />}
				{!isTrigger && (
					<AgentConfigPanel
						node={selectedNode}
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
