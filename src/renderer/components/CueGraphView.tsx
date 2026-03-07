/**
 * CueGraphView — Canvas-based visualization of Maestro Cue subscription graph.
 *
 * Shows how triggers (events) connect to agents, and how agents chain to other agents
 * via agent.completed subscriptions. Follows the same canvas-based rendering approach
 * as the Document Graph MindMap for visual consistency.
 *
 * Features:
 * - Trigger nodes (event sources) on the left
 * - Agent nodes in the center/right
 * - Edges showing subscription connections with labels
 * - Pan/zoom with mouse
 * - Double-click an agent node to switch focus and close the modal
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceCenter,
	forceCollide,
	forceX,
	forceY,
	type SimulationNodeDatum,
	type SimulationLinkDatum,
} from 'd3-force';
import { RefreshCw } from 'lucide-react';
import type { Theme } from '../types';
import { useSessionStore } from '../stores/sessionStore';

// ============================================================================
// Types
// ============================================================================

interface CueGraphViewProps {
	theme: Theme;
	onClose: () => void;
}

type GraphNodeType = 'agent' | 'trigger';

interface GraphNode extends SimulationNodeDatum {
	id: string;
	type: GraphNodeType;
	label: string;
	sublabel: string;
	sessionId?: string;
	toolType?: string;
	subscriptionCount?: number;
	eventType?: string;
	width: number;
	height: number;
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
	id: string;
	label: string;
	sourceId: string;
	targetId: string;
}

// ============================================================================
// Constants
// ============================================================================

const CUE_TEAL = '#06b6d4';

const AGENT_NODE_WIDTH = 180;
const AGENT_NODE_HEIGHT = 56;
const TRIGGER_NODE_WIDTH = 160;
const TRIGGER_NODE_HEIGHT = 44;
const NODE_BORDER_RADIUS = 10;

const EVENT_COLORS: Record<string, string> = {
	'time.interval': '#f59e0b',
	'file.changed': '#3b82f6',
	'agent.completed': '#22c55e',
	'github.pull_request': '#a855f7',
	'github.issue': '#f97316',
	'task.pending': CUE_TEAL,
};

const EVENT_LABELS: Record<string, string> = {
	'time.interval': 'Timer',
	'file.changed': 'File Watch',
	'agent.completed': 'Agent Done',
	'github.pull_request': 'GitHub PR',
	'github.issue': 'GitHub Issue',
	'task.pending': 'Task Queue',
};

// ============================================================================
// Graph Data Builder
// ============================================================================

interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

function buildGraphData(
	graphSessions: Array<{
		sessionId: string;
		sessionName: string;
		toolType: string;
		subscriptions: Array<{
			name: string;
			event: string;
			enabled: boolean;
			source_session?: string | string[];
			fan_out?: string[];
			watch?: string;
			interval_minutes?: number;
			repo?: string;
			poll_minutes?: number;
		}>;
	}>,
	allSessions: Array<{ id: string; name: string; toolType: string }>
): GraphData {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const nodeIds = new Set<string>();
	const triggerKeys = new Map<string, string>(); // composite key → node id

	// Add agent nodes for all Cue-enabled sessions
	for (const gs of graphSessions) {
		const nodeId = `agent:${gs.sessionId}`;
		if (!nodeIds.has(nodeId)) {
			nodes.push({
				id: nodeId,
				type: 'agent',
				label: gs.sessionName,
				sublabel: gs.toolType,
				sessionId: gs.sessionId,
				toolType: gs.toolType,
				subscriptionCount: gs.subscriptions.filter((s) => s.enabled !== false).length,
				width: AGENT_NODE_WIDTH,
				height: AGENT_NODE_HEIGHT,
			});
			nodeIds.add(nodeId);
		}
	}

	// Helper to ensure an agent node exists (for referenced agents not in graph sessions)
	function ensureAgentNode(sessionName: string) {
		// Try to find by name in graphSessions first
		const gs = graphSessions.find((s) => s.sessionName === sessionName);
		if (gs) return `agent:${gs.sessionId}`;

		// Try to find in all sessions
		const session = allSessions.find((s) => s.name === sessionName);
		const nodeId = session ? `agent:${session.id}` : `agent:ref:${sessionName}`;

		if (!nodeIds.has(nodeId)) {
			nodes.push({
				id: nodeId,
				type: 'agent',
				label: sessionName,
				sublabel: session?.toolType ?? 'unknown',
				sessionId: session?.id,
				toolType: session?.toolType,
				width: AGENT_NODE_WIDTH,
				height: AGENT_NODE_HEIGHT,
			});
			nodeIds.add(nodeId);
		}
		return nodeId;
	}

	// Process subscriptions
	for (const gs of graphSessions) {
		const agentNodeId = `agent:${gs.sessionId}`;

		for (const sub of gs.subscriptions) {
			if (sub.enabled === false) continue;

			if (sub.event === 'agent.completed') {
				// Agent → Agent connection
				const sources = Array.isArray(sub.source_session)
					? sub.source_session
					: sub.source_session
						? [sub.source_session]
						: [];

				for (const sourceName of sources) {
					const sourceNodeId = ensureAgentNode(sourceName);
					edges.push({
						id: `edge:${sourceNodeId}→${agentNodeId}:${sub.name}`,
						source: sourceNodeId,
						target: agentNodeId,
						sourceId: sourceNodeId,
						targetId: agentNodeId,
						label: sub.name,
					});
				}

				// Also handle fan_out targets
				if (sub.fan_out) {
					for (const targetName of sub.fan_out) {
						const targetNodeId = ensureAgentNode(targetName);
						edges.push({
							id: `edge:${agentNodeId}→${targetNodeId}:${sub.name}:fanout`,
							source: agentNodeId,
							target: targetNodeId,
							sourceId: agentNodeId,
							targetId: targetNodeId,
							label: `${sub.name} (fan-out)`,
						});
					}
				}
			} else {
				// Trigger → Agent connection
				const triggerDetail = getTriggerDetail(sub);
				const triggerKey = `${sub.event}:${triggerDetail}`;

				let triggerNodeId = triggerKeys.get(triggerKey);
				if (!triggerNodeId) {
					triggerNodeId = `trigger:${triggerKey}`;
					triggerKeys.set(triggerKey, triggerNodeId);

					nodes.push({
						id: triggerNodeId,
						type: 'trigger',
						label: EVENT_LABELS[sub.event] ?? sub.event,
						sublabel: triggerDetail,
						eventType: sub.event,
						width: TRIGGER_NODE_WIDTH,
						height: TRIGGER_NODE_HEIGHT,
					});
					nodeIds.add(triggerNodeId);
				}

				// Edge from trigger to this agent
				edges.push({
					id: `edge:${triggerNodeId}→${agentNodeId}:${sub.name}`,
					source: triggerNodeId,
					target: agentNodeId,
					sourceId: triggerNodeId,
					targetId: agentNodeId,
					label: sub.name,
				});

				// Handle fan_out for non-agent.completed events
				if (sub.fan_out) {
					for (const targetName of sub.fan_out) {
						const targetNodeId = ensureAgentNode(targetName);
						edges.push({
							id: `edge:${triggerNodeId}→${targetNodeId}:${sub.name}:fanout`,
							source: triggerNodeId,
							target: targetNodeId,
							sourceId: triggerNodeId,
							targetId: targetNodeId,
							label: `${sub.name} (fan-out)`,
						});
					}
				}
			}
		}
	}

	return { nodes, edges };
}

function getTriggerDetail(sub: {
	event: string;
	watch?: string;
	interval_minutes?: number;
	repo?: string;
	poll_minutes?: number;
}): string {
	switch (sub.event) {
		case 'time.interval':
			return sub.interval_minutes ? `${sub.interval_minutes}m` : 'interval';
		case 'file.changed':
			return sub.watch ?? '**/*';
		case 'github.pull_request':
		case 'github.issue':
			return sub.repo ?? 'repo';
		case 'task.pending':
			return sub.watch ?? 'tasks';
		default:
			return sub.event;
	}
}

