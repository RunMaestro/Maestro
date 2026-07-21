/**
 * Pure utility functions for converting the internal CuePipelineState
 * into React Flow nodes and edges for rendering.
 *
 * Extracted here so they can be unit-tested independently of the component.
 */

import { MarkerType, type Node, type Edge } from 'reactflow';
import type {
	CuePipelineState,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
	ErrorNodeData,
} from '../../../../shared/cue-pipeline-types';
import type { Theme } from '../../../../shared/theme-types';
import type { TriggerNodeDataProps } from '../nodes/TriggerNode';
import type { AgentNodeDataProps } from '../nodes/AgentNode';
import type { CommandNodeDataProps } from '../nodes/CommandNode';
import type { ErrorNodeDataProps } from '../nodes/ErrorNode';
import type { PipelineGroupNodeDataProps } from '../nodes/PipelineGroupNode';
import type { PipelineEdgeData } from '../edges/PipelineEdge';

/** Build the one-line summary shown under the command node's name. */
function summarizeCommandNode(data: CommandNodeData): string {
	if (data.mode === 'shell') {
		const text = data.shell?.trim() ?? '';
		if (!text) return '(no command)';
		const firstLine = text.split('\n')[0];
		return '$ ' + (firstLine.length > 36 ? firstLine.slice(0, 33) + '…' : firstLine);
	}
	const target = data.cliTarget?.trim() || '(no target)';
	return `cli send → ${target}`;
}

// ─── Trigger config summary ──────────────────────────────────────────────────

/** Returns a short human-readable summary of a trigger's configuration. */
export function getTriggerConfigSummary(data: TriggerNodeData): string {
	const { eventType, config } = data;
	switch (eventType) {
		case 'time.heartbeat':
			return config.interval_minutes ? `every ${config.interval_minutes}min` : 'heartbeat';
		case 'time.scheduled': {
			const times = config.schedule_times ?? [];
			const days = config.schedule_days ?? [];
			if (times.length === 0) return 'scheduled';
			const timeStr = times.length <= 2 ? times.join(', ') : `${times.length} times`;
			const dayStr = days.length > 0 && days.length < 7 ? ` (${days.join(', ')})` : '';
			return `${timeStr}${dayStr}`;
		}
		case 'file.changed':
			return config.watch ?? '**/*';
		case 'github.pull_request':
		case 'github.issue':
			return config.repo ?? 'repo';
		case 'task.pending':
			return config.watch ?? 'tasks';
		case 'agent.completed':
			return 'agent done';
		case 'cli.trigger':
			return 'cli';
		default:
			return '';
	}
}

// ─── Pipeline Y-offset (for "All Pipelines" view) ──────────────────────────

const PIPELINE_GAP = 100; // px between pipeline groups
const NODE_HEIGHT = 100; // approximate node height

// Approximate node footprint used to compute the bounding box of the per-pipeline
// translucent background card in All Pipelines view. Real nodes are a touch
// narrower/shorter, so the box always fully encloses them. Exported so the
// auto-arrange layout (pipelineAutoArrange.ts) sizes group cells with the exact
// same footprint the renderer uses, keeping grid spacing pixel-accurate.
export const NODE_BG_WIDTH = 320;
export const NODE_BG_HEIGHT = 100;
export const PIPELINE_GROUP_PADDING = 28;

/**
 * Computes vertical offsets so pipeline groups don't overlap in the
 * "All Pipelines" view. Returns an empty map when a single pipeline is
 * selected (offsets are only needed for the combined view).
 *
 * Pipelines with a manual `viewOffset` are excluded from the auto-stack
 * chain - they're placed by the user, so they shouldn't push the rest
 * of the auto-stacked pipelines around. Their offset comes from
 * `resolvePipelineOffset` instead.
 *
 * Mixed state (some pipelines with `viewOffset`, some without) used to
 * render the auto-stacked subset starting at y=0 with no awareness of
 * where manual pipelines actually live in the render frame, producing
 * overlapping group cards on first open until any drag triggered the
 * `onNodeDragStop` snapshot that converts every pipeline to manual mode.
 * To avoid that "first open is jumbled" symptom, auto-stack now starts
 * BELOW the rendered bottom of every manually-positioned pipeline so the
 * two coordinate frames can never collide.
 *
 * Exported so `onNodesChange` can subtract offsets before writing
 * ReactFlow's screen-space positions back to the canonical state.
 */
