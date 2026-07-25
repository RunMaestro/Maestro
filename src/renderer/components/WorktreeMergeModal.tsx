import { useState, useEffect, useRef, useCallback } from 'react';
import { X, GitMerge, GitPullRequestArrow, AlertTriangle, Check } from 'lucide-react';
import { GhostIconButton } from './ui/GhostIconButton';
import { Spinner } from './ui/Spinner';
import type { Theme, Session } from '../types';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { captureException } from '../utils/sentry';

export type WorktreeMergeMode = 'merge' | 'rebase';

interface WorktreeMergeModalProps {
	isOpen: boolean;
	mode: WorktreeMergeMode;
	onClose: () => void;
	theme: Theme;
	session: Session;
	/** Called after a merge or rebase lands, so callers can refresh git state. */
	onCompleted?: () => void;
}

/** Outcome of the git operation, used to pick the result banner. */
type Result =
	| { kind: 'success'; message: string }
	| { kind: 'conflicts'; paths: string[] }
	| { kind: 'error'; message: string };

/**
 * WorktreeMergeModal - Confirm and run a merge or rebase for a worktree agent.
 *
 * Merge takes the worktree's branch into a branch you pick (usually main).
 * Rebase replays the worktree's branch on top of a branch you pick, which is
 * how you pull new upstream work into a long-running worktree.
 *
 * Both operations refuse to run against a dirty tree, so when the worktree has
 * uncommitted changes the modal offers to commit them first with a message you
 * can edit. Conflicts abort the operation and are listed here for manual
 * resolution - a button press should never leave a checkout mid-merge.
 */
