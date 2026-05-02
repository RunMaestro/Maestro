import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { MessageSquare, GripVertical, Settings } from 'lucide-react';
import type { Theme } from '../../../types';

export interface AgentNodeDataProps {
	compositeId: string;
	sessionId: string;
	sessionName: string;
	toolType: string;
	/** Instance number when the same agent appears multiple times (e.g. 1, 2, 3) */
	instanceLabel?: number;
	/** Number of incoming agent edges (shown as fan-in badge when > 1) */
	fanInCount?: number;
	hasPrompt: boolean;
	hasOutgoingEdge: boolean;
	pipelineColor: string;
	pipelineCount: number;
	pipelineColors: string[];
	onConfigure?: (compositeId: string) => void;
	theme?: Theme;
}

export const AgentNode = memo(function AgentNode({
	data,
	selected,
}: NodeProps<AgentNodeDataProps>) {
	const theme = data.theme;
	const accentColor = data.pipelineColor;

	return (
		<div
			style={{
				minWidth: 180,
				height: 80,
				width: 'max-content',
				borderRadius: 8,
				willChange: 'transform',
				backgroundColor: theme?.colors.bgMain ?? '#1e1e2e',
				border: `2px solid ${selected ? accentColor : (theme?.colors.border ?? '#333')}`,
				boxShadow: selected ? `0 4px 16px ${accentColor}30` : '0 2px 8px rgba(0,0,0,0.3)',
				animation: selected ? 'pipeline-node-pulse 2s ease-in-out infinite' : undefined,
				['--node-color-40' as string]: `${accentColor}40`,
				['--node-color-60' as string]: `${accentColor}60`,
				['--node-color-30' as string]: `${accentColor}30`,
				display: 'flex',
				flexDirection: 'row',
				overflow: 'visible',
				cursor: 'default',
				transition: 'border-color 0.15s, box-shadow 0.15s',
				position: 'relative',
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
					color: theme?.colors.textDim ?? '#555',
					flexShrink: 0,
					backgroundColor: accentColor,
					borderRadius: '6px 0 0 6px',
					transition: 'color 0.15s, filter 0.15s',
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.color = theme?.colors.accentForeground ?? '#fff';
					e.currentTarget.style.filter = 'brightness(1.3)';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.color = theme?.colors.textDim ?? '#555';
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
					justifyContent: 'center',
					padding: '8px 10px',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<span
						style={{
							color: theme?.colors.textMain ?? '#e4e4e7',
							fontSize: 13,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							flex: 1,
						}}
					>
						{data.sessionName}
						{data.instanceLabel != null ? ` (${data.instanceLabel})` : ''}
					</span>
					{data.hasPrompt && (
						<MessageSquare
							size={12}
							style={{ color: theme?.colors.textDim ?? '#9ca3af', flexShrink: 0 }}
						/>
					)}
				</div>
				<span
					style={{
						color: theme?.colors.textDim ?? '#6b7280',
						fontSize: 11,
						marginTop: 2,
					}}
				>
					{data.toolType}
				</span>

				{/* Multi-pipeline color strip */}
				{data.pipelineColors.length > 1 && (
					<div
						style={{
							display: 'flex',
							gap: 3,
							marginTop: 6,
						}}
					>
						{data.pipelineColors.map((c, i) => (
							<div
								key={i}
								style={{
									width: 8,
									height: 8,
									borderRadius: '50%',
									backgroundColor: c,
								}}
							/>
						))}
					</div>
				)}
			</div>

			{/* Gear icon */}
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
					color: selected ? accentColor : (theme?.colors.textDim ?? '#555'),
					flexShrink: 0,
					padding: '0 6px',
					marginRight: 14,
					borderRadius: 4,
					transition: 'color 0.15s',
				}}
				onMouseEnter={(e) => (e.currentTarget.style.color = accentColor)}
				onMouseLeave={(e) =>
					(e.currentTarget.style.color = selected ? accentColor : (theme?.colors.textDim ?? '#555'))
				}
				title="Configure"
			>
				<Settings size={14} />
			</div>

			{/* Pipeline count badge */}
			{data.pipelineCount > 1 && (
				<div
					style={{
						position: 'absolute',
						top: -6,
						right: -6,
						width: 20,
						height: 20,
						borderRadius: '50%',
						backgroundColor: accentColor,
						color: theme?.colors.accentForeground ?? '#fff',
						fontSize: 10,
						fontWeight: 700,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: `2px solid ${theme?.colors.bgMain ?? '#1e1e2e'}`,
					}}
				>
					{data.pipelineCount}
				</div>
			)}

			<Handle
				type="target"
				position={Position.Left}
				style={{
					backgroundColor: accentColor,
					border: `3px solid ${theme?.colors.bgMain ?? '#1e1e2e'}`,
					boxShadow: `0 0 0 2px ${accentColor}`,
					width: 16,
					height: 16,
					zIndex: 10,
					left: -8,
				}}
			/>

			{/* Fan-in count badge (left side) */}
			{data.fanInCount != null && (
				<div
					style={{
						position: 'absolute',
						bottom: -8,
						left: -8,
						minWidth: 20,
						height: 18,
						borderRadius: 9,
						backgroundColor: accentColor,
						color: theme?.colors.accentForeground ?? '#fff',
						fontSize: 9,
						fontWeight: 700,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '0 4px',
						border: `2px solid ${theme?.colors.bgMain ?? '#1e1e2e'}`,
						zIndex: 11,
					}}
					title={`Fan-in: waiting for ${data.fanInCount} agents`}
				>
					{data.fanInCount}→
				</div>
			)}
			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: accentColor,
					border: `3px solid ${theme?.colors.bgMain ?? '#1e1e2e'}`,
					boxShadow: `0 0 0 2px ${accentColor}`,
					width: 16,
					height: 16,
					zIndex: 10,
					right: -8,
				}}
			/>
		</div>
	);
});
