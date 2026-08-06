/**
 * CommandModeBar - the "you are in command mode" strip above the AI composer.
 *
 * Appears the moment a draft starts with `!` and disappears when it doesn't, so
 * the switch from talking-to-the-agent to running-a-shell-command is visible
 * before Enter, not a surprise after. It also advertises Tab completion, which
 * is otherwise undiscoverable.
 *
 * Only rendered in AI mode - the terminal composer is already, self-evidently,
 * a shell.
 */

import { memo } from 'react';
import { CornerDownLeft, Terminal } from 'lucide-react';
import type { Theme } from '../../../types';
import { truncatePath } from '../../../../shared/formatters';

interface CommandModeBarProps {
	theme: Theme;
	/** Directory the command will run in (the agent's cwd, or its SSH remote's). */
	cwd: string;
	/** SSH remote name when the agent runs remotely, else undefined. */
	remoteName?: string;
	/** Whether Tab completion has anything to offer (git repos add branches/tags). */
	isGitRepo?: boolean;
}

export const CommandModeBar = memo(function CommandModeBar({
	theme,
	cwd,
	remoteName,
	isGitRepo,
}: CommandModeBarProps) {
	const completes = isGitRepo ? 'files, dirs, branches' : 'files and dirs';

	return (
		<div
			className="flex items-center gap-2 px-3 py-1 border-b text-[10px] select-none"
			style={{
				borderColor: `${theme.colors.accent}30`,
				backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 10%, transparent)`,
			}}
		>
			<Terminal className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
			<span className="font-medium uppercase tracking-wide" style={{ color: theme.colors.accent }}>
				Command Mode
			</span>
			<span className="truncate" style={{ color: theme.colors.textDim }} title={cwd}>
				{remoteName ? `${remoteName}:` : ''}
				{truncatePath(cwd, 40)}
			</span>
			<span
				className="ml-auto shrink-0 hidden sm:flex items-center gap-1"
				style={{ color: theme.colors.textDim }}
			>
				<kbd
					className="px-1 rounded border font-mono"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					Tab
				</kbd>
				{completes}
				<CornerDownLeft className="w-3 h-3 ml-1" />
				runs it
				{/* The way out. There is no `!` left in the text to delete, so without
				    this the mode looks like a trap. */}
				<kbd
					className="px-1 rounded border font-mono ml-1"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					Esc
				</kbd>
				exits
			</span>
		</div>
	);
});
