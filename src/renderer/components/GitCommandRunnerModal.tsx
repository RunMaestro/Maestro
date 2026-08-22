/**
 * GitCommandRunnerModal - live console for network git commands.
 *
 * Opened from the header git pill menu (Pull / Push). The command runs in the
 * main process and streams its stdout/stderr back chunk-by-chunk, so the user
 * watches the transfer happen instead of staring at a spinner.
 *
 * The modal is a VIEW: the run itself lives in `gitCommandRunStore` and
 * outlives this component. Closing (X / Escape / backdrop) hides the console
 * and leaves the command running - a push mid-transfer should finish, and a
 * toast reports how it went. Reopening the same operation on the same repo
 * re-attaches to that run with its transcript intact. Cancel is the only thing
 * that kills the command.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, RefreshCw, X } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { processCarriageReturns } from '../utils/textProcessing';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { useGitCommandRunStore, gitRunKey, selectGitRun } from '../stores/gitCommandRunStore';
import { useSessionStore } from '../stores/sessionStore';
import type { GitCommandRunnerData } from '../stores/modalStore';
import type { GitStreamingOperation } from '../../shared/gitUtils';
import type { Theme } from '../types';

export interface GitCommandRunnerModalProps {
	theme: Theme;
	data: GitCommandRunnerData;
	onClose: () => void;
}

const OPERATION_ICONS: Record<GitStreamingOperation, typeof ArrowDownToLine> = {
	pull: ArrowDownToLine,
	push: ArrowUpFromLine,
	fetch: RefreshCw,
};

/**
 * git only tells you a branch has no upstream when you try to push it. Detect
 * that specific failure so we can offer the one-click `--set-upstream` retry
 * instead of making the user drop to a terminal.
 */
function needsUpstream(output: string): boolean {
	return /no upstream branch|--set-upstream/i.test(output);
}

export function GitCommandRunnerModal({ theme, data, onClose }: GitCommandRunnerModalProps) {
	const { sessionId, operation, branch } = data;
	const runKey = gitRunKey(data);
	const run = useGitCommandRunStore(selectGitRun(runKey));

	// Which agent this transfer belongs to. Pull/Push are reachable by
	// right-clicking any row in the Left Bar, so the target is often NOT the
	// highlighted agent and the command line alone ("git push") names nothing.
	// Subscribe to the name only, never the Session: this modal is on screen
	// while a command streams, and a whole-session subscription would re-render
	// it on every unrelated token and log update.
	const agentName = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.name);

	const scrollRef = useRef<HTMLPreElement>(null);
	const pinnedToBottomRef = useRef(true);

	// Start the command, or attach to the one already running for this repo.
	// `startRun` is a no-op in the attach case, which is also what makes the
	// StrictMode double-invoke harmless.
	useEffect(() => {
		useGitCommandRunStore.getState().startRun(data);
		// Identity of `data` changes per open; the key is what identifies the run.
	}, [runKey]);

	const status = run?.status ?? 'running';
	const output = run?.output ?? '';
	const error = run?.error;
	const setUpstream = run?.setUpstream ?? false;

	// Follow the tail unless the user has scrolled up to read something.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !pinnedToBottomRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [output]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
	}, []);

	const handleCancel = useCallback(() => {
		useGitCommandRunStore.getState().cancelRun(runKey);
	}, [runKey]);

	const handleClose = useCallback(() => {
		// A settled console has served its purpose: drop it so the next Pull or
		// Push on this repo opens a fresh transcript instead of the old result.
		// A RUNNING one is deliberately left alone - that is the whole point of
		// close-vs-cancel, and the notifier will toast it when it lands.
		const current = useGitCommandRunStore.getState().runs[runKey];
		if (current && current.status !== 'running') {
			useGitCommandRunStore.getState().clearRun(runKey);
		}
		onClose();
	}, [runKey, onClose]);

	const handleRetryWithUpstream = useCallback(() => {
		useGitCommandRunStore.getState().retryWithUpstream(runKey);
	}, [runKey]);

	const rendered = useMemo(
		() => processCarriageReturns(stripAnsiCodes(output)).trimEnd(),
		[output]
	);

	const commandLine = `git ${operation}${setUpstream ? ` --set-upstream origin ${branch ?? 'HEAD'}` : ''}`;
	const OperationIcon = OPERATION_ICONS[operation];
	const showUpstreamRetry =
		status === 'failed' &&
		operation === 'push' &&
		!setUpstream &&
		needsUpstream(output + (error ?? ''));

	const statusColor =
		status === 'success'
			? theme.colors.success
			: status === 'failed'
				? theme.colors.error
				: theme.colors.textDim;

	return (
		<Modal
			theme={theme}
			title={commandLine}
			subtitle={agentName}
			priority={MODAL_PRIORITIES.GIT_COMMAND_RUNNER}
			onClose={handleClose}
			width={700}
			maxHeight="70vh"
			resizeKey="modal-git-command-runner"
			defaultSize={{ width: 700, height: 420 }}
			minSize={{ width: 420, height: 240 }}
			closeOnBackdropClick
			headerIcon={<OperationIcon className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			contentClassName="flex-1 min-h-0 flex flex-col"
			testId="git-command-runner-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					<div className="flex items-center gap-2 mr-auto text-xs" style={{ color: statusColor }}>
						{status === 'running' && (
							<>
								<Spinner size={14} />
								<span>{branch ? `Running on ${branch}...` : 'Running...'}</span>
							</>
						)}
						{status === 'success' && (
							<>
								<Check className="w-3.5 h-3.5" />
								<span>Done</span>
							</>
						)}
						{status === 'cancelled' && <span>Cancelled</span>}
						{status === 'failed' && (
							<>
								<X className="w-3.5 h-3.5" />
								<span className="truncate max-w-[24rem]" title={error}>
									{error || 'Command failed'}
								</span>
							</>
						)}
					</div>

					{showUpstreamRetry && (
						<button
							type="button"
							onClick={handleRetryWithUpstream}
							className="px-4 py-2 rounded transition-colors"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Push and Set Upstream
						</button>
					)}

					{status === 'running' && (
						<button
							type="button"
							onClick={handleCancel}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title={`Stop git ${operation}`}
							data-testid="git-command-cancel"
						>
							Cancel
						</button>
					)}

					<button
						type="button"
						onClick={handleClose}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						title={
							status === 'running'
								? `Hide this console - git ${operation} keeps running`
								: undefined
						}
						data-testid="git-command-close"
					>
						{status === 'running' ? 'Run in Background' : 'Close'}
					</button>
				</div>
			}
		>
			<pre
				ref={scrollRef}
				onScroll={handleScroll}
				className="flex-1 min-h-0 overflow-auto scrollbar-thin p-4 m-0 text-xs font-mono whitespace-pre-wrap break-words select-text"
				style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
				data-testid="git-command-output"
			>
				{rendered || (status === 'running' ? 'Starting...' : 'No output')}
			</pre>
		</Modal>
	);
}

export default GitCommandRunnerModal;
