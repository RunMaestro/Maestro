import type { Theme } from '../../../../../types';
import { getToolDetail } from '../../../shared/wizardHelpers';
import type { ToolExecutionEvent } from '../types';

export function ToolExecutionEntry({
	tool,
	theme,
}: {
	tool: ToolExecutionEvent;
	theme: Theme;
}): JSX.Element {
	const state = tool.state as { status?: string; input?: unknown } | undefined;
	const status = state?.status || 'running';
	const toolDetail = getToolDetail(state?.input);

	return (
		<div
			className="flex items-start gap-2 py-1 text-xs font-mono"
			style={{ color: theme.colors.textDim }}
		>
			<span
				className="px-1.5 py-0.5 rounded text-[10px] shrink-0"
				style={{
					backgroundColor:
						status === 'complete' ? `${theme.colors.success}30` : `${theme.colors.accent}30`,
					color: status === 'complete' ? theme.colors.success : theme.colors.accent,
				}}
			>
				{tool.toolName}
			</span>
			{status === 'complete' ? (
				<span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>
					✓
				</span>
			) : (
				<span className="animate-pulse shrink-0 pt-0.5" style={{ color: theme.colors.warning }}>
					●
				</span>
			)}
			{toolDetail && (
				<span
					className="opacity-70 break-all whitespace-pre-wrap"
					style={{ color: theme.colors.textMain }}
				>
					{toolDetail}
				</span>
			)}
		</div>
	);
}
