import { memo } from 'react';
import { Clock, FileText, Zap, GitPullRequest, GitBranch, CheckSquare, X } from 'lucide-react';
import type { CueEventType } from '../../../../shared/cue-pipeline-types';

export interface TriggerDrawerProps {
	isOpen: boolean;
	onClose: () => void;
}

interface TriggerItem {
	eventType: CueEventType;
	label: string;
	icon: typeof Clock;
	color: string;
}

const TRIGGER_ITEMS: TriggerItem[] = [
	{ eventType: 'time.interval', label: 'Scheduled', icon: Clock, color: '#f59e0b' },
	{ eventType: 'file.changed', label: 'File Change', icon: FileText, color: '#3b82f6' },
	{ eventType: 'agent.completed', label: 'Agent Done', icon: Zap, color: '#22c55e' },
	{
		eventType: 'github.pull_request',
		label: 'Pull Request',
		icon: GitPullRequest,
		color: '#a855f7',
	},
	{ eventType: 'github.issue', label: 'Issue', icon: GitBranch, color: '#f97316' },
	{ eventType: 'task.pending', label: 'Pending Task', icon: CheckSquare, color: '#06b6d4' },
];

function handleDragStart(e: React.DragEvent, item: TriggerItem) {
	e.dataTransfer.setData(
		'application/cue-pipeline',
		JSON.stringify({ type: 'trigger', eventType: item.eventType, label: item.label })
	);
	e.dataTransfer.effectAllowed = 'move';
}

export const TriggerDrawer = memo(function TriggerDrawer({ isOpen, onClose }: TriggerDrawerProps) {
	return (
		<div
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				bottom: 0,
				width: 220,
				zIndex: 20,
				backgroundColor: '#1e1e2e',
				borderRight: '1px solid #333',
				transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
				transition: 'transform 200ms ease',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '10px 12px',
					borderBottom: '1px solid #333',
					flexShrink: 0,
				}}
			>
				<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>Triggers</span>
				<button
					onClick={onClose}
					style={{
						background: 'none',
						border: 'none',
						cursor: 'pointer',
						padding: 2,
						display: 'flex',
						alignItems: 'center',
						color: '#9ca3af',
					}}
				>
					<X size={14} />
				</button>
			</div>

			{/* Trigger list */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
				{TRIGGER_ITEMS.map((item) => {
					const Icon = item.icon;
					return (
						<div
							key={item.eventType}
							draggable
							onDragStart={(e) => handleDragStart(e, item)}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								padding: '8px 10px',
								marginBottom: 4,
								borderRadius: 6,
								borderLeft: `3px solid ${item.color}`,
								backgroundColor: '#252535',
								cursor: 'grab',
								transition: 'filter 0.15s',
							}}
							onMouseEnter={(e) => {
								(e.currentTarget as HTMLElement).style.filter = 'brightness(1.2)';
							}}
							onMouseLeave={(e) => {
								(e.currentTarget as HTMLElement).style.filter = 'brightness(1)';
							}}
						>
							<Icon size={14} style={{ color: item.color, flexShrink: 0 }} />
							<span style={{ color: '#e4e4e7', fontSize: 12, fontWeight: 500 }}>{item.label}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
});