export function computePipelineYOffsets(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null
): Map<string, number> {
	const offsets = new Map<string, number>();
	if (selectedPipelineId !== null || pipelines.length <= 1) return offsets;

	// Establish a floor: auto-stacked pipelines must land below the rendered
	// bottom of every manually-positioned pipeline so the two regimes share
	// one global y-axis instead of overlapping in independent frames.
	let manualFloor = -Infinity;
	for (const pipeline of pipelines) {
		if (!pipeline.viewOffset || pipeline.nodes.length === 0) continue;
		let manualMaxY = -Infinity;
		for (const node of pipeline.nodes) {
			manualMaxY = Math.max(manualMaxY, node.position.y);
		}
		const renderedBottom = pipeline.viewOffset.y + manualMaxY + NODE_HEIGHT;
		manualFloor = Math.max(manualFloor, renderedBottom + PIPELINE_GAP);
	}

	let currentY = manualFloor === -Infinity ? 0 : manualFloor;
	for (const pipeline of pipelines) {
		if (pipeline.nodes.length === 0) continue;
		// Manually-positioned pipelines opt out of auto-stack.
		if (pipeline.viewOffset) continue;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const node of pipeline.nodes) {
			minY = Math.min(minY, node.position.y);
			maxY = Math.max(maxY, node.position.y);
		}
		offsets.set(pipeline.id, currentY - minY);
		currentY += maxY - minY + NODE_HEIGHT + PIPELINE_GAP;
	}
	return offsets;
}

/**
 * Resolves the (x, y) offset to apply to every node of a pipeline in the
 * "All Pipelines" view. Manual `viewOffset` (set by the user dragging a
 * pipeline-group node) wins; otherwise we fall back to the auto-stack
 * Y-offset and 0 on X.
 */
export function resolvePipelineOffset(
	pipeline: CuePipelineState['pipelines'][number],
	autoYOffsets: Map<string, number>
): { x: number; y: number } {
	if (pipeline.viewOffset) return pipeline.viewOffset;
	return { x: 0, y: autoYOffsets.get(pipeline.id) ?? 0 };
}

// ─── Pipeline bounding-box & overlap resolution ──────────────────────────────

/** Visual breathing room when sliding a dropped pipeline to clear an overlap. */
const PIPELINE_OVERLAP_GAP = 16;

interface PipelineBBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Computes the All-Pipelines-view bounding box for a single pipeline at a
 * given offset. Returns null for empty pipelines (no nodes ⇒ no box).
 *
 * Box dimensions match the translucent group card rendered in
 * `convertToReactFlowNodes` (NODE_BG_WIDTH/HEIGHT + PIPELINE_GROUP_PADDING),
 * so collision tests align with what the user sees.
 */
function pipelineBoundingBox(
	pipeline: CuePipelineState['pipelines'][number],
	offset: { x: number; y: number }
): PipelineBBox | null {
	if (pipeline.nodes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of pipeline.nodes) {
		const x = n.position.x + offset.x;
		const y = n.position.y + offset.y;
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + NODE_BG_WIDTH);
		maxY = Math.max(maxY, y + NODE_BG_HEIGHT);
	}
	return {
		minX: minX - PIPELINE_GROUP_PADDING,
		minY: minY - PIPELINE_GROUP_PADDING,
		maxX: maxX + PIPELINE_GROUP_PADDING,
		maxY: maxY + PIPELINE_GROUP_PADDING,
	};
}

