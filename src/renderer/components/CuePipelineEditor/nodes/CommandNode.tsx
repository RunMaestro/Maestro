import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Terminal, GripVertical, Settings, Send } from 'lucide-react';
import type { Theme } from '../../../types';
import { COMMAND_NODE_COLOR, type CueCommandMode } from '../../../../shared/cue-pipeline-types';

export interface CommandNodeDataProps {
	compositeId: string;
	name: string;
	mode: CueCommandMode;
	/** Mode-specific summary line shown under the name (e.g. truncated shell command, or `cli send → target`). */
	summary: string;
	owningSessionName: string;
	pipelineColor: string;
	pipelineCount: number;
	pipelineColors: string[];
	onConfigure?: (compositeId: string) => void;
	theme?: Theme;
}

export const CommandNode = memo(function CommandNode({
	data,
	selected,
}: NodeProps<CommandNodeDataProps>) {
	const theme = data.theme;
	const accentColor = COMMAND_NODE_COLOR;
	const ModeIcon = data.mode === 'cli' ? Send : Terminal;
	const modeLabel = data.mode === 'cli' ? 'CLI' : 'Shell';

	return (
		<div
			style={{
				minWidth: 180,
				maxWidth: 320,
				height: 80,
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
					overflow: 'hidden',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<ModeIcon
						size={12}
						style={{ color: theme?.colors.textDim ?? '#9ca3af', flexShrink: 0 }}
					/>
					<span
						style={{
							color: theme?.colors.textMain ?? '#e4e4e7',
							fontSize: 13,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							flex: 1,
						}}
					>
						{data.name || 'command'}
					</span>
					<span
						style={{
							fontSize: 9,
							color: theme?.colors.textDim ?? '#9ca3af',
							backgroundColor: `${accentColor}20`,
							padding: '1px 5px',
							borderRadius: 3,
							flexShrink: 0,
						}}
					>
						{modeLabel}
					</span>
				</div>
				<span
					style={{
						color: theme?.colors.textDim ?? '#6b7280',
						fontSize: 11,
						marginTop: 2,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						fontFamily: 'monospace',
					}}
					title={data.summary}
				>
					{data.summary || '(unconfigured)'}
				</span>
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

			{/* Owning-session pill */}
			<div
				style={{
					position: 'absolute',
					bottom: -8,
					right: 8,
					padding: '1px 6px',
					borderRadius: 4,
					backgroundColor: theme?.colors.bgActivity ?? '#2a2a3a',
					border: `1px solid ${theme?.colors.border ?? '#333'}`,
					fontSize: 9,
					color: theme?.colors.textDim ?? '#9ca3af',
					whiteSpace: 'nowrap',
				}}
				title={`Runs in ${data.owningSessionName}'s project root`}
			>
				in: {data.owningSessionName}
			</div>

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
