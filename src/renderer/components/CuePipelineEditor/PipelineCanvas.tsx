/**
 * PipelineCanvas — ReactFlow canvas area with drawers, overlays, legend, and config panels.
 *
 * Pure composition container: renders the ReactFlow canvas with all surrounding UI
 * (drawers, empty states, pipeline legend, settings panel, node/edge config panels).
 */

import React from 'react';
import ReactFlow, {
	Background,
	ConnectionMode,
	Controls,
	MiniMap,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { Theme } from '../../types';
import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge as PipelineEdgeType,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
	CuePipelineSessionInfo as SessionInfo,
	IncomingAgentEdgeInfo,
} from '../../../shared/cue-pipeline-types';
import type { CueSettings } from '../../../shared/cue';
import { TriggerNode, type TriggerNodeDataProps } from './nodes/TriggerNode';
import { AgentNode, type AgentNodeDataProps } from './nodes/AgentNode';
import { CommandNode, type CommandNodeDataProps } from './nodes/CommandNode';
import { ErrorNode } from './nodes/ErrorNode';
import { edgeTypes } from './edges/PipelineEdge';
import { TriggerDrawer } from './drawers/TriggerDrawer';
import { AgentDrawer } from './drawers/AgentDrawer';
import { NodeConfigPanel, type IncomingTriggerEdgeInfo } from './panels/NodeConfigPanel';
import { EdgeConfigPanel } from './panels/EdgeConfigPanel';
import { CueSettingsPanel } from './panels/CueSettingsPanel';
import { PipelineLegend } from './panels/PipelineLegend';
import { PipelineEmptyState } from './panels/PipelineEmptyState';
import { EVENT_COLORS } from './cueEventConstants';

const nodeTypes = {
	trigger: TriggerNode,
	agent: AgentNode,
	command: CommandNode,
	error: ErrorNode,
};

export interface PipelineCanvasProps {
	theme: Theme;
	/**
	 * When true (All Pipelines view), the canvas is fully read-only:
	 * nodes can't be dragged, connected, selected, or edited; no config
	 * panels render even if a selection is already set. The parent also
	 * guards each edit callback, so this is defense-in-depth at the
	 * ReactFlow interaction layer.
	 */
	isReadOnly?: boolean;
	// ReactFlow
	nodes: Node[];
	edges: Edge[];
	onNodesChange: OnNodesChange;
	onEdgesChange: OnEdgesChange;
	onConnect: (connection: Connection) => void;
	isValidConnection: (connection: Connection) => boolean;
	onNodeClick: (event: React.MouseEvent, node: Node) => void;
	onEdgeClick: (event: React.MouseEvent, edge: Edge) => void;
	onPaneClick: () => void;
	onNodeContextMenu: (event: React.MouseEvent, node: Node) => void;
	onNodeDragStop: (event: React.MouseEvent, node: Node, nodes: Node[]) => void;
	onDragOver: (event: React.DragEvent) => void;
	onDrop: (event: React.DragEvent) => void;
	// Drawers
	triggerDrawerOpen: boolean;
	setTriggerDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	agentDrawerOpen: boolean;
	setAgentDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	sessions: SessionInfo[];
	groups?: { id: string; name: string; emoji: string }[];
	onCanvasSessionIds: Set<string>;
	// Empty state
	pipelineCount: number;
	createPipeline: () => void;
	// Legend
	selectedPipelineId: string | null;
	pipelines: CuePipeline[];
	selectPipeline: (id: string | null) => void;
	// Settings panel
	showSettings: boolean;
	cueSettings: CueSettings;
	setCueSettings: React.Dispatch<React.SetStateAction<CueSettings>>;
	setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
	setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
	// Config panels
	selectedNode: PipelineNode | null;
	selectedEdge: PipelineEdgeType | null;
	selectedNodeHasOutgoingEdge: boolean;
	hasIncomingAgentEdges: boolean;
	incomingAgentEdgeCount: number;
	incomingAgentEdges: IncomingAgentEdgeInfo[];
	incomingTriggerEdges: IncomingTriggerEdgeInfo[];
	onUpdateNode: (
		nodeId: string,
		data: Partial<TriggerNodeData | AgentNodeData | CommandNodeData>
	) => void;
	onUpdateEdgePrompt: (edgeId: string, prompt: string) => void;
	onDeleteNode: (nodeId: string) => void;
	onSwitchToSession: (id: string) => void;
	triggerDrawerOpenForConfig: boolean;
	agentDrawerOpenForConfig: boolean;
	edgeSourceNode: PipelineNode | null;
	edgeTargetNode: PipelineNode | null;
	selectedEdgePipelineColor: string;
	onUpdateEdge: (edgeId: string, updates: Partial<PipelineEdgeType>) => void;
	onDeleteEdge: (edgeId: string) => void;
	/** Callback to manually trigger a pipeline by name */
	onTriggerPipeline?: (pipelineName: string) => void;
	/** Whether the pipeline config has unsaved changes */
	isDirty?: boolean;
	/** Set of pipeline IDs that are currently running */
	runningPipelineIds?: Set<string>;
}