function rectsOverlap(a: PipelineBBox, b: PipelineBBox): boolean {
	return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/**
 * Adjusts `desiredOffset` so the moved pipeline's bounding box doesn't overlap
 * any other pipeline's. On overlap, picks the cardinal direction (left/right/
 * up/down) with the smallest push needed to clear ALL overlapping neighbors,
 * then iterates (a single push can introduce a new overlap with a third
 * pipeline). Caps iterations to avoid pathological loops.
 *
 * Used by the pipeline-group drag-stop handler so a user can drop a pipeline
 * group anywhere and have it slide into the nearest free slot rather than
 * land on top of an existing group.
 */
export function resolveNonOverlappingPipelineOffset(
	pipeline: CuePipelineState['pipelines'][number],
	desiredOffset: { x: number; y: number },
	others: {
		pipeline: CuePipelineState['pipelines'][number];
		offset: { x: number; y: number };
	}[]
): { x: number; y: number } {
	const otherBoxes = others
		.map((o) => pipelineBoundingBox(o.pipeline, o.offset))
		.filter((b): b is PipelineBBox => b !== null);
	if (otherBoxes.length === 0) return desiredOffset;

	let offset = { ...desiredOffset };
	const MAX_ITERATIONS = 8;
	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		const movedBox = pipelineBoundingBox(pipeline, offset);
		if (!movedBox) return offset;
		const overlapping = otherBoxes.filter((b) => rectsOverlap(movedBox, b));
		if (overlapping.length === 0) return offset;

		// Min push along each cardinal axis to clear ALL currently-overlapping boxes.
		let pushRight = 0;
		let pushLeft = 0;
		let pushDown = 0;
		let pushUp = 0;
		for (const ob of overlapping) {
			pushRight = Math.max(pushRight, ob.maxX - movedBox.minX + PIPELINE_OVERLAP_GAP);
			pushLeft = Math.max(pushLeft, movedBox.maxX - ob.minX + PIPELINE_OVERLAP_GAP);
			pushDown = Math.max(pushDown, ob.maxY - movedBox.minY + PIPELINE_OVERLAP_GAP);
			pushUp = Math.max(pushUp, movedBox.maxY - ob.minY + PIPELINE_OVERLAP_GAP);
		}
		const candidates = [
			{ dx: pushRight, dy: 0 },
			{ dx: -pushLeft, dy: 0 },
			{ dx: 0, dy: pushDown },
			{ dx: 0, dy: -pushUp },
		];
		// Pick the smallest displacement that clears the current set.
		candidates.sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
		const best = candidates[0];
		offset = { x: offset.x + best.dx, y: offset.y + best.dy };
	}
	return offset;
}

// ─── Node conversion ─────────────────────────────────────────────────────────

/**
 * Converts the internal pipeline state into React Flow node objects.
 *
 * Rules:
 * - "All Pipelines" view (selectedPipelineId === null): renders all nodes from
 *   all pipelines, stacked vertically with gap offsets to avoid overlap.
 * - "Selected pipeline" view: renders ONLY nodes belonging to the active
 *   pipeline. Nodes from other pipelines are fully hidden - even if the same
 *   agent session appears in multiple pipelines. This prevents confusing
 *   "ghost" duplicates when an agent is shared across pipelines.
 *
 * Agent nodes always carry multi-pipeline color metadata so the AgentNode
 * component can display the multi-color indicator even in the selected view.
 */
