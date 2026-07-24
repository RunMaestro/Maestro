import React from 'react';
import { ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import type { Theme } from '../../types';

export interface CollapsedCommandsNoticeProps {
	/** The current theme */
	theme: Theme;
	/** How many commands are currently hidden */
	count: number;
	/** Whether the hidden commands are being shown anyway */
	expanded: boolean;
	/** Toggles the reveal state */
	onToggle: () => void;
	/** Section name used in the notice text (e.g. "Spec Kit") */
	sectionName: string;
}

/**
 * Collapsed placeholder shown in place of a disabled command section's list.
 * Keeps the commands reachable for editing without leaving a long list on
 * screen for a section the user has turned off.
 */
export function CollapsedCommandsNotice({
	theme,
	count,
	expanded,
	onToggle,
	sectionName,
}: CollapsedCommandsNoticeProps): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed text-xs transition-colors hover:bg-white/5"
			style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			aria-expanded={expanded}
		>
			{expanded ? (
				<ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
			) : (
				<ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
			)}
			<EyeOff className="w-3.5 h-3.5 flex-shrink-0" />
			<span>
				{count} {sectionName} command{count === 1 ? '' : 's'} hidden
			</span>
			<span className="ml-auto font-medium" style={{ color: theme.colors.accent }}>
				{expanded ? 'Collapse' : 'Show anyway'}
			</span>
		</button>
	);
}
