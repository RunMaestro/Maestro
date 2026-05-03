import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { GripVertical, Settings, Zap, Play, Loader2 } from 'lucide-react';
import { CUE_COLOR, type CueEventType } from '../../../../shared/cue-pipeline-types';
import { EVENT_COLORS, EVENT_ICONS } from '../cueEventConstants';
import type { Theme } from '../../../types';

export interface TriggerNodeDataProps {
	compositeId: string;
	eventType: CueEventType;
	label: string;
	configSummary: string;
	onConfigure?: (compositeId: string) => void;
	/** Callback to manually trigger the subscription owned by this trigger node. */
	onTriggerPipeline?: (subscriptionName: string) => void;
	/** The pipeline this node belongs to — shown in the Play button's aria-label. */
	pipelineName?: string;
	/** The Cue subscription this specific trigger node owns. In multi-trigger
	 *  pipelines, distinct trigger nodes map to distinct subscriptions
	 *  (`pipeline.name`, `pipeline.name-chain-1`, etc.). The Play button MUST
	 *  fire this sub name — firing the pipeline name only matches the first
	 *  trigger, leaving chain triggers (e.g. GitHub PR polls) unreachable. */
	subscriptionName?: string;
	/** Whether the pipeline config is saved (play only works when saved) */
	isSaved?: boolean;
	/** Whether this pipeline is currently running */
	isRunning?: boolean;
	/** Number of fan-out targets (shown as badge when > 1) */
	fanOutCount?: number;
	theme?: Theme;
}

export const TriggerNode = memo(function TriggerNode({
	data,
	selected,
}: NodeProps<TriggerNodeDataProps>) {
	const theme = data.theme;
	const color = EVENT_COLORS[data.eventType] ?? CUE_COLOR;
	const Icon = EVENT_ICONS[data.eventType] ?? Zap;

	return (
		<div
			style={{
				minWidth: 220,
				height: 60,
				width: 'max-content',
				borderRadius: 9999,
				willChange: 'transform',
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
					backgroundColor: color,
					borderRadius: '9999px 0 0 9999px',
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
					minWidth: 0,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
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
						}}
						title={data.label}
					>
						{data.label}
					</span>
				</div>
				{data.configSummary && (
					<span
						style={{
							color: theme?.colors.textDim ?? '#9ca3af',
							fontSize: 10,
							marginTop: 2,
							whiteSpace: 'nowrap',
						}}
						title={data.configSummary}
					>
						{data.configSummary}
					</span>
				)}
			</div>

			{/* Action icons - placed before connector to avoid overlap */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					flexShrink: 0,
					marginRight: 14,
					gap: 2,
				}}
			>
				{/* Play button — only when pipeline is saved. Fires THIS trigger's
				 *  subscription (sub name populated by yamlToPipeline on load).
				 *  Falls back to pipelineName only for legacy pipelines where the
				 *  sub name wasn't stamped on the node; for post-fix data this
				 *  correctly targets per-trigger chain subs like "Pipeline 1-chain-2".
				 *
				 *  The fire target is computed ONCE with truthy semantics so an
				 *  empty-string `subscriptionName` can't render a button that
				 *  fires the empty sub name. Rendering, click, and aria-label
				 *  all use the same resolved target. */}
				{(() => {
					const fireTarget = data.subscriptionName || data.pipelineName;
					if (!data.isSaved || !data.onTriggerPipeline || !fireTarget) return null;
					return (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								if (!data.isRunning) {
									data.onTriggerPipeline!(fireTarget);
								}
							}}
							disabled={data.isRunning}
							aria-label={data.isRunning ? 'Running' : `Run ${fireTarget}`}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								cursor: data.isRunning ? 'default' : 'pointer',
								color: data.isRunning
									? (theme?.colors.success ?? '#22c55e')
									: `${theme?.colors.success ?? '#22c55e'}90`,
								padding: 4,
								borderRadius: 4,
								border: 'none',
								backgroundColor: 'transparent',
								transition: 'color 0.15s',
							}}
							onMouseEnter={(e) => {
								if (!data.isRunning)
									e.currentTarget.style.color = theme?.colors.success ?? '#22c55e';
							}}
							onMouseLeave={(e) => {
								if (!data.isRunning)
									e.currentTarget.style.color = `${theme?.colors.success ?? '#22c55e'}90`;
							}}
							title={data.isRunning ? 'Running…' : 'Run now'}
						>
							{data.isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
						</button>
					);
				})()}

				{/* Gear icon */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						data.onConfigure?.(data.compositeId);
					}}
					aria-label="Configure"
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						cursor: 'pointer',
						color: selected ? color : `${color}60`,
						padding: 4,
						borderRadius: 4,
						border: 'none',
						backgroundColor: 'transparent',
						transition: 'color 0.15s',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.color = color)}
					onMouseLeave={(e) => (e.currentTarget.style.color = selected ? color : `${color}60`)}
					title="Configure"
				>
					<Settings size={14} />
				</button>
			</div>

			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: color,
					border: `3px solid ${theme?.colors.bgMain ?? '#1e1e2e'}`,
					boxShadow: `0 0 0 2px ${color}`,
					width: 16,
					height: 16,
					zIndex: 10,
					right: -8,
				}}
			/>

			{/* Fan-out count badge */}
			{data.fanOutCount && (
				<div
					style={{
						position: 'absolute',
						top: -8,
						right: -8,
						minWidth: 18,
						height: 18,
						borderRadius: 9,
						backgroundColor: color,
						color: '#fff',
						fontSize: 10,
						fontWeight: 700,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '0 4px',
						border: `2px solid ${theme?.colors.bgMain ?? '#1e1e2e'}`,
						zIndex: 11,
					}}
					title={`Fan-out to ${data.fanOutCount} agents`}
				>
					×{data.fanOutCount}
				</div>
			)}
		</div>
	);
});