// ============================================================================
// Layout (d3-force)
// ============================================================================

function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): void {
	if (nodes.length === 0) return;

	// Seed initial positions: triggers left, agents right
	for (const node of nodes) {
		if (node.type === 'trigger') {
			node.x = width * 0.25 + (Math.random() - 0.5) * 100;
			node.y = height * 0.5 + (Math.random() - 0.5) * 200;
		} else {
			node.x = width * 0.7 + (Math.random() - 0.5) * 100;
			node.y = height * 0.5 + (Math.random() - 0.5) * 200;
		}
	}

	const simulation = forceSimulation(nodes)
		.force(
			'link',
			forceLink<GraphNode, GraphEdge>(edges)
				.id((d) => d.id)
				.distance(200)
				.strength(0.5)
		)
		.force('charge', forceManyBody().strength(-400))
		.force('center', forceCenter(width / 2, height / 2))
		.force(
			'collide',
			forceCollide<GraphNode>().radius((d) => Math.max(d.width, d.height) * 0.7)
		)
		.force(
			'x',
			forceX<GraphNode>()
				.x((d) => (d.type === 'trigger' ? width * 0.25 : width * 0.7))
				.strength(0.15)
		)
		.force('y', forceY(height / 2).strength(0.05))
		.stop();

	// Run simulation synchronously
	const iterations = 200;
	for (let i = 0; i < iterations; i++) {
		simulation.tick();
	}
}

