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
	eventType: CueEventType;
	label: string;
	configSummary: string;
	onConfigure?: () => void;
}

const EVENT_COLORS: Record<CueEventType, string> = {
	'time.interval': '#f59e0b',
	'file.changed': '#3b82f6',
	'agent.completed': '#22c55e',
	'github.pull_request': '#a855f7',
	'github.issue': '#f97316',
	'task.pending': '#06b6d4',
};

const EVENT_ICONS: Record<CueEventType, typeof Clock> = {
	'time.interval': Clock,
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
				width: 200,
				height: 60,
				borderRadius: 9999,
				backgroundColor: `${color}18`,
				border: `2px solid ${selected ? color : `${color}60`}`,
				boxShadow: selected ? `0 0 12px ${color}40` : undefined,
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'center',
				padding: '0 6px',
				cursor: 'grab',
				transition: 'border-color 0.15s, box-shadow 0.15s',
			}}
		>
			{/* Drag handle */}
			<div
				className="drag-handle"
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'grab',
					color: `${color}80`,
					flexShrink: 0,
					padding: '4px 6px',
					borderRadius: 4,
				}}
				title="Drag to move"
			>
				<GripVertical size={14} />
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
					data.onConfigure?.();
				}}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'pointer',
					color: selected ? color : `${color}60`,
					flexShrink: 0,
					padding: '4px 4px',
					marginRight: 6,
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
