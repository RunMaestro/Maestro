/**
 * CommandModeBar - the "you are not talking to the agent" strip above the AI
 * composer.
 *
 * Serves both rungs of the bang ladder, because they are the same strip with
 * different words: a shell prompt you type into (`'shell'`), and a request the
 * model turns into a shell prompt (`'ai'`). Keeping one component is what stops
 * the two from drifting apart on the thing that actually matters here - the
 * working directory the command will run in, which is identical either way.
 *
 * It exists because the switch from talking-to-the-agent to running-a-shell-
 * command must be visible BEFORE Enter, not a surprise after. It also
 * advertises the keys, which are otherwise undiscoverable: the bang was
 * consumed on entry, so there is no character left in the composer to hint at
 * the mode or to delete your way out of.
 *
 * Only rendered in AI mode - the terminal composer is already, self-evidently,
 * a shell.
 */

import { memo } from 'react';
import { CornerDownLeft, Sparkles, Terminal } from 'lucide-react';
import type { Theme } from '../../../types';
import { truncatePath } from '../../../../shared/formatters';
import { TurnSettingPills } from '../../ui/TurnSettingPills';

interface CommandModeBarProps {
	theme: Theme;
	/** Which rung is active. */
	mode: 'shell' | 'ai';
	/** Directory the command will run in (the agent's cwd, or its SSH remote's). */
	cwd: string;
	/** SSH remote name when the agent runs remotely, else undefined. */
	remoteName?: string;
	/** Whether Tab completion has anything to offer (git repos add branches/tags). */
	isGitRepo?: boolean;
	/** Model the suggestion will run under. AI mode only. */
	model?: string;
	/** Effort the suggestion will run under. AI mode only. */
	effort?: string;
}

export const CommandModeBar = memo(function CommandModeBar({
	theme,
	mode,
	cwd,
	remoteName,
	isGitRepo,
	model,
	effort,
}: CommandModeBarProps) {
	const isAi = mode === 'ai';
	const Icon = isAi ? Sparkles : Terminal;
	const completes = isGitRepo ? 'files, dirs, branches' : 'files and dirs';

	return (
		<div
			className="flex items-center gap-2 px-3 py-1 border-b text-2xs select-none"
			style={{
				borderColor: `${theme.colors.accent}30`,
				backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 10%, transparent)`,
			}}
			data-testid={isAi ? 'ai-command-mode-bar' : 'command-mode-bar'}
		>
			<Icon className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
			<span className="font-medium uppercase tracking-wide" style={{ color: theme.colors.accent }}>
				{isAi ? 'AI Command' : 'Command Mode'}
			</span>
			<span className="truncate" style={{ color: theme.colors.textDim }} title={cwd}>
				{remoteName ? `${remoteName}:` : ''}
				{truncatePath(cwd, isAi ? 28 : 40)}
			</span>
			{isAi && <TurnSettingPills theme={theme} model={model} effort={effort} />}
			<span
				className="ml-auto shrink-0 hidden sm:flex items-center gap-1"
				style={{ color: theme.colors.textDim }}
			>
				{isAi ? (
					<>
						<CornerDownLeft className="w-3 h-3" />
						asks for a command
					</>
				) : (
					<>
						<kbd
							className="px-1 rounded border font-mono"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							Tab
						</kbd>
						{completes}
						<CornerDownLeft className="w-3 h-3 ml-1" />
						runs it
					</>
				)}
				{/* The way out. There is no `!` left in the text to delete, so without
				    this the mode looks like a trap. */}
				<kbd
					className="px-1 rounded border font-mono ml-1"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					Esc
				</kbd>
				{isAi ? 'back to Command Mode' : 'exits'}
				{!isAi && (
					<>
						<kbd
							className="px-1 rounded border font-mono ml-1"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							!
						</kbd>
						asks AI
					</>
				)}
			</span>
		</div>
	);
});