export function convertToReactFlowNodes(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null,
	onConfigureNode?: (compositeId: string) => void,
	triggerOptions?: {
		onTriggerPipeline?: (pipelineName: string) => void;
		isSaved?: boolean;
		/** Pipeline-wide running state - kept for components (e.g. the
		 *  NodeConfigPanel on the right rail) that only need a yes/no per
		 *  pipeline. Trigger-node animation should prefer
		 *  `runningSubscriptionsByPipeline` for per-sub precision. */
		runningPipelineIds?: Set<string>;
		/** Per-pipeline set of exact subscription names with active runs.
		 *  A trigger node animates iff its own `subscriptionName` is in the
		 *  set for its owning pipeline. Falls back to `runningPipelineIds`
		 *  when the trigger has no `subscriptionName` stamped (legacy
		 *  never-saved pipelines) so the spinner still surfaces something. */
		runningSubscriptionsByPipeline?: Map<string, Set<string>>;
		/** Per-pipeline set of agent `sessionName`s currently executing a Cue
		 *  run. Used to pulse running agent nodes so the active leg is visible
		 *  even when the user isn't watching the edges between them. */
		runningAgentsByPipeline?: Map<string, Set<string>>;
	},
	theme?: Theme,
	/** Pre-computed Y-offsets to use instead of recomputing from bounding boxes.
	 *  Passed during drag so rendering uses the same offsets as onNodesChange. */
	frozenYOffsets?: Map<string, number> | null,
	/** When true, the canvas is in pan (hand) mode. Pipeline group nodes opt
	 *  out of dragging so a left-drag on the group's empty area pans the
	 *  canvas instead of moving the whole pipeline. */
	isHandMode?: boolean
): Node[] {
	const nodes: Node[] = [];

	// When showing all pipelines, compute vertical offsets to prevent overlap.
	// During drag, use frozen offsets so the display stays consistent with the
	// offsets subtracted in onNodesChange (prevents visual jump on drag end).
	const pipelineYOffsets = frozenYOffsets ?? computePipelineYOffsets(pipelines, selectedPipelineId);

	// In All Pipelines view, render a translucent color-matched background
	// card behind each pipeline so the visual grouping is obvious. Pushed
	// FIRST so they render under content nodes; zIndex -1 belt-and-braces
	// in case ReactFlow decides to bump a selected node's stacking order.
	if (selectedPipelineId === null) {
		for (const pipeline of pipelines) {
			if (pipeline.nodes.length === 0) continue;
			const offset = resolvePipelineOffset(pipeline, pipelineYOffsets);
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const pNode of pipeline.nodes) {
				const x = pNode.position.x + offset.x;
				const y = pNode.position.y + offset.y;
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x + NODE_BG_WIDTH);
				maxY = Math.max(maxY, y + NODE_BG_HEIGHT);
			}
			const groupData: PipelineGroupNodeDataProps = {
				pipelineName: pipeline.name,
				color: pipeline.color,
				width: maxX - minX + 2 * PIPELINE_GROUP_PADDING,
				height: maxY - minY + 2 * PIPELINE_GROUP_PADDING,
				theme,
			};
			nodes.push({
				id: `pipeline-group:${pipeline.id}`,
				type: 'pipeline-group',
				position: {
					x: minX - PIPELINE_GROUP_PADDING,
					y: minY - PIPELINE_GROUP_PADDING,
				},
				data: groupData,
				// Group is the user-grabbable handle for the whole pipeline in
				// pointer/select mode. ReactFlow honors per-node `draggable` /
				// `selectable` even when the global `nodesDraggable` /
				// `elementsSelectable` are false (both are, in All Pipelines
				// view), so the group participates while content nodes stay
				// inert. In hand/pan mode we opt out so a left-drag on the
				// group's empty area falls through to canvas pan - pan tool
				// should never move groups.
				selectable: !isHandMode,
				draggable: !isHandMode,
				focusable: false,
				// Never delete a pipeline via the canvas Delete key - selection
				// makes that reachable, but removal must go through the toolbar.
				deletable: false,
				// In pointer/select mode the card sits ABOVE its content nodes so
				// the entire body is a drag handle (the 8%-alpha fill keeps the
				// content readable underneath). In hand/pan mode it drops behind
				// (zIndex -1) so a left-drag on the card's empty area falls
				// through to the canvas pan instead of being captured here.
				zIndex: isHandMode ? -1 : 5,
			});
		}
	}

	// First pass: compute all pipeline colors per agent session (for multi-color indicator)
	const agentPipelineMap = new Map<string, string[]>();
	for (const pipeline of pipelines) {
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				const existing = agentPipelineMap.get(agentData.sessionId) ?? [];
				if (!existing.includes(pipeline.color)) {
					existing.push(pipeline.color);
				}
				agentPipelineMap.set(agentData.sessionId, existing);
			}
		}
	}

	// Count how many pipelines each agent appears in (for pipelineCount badge)
	const agentPipelineCount = new Map<string, number>();
	for (const pipeline of pipelines) {
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				agentPipelineCount.set(
					agentData.sessionId,
					(agentPipelineCount.get(agentData.sessionId) ?? 0) + 1
				);
			}
		}
	}

	// Count agent session occurrences for duplicate instance labeling
	const agentSessionCounts = new Map<string, number>();
	const agentSessionIndex = new Map<string, number>();
	for (const pipeline of pipelines) {
		if (selectedPipelineId !== null && pipeline.id !== selectedPipelineId) continue;
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const sid = (pNode.data as AgentNodeData).sessionId;
				agentSessionCounts.set(sid, (agentSessionCounts.get(sid) ?? 0) + 1);
			}
		}
	}

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		// Only render nodes from the active pipeline. In "All Pipelines" view all
		// pipelines are active, so nothing is skipped. In "selected pipeline" view,
		// nodes from other pipelines are hidden entirely - this prevents the jarring
		// "ghost duplicate" that appeared when a shared agent was dragged into a new
		// pipeline, causing the same agent from another pipeline to pop up dimmed.
		if (!isActive) continue;

		// viewOffset only applies in All Pipelines view - single-pipeline view
		// must always show nodes at their canonical positions.
		const pipelineOffset =
			selectedPipelineId === null
				? resolvePipelineOffset(pipeline, pipelineYOffsets)
				: { x: 0, y: 0 };

		// In All-Pipelines view a pipeline moves as ONE unit by dragging its group
		// card. Content nodes paint on top of that card, so without this a drag is
		// only grabbable on the card's empty margins - and dense/small cards (a
		// two-node pipeline like "BJJ Sensei") have almost none, making them feel
		// un-draggable. Give content nodes `pointer-events: none` so a drag
		// anywhere on the pipeline (including over its nodes) falls through to the
		// draggable group card beneath (zIndex -1) and moves the whole pipeline.
		// ReactFlow spreads a node's `style` AFTER its own computed `pointerEvents`
		// on the wrapper, so this reliably wins. Also opt them out of selection/drag
		// so a stray pointer can't pick up a single node in a view that can't edit
		// one anyway.
		const contentNodeExtras =
			selectedPipelineId === null
				? {
						selectable: false,
						draggable: false,
						style: { pointerEvents: 'none' as const },
					}
				: {};

		for (const pNode of pipeline.nodes) {
			const compositeId = `${pipeline.id}:${pNode.id}`;

			if (pNode.type === 'trigger') {
				const triggerData = pNode.data as TriggerNodeData;
				const fanOutCount = pipeline.edges.filter((e) => e.source === pNode.id).length;

				// Per-trigger running state: a trigger node only shows the
				// spinner when its OWN subscription has an active run. In a
				// multi-trigger pipeline (e.g. startup + scheduled + GitHub PR
				// all under "Pipeline 1") this prevents every trigger icon from
				// spinning just because one sub fired.
				//
				// Fallback: when the trigger has no `subscriptionName` (legacy
				// never-saved pipelines), fall back to the pipeline-wide flag
				// so the spinner still surfaces something rather than going
				// silent entirely.
				const runningSubs = triggerOptions?.runningSubscriptionsByPipeline?.get(pipeline.id);
				const isRunning = triggerData.subscriptionName
					? !!runningSubs?.has(triggerData.subscriptionName)
					: (triggerOptions?.runningPipelineIds?.has(pipeline.id) ?? false);

				const nodeData: TriggerNodeDataProps = {
					compositeId,
					eventType: triggerData.eventType,
					label: triggerData.customLabel || triggerData.label,
					configSummary: getTriggerConfigSummary(triggerData),
					onConfigure: onConfigureNode,
					onTriggerPipeline: triggerOptions?.onTriggerPipeline,
					pipelineName: pipeline.name,
					// Thread the trigger's owning subscription name through to the
					// Play button. Populated by yamlToPipeline on load; absent on
					// never-saved pipelines (Play button is hidden in that case).
					subscriptionName: triggerData.subscriptionName,
					isSaved: triggerOptions?.isSaved,
					isRunning,
					fanOutCount: fanOutCount > 1 ? fanOutCount : undefined,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'trigger',
					position: {
						x: pNode.position.x + pipelineOffset.x,
						y: pNode.position.y + pipelineOffset.y,
					},
					data: nodeData,
					dragHandle: '.drag-handle',
					...contentNodeExtras,
				});
			} else if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				const pipelineColors = agentPipelineMap.get(agentData.sessionId) ?? [pipeline.color];
				const hasOutgoingEdge = pipeline.edges.some((e) => e.source === pNode.id);
				const hasEdgePrompt = pipeline.edges.some((e) => e.target === pNode.id && !!e.prompt);
				// Compute instance index for duplicate agent differentiation
				const totalInstances = agentSessionCounts.get(agentData.sessionId) ?? 1;
				const currentIdx = (agentSessionIndex.get(agentData.sessionId) ?? 0) + 1;
				agentSessionIndex.set(agentData.sessionId, currentIdx);
				const instanceLabel = totalInstances > 1 ? currentIdx : undefined;
				// Compute fan-in count: incoming edges from other agent nodes
				const incomingAgentEdgeCount = pipeline.edges.filter((e) => {
					if (e.target !== pNode.id) return false;
					const srcNode = pipeline.nodes.find((n) => n.id === e.source);
					return srcNode?.type === 'agent';
				}).length;
				const runningAgentsForPipeline = triggerOptions?.runningAgentsByPipeline?.get(pipeline.id);
				const isAgentRunning = !!runningAgentsForPipeline?.has(agentData.sessionName);
				const nodeData: AgentNodeDataProps = {
					compositeId,
					sessionId: agentData.sessionId,
					sessionName: agentData.sessionName,
					toolType: agentData.toolType,
					instanceLabel,
					fanInCount: incomingAgentEdgeCount > 1 ? incomingAgentEdgeCount : undefined,
					hasPrompt: !!(agentData.inputPrompt || agentData.outputPrompt || hasEdgePrompt),
					hasOutgoingEdge,
					pipelineColor: pipeline.color,
					pipelineCount: agentPipelineCount.get(agentData.sessionId) ?? 1,
					pipelineColors,
					onConfigure: onConfigureNode,
					isRunning: isAgentRunning,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'agent',
					position: {
						x: pNode.position.x + pipelineOffset.x,
						y: pNode.position.y + pipelineOffset.y,
					},
					data: nodeData,
					dragHandle: '.drag-handle',
					...contentNodeExtras,
				});
			} else if (pNode.type === 'command') {
				const cmdData = pNode.data as CommandNodeData;
				const nodeData: CommandNodeDataProps = {
					compositeId,
					name: cmdData.name,
					mode: cmdData.mode,
					summary: summarizeCommandNode(cmdData),
					owningSessionName: cmdData.owningSessionName,
					pipelineColor: pipeline.color,
					pipelineCount: 1,
					pipelineColors: [pipeline.color],
					onConfigure: onConfigureNode,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'command',
					position: {
						x: pNode.position.x + pipelineOffset.x,
						y: pNode.position.y + pipelineOffset.y,
					},
					data: nodeData,
					dragHandle: '.drag-handle',
					...contentNodeExtras,
				});
			} else if (pNode.type === 'error') {
				const errData = pNode.data as ErrorNodeData;
				const nodeData: ErrorNodeDataProps = {
					compositeId,
					message: errData.message,
					unresolvedId: errData.unresolvedId,
					unresolvedName: errData.unresolvedName,
					subscriptionName: errData.subscriptionName,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'error',
					position: {
						x: pNode.position.x + pipelineOffset.x,
						y: pNode.position.y + pipelineOffset.y,
					},
					data: nodeData,
					dragHandle: '.drag-handle',
					selectable: false,
					...contentNodeExtras,
				});
			}
		}
	}

	return nodes;
}

