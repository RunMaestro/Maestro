/**
 * ErrorNode — Rendered in place of an unresolved agent when the Cue YAML
 * references a session that no longer exists.
 *
 * Prevents the "silent agent swap" failure mode: when `agent_id` or
 * `source_session_ids` can't be resolved to any live session, the loader
 * emits an error node instead of picking a replacement via heuristics. The
 * user sees a clear red node with the unresolved identifier and must take
 * action (delete the subscription or edit the YAML) before the pipeline
 * can be saved.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { AlertTriangle, GripVertical } from 'lucide-react';
import type { Theme } from '../../../types';

export interface ErrorNodeDataProps {
	compositeId: string;
	message: string;
	unresolvedId?: string;
	unresolvedName?: string;
	subscriptionName: string;
	theme?: Theme;
}

const ERROR_COLOR = '#ef4444';

export const ErrorNode = memo(function ErrorNode({
	data,
	selected,
}: NodeProps<ErrorNodeDataProps>) {
	const theme = data.theme;
	const bg = theme?.colors.bgMain ?? '#1e1e2e';
	const textMain = theme?.colors.textMain ?? '#e4e4e7';
	const textDim = theme?.colors.textDim ?? '#9ca3af';

	return (
		<div
			role="alert"
			aria-label={`Unresolved agent: ${data.message}`}
			style={{
				minWidth: 200,
				maxWidth: 320,
				borderRadius: 8,
				backgroundColor: bg,
				border: `2px solid ${ERROR_COLOR}`,
				boxShadow: selected ? `0 4px 16px ${ERROR_COLOR}60` : `0 2px 8px ${ERROR_COLOR}30`,
				animation: 'pipeline-node-pulse 2.4s ease-in-out infinite',
				['--node-color-40' as string]: `${ERROR_COLOR}40`,
				['--node-color-60' as string]: `${ERROR_COLOR}60`,
				['--node-color-30' as string]: `${ERROR_COLOR}30`,
				display: 'flex',
				flexDirection: 'row',
				overflow: 'visible',
				cursor: 'default',
				position: 'relative',
			}}
		>
			<div
				className="drag-handle"
				style={{
					width: 28,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'grab',
					color: '#fff',
					flexShrink: 0,
					backgroundColor: `${ERROR_COLOR}cc`,
					borderRadius: '6px 0 0 6px',
				}}
				title="Drag to move"
			>
				<GripVertical size={14} />
			</div>

			<div
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					padding: '8px 12px',
					gap: 4,
					overflow: 'hidden',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<AlertTriangle size={14} style={{ color: ERROR_COLOR, flexShrink: 0 }} />
					<span style={{ color: ERROR_COLOR, fontSize: 12, fontWeight: 700 }}>
						Unresolved agent
					</span>
				</div>
				<span
					style={{
						color: textMain,
						fontSize: 11,
						lineHeight: 1.35,
						wordBreak: 'break-word',
					}}
				>
					{data.message}
				</span>
				{(data.unresolvedName || data.unresolvedId) && (
					<span
						style={{
							color: textDim,
							fontSize: 10,
							fontFamily: 'ui-monospace, SFMono-Regular, monospace',
							wordBreak: 'break-all',
						}}
					>
						{data.unresolvedName ? `name: ${data.unresolvedName}` : null}
						{data.unresolvedName && data.unresolvedId ? ' · ' : null}
						{data.unresolvedId ? `id: ${data.unresolvedId}` : null}
					</span>
				)}
				<span style={{ color: textDim, fontSize: 10, fontStyle: 'italic' }}>
					in subscription “{data.subscriptionName}”
				</span>
			</div>

			<Handle
				type="target"
				position={Position.Left}
				style={{
					backgroundColor: ERROR_COLOR,
					border: `3px solid ${bg}`,
					width: 12,
					height: 12,
					zIndex: 10,
					left: -6,
				}}
			/>
			<Handle
				type="source"
				position={Position.Right}
				style={{
					backgroundColor: ERROR_COLOR,
					border: `3px solid ${bg}`,
					width: 12,
					height: 12,
					zIndex: 10,
					right: -6,
				}}
			/>
		</div>
	);
});
