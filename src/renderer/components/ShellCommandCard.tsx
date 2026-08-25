/**
 * ShellCommandCard - the transcript card for a command-mode (`!command`) run.
 *
 * A message typed as `!git status` never reaches the agent: Maestro runs it in
 * the agent's working directory and streams stdout/stderr here. The card shows
 * the command, where it ran, a live spinner with a Stop button while it's in
 * flight, and the exit code plus duration once it finishes.
 *
 * Output is rendered as terminal text (ANSI colors preserved, monospace,
 * whitespace intact) rather than markdown - shell output is not prose, and
 * running it through the markdown pipeline mangles it. The output box caps its
 * own height and follows the tail while a command streams (see
 * `useStickToBottom`), so a chatty command cannot push the rest of the
 * conversation off the screen and the newest lines stay visible.
 *
 * There are TWO copy buttons, and they copy different things: the one in the
 * header copies the OUTPUT, and the one beside the expanded command copies the
 * COMMAND. Long command lines are truncated to one line until the header is
 * clicked, because a `find` with a dozen predicates otherwise buries the status
 * and the controls.
 *
 * Driven entirely by the anchoring `LogEntry.shellCommand` record, so the card
 * survives a restart and freezes into its final state.
 */

import React, { useCallback, useState } from 'react';
import {
	Check,
	ChevronDown,
	ChevronRight,
	Loader2,
	Sparkles,
	Square,
	Terminal,
	Trash2,
	X,
} from 'lucide-react';
import type Convert from 'ansi-to-html';

import type { LogEntry, Theme } from '../types';
import { getCachedAnsiHtml } from '../utils/textProcessing';
import { cancelShellCommand } from '../services/shellCommand';
import { useStickToBottom } from '../hooks/ui/useStickToBottom';
import { CopyIconButton } from './ui/CopyIconButton';
import { formatDuration } from '../../shared/performance-metrics';
import { truncatePath } from '../../shared/formatters';
import { stripAnsiCodes } from '../../shared/stringUtils';

interface ShellCommandCardProps {
	log: LogEntry;
	theme: Theme;
	fontFamily: string;
	ansiConverter: Convert;
	/**
	 * Remove this card from the transcript. Omitted where a transcript is not
	 * the user's to edit (exports, read-only views), which hides the affordance.
	 */
	onDelete?: (logId: string) => void;
	/** Log id currently showing its "Delete?" confirmation, if any. */
	deleteConfirmLogId?: string | null;
	/** Arm / disarm that confirmation. */
	onSetDeleteConfirmLogId?: (logId: string | null) => void;
}

