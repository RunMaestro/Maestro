/**
 * PipelineCanvas — ReactFlow canvas area with drawers, overlays, legend, and config panels.
 *
 * Pure composition container: renders the ReactFlow canvas with all surrounding UI
 * (drawers, empty states, pipeline legend, settings panel, node/edge config panels).
 */

import React from 'react';
import ReactFlow, {
	Background,
	ConnectionLineType,
	ConnectionMode,
	Controls,
	MiniMap,
	getBezierPath,
	type ConnectionLineComponentProps,
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
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import type { CueSettings } from '../../../shared/cue';
import { Hand, MousePointer2 } from 'lucide-react';
import { TriggerNode, type TriggerNodeDataProps } from './nodes/TriggerNode';
import { AgentNode, type AgentNodeDataProps } from './nodes/AgentNode';
import { CommandNode, type CommandNodeDataProps } from './nodes/CommandNode';
import { ErrorNode } from './nodes/ErrorNode';
import { PipelineGroupNode } from './nodes/PipelineGroupNode';
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
	'pipeline-group': PipelineGroupNode,
};

/**
 * Custom drag-preview component for the connection line.
 *
 * ReactFlow's default `<ConnectionLine>` paints `.react-flow__connection-path`
 * with `stroke: #b1b1b7` at 1px — invisible against our dark theme. Setting
 * `connectionLineStyle` alone proved insufficient (no visible line during
 * drag, only the committed edge appearing on release). A custom component
 * bypasses any styling/specificity issues with the default render path
 * entirely — we own the `<path>` element and its attributes.
 *
 * Visual contract: dashed bezier in CUE_COLOR at 2px, matching the look of
 * committed edges (which also use bezier + CUE_COLOR via PipelineEdge.tsx)
 * so the drag → release transition feels continuous.
 */
const PipelineConnectionLine = (props: ConnectionLineComponentProps) => {
	const { fromX, fromY, toX, toY, fromPosition, toPosition } = props;
	const [path] = getBezierPath({
		sourceX: fromX,
		sourceY: fromY,
		sourcePosition: fromPosition,
		targetX: toX,
		targetY: toY,
		targetPosition: toPosition,
	});
	return (
		<g>
			<path
				d={path}
				fill="none"
				stroke={CUE_COLOR}
				strokeWidth={2}
				strokeDasharray="6 3"
				strokeLinecap="round"
				className="react-flow__connection-path"
			/>
			<circle cx={toX} cy={toY} r={4} fill={CUE_COLOR} stroke="none" />
		</g>
	);
};