// ============================================================================
// Canvas Rendering
// ============================================================================

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number
): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let truncated = text;
	while (truncated.length > 0 && ctx.measureText(truncated + '...').width > maxWidth) {
		truncated = truncated.slice(0, -1);
	}
	return truncated + '...';
}

function drawArrowhead(
	ctx: CanvasRenderingContext2D,
	toX: number,
	toY: number,
	angle: number,
	size: number,
	color: string
): void {
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(toX, toY);
	ctx.lineTo(
		toX - size * Math.cos(angle - Math.PI / 6),
		toY - size * Math.sin(angle - Math.PI / 6)
	);
	ctx.lineTo(
		toX - size * Math.cos(angle + Math.PI / 6),
		toY - size * Math.sin(angle + Math.PI / 6)
	);
	ctx.closePath();
	ctx.fill();
}

function renderGraph(
	ctx: CanvasRenderingContext2D,
	nodes: GraphNode[],
	edges: GraphEdge[],
	theme: Theme,
	transform: { zoom: number; panX: number; panY: number },
	hoveredNodeId: string | null,
	selectedNodeId: string | null,
	canvasWidth: number,
	canvasHeight: number
): void {
	const dpr = window.devicePixelRatio || 1;

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, canvasWidth, canvasHeight);

	// Apply transform
	ctx.save();
	ctx.translate(transform.panX, transform.panY);
	ctx.scale(transform.zoom, transform.zoom);

	// Draw edges
	for (const edge of edges) {
		const source = edge.source as GraphNode;
		const target = edge.target as GraphNode;
		if (!source.x || !source.y || !target.x || !target.y) continue;

		const sx = source.x + source.width / 2;
		const sy = source.y;
		const tx = target.x - target.width / 2;
		const ty = target.y;

		// Determine edge color based on source type
		const edgeColor =
			source.type === 'trigger'
				? (EVENT_COLORS[source.eventType ?? ''] ?? theme.colors.textDim)
				: '#22c55e';

		ctx.strokeStyle = edgeColor + '80';
		ctx.lineWidth = 2;
		ctx.setLineDash([]);

		// Bezier curve
		const dx = Math.abs(tx - sx);
		const controlOffset = Math.min(dx * 0.4, 120);

		ctx.beginPath();
		ctx.moveTo(sx, sy);
		ctx.bezierCurveTo(sx + controlOffset, sy, tx - controlOffset, ty, tx, ty);
		ctx.stroke();

		// Arrowhead
		const angle = Math.atan2(ty - (ty - 0), tx - (tx - controlOffset));
		drawArrowhead(ctx, tx, ty, angle, 8, edgeColor + 'cc');

		// Edge label
		const midX = (sx + tx) / 2;
		const midY = (sy + ty) / 2 - 8;
		ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
		ctx.fillStyle = theme.colors.textDim;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		const labelText = truncateText(ctx, edge.label, 120);
		ctx.fillText(labelText, midX, midY);
	}

	// Draw nodes
	for (const node of nodes) {
		if (node.x === undefined || node.y === undefined) continue;

		const nx = node.x - node.width / 2;
		const ny = node.y - node.height / 2;
		const isHovered = hoveredNodeId === node.id;
		const isSelected = selectedNodeId === node.id;

		if (node.type === 'trigger') {
			// Trigger node - pill shape with event color
			const color = EVENT_COLORS[node.eventType ?? ''] ?? CUE_TEAL;

			roundRect(ctx, nx, ny, node.width, node.height, NODE_BORDER_RADIUS);
			ctx.fillStyle = color + '18';
			ctx.fill();
			ctx.strokeStyle = isHovered || isSelected ? color : color + '60';
			ctx.lineWidth = isHovered || isSelected ? 2 : 1;
			ctx.stroke();

			// Event type label
			ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = color;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(node.label, node.x, node.y - 7);

			// Detail
			ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = theme.colors.textDim;
			const detailText = truncateText(ctx, node.sublabel, node.width - 20);
			ctx.fillText(detailText, node.x, node.y + 8);
		} else {
			// Agent node - card style
			const isAgentCompleted = edges.some(
				(e) => (e.source as GraphNode).type === 'agent' && (e.target as GraphNode).id === node.id
			);
			const accentColor = isAgentCompleted ? '#22c55e' : CUE_TEAL;

			// Background
			roundRect(ctx, nx, ny, node.width, node.height, NODE_BORDER_RADIUS);
			ctx.fillStyle = theme.colors.bgActivity;
			ctx.fill();

			// Border
			ctx.strokeStyle = isHovered || isSelected ? accentColor : theme.colors.border;
			ctx.lineWidth = isHovered || isSelected ? 2 : 1;
			ctx.stroke();

			// Accent bar at top
			ctx.save();
			ctx.beginPath();
			ctx.moveTo(nx + NODE_BORDER_RADIUS, ny);
			ctx.lineTo(nx + node.width - NODE_BORDER_RADIUS, ny);
			ctx.quadraticCurveTo(nx + node.width, ny, nx + node.width, ny + NODE_BORDER_RADIUS);
			ctx.lineTo(nx + node.width, ny + 4);
			ctx.lineTo(nx, ny + 4);
			ctx.lineTo(nx, ny + NODE_BORDER_RADIUS);
			ctx.quadraticCurveTo(nx, ny, nx + NODE_BORDER_RADIUS, ny);
			ctx.closePath();
			ctx.fillStyle = accentColor;
			ctx.fill();
			ctx.restore();

			// Agent name
			ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = theme.colors.textMain;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			const nameText = truncateText(ctx, node.label, node.width - 20);
			ctx.fillText(nameText, node.x, node.y - 4);

			// Tool type
			ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = theme.colors.textDim;
			ctx.fillText(node.sublabel, node.x, node.y + 12);

			// Subscription count badge
			if (node.subscriptionCount && node.subscriptionCount > 0) {
				const badgeText = `${node.subscriptionCount}`;
				ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
				const badgeWidth = Math.max(ctx.measureText(badgeText).width + 8, 18);
				const badgeX = nx + node.width - badgeWidth - 6;
				const badgeY = ny + node.height - 16;

				roundRect(ctx, badgeX, badgeY, badgeWidth, 14, 7);
				ctx.fillStyle = accentColor;
				ctx.fill();

				ctx.fillStyle = '#fff';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(badgeText, badgeX + badgeWidth / 2, badgeY + 7);
			}
		}
	}

	ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