export function ShellCommandCard({
	log,
	theme,
	fontFamily,
	ansiConverter,
	onDelete,
	deleteConfirmLogId,
	onSetDeleteConfirmLogId,
}: ShellCommandCardProps): React.ReactElement | null {
	const shell = log.shellCommand;

	const html = React.useMemo(
		() => (log.text ? getCachedAnsiHtml(log.text, theme.id, ansiConverter) : ''),
		[log.text, theme.id, ansiConverter]
	);

	// Follows the tail while output streams, and lets go the moment the user
	// scrolls up to read something. Keyed on the rendered html so it re-pins on
	// every chunk; the box caps at 480px, so without this the user would be left
	// staring at the FIRST screen of a long command's output while the live tail
	// piled up out of sight below.
	const outputRef = useStickToBottom<HTMLDivElement>(html);

	// Long command lines are one truncated line until asked for. Collapsed is the
	// default because the header's job is status at a glance - a wrapped 300-char
	// `find` would push the exit code and the controls out of view on every card.
	const [commandExpanded, setCommandExpanded] = useState(false);
	const toggleCommandExpanded = useCallback(() => setCommandExpanded((v) => !v), []);

	// Acknowledge the press immediately. The kill is SIGTERM first, so a process
	// that traps it can take up to the SIGKILL escalation to actually die - and
	// during that gap an unchanged "Stop" button reads as "the click did nothing".
	const [stopping, setStopping] = useState(false);
	const handleStop = useCallback(() => {
		setStopping(true);
		void cancelShellCommand(log.id);
	}, [log.id]);

	if (!shell) return null;

	const isRunning = shell.status === 'running';
	// Delete is offered only once the command has settled. While it runs the
	// header already carries Stop, and deleting a live card would orphan the
	// process: output would keep streaming into an entry that no longer exists,
	// with nothing left on screen to stop it. Stop first, then delete.
	const canDelete = !!onDelete && !isRunning;
	const confirmingDelete = canDelete && deleteConfirmLogId === log.id;
	const failed =
		shell.status === 'cancelled' || (shell.exitCode !== undefined && shell.exitCode !== 0);
	const statusColor = isRunning
		? theme.colors.warning
		: failed
			? theme.colors.error
			: theme.colors.success;

	return (
		<div
			className="rounded-xl border overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: failed ? `${theme.colors.error}60` : theme.colors.border,
			}}
		>
			{/* Provenance: what was asked, for a command AI command mode generated.
			    Above the command because that is the order it happened, and because
			    a transcript read weeks later needs the intent to make sense of the
			    flags. Absent for a typed command, where the line already is the
			    intent. */}
			{shell.request && (
				<div
					className="flex items-start gap-1.5 px-3 pt-2 text-[11px] select-text"
					style={{ color: theme.colors.textDim }}
					data-testid="shell-command-request"
				>
					<Sparkles className="w-3 h-3 shrink-0 mt-px" style={{ color: theme.colors.accent }} />
					<span className="min-w-0 break-words">{shell.request}</span>
				</div>
			)}

			{/* Header: the command, where it ran, and its status */}
			<div
				className="flex items-center gap-2 px-3 py-2 border-b"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: `color-mix(in srgb, ${statusColor} 8%, ${theme.colors.bgActivity})`,
				}}
			>
				<Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: statusColor }} />

				{/* A real <button>, not a div with onClick: this is a keyboard-first app,
				    and role="button" would announce as one while doing nothing from the
				    keyboard. `items-start` on the expanded form keeps the chevron on the
				    first line of a wrapped command rather than centred beside a block. */}
				<button
					type="button"
					onClick={toggleCommandExpanded}
					className={`flex min-w-0 flex-1 gap-1.5 text-left ${commandExpanded ? 'items-start' : 'items-center'}`}
					aria-expanded={commandExpanded}
					title={commandExpanded ? 'Collapse the command' : 'Show the full command'}
					data-testid="shell-command-toggle"
				>
					{commandExpanded ? (
						<ChevronDown
							className="w-3 h-3 shrink-0 mt-1"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
					)}
					<span
						className={`text-sm font-medium min-w-0 ${
							commandExpanded ? 'whitespace-pre-wrap break-all select-text' : 'truncate'
						}`}
						style={{ fontFamily, color: theme.colors.textMain }}
						// Only useful while truncated; expanded, the text is all there.
						title={commandExpanded ? undefined : shell.command}
						data-testid="shell-command-text"
					>
						<span style={{ color: statusColor }}>$ </span>
						{shell.command}
					</span>
				</button>

				{/* Copies the COMMAND. Only offered while expanded, so it cannot be
				    mistaken for the output copy sitting a few pixels to its right. It
				    stops propagation (via CopyIconButton) so copying does not also
				    collapse the command out from under the click. */}
				{commandExpanded && (
					<CopyIconButton
						value={shell.command}
						theme={theme}
						title="Copy command"
						iconClassName="w-3 h-3"
						flash
						testId="shell-command-copy-command"
					/>
				)}

				<div className="ml-auto flex items-center gap-2 shrink-0">
					<span
						className="text-[10px] hidden sm:inline"
						style={{ color: theme.colors.textDim }}
						title={shell.remoteName ? `${shell.remoteName}:${shell.cwd}` : shell.cwd}
					>
						{shell.remoteName ? `${shell.remoteName}:` : ''}
						{truncatePath(shell.cwd, 32)}
					</span>

					{isRunning ? (
						<>
							<Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: statusColor }} />
							<button
								type="button"
								onClick={handleStop}
								disabled={stopping}
								className="flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] hover:opacity-80 transition-opacity disabled:opacity-50"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								title={stopping ? 'Stopping...' : 'Stop this command'}
							>
								<Square className="w-2.5 h-2.5" />
								{stopping ? 'Stopping' : 'Stop'}
							</button>
						</>
					) : (
						<span
							className="flex items-center gap-1 text-[10px] tabular-nums"
							style={{ color: statusColor }}
						>
							{shell.status === 'cancelled' ? (
								<>
									<X className="w-3 h-3" />
									stopped
								</>
							) : (
								<>
									{shell.exitCode === 0 ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
									exit {shell.exitCode ?? 0}
								</>
							)}
							{shell.durationMs !== undefined && (
								<span style={{ color: theme.colors.textDim }}>
									{' '}
									· {formatDuration(shell.durationMs)}
								</span>
							)}
						</span>
					)}

					{/* Copies the OUTPUT - unchanged in position and meaning, now sharing
					    the app's copy button instead of hand-rolling the swap-to-a-check.
					    Copies what the user SEES, not the wire format: the stored text
					    keeps its ANSI codes so the card can render colour, but pasting
					    `\x1b[36m` into an issue or a shell is never what anyone wants. */}
					{log.text.length > 0 && (
						<CopyIconButton
							value={() => stripAnsiCodes(log.text)}
							theme={theme}
							title="Copy output"
							iconClassName="w-3 h-3"
							flash
							testId="shell-command-copy-output"
						/>
					)}

					{/* Delete lives in the card's own header rather than the transcript's
					    shared hover toolbar: a command card takes an early return in
					    TerminalOutput and never renders that toolbar. */}
					{canDelete &&
						(confirmingDelete ? (
							<div
								className="flex items-center gap-1 px-1 py-0.5 rounded border"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									borderColor: theme.colors.error,
								}}
								data-testid="shell-command-delete-confirm"
							>
								<span className="text-[10px] px-0.5" style={{ color: theme.colors.error }}>
									Delete?
								</span>
								<button
									type="button"
									onClick={() => {
										onSetDeleteConfirmLogId?.(null);
										onDelete?.(log.id);
									}}
									className="px-1.5 py-0.5 rounded text-[10px] font-medium hover:opacity-80"
									style={{ backgroundColor: theme.colors.error, color: '#fff' }}
									data-testid="shell-command-delete-yes"
								>
									Yes
								</button>
								<button
									type="button"
									onClick={() => onSetDeleteConfirmLogId?.(null)}
									className="px-1.5 py-0.5 rounded text-[10px] hover:opacity-80"
									style={{ color: theme.colors.textDim }}
									data-testid="shell-command-delete-no"
								>
									No
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => onSetDeleteConfirmLogId?.(log.id)}
								className="p-1 rounded hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.textDim }}
								title="Delete this command and its output"
								aria-label="Delete this command and its output"
								data-testid="shell-command-delete"
							>
								<Trash2 className="w-3 h-3" />
							</button>
						))}
				</div>
			</div>

			{/* Output: terminal text, not markdown. Pinned to the tail while it
			    streams - see useStickToBottom on `outputRef`. */}
			{log.text.trim().length > 0 ? (
				<div
					ref={outputRef}
					className="px-3 py-2 text-sm whitespace-pre overflow-auto scrollbar-thin select-text"
					style={{
						fontFamily,
						color: theme.colors.textMain,
						maxHeight: '480px',
						overscrollBehavior: 'contain',
					}}
					data-testid="shell-command-output"
					// Sanitized by getCachedAnsiHtml (DOMPurify).
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<div className="px-3 py-2 text-xs italic" style={{ color: theme.colors.textDim }}>
					{isRunning ? 'Running...' : 'No output'}
				</div>
			)}

			{shell.truncated && (
				<div
					className="px-3 py-1 text-[10px] border-t"
					style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
				>
					Output truncated - the command produced more than Maestro keeps in the transcript.
				</div>
			)}
		</div>
	);
}
