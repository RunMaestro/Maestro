import { memo, useState, useMemo } from 'react';
import {
	Clock,
	FileText,
	Zap,
	GitPullRequest,
	GitBranch,
	CheckSquare,
	Search,
	X,
} from 'lucide-react';
import type { CueEventType } from '../../../../shared/cue-pipeline-types';
import type { Theme } from '../../../types';

export interface TriggerDrawerProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
}

interface TriggerItem {
	eventType: CueEventType;
	label: string;
	description: string;
	icon: typeof Clock;
	color: string;
}

const TRIGGER_ITEMS: TriggerItem[] = [
	{
		eventType: 'time.interval',
		label: 'Scheduled',
		description: 'Run on a timer',
		icon: Clock,
		color: '#f59e0b',
	},
	{
		eventType: 'file.changed',
		label: 'File Change',
		description: 'Watch for file modifications',
		icon: FileText,
		color: '#3b82f6',
	},
	{
		eventType: 'agent.completed',
		label: 'Agent Done',
		description: 'After an agent finishes',
		icon: Zap,
		color: '#22c55e',
	},
	{
		eventType: 'github.pull_request',
		label: 'Pull Request',
		description: 'GitHub PR events',
		icon: GitPullRequest,
		color: '#a855f7',
	},
	{
		eventType: 'github.issue',
		label: 'Issue',
		description: 'GitHub issue events',
		icon: GitBranch,
		color: '#f97316',
	},
	{
		eventType: 'task.pending',
		label: 'Pending Task',
		description: 'Markdown task checkboxes',
		icon: CheckSquare,
		color: '#06b6d4',
	},
];

function handleDragStart(e: React.DragEvent, item: TriggerItem) {
	e.dataTransfer.setData(
		'application/cue-pipeline',
		JSON.stringify({ type: 'trigger', eventType: item.eventType, label: item.label })
	);
	e.dataTransfer.effectAllowed = 'move';
}

export const TriggerDrawer = memo(function TriggerDrawer({
	isOpen,
	onClose,
	theme,
}: TriggerDrawerProps) {
	const [search, setSearch] = useState('');

	const filtered = useMemo(() => {
		if (!search.trim()) return TRIGGER_ITEMS;
		const q = search.toLowerCase();
		return TRIGGER_ITEMS.filter(
			(item) =>
				item.label.toLowerCase().includes(q) ||
				item.eventType.toLowerCase().includes(q) ||
				item.description.toLowerCase().includes(q)
		);
	}, [search]);

	return (
		<div
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				bottom: 0,
				width: 220,
				zIndex: 20,
				backgroundColor: theme.colors.bgMain,
				borderRight: `1px solid ${theme.colors.border}`,
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
					borderBottom: `1px solid ${theme.colors.border}`,
					flexShrink: 0,
				}}
			>
				<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
					Triggers
				</span>
				<button
					onClick={onClose}
					style={{
						background: 'none',
						border: 'none',
						cursor: 'pointer',
						padding: 2,
						display: 'flex',
						alignItems: 'center',
						color: theme.colors.textDim,
					}}
				>
					<X size={14} />
				</button>
			</div>

			{/* Search */}
			<div style={{ padding: '8px 12px 4px', flexShrink: 0 }}>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						backgroundColor: theme.colors.bgActivity,
						borderRadius: 6,
						padding: '4px 8px',
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<Search size={12} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter triggers..."
						style={{
							flex: 1,
							background: 'none',
							border: 'none',
							outline: 'none',
							color: theme.colors.textMain,
							fontSize: 12,
						}}
					/>
				</div>
			</div>

			{/* Trigger list */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
				{filtered.map((item) => {
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
								backgroundColor: theme.colors.bgActivity,
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
							<div style={{ flex: 1, minWidth: 0 }}>
								<div style={{ color: theme.colors.textMain, fontSize: 12, fontWeight: 500 }}>
									{item.label}
								</div>
								<div style={{ color: theme.colors.textDim, fontSize: 10 }}>{item.description}</div>
							</div>
						</div>
					);
				})}
				{filtered.length === 0 && (
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: 12,
							textAlign: 'center',
							padding: '20px 0',
						}}
					>
						No triggers match
					</div>
				)}
			</div>
		</div>
	);
});
