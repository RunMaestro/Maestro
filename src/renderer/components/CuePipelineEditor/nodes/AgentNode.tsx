import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { MessageSquare } from 'lucide-react';

export interface AgentNodeDataProps {
	sessionId: string;
	sessionName: string;
	toolType: string;
	hasPrompt: boolean;
	pipelineColor: string;
	pipelineCount: number;
	pipelineColors: string[];
}

export const AgentNode = memo(function AgentNode({
	data,
	selected,
}: NodeProps<AgentNodeDataProps>) {
	const accentColor = data.pipelineColor;

	return (
		<div
			style={{
				width: 200,
				height: 80,
				borderRadius: 8,
				backgroundColor: '#1e1e2e',
				border: `2px solid ${selected ? accentColor : '#333'}`,
				boxShadow: selected ? `0 4px 16px ${accentColor}30` : '0 2px 8px rgba(0,0,0,0.3)',
				display: 'flex',
				flexDirection: 'row',
				overflow: 'hidden',
				cursor: 'pointer',
				transition: 'border-color 0.15s, box-shadow 0.15s',
				position: 'relative',
			}}
		>
			{/* Left accent bar */}
			<div
				style={{
					width: 4,
					backgroundColor: accentColor,
					flexShrink: 0,
				}}
			/>

			{/* Content */}
			<div
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					padding: '8px 12px',
					overflow: 'hidden',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<span
						style={{
							color: '#e4e4e7',
							fontSize: 13,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							flex: 1,
						}}
					>
						{data.sessionName}
					</span>
					{data.hasPrompt && (
						<MessageSquare size={12} style={{ color: '#9ca3af', flexShrink: 0 }} />
					)}
				</div>
				<span
					style={{
						color: '#6b7280',
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
						color: '#fff',
						fontSize: 10,
						fontWeight: 700,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '2px solid #1e1e2e',
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
					borderColor: '#1e1e2e',
					width: 8,
					height: 8,
				}}
			/>
			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: accentColor,
					borderColor: '#1e1e2e',
					width: 8,
					height: 8,
				}}
			/>
		</div>
	);
});