function hitTest(
	nodes: GraphNode[],
	x: number,
	y: number,
	transform: { zoom: number; panX: number; panY: number }
): GraphNode | null {
	// Convert screen coords to graph coords
	const gx = (x - transform.panX) / transform.zoom;
	const gy = (y - transform.panY) / transform.zoom;

	// Check nodes in reverse order (top-most first)
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		if (node.x === undefined || node.y === undefined) continue;

		const nx = node.x - node.width / 2;
		const ny = node.y - node.height / 2;

		if (gx >= nx && gx <= nx + node.width && gy >= ny && gy <= ny + node.height) {
			return node;
		}
	}

	return null;
}

// ============================================================================
// Component
// ============================================================================

export function CueGraphView({ theme, onClose }: CueGraphViewProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [graphData, setGraphData] = useState<GraphData | null>(null);
	const [loading, setLoading] = useState(true);
	const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

	const transformRef = useRef({ zoom: 1, panX: 0, panY: 0 });
	const isDraggingRef = useRef(false);
	const lastMouseRef = useRef({ x: 0, y: 0 });
	const rafRef = useRef<number>(0);

	const sessions = useSessionStore((state) => state.sessions);
	const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);

	// Fetch graph data
	const fetchGraphData = useCallback(async () => {
		setLoading(true);
		try {
			const data = await window.maestro.cue.getGraphData();
			const allSessionsSimple = sessions.map((s) => ({
				id: s.id,
				name: s.name,
				toolType: s.toolType,
			}));
			const graph = buildGraphData(data, allSessionsSimple);
			layoutGraph(graph.nodes, graph.edges, dimensions.width, dimensions.height);
			setGraphData(graph);
		} catch {
			setGraphData({ nodes: [], edges: [] });
		} finally {
			setLoading(false);
		}
	}, [sessions, dimensions.width, dimensions.height]);

	useEffect(() => {
		fetchGraphData();
	}, [fetchGraphData]);

	// Observe container size
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				if (width > 0 && height > 0) {
					setDimensions({ width, height });
				}
			}
		});

		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	// Re-layout when dimensions change (but not on every render)
	useEffect(() => {
		if (graphData && graphData.nodes.length > 0) {
			layoutGraph(graphData.nodes, graphData.edges, dimensions.width, dimensions.height);
			// Center the transform
			transformRef.current = { zoom: 1, panX: 0, panY: 0 };
			requestDraw();
		}
	}, [dimensions.width, dimensions.height, graphData]);

	// Canvas setup and rendering
	const requestDraw = useCallback(() => {
		if (rafRef.current) cancelAnimationFrame(rafRef.current);
		rafRef.current = requestAnimationFrame(() => {
			const canvas = canvasRef.current;
			if (!canvas || !graphData) return;

			const ctx = canvas.getContext('2d');
			if (!ctx) return;

			renderGraph(
				ctx,
				graphData.nodes,
				graphData.edges,
				theme,
				transformRef.current,
				hoveredNodeId,
				selectedNodeId,
				dimensions.width,
				dimensions.height
			);
		});
	}, [graphData, theme, hoveredNodeId, selectedNodeId, dimensions]);

	useEffect(() => {
		requestDraw();
	}, [requestDraw]);

	// Set canvas size with DPR
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = dimensions.width * dpr;
		canvas.height = dimensions.height * dpr;
		canvas.style.width = `${dimensions.width}px`;
		canvas.style.height = `${dimensions.height}px`;
		requestDraw();
	}, [dimensions, requestDraw]);

	// Mouse handlers
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			const rect = canvasRef.current?.getBoundingClientRect();
			if (!rect || !graphData) return;

			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;

			const node = hitTest(graphData.nodes, x, y, transformRef.current);
			if (node) {
				setSelectedNodeId(node.id);
			} else {
				setSelectedNodeId(null);
				isDraggingRef.current = true;
				lastMouseRef.current = { x: e.clientX, y: e.clientY };
			}
		},
		[graphData]
	);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (isDraggingRef.current) {
				const dx = e.clientX - lastMouseRef.current.x;
				const dy = e.clientY - lastMouseRef.current.y;
				transformRef.current.panX += dx;
				transformRef.current.panY += dy;
				lastMouseRef.current = { x: e.clientX, y: e.clientY };
				requestDraw();
				return;
			}

			const rect = canvasRef.current?.getBoundingClientRect();
			if (!rect || !graphData) return;

			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			const node = hitTest(graphData.nodes, x, y, transformRef.current);
			const newHoveredId = node?.id ?? null;
			if (newHoveredId !== hoveredNodeId) {
				setHoveredNodeId(newHoveredId);
			}

			// Cursor style
			if (canvasRef.current) {
				canvasRef.current.style.cursor = node
					? node.type === 'agent'
						? 'pointer'
						: 'default'
					: isDraggingRef.current
						? 'grabbing'
						: 'grab';
			}
		},
		[graphData, hoveredNodeId, requestDraw]
	);

	const handleMouseUp = useCallback(() => {
		isDraggingRef.current = false;
	}, []);

	const handleDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			const rect = canvasRef.current?.getBoundingClientRect();
			if (!rect || !graphData) return;

			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			const node = hitTest(graphData.nodes, x, y, transformRef.current);

			if (node?.type === 'agent' && node.sessionId) {
				setActiveSessionId(node.sessionId);
				onClose();
			}
		},
		[graphData, setActiveSessionId, onClose]
	);

	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			e.preventDefault();
			const rect = canvasRef.current?.getBoundingClientRect();
			if (!rect) return;

			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			const zoomFactor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
			const newZoom = Math.max(0.2, Math.min(3, transformRef.current.zoom * zoomFactor));

			// Zoom toward mouse position
			const scale = newZoom / transformRef.current.zoom;
			transformRef.current.panX = mouseX - scale * (mouseX - transformRef.current.panX);
			transformRef.current.panY = mouseY - scale * (mouseY - transformRef.current.panY);
			transformRef.current.zoom = newZoom;

			requestDraw();
		},
		[requestDraw]
	);

	// Selected node info
	const selectedNode = useMemo(
		() => graphData?.nodes.find((n) => n.id === selectedNodeId) ?? null,
		[graphData, selectedNodeId]
	);

	if (loading) {
		return (
			<div
				className="flex items-center justify-center py-20"
				style={{ color: theme.colors.textDim }}
			>
				<span className="text-sm">Loading Cue graph...</span>
			</div>
		);
	}

	if (!graphData || graphData.nodes.length === 0) {
		return (
			<div
				className="flex flex-col items-center justify-center py-20 gap-3"
				style={{ color: theme.colors.textDim }}
			>
				<span className="text-sm">
					No Cue subscriptions found. Create a maestro-cue.yaml in a project to see the graph.
				</span>
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Toolbar */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-3">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{graphData.nodes.filter((n) => n.type === 'agent').length} agents
						<span className="mx-1.5">·</span>
						{graphData.nodes.filter((n) => n.type === 'trigger').length} triggers
						<span className="mx-1.5">·</span>
						{graphData.edges.length} connections
					</span>
				</div>
				<div className="flex items-center gap-2">
					{selectedNode?.type === 'agent' && selectedNode.sessionId && (
						<button
							onClick={() => {
								if (selectedNode.sessionId) {
									setActiveSessionId(selectedNode.sessionId);
									onClose();
								}
							}}
							className="px-2 py-1 rounded text-xs font-medium transition-opacity hover:opacity-80"
							style={{ color: CUE_TEAL }}
						>
							Switch to {selectedNode.label}
						</button>
					)}
					<button
						onClick={fetchGraphData}
						className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
						title="Refresh graph"
						style={{ color: theme.colors.textDim }}
					>
						<RefreshCw className="w-3.5 h-3.5" />
					</button>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						Double-click agent to switch focus
					</span>
				</div>
			</div>

			{/* Canvas */}
			<div ref={containerRef} className="flex-1 relative overflow-hidden">
				<canvas
					ref={canvasRef}
					onMouseDown={handleMouseDown}
					onMouseMove={handleMouseMove}
					onMouseUp={handleMouseUp}
					onMouseLeave={handleMouseUp}
					onDoubleClick={handleDoubleClick}
					onWheel={handleWheel}
					style={{ display: 'block' }}
				/>
			</div>
		</div>
	);
}
