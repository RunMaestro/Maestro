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
 * running it through the markdown pipeline mangles it.
 *
 * Driven entirely by the anchoring `LogEntry.shellCommand` record, so the card
 * survives a restart and freezes into its final state.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Check, Copy, Loader2, Sparkles, Square, Terminal, Trash2, X } from 'lucide-react';
import type Convert from 'ansi-to-html';

import type { LogEntry, Theme } from '../types';
import { getCachedAnsiHtml } from '../utils/textProcessing';
import { cancelShellCommand } from '../services/shellCommand';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
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
	const [copied, setCopied] = useState(false);
	const shell = log.shellCommand;

	const html = useMemo(
		() => (log.text ? getCachedAnsiHtml(log.text, theme.id, ansiConverter) : ''),
		[log.text, theme.id, ansiConverter]
	);

	const handleCopy = useCallback(async () => {
		// Copy what the user SEES, not the wire format. The stored text keeps its
		// ANSI codes so the card can render colour, but pasting `\x1b[36m` into an
		// issue or a shell is never what anyone wants.
		await safeClipboardWrite(stripAnsiCodes(log.text));
		flashCopiedToClipboard();
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	}, [log.text]);

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
				<span
					className="text-sm font-medium truncate"
					style={{ fontFamily, color: theme.colors.textMain }}
					title={shell.command}
				>
					<span style={{ color: statusColor }}>$ </span>
					{shell.command}
				</span>

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

					{log.text.length > 0 && (
						<button
							type="button"
							onClick={handleCopy}
							className="p-1 rounded hover:opacity-80 transition-opacity"
							style={{ color: copied ? theme.colors.success : theme.colors.textDim }}
							title="Copy output"
						>
							{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
						</button>
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

			{/* Output: terminal text, not markdown */}
			{log.text.trim().length > 0 ? (
				<div
					className="px-3 py-2 text-sm whitespace-pre overflow-auto scrollbar-thin select-text"
					style={{
						fontFamily,
						color: theme.colors.textMain,
						maxHeight: '480px',
						overscrollBehavior: 'contain',
					}}
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