export function WorktreeMergeModal({
	isOpen,
	mode,
	onClose,
	theme,
	session,
	onCompleted,
}: WorktreeMergeModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useModalLayer(MODAL_PRIORITIES.WORKTREE_MERGE, undefined, () => onCloseRef.current(), {
		focusTrap: 'lenient',
		enabled: isOpen,
	});

	const [branches, setBranches] = useState<string[]>([]);
	const [targetBranch, setTargetBranch] = useState('');
	const [branchLoadError, setBranchLoadError] = useState(false);
	const [dirtyFileCount, setDirtyFileCount] = useState(0);
	const [commitMessage, setCommitMessage] = useState('');
	const [isRunning, setIsRunning] = useState(false);
	const [result, setResult] = useState<Result | null>(null);

	const sshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
	const sourceBranch = session.worktreeBranch || '';
	const isMerge = mode === 'merge';

	// Reset transient state whenever the modal opens so a previous run's result
	// or stale commit message never bleeds into the next one.
	useEffect(() => {
		if (!isOpen) return;
		setBranches([]);
		setTargetBranch('');
		setBranchLoadError(false);
		setDirtyFileCount(0);
		setResult(null);
		setCommitMessage(sourceBranch ? `Work in progress on ${sourceBranch}` : 'Work in progress');
	}, [isOpen, sourceBranch]);

	// Load the branch list, the repo's default branch, and the worktree's dirty
	// state together. The default branch is preselected because merging into (or
	// rebasing onto) main is overwhelmingly the common case.
	useEffect(() => {
		if (!isOpen) return;

		let cancelled = false;
		Promise.all([
			gitService.getBranches(session.cwd, sshRemoteId),
			window.maestro.git.getDefaultBranch(session.cwd),
			gitService.getStatus(session.cwd, sshRemoteId),
		])
			.then(([allBranches, defaultBranchResult, status]) => {
				if (cancelled) return;
				// The worktree's own branch is never a valid merge target or rebase
				// base - merging a branch into itself is a no-op at best.
				const selectable = allBranches.filter((b) => b !== sourceBranch);
				const defaultBranch = defaultBranchResult.branch || '';
				const sorted = [...selectable].sort((a, b) => {
					if (a === defaultBranch && b !== defaultBranch) return -1;
					if (a !== defaultBranch && b === defaultBranch) return 1;
					return a.localeCompare(b);
				});
				setBranches(sorted);
				setTargetBranch(sorted[0] || '');
				setDirtyFileCount(status.files.length);
			})
			.catch((err) => {
				if (cancelled) return;
				captureException(err, { extra: { cwd: session.cwd, sshRemoteId, mode } });
				setBranchLoadError(true);
			});

		return () => {
			cancelled = true;
		};
	}, [isOpen, session.cwd, sshRemoteId, sourceBranch, mode]);

	const handleRun = useCallback(async () => {
		if (!targetBranch || !sourceBranch) return;

		setIsRunning(true);
		setResult(null);
		try {
			// Both git merge and git rebase refuse to run against a dirty tree, so
			// commit first when the user asked for it via the message field.
			if (dirtyFileCount > 0) {
				const commit = await gitService.commitAll(
					session.cwd,
					commitMessage.trim() || 'Work in progress',
					sshRemoteId
				);
				if (!commit.success) {
					setResult({ kind: 'error', message: commit.error || 'Failed to commit changes' });
					return;
				}
				setDirtyFileCount(0);
			}

			const op = isMerge
				? await gitService.mergeBranch(session.cwd, sourceBranch, targetBranch, sshRemoteId)
				: await gitService.rebaseBranch(session.cwd, targetBranch, sshRemoteId);

			if (op.conflicts && op.conflicts.length > 0) {
				setResult({ kind: 'conflicts', paths: op.conflicts });
				return;
			}
			if (!op.success) {
				setResult({
					kind: 'error',
					message: op.error || `git ${mode} failed`,
				});
				return;
			}

			if (op.alreadyUpToDate) {
				setResult({ kind: 'success', message: 'Already up to date - nothing to do.' });
			} else if (isMerge) {
				setResult({
					kind: 'success',
					message: `Merged ${sourceBranch} into ${targetBranch}.`,
				});
			} else {
				setResult({
					kind: 'success',
					message: `Rebased ${sourceBranch} onto ${targetBranch}.`,
				});
			}
			onCompleted?.();
		} finally {
			setIsRunning(false);
		}
	}, [
		targetBranch,
		sourceBranch,
		dirtyFileCount,
		commitMessage,
		session.cwd,
		sshRemoteId,
		isMerge,
		mode,
		onCompleted,
	]);

	if (!isOpen) return null;

	const title = isMerge ? 'Merge Worktree Branch' : 'Rebase Worktree Branch';
	const Icon = isMerge ? GitMerge : GitPullRequestArrow;
	const branchLabel = isMerge ? 'Merge Into' : 'Rebase Onto';
	const actionLabel = isMerge ? 'Merge' : 'Rebase';
	const runningLabel = isMerge ? 'Merging…' : 'Rebasing…';
	const canRun = !isRunning && !!sourceBranch && !!targetBranch && result?.kind !== 'success';

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60" onClick={onClose} />

			{/* Modal */}
			<div
				className="relative w-full max-w-md rounded-lg shadow-2xl border"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-4 py-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Icon className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="font-bold" style={{ color: theme.colors.textMain }}>
							{title}
						</h2>
					</div>
					<GhostIconButton onClick={onClose} ariaLabel="Close">
						<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</GhostIconButton>
				</div>

				{/* Content */}
				<div className="p-4 space-y-4">
					{/* Source branch (fixed - it is this worktree's branch) */}
					<div>
						<label
							className="text-xs font-bold uppercase mb-1.5 block"
							style={{ color: theme.colors.textDim }}
						>
							Worktree Branch
						</label>
						<div
							className="px-3 py-2 rounded border text-sm font-mono truncate"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							{sourceBranch || 'unknown'}
						</div>
					</div>

					{/* Target branch */}
					<div>
						<label
							htmlFor="worktree-merge-target"
							className="text-xs font-bold uppercase mb-1.5 block"
							style={{ color: theme.colors.textDim }}
						>
							{branchLabel}
						</label>
						<select
							id="worktree-merge-target"
							value={targetBranch}
							onChange={(e) => setTargetBranch(e.target.value)}
							disabled={isRunning || branchLoadError || branches.length === 0}
							className="w-full px-3 py-2 rounded border outline-none text-sm"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: branchLoadError ? theme.colors.error : theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							{branches.length === 0 && !branchLoadError && (
								<option value="">Loading branches…</option>
							)}
							{branches.map((b) => (
								<option key={b} value={b}>
									{b}
								</option>
							))}
						</select>
						{branchLoadError && (
							<p className="text-xs mt-1" style={{ color: theme.colors.error }}>
								Could not load branches.
							</p>
						)}
						<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
							{isMerge
								? 'Runs in whichever worktree has this branch checked out. It must have a clean tree.'
								: 'Replays this worktree onto the selected branch.'}
						</p>
					</div>

					{/* Uncommitted changes - offer to commit first, since neither
					    merge nor rebase will run against a dirty tree. */}
					{dirtyFileCount > 0 && (
						<div
							className="p-3 rounded border space-y-2"
							style={{
								backgroundColor: theme.colors.warning + '10',
								borderColor: theme.colors.warning,
							}}
						>
							<div className="flex items-start gap-2">
								<AlertTriangle
									className="w-4 h-4 mt-0.5 shrink-0"
									style={{ color: theme.colors.warning }}
								/>
								<p className="text-sm" style={{ color: theme.colors.warning }}>
									{dirtyFileCount} uncommitted {dirtyFileCount === 1 ? 'change' : 'changes'} will be
									committed first.
								</p>
							</div>
							<textarea
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
								rows={2}
								placeholder="Commit message"
								disabled={isRunning}
								className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm resize-none"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
						</div>
					)}

					{/* Result */}
					{result?.kind === 'success' && (
						<div
							className="flex items-start gap-2 p-3 rounded border"
							style={{
								backgroundColor: theme.colors.success + '10',
								borderColor: theme.colors.success,
							}}
						>
							<Check className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.success }} />
							<p className="text-sm" style={{ color: theme.colors.success }}>
								{result.message}
							</p>
						</div>
					)}

					{result?.kind === 'conflicts' && (
						<div
							className="p-3 rounded border space-y-1"
							style={{
								backgroundColor: theme.colors.error + '10',
								borderColor: theme.colors.error,
							}}
						>
							<p className="text-sm" style={{ color: theme.colors.error }}>
								{actionLabel} aborted - conflicts in {result.paths.length}{' '}
								{result.paths.length === 1 ? 'file' : 'files'}. Nothing was changed; resolve these
								by hand.
							</p>
							<ul
								className="text-xs font-mono max-h-28 overflow-y-auto"
								style={{ color: theme.colors.textDim }}
							>
								{result.paths.map((p) => (
									<li key={p} className="truncate">
										{p}
									</li>
								))}
							</ul>
						</div>
					)}

					{result?.kind === 'error' && (
						<div
							className="flex items-start gap-2 p-3 rounded border"
							style={{
								backgroundColor: theme.colors.error + '10',
								borderColor: theme.colors.error,
							}}
						>
							<AlertTriangle
								className="w-4 h-4 mt-0.5 shrink-0"
								style={{ color: theme.colors.error }}
							/>
							<p className="text-sm" style={{ color: theme.colors.error }}>
								{result.message}
							</p>
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					className="flex justify-end gap-2 px-4 py-3 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 rounded border hover:bg-white/5 transition-colors outline-none text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						{result?.kind === 'success' ? 'Close' : 'Cancel'}
					</button>
					{result?.kind !== 'success' && (
						<button
							type="button"
							onClick={handleRun}
							disabled={!canRun}
							className="px-3 py-1.5 rounded transition-colors outline-none text-xs flex items-center gap-1.5 disabled:opacity-50"
							style={{ backgroundColor: theme.colors.accent, color: '#ffffff' }}
						>
							{isRunning && <Spinner size={12} />}
							{isRunning ? runningLabel : actionLabel}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