// ─── Edge conversion ─────────────────────────────────────────────────────────

/**
 * Converts the internal pipeline state into React Flow edge objects.
 *
 * Edges from non-active pipelines are rendered with `isActivePipeline: false`
 * so the PipelineEdge component can dim them appropriately.
 *
 * Edge animation rule: an edge is flagged `isRunning` iff its TARGET is an
 * agent node whose `sessionName` appears in this pipeline's active-agents
 * set (`runningAgentsByPipeline`). This makes only the edges feeding into
 * the currently-executing agent(s) animate - rather than every edge in a
 * pipeline where any run is active. Works identically for linear chains
 * (one target per hop), fan-out (multiple targets concurrently), and
 * fan-in (multiple incoming edges to one running target).
 *
 * Non-agent targets (cli_output, error nodes) never animate - they don't
 * correspond to a dispatchable run.
 *
 * Optimistic-trigger override: when a pipeline appears in
 * `optimisticTriggeredPipelineIds`, every edge in that pipeline is flagged
 * `isRunning` for the brief optimistic window after a manual Play click. This
 * gives instant "your click registered" feedback even before any agent has
 * spun up - useful for sub-second shell-only triggers that would otherwise
 * complete before the per-agent rule could light anything up.
 */
export function convertToReactFlowEdges(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null,
	selectedEdgeId?: string | null,
	theme?: Theme,
	runningAgentsByPipeline?: Map<string, Set<string>>,
	optimisticTriggeredPipelineIds?: Set<string>
): Edge[] {
	const edges: Edge[] = [];

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		// Skip non-active pipelines entirely - their nodes are not rendered by
		// convertToReactFlowNodes, so edges referencing them would be orphaned.
		// React Flow may cache the "invalid" state of orphaned edges internally,
		// causing them to not re-appear when switching back to All Pipelines view.
		if (!isActive) continue;

		const runningAgents = runningAgentsByPipeline?.get(pipeline.id);
		const isOptimisticallyTriggered = !!optimisticTriggeredPipelineIds?.has(pipeline.id);
		// Build node lookup once per pipeline so the per-edge target lookup is O(1).
		const nodeById = new Map<string, (typeof pipeline.nodes)[number]>();
		for (const n of pipeline.nodes) nodeById.set(n.id, n);

		for (const pEdge of pipeline.edges) {
			const compositeId = `${pipeline.id}:${pEdge.id}`;
			const targetNode = nodeById.get(pEdge.target);
			const targetSessionName =
				targetNode?.type === 'agent' ? (targetNode.data as AgentNodeData).sessionName : undefined;
			const isRunning =
				isOptimisticallyTriggered ||
				(!!targetSessionName && !!runningAgents && runningAgents.has(targetSessionName));

			const edgeData: PipelineEdgeData = {
				pipelineColor: pipeline.color,
				mode: pEdge.mode,
				isActivePipeline: isActive,
				isRunning,
				theme,
			};
			edges.push({
				id: compositeId,
				source: `${pipeline.id}:${pEdge.source}`,
				target: `${pipeline.id}:${pEdge.target}`,
				type: 'pipeline',
				data: edgeData,
				selected: compositeId === selectedEdgeId,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					color: pipeline.color,
					width: selectedEdgeId === compositeId ? 18 : 16,
					height: selectedEdgeId === compositeId ? 18 : 16,
				},
			});
		}
	}

	return edges;
}
