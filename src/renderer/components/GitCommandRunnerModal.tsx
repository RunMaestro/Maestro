/**
 * GitCommandRunnerModal - live console for network git commands.
 *
 * Opened from the header git pill menu (Pull / Push). The command runs in the
 * main process and streams its stdout/stderr back chunk-by-chunk, so the user
 * watches the transfer happen instead of staring at a spinner. Dismissible at
 * any time: closing leaves the command running (a push mid-transfer should
 * finish), while the Cancel button explicitly kills it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, RefreshCw, X } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { generateId } from '../utils/ids';
import { processCarriageReturns } from '../utils/textProcessing';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { useGitDetail } from '../contexts/GitStatusContext';
import type { GitCommandRunnerData } from '../stores/modalStore';
import type { GitStreamingOperation, GitRunCommandResult } from '../../shared/gitUtils';
import type { Theme } from '../types';

export interface GitCommandRunnerModalProps {
	theme: Theme;
	data: GitCommandRunnerData;
	onClose: () => void;
}

type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';

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
	const { operation, cwd, sshRemoteId, branch } = data;
	const { refreshGitStatus } = useGitDetail();

	const [output, setOutput] = useState('');
	const [status, setStatus] = useState<RunStatus>('running');
	const [error, setError] = useState<string | undefined>();
	const [setUpstream, setSetUpstream] = useState(false);
	// Bumping this re-runs the command (the "set upstream and retry" path).
	const [attempt, setAttempt] = useState(0);

	const runIdRef = useRef<string | null>(null);
	const startedAttemptRef = useRef(-1);
	const scrollRef = useRef<HTMLPreElement>(null);
	const pinnedToBottomRef = useRef(true);

	// Subscription lives in its own effect so a StrictMode remount re-attaches
	// the listener even though the run-effect below skips its second pass. The
	// filter reads runIdRef at delivery time, so ordering with the run is safe.
	useEffect(() => {
		return gitService.onCommandOutput((chunk) => {
			if (chunk.runId !== runIdRef.current) return;
			setOutput((prev) => prev + chunk.chunk);
		});
	}, [attempt]);

	// Fire the command exactly once per attempt. React StrictMode invokes
	// effects twice in development - without this guard every push would run
	// twice. Dismissing the modal deliberately does NOT cancel: a push already
	// talking to the remote should finish. Cancel is an explicit button.
	useEffect(() => {
		if (startedAttemptRef.current === attempt) return;
		startedAttemptRef.current = attempt;

		const runId = generateId();
		runIdRef.current = runId;
		setOutput('');
		setStatus('running');
		setError(undefined);

		void gitService
			.runCommand({ runId, operation, cwd, sshRemoteId, setUpstream })
			.then((result: GitRunCommandResult) => {
				setStatus(result.cancelled ? 'cancelled' : result.success ? 'success' : 'failed');
				setError(result.error);
				// Branch, ahead/behind and file counts all move after a sync.
				void refreshGitStatus();
			});
		// `attempt` is the retry trigger; the rest are stable for a given modal open.
	}, [attempt, operation, cwd, sshRemoteId, setUpstream, refreshGitStatus]);

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
		const runId = runIdRef.current;
		if (runId) void gitService.cancelCommand(runId);
	}, []);

	const handleRetryWithUpstream = useCallback(() => {
		setSetUpstream(true);
		setAttempt((n) => n + 1);
	}, []);

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
			priority={MODAL_PRIORITIES.GIT_COMMAND_RUNNER}
			onClose={onClose}
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

					{status === 'running' ? (
						<button
							type="button"
							onClick={handleCancel}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							Cancel
						</button>
					) : (
						<button
							type="button"
							onClick={onClose}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							Close
						</button>
					)}
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
