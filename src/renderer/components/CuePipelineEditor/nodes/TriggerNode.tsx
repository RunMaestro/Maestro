import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import {
	Clock,
	FileText,
	GitPullRequest,
	GitBranch,
	CheckSquare,
	Zap,
	GripVertical,
	Settings,
} from 'lucide-react';
import type { CueEventType } from '../../../../shared/cue-pipeline-types';

export interface TriggerNodeDataProps {
	compositeId: string;
	eventType: CueEventType;
	label: string;
	configSummary: string;
	onConfigure?: (compositeId: string) => void;
}

const EVENT_COLORS: Record<CueEventType, string> = {
	'time.heartbeat': '#f59e0b',
	'time.scheduled': '#8b5cf6',
	'file.changed': '#3b82f6',
	'agent.completed': '#22c55e',
	'github.pull_request': '#a855f7',
	'github.issue': '#f97316',
	'task.pending': '#06b6d4',
};

const EVENT_ICONS: Record<CueEventType, typeof Clock> = {
	'time.heartbeat': Clock,
	'time.scheduled': Clock,
	'file.changed': FileText,
	'agent.completed': Zap,
	'github.pull_request': GitPullRequest,
	'github.issue': GitBranch,
	'task.pending': CheckSquare,
};

export const TriggerNode = memo(function TriggerNode({
	data,
	selected,
}: NodeProps<TriggerNodeDataProps>) {
	const color = EVENT_COLORS[data.eventType] ?? '#06b6d4';
	const Icon = EVENT_ICONS[data.eventType] ?? Zap;

	return (
		<div
			style={{
				width: 220,
				height: 60,
				borderRadius: 9999,
				backgroundColor: `${color}18`,
				border: `2px solid ${selected ? color : `${color}60`}`,
				boxShadow: selected ? `0 0 12px ${color}40` : undefined,
				animation: selected ? 'pipeline-node-pulse 2s ease-in-out infinite' : undefined,
				['--node-color-40' as string]: `${color}40`,
				['--node-color-60' as string]: `${color}60`,
				['--node-color-30' as string]: `${color}30`,
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'stretch',
				overflow: 'hidden',
				cursor: 'default',
				transition: 'border-color 0.15s, box-shadow 0.15s',
			}}
		>
			{/* Drag handle */}
			<div
				className="drag-handle"
				style={{
					width: 32,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'grab',
					color: '#555',
					flexShrink: 0,
					backgroundColor: color,
					borderRadius: '9999px 0 0 9999px',
					transition: 'color 0.15s, filter 0.15s',
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.color = '#fff';
					e.currentTarget.style.filter = 'brightness(1.3)';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.color = '#555';
					e.currentTarget.style.filter = 'brightness(1)';
				}}
				title="Drag to move"
			>
				<GripVertical size={16} />
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					overflow: 'hidden',
					padding: '0 4px',
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
					}}
				>
					<Icon size={14} style={{ color, flexShrink: 0 }} />
					<span
						style={{
							color,
							fontSize: 12,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							maxWidth: 110,
						}}
					>
						{data.label}
					</span>
				</div>
				{data.configSummary && (
					<span
						style={{
							color: '#9ca3af',
							fontSize: 10,
							marginTop: 2,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							maxWidth: 130,
						}}
					>
						{data.configSummary}
					</span>
				)}
			</div>

			{/* Gear icon - placed before connector to avoid overlap */}
			<div
				onClick={(e) => {
					e.stopPropagation();
					data.onConfigure?.(data.compositeId);
				}}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'pointer',
					color: selected ? color : `${color}60`,
					flexShrink: 0,
					padding: '4px 4px',
					marginRight: 14,
					borderRadius: 4,
					transition: 'color 0.15s',
				}}
				onMouseEnter={(e) => (e.currentTarget.style.color = color)}
				onMouseLeave={(e) => (e.currentTarget.style.color = selected ? color : `${color}60`)}
				title="Configure"
			>
				<Settings size={14} />
			</div>

			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: color,
					border: '3px solid #1e1e2e',
					boxShadow: `0 0 0 2px ${color}`,
					width: 16,
					height: 16,
					zIndex: 10,
					right: -8,
				}}
			/>
		</div>
	);
});
