import { memo } from 'react';
import { formatElapsedTime } from '../../../../shared/formatters';
import type { Theme } from '../../../types';
import { getStatusColor } from '../../../utils/theme';
import type { QuickAction } from '../types';

interface RunningAgentSubtextProps {
	info: NonNullable<QuickAction['runningInfo']>;
	now: number;
	theme: Theme;
	isSelected: boolean;
}

export const RunningAgentSubtext = memo(function RunningAgentSubtext({
	info,
	now,
	theme,
	isSelected,
}: RunningAgentSubtextProps) {
	const elapsedMs =
		info.thinkingStartTime !== undefined ? Math.max(0, now - info.thinkingStartTime) : null;
	const parts: string[] = [];
	parts.push(elapsedMs !== null ? formatElapsedTime(elapsedMs) : info.state.toUpperCase());
	if (info.busyTabName) parts.push(info.busyTabName);
	if (info.queueCount > 0) {
		parts.push(`${info.queueCount} queued`);
	}
	return (
		<span
			className="text-[10px] truncate"
			style={{
				color: isSelected ? theme.colors.accentForeground : getStatusColor(info.state, theme),
			}}
		>
			{parts.join(' · ')}
		</span>
	);
});