export type CanvasInteractionMode = 'hand' | 'pointer';

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
	onNodeDragStart: (event: React.MouseEvent, node: Node, nodes: Node[]) => void;
	onNodeDrag: (event: React.MouseEvent, node: Node, nodes: Node[]) => void;
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
	/** Dismiss the node config panel by clearing the selection. */
	onCloseNodeConfig?: () => void;
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
	/**
	 * True while pipelines are still loading (initial graph fetch in flight or
	 * layout restore not yet complete). Suppresses the empty-state CTA so the
	 * "Create your first pipeline" message doesn't flash before pipelines arrive.
	 */
	isLoading?: boolean;
	/** Canvas interaction mode: hand pans on left-drag, pointer box-selects. */
	interactionMode: CanvasInteractionMode;
	setInteractionMode: React.Dispatch<React.SetStateAction<CanvasInteractionMode>>;
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
	onNodeDragStart,
	onNodeDrag,
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
	onCloseNodeConfig,
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
	isLoading = false,
	interactionMode,
	setInteractionMode,
}: PipelineCanvasProps) {
	const handleCueSettingsChange = React.useCallback(
		(s: CueSettings) => {
			setCueSettings(s);
			setIsDirty(true);
		},
		[setCueSettings, setIsDirty]
	);

	const handleCloseCueSettings = React.useCallback(() => setShowSettings(false), [setShowSettings]);

	// Stabilize ReactFlow child props on `theme`. PipelineCanvas re-renders on
	// every node drag / pan / zoom (it owns `nodes` and `edges`), so inline
	// objects/functions here would bust the memoization on MiniMap, Controls,
	// and Background — producing both wasted renders and a flood of WDYR logs.
	const reactFlowStyle = React.useMemo(
		() => ({ backgroundColor: theme.colors.bgMain }),
		[theme.colors.bgMain]
	);
	const controlsStyle = React.useMemo(
		() => ({ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }),
		[theme.colors.bgActivity, theme.colors.border]
	);
	const miniMapStyle = React.useMemo(
		() => ({
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
		}),
		[theme.colors.bgActivity, theme.colors.border]
	);
	const miniMapMaskColor = React.useMemo(() => `${theme.colors.bgMain}cc`, [theme.colors.bgMain]);
	// Drag-preview line shown while connecting one handle to another. Without
	// an explicit style, ReactFlow uses its default `stroke: #b1b1b7` at 1px
	// — invisible against most theme backgrounds. Match the committed-edge
	// look (CUE_COLOR, 2px, dashed) so the user sees a clear preview while
	// dragging and a smooth visual transition into the final edge on release.
	const connectionLineStyle = React.useMemo(
		() => ({
			stroke: CUE_COLOR,
			strokeWidth: 2,
			strokeDasharray: '6 3',
		}),
		[]
	);
	const miniMapNodeColor = React.useCallback(
		(node: Node) => {
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
		},
		[theme.colors.accent, theme.colors.error]
	);

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
				isLoading={isLoading}
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
				onNodeDragStart={onNodeDragStart}
				onNodeDrag={onNodeDrag}
				onNodeDragStop={onNodeDragStop}
				onDragOver={onDragOver}
				onDrop={onDrop}
				connectionMode={ConnectionMode.Loose}
				connectionLineType={ConnectionLineType.Bezier}
				connectionLineStyle={connectionLineStyle}
				connectionLineComponent={PipelineConnectionLine}
				minZoom={0.1}
				maxZoom={2}
				// All Pipelines view is read-only. These ReactFlow props are the
				// first line of defense — the parent also guards each callback.
				// Hand mode disables node/group dragging so left-drag on a node
				// falls through to the canvas pan instead of moving the node.
				// Connections, however, are scoped to handles (not the node
				// body) and should always work regardless of canvas mode —
				// matches n8n / Zapier / Figma's behavior, where handle
				// affordances are unaffected by pan vs. select. The
				// drag-preview line also requires nodesConnectable=true to
				// render, so gating this on mode broke the preview in hand
				// mode.
				nodesDraggable={!isReadOnly && interactionMode === 'pointer'}
				nodesConnectable={!isReadOnly}
				elementsSelectable={!isReadOnly}
				// Hand mode: left-drag pans (ReactFlow default). Pointer mode:
				// left-drag box-selects, middle/right-drag still pans as an
				// escape hatch.
				panOnDrag={interactionMode === 'hand' ? true : [1, 2]}
				selectionOnDrag={interactionMode === 'pointer' && !isReadOnly}
				style={reactFlowStyle}
			>
				<Background color={theme.colors.border} gap={20} />
				<Controls style={controlsStyle} />
				<MiniMap
					pannable
					zoomable
					style={miniMapStyle}
					maskColor={miniMapMaskColor}
					nodeColor={miniMapNodeColor}
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

			{/* Canvas interaction-mode toggle (hand pans, pointer box-selects). */}
			<div
				style={{
					position: 'absolute',
					top: 8,
					left: 8,
					zIndex: 10,
					display: 'flex',
					gap: 2,
					padding: 2,
					backgroundColor: `${theme.colors.bgActivity}f5`,
					border: `1px solid ${theme.colors.border}`,
					borderRadius: 6,
				}}
			>
				{(
					[
						{
							mode: 'hand' as const,
							Icon: Hand,
							title: 'Pan — left-drag to move canvas (P)',
						},
						{
							mode: 'pointer' as const,
							Icon: MousePointer2,
							title: 'Select — left-drag for bounding box (S)',
						},
					] satisfies {
						mode: CanvasInteractionMode;
						Icon: typeof Hand;
						title: string;
					}[]
				).map(({ mode, Icon, title }) => {
					const active = interactionMode === mode;
					return (
						<button
							key={mode}
							onClick={() => setInteractionMode(mode)}
							title={title}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: 24,
								height: 24,
								backgroundColor: active ? `${theme.colors.accent}25` : 'transparent',
								color: active ? theme.colors.accent : theme.colors.textDim,
								border: 'none',
								borderRadius: 4,
								cursor: 'pointer',
								transition: 'background-color 0.15s, color 0.15s',
							}}
						>
							<Icon size={14} />
						</button>
					);
				})}
			</div>

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
							onClose={onCloseNodeConfig}
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
