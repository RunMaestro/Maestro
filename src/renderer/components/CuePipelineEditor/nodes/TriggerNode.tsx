import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Clock, FileText, GitPullRequest, GitBranch, CheckSquare, Zap } from 'lucide-react';
import type { CueEventType } from '../../../../shared/cue-pipeline-types';

export interface TriggerNodeDataProps {
	eventType: CueEventType;
	label: string;
	configSummary: string;
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
				width: 180,
				height: 60,
				borderRadius: 9999,
				backgroundColor: `${color}18`,
				border: `2px solid ${selected ? color : `${color}60`}`,
				boxShadow: selected ? `0 0 12px ${color}40` : undefined,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '0 16px',
				cursor: 'pointer',
				transition: 'border-color 0.15s, box-shadow 0.15s',
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
						maxWidth: 130,
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
						maxWidth: 150,
					}}
				>
					{data.configSummary}
				</span>
			)}
			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: color,
					borderColor: `${color}60`,
					width: 8,
					height: 8,
				}}
			/>
		</div>
	);
});
