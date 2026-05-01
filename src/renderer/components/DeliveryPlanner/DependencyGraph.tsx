import { memo, useMemo } from 'react';
import type React from 'react';
import ReactFlow, {
	Background,
	Controls,
	MiniMap,
	MarkerType,
	type Edge,
	type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { Theme, WorkItem } from '../../types';
import { WORK_GRAPH_READY_TAG } from '../../types';
import { applyHierarchicalLayout } from '../DocumentGraph/layoutAlgorithms';

interface DependencyGraphProps {
	items: WorkItem[];
	theme: Theme;
}

interface PlannerNodeData {
	label: string;
	status: WorkItem['status'];
	ready: boolean;
	blocked: boolean;
}

function isOpen(item: WorkItem): boolean {
	return !['done', 'canceled'].includes(item.status);
}

function isBlockingDependencyBlocked(item: WorkItem, itemById: Map<string, WorkItem>): boolean {
	return (item.dependencies ?? []).some((dependency) => {
		if (dependency.type !== 'blocks' || dependency.status !== 'active') return false;
		if (dependency.fromWorkItemId !== item.id) return false;
		const blocker = itemById.get(dependency.toWorkItemId);
		return !blocker || isOpen(blocker);
	});
}

function nodeStyle(theme: Theme, data: PlannerNodeData): React.CSSProperties {
	const borderColor = data.ready
		? theme.colors.success
		: data.blocked
			? theme.colors.error
			: theme.colors.border;

	return {
		width: 220,
		padding: 10,
		borderRadius: 8,
		border: `1px solid ${borderColor}`,
		background: data.blocked ? `${theme.colors.error}12` : theme.colors.bgSidebar,
		color: theme.colors.textMain,
		boxShadow: data.ready ? `0 0 0 1px ${theme.colors.success}33` : undefined,
	};
}

export const DependencyGraph = memo(function DependencyGraph({
	items,
	theme,
}: DependencyGraphProps) {
	const { nodes, edges } = useMemo(() => {
		const visibleItems = items.slice(0, 80);
		const itemById = new Map(items.map((item) => [item.id, item]));
		const visibleIds = new Set(visibleItems.map((item) => item.id));

		const rawNodes: Node<PlannerNodeData>[] = visibleItems.map((item, index) => {
			const blocked = item.status === 'blocked' || isBlockingDependencyBlocked(item, itemById);
			const ready = item.tags.includes(WORK_GRAPH_READY_TAG);

			return {
				id: item.id,
				type: 'default',
				position: { x: (index % 4) * 260, y: Math.floor(index / 4) * 130 },
				data: {
					label: item.title,
					status: item.status,
					ready,
					blocked,
				},
				style: nodeStyle(theme, { label: item.title, status: item.status, ready, blocked }),
			};
		});

		const rawEdges: Edge[] = [];
		for (const item of visibleItems) {
			for (const dependency of item.dependencies ?? []) {
				if (
					dependency.status !== 'active' ||
					dependency.type !== 'blocks' ||
					!visibleIds.has(dependency.fromWorkItemId) ||
					!visibleIds.has(dependency.toWorkItemId)
				) {
					continue;
				}

				rawEdges.push({
					id: dependency.id,
					source: dependency.toWorkItemId,
					target: dependency.fromWorkItemId,
					animated: itemById.get(dependency.fromWorkItemId)?.status === 'blocked',
					markerEnd: { type: MarkerType.ArrowClosed },
					style: { stroke: theme.colors.warning, strokeWidth: 1.5 },
				});
			}
		}

		return {
			nodes: applyHierarchicalLayout(rawNodes as Node<any>[], rawEdges, {
				rankDirection: 'LR',
				nodeWidth: 220,
				nodeHeight: 90,
				nodeSeparation: 70,
				rankSeparation: 120,
			}) as unknown as Node<PlannerNodeData>[],
			edges: rawEdges,
		};
	}, [items, theme]);

	if (items.length === 0) {
		return (
			<div
				className="h-48 rounded border flex items-center justify-center text-xs"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				No dependencies to display.
			</div>
		);
	}

	return (
		<div
			className="h-80 rounded border overflow-hidden"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				fitView
				minZoom={0.25}
				maxZoom={1.5}
				nodesDraggable={false}
			>
				<Background color={theme.colors.border} gap={18} size={1} />
				<MiniMap
					nodeColor={(node) => {
						const data = node.data as PlannerNodeData;
						if (data.ready) return theme.colors.success;
						if (data.blocked) return theme.colors.error;
						return theme.colors.accent;
					}}
					style={{ backgroundColor: theme.colors.bgSidebar }}
				/>
				<Controls showInteractive={false} />
			</ReactFlow>
		</div>
	);
});