export const PipelineCanvas = React.memo(function PipelineCanvas({
	theme,
	isReadOnly = false,
	nodes,
	edges,
	onNodesChange,
	onEdgesChange,
	onConnect,
	isValidConnection,
	onNodeClick,
	onEdgeClick,
	onPaneClick,
	onNodeContextMenu,
	onNodeDragStop,
	onDragOver,
	onDrop,
	triggerDrawerOpen,
	setTriggerDrawerOpen,
	agentDrawerOpen,
	setAgentDrawerOpen,
	sessions,
	groups,
	onCanvasSessionIds,
	pipelineCount,
	createPipeline,
	selectedPipelineId,
	pipelines,
	selectPipeline,
	showSettings,
	cueSettings,
	setCueSettings,
	setShowSettings,
	setIsDirty,
	selectedNode,
	selectedEdge,
	selectedNodeHasOutgoingEdge,
	hasIncomingAgentEdges,
	incomingAgentEdgeCount,
	incomingAgentEdges,
	incomingTriggerEdges,
	onUpdateNode,
	onUpdateEdgePrompt,
	onDeleteNode,
	onSwitchToSession,
	triggerDrawerOpenForConfig,
	agentDrawerOpenForConfig,
	edgeSourceNode,
	edgeTargetNode,
	selectedEdgePipelineColor,
	onUpdateEdge,
	onDeleteEdge,
	onTriggerPipeline,
	isDirty,
	runningPipelineIds,
}: PipelineCanvasProps) {
	const handleCueSettingsChange = React.useCallback(
		(s: CueSettings) => {
			setCueSettings(s);
			setIsDirty(true);
		},
		[setCueSettings, setIsDirty]
	);

	const handleCloseCueSettings = React.useCallback(() => setShowSettings(false), [setShowSettings]);

	return (
		<div className="flex-1 relative overflow-hidden">
			{/* Trigger drawer (left) */}
			<TriggerDrawer
				isOpen={triggerDrawerOpen}
				onClose={() => setTriggerDrawerOpen(false)}
				theme={theme}
			/>

			{/* Empty state overlay (Phase 14B — extracted + memoized) */}
			<PipelineEmptyState
				nodeCount={nodes.length}
				pipelineCount={pipelineCount}
				theme={theme}
				createPipeline={createPipeline}
				setTriggerDrawerOpen={setTriggerDrawerOpen}
				setAgentDrawerOpen={setAgentDrawerOpen}
			/>

			{/* React Flow Canvas */}
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				isValidConnection={isValidConnection}
				onNodeClick={onNodeClick}
				onEdgeClick={onEdgeClick}
				onPaneClick={onPaneClick}
				onNodeContextMenu={onNodeContextMenu}
				onNodeDragStop={onNodeDragStop}
				onDragOver={onDragOver}
				onDrop={onDrop}
				connectionMode={ConnectionMode.Loose}
				// All Pipelines view is read-only. These ReactFlow props are the
				// first line of defense — the parent also guards each callback.
				nodesDraggable={!isReadOnly}
				nodesConnectable={!isReadOnly}
				elementsSelectable={!isReadOnly}
				style={{
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<Background color={theme.colors.border} gap={20} />
				<Controls
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
					}}
				/>
				<MiniMap
					style={{
						backgroundColor: theme.colors.bgActivity,
						border: `1px solid ${theme.colors.border}`,
					}}
					maskColor={`${theme.colors.bgMain}cc`}
					nodeColor={(node) => {
						if (node.type === 'trigger') {
							const data = node.data as TriggerNodeDataProps;
							return EVENT_COLORS[data.eventType] ?? theme.colors.accent;
						}
						if (node.type === 'agent') {
							const data = node.data as AgentNodeDataProps;
							return data.pipelineColor ?? theme.colors.accent;
						}
						if (node.type === 'command') {
							const data = node.data as CommandNodeDataProps;
							return data.pipelineColor ?? theme.colors.accent;
						}
						// Error nodes (unresolved agent/source) stand out in the
						// minimap so the user spots them when zoomed out.
						if (node.type === 'error') {
							return theme.colors.error ?? '#ef4444';
						}
						return theme.colors.accent;
					}}
				/>
			</ReactFlow>

			{/* Agent drawer (right) */}
			<AgentDrawer
				isOpen={agentDrawerOpen}
				onClose={() => setAgentDrawerOpen(false)}
				sessions={sessions}
				groups={groups}
				onCanvasSessionIds={onCanvasSessionIds}
				theme={theme}
			/>

			{/* Pipeline legend — extracted + memoized (Phase 14B) */}
			<PipelineLegend
				pipelines={pipelines}
				selectedPipelineId={selectedPipelineId}
				selectPipeline={selectPipeline}
				theme={theme}
			/>

			{/* Cue settings panel */}
			{showSettings && (
				<CueSettingsPanel
					settings={cueSettings}
					onChange={handleCueSettingsChange}
					onClose={handleCloseCueSettings}
					theme={theme}
				/>
			)}

			{/* Config panels — suppressed in read-only (All Pipelines) view so
			    any selection carried over from a previous single-pipeline view
			    does not expose editable fields. */}
			{!isReadOnly &&
				selectedNode &&
				!selectedEdge &&
				(() => {
					const selectedPipeline = pipelines.find((pl) =>
						pl.nodes.some((n) => n.id === selectedNode.id)
					);
					return (
						<NodeConfigPanel
							selectedNode={selectedNode}
							theme={theme}
							pipelines={pipelines}
							sessions={sessions}
							hasOutgoingEdge={selectedNodeHasOutgoingEdge}
							hasIncomingAgentEdges={hasIncomingAgentEdges}
							incomingAgentEdgeCount={incomingAgentEdgeCount}
							incomingAgentEdges={incomingAgentEdges}
							incomingTriggerEdges={incomingTriggerEdges}
							onUpdateNode={onUpdateNode}
							onUpdateEdge={onUpdateEdge}
							onUpdateEdgePrompt={onUpdateEdgePrompt}
							onDeleteNode={onDeleteNode}
							onSwitchToAgent={onSwitchToSession}
							triggerDrawerOpen={triggerDrawerOpenForConfig}
							agentDrawerOpen={agentDrawerOpenForConfig}
							onTriggerPipeline={onTriggerPipeline}
							pipelineName={selectedPipeline?.name}
							isSaved={!isDirty}
							isRunning={selectedPipeline ? runningPipelineIds?.has(selectedPipeline.id) : false}
						/>
					);
				})()}
			{!isReadOnly && selectedEdge && !selectedNode && (
				<EdgeConfigPanel
					selectedEdge={selectedEdge}
					theme={theme}
					sourceNode={edgeSourceNode}
					targetNode={edgeTargetNode}
					pipelineColor={selectedEdgePipelineColor}
					onUpdateEdge={onUpdateEdge}
					onDeleteEdge={onDeleteEdge}
				/>
			)}
		</div>
	);
});
