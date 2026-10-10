/**
 * CheckpointsModal - snapshot and roll back an agent's working tree.
 *
 * The visible half of worktree checkpoints. See `src/shared/gitCheckpoints.ts`
 * for the model and `src/main/git/checkpoints.ts` for the git mechanism.
 *
 * Two ideas drive the layout:
 *
 * - Taking a checkpoint is the cheap, common action, so it is a always-visible
 *   row at the top rather than something behind another click. The list below
 *   is the rare action.
 * - Restoring overwrites the tree, so it goes through the shared destructive
 *   `confirm` modal and the confirmation names what is about to be lost. The
 *   restore is undoable (a safety checkpoint is taken first, in the main
 *   process, unconditionally), and the toast afterwards says so - a user who
 *   restores the wrong snapshot needs to learn that from the UI, not from
 *   reading the source.
 *
 * The list is re-read from git after every mutation rather than patched
 * locally. Checkpoints can also be created by `maestro-cli worktree checkpoint`
 * and by Auto Run task boundaries, so local state would drift from the repo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Camera, GitBranch, History, RotateCcw, Trash2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { EscCloseButton } from './ui/EscCloseButton';
import { MiniBadge } from './ui/MiniBadge';
import { FilterInput } from './ui/FilterInput';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { useModalStore } from '../stores/modalStore';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { useGitDetail } from '../contexts/GitStatusContext';
import { formatRelativeTime } from '../../shared/formatters';
import { describeCheckpointOrigin, type GitCheckpoint } from '../../shared/gitCheckpoints';
import type { CheckpointsModalData } from '../stores/modalStore';
import type { Theme } from '../types';

export interface CheckpointsModalProps {
	theme: Theme;
	data: CheckpointsModalData;
	onClose: () => void;
}

export function CheckpointsModal({ theme, data, onClose }: CheckpointsModalProps) {
	const { sessionId, cwd, sshRemoteId, branch } = data;
	const { refreshGitStatus } = useGitDetail();

	// Reachable by right-clicking any Left Bar row, so the target is often not
	// the highlighted agent. Subscribe to the name alone - a whole-session
	// subscription would re-render this list on every unrelated token update.
	const agentName = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.name);

	const [checkpoints, setCheckpoints] = useState<GitCheckpoint[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [label, setLabel] = useState('');
	const [includeIgnored, setIncludeIgnored] = useState(false);
	const [query, setQuery] = useState('');
	const [error, setError] = useState<string | null>(null);

	/**
	 * Re-read the list from git.
	 *
	 * Always a fresh read rather than a local patch: checkpoints are also created
	 * by `maestro-cli worktree checkpoint` and by Auto Run task boundaries, so
	 * anything held locally drifts from the repo.
	 */
	const reload = useCallback(async () => {
		const result = await gitService.listCheckpoints(cwd, undefined, sshRemoteId);
		setCheckpoints(result.checkpoints);
		setError(result.success ? null : (result.error ?? 'Failed to list checkpoints'));
		setLoading(false);
	}, [cwd, sshRemoteId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return checkpoints;
		return checkpoints.filter(
			(c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
		);
	}, [checkpoints, query]);

	const handleCreate = useCallback(async () => {
		setBusy('create');
		setError(null);
		const result = await gitService.createCheckpoint(
			cwd,
			{ label: label.trim() || undefined, includeIgnored },
			sshRemoteId
		);
		setBusy(null);
		if (!result.success || !result.checkpoint) {
			setError(result.error || 'Failed to create checkpoint');
			return;
		}
		setLabel('');
		await reload();
		notifyToast({
			color: 'green',
			title: 'Checkpoint created',
			message: result.checkpoint.label,
		});
	}, [cwd, label, includeIgnored, sshRemoteId, reload]);

	const handleRestore = useCallback(
		(checkpoint: GitCheckpoint) => {
			// Through the shared destructive confirm rather than an inline one: this
			// overwrites every uncommitted edit in the tree, and the message has to
			// say both what is lost and that the loss is recoverable.
			useModalStore.getState().openModal('confirm', {
				title: 'Restore checkpoint?',
				destructive: true,
				message: `This replaces the working tree with "${checkpoint.label}", discarding uncommitted changes made since${checkpoint.includesIgnored ? ' (including ignored files)' : ''}. Your branch and commit history are not touched, and a checkpoint of the current state is saved first so this can be undone.`,
				onConfirm: () => {
					void (async () => {
						setBusy(checkpoint.id);
						setError(null);
						const result = await gitService.restoreCheckpoint(cwd, checkpoint.id, sshRemoteId);
						setBusy(null);
						if (!result.success) {
							setError(result.error || 'Failed to restore checkpoint');
							return;
						}
						await reload();
						// The tree just changed underneath every git-derived widget in
						// the app; without this the file badges keep showing the old diff.
						await refreshGitStatus();
						notifyToast({
							color: 'green',
							title: 'Checkpoint restored',
							message: result.safetyCheckpoint
								? `Restored "${checkpoint.label}". The previous state was saved as "${result.safetyCheckpoint.label}".`
								: `Restored "${checkpoint.label}".`,
						});
					})();
				},
			});
		},
		[cwd, sshRemoteId, reload, refreshGitStatus]
	);

	const handleDelete = useCallback(
		(checkpoint: GitCheckpoint) => {
			useModalStore.getState().openModal('confirm', {
				title: 'Delete checkpoint?',
				destructive: true,
				message: `"${checkpoint.label}" will no longer be restorable. This does not change the working tree.`,
				onConfirm: () => {
					void (async () => {
						setBusy(checkpoint.id);
						const result = await gitService.deleteCheckpoint(cwd, checkpoint.id, sshRemoteId);
						setBusy(null);
						if (!result.success) {
							setError(result.error || 'Failed to delete checkpoint');
							return;
						}
						await reload();
					})();
				},
			});
		},
		[cwd, sshRemoteId, reload]
	);

	return (
		<Modal
			theme={theme}
			title="Checkpoints"
			subtitle={agentName}
			priority={MODAL_PRIORITIES.CHECKPOINTS}
			onClose={onClose}
			width={640}
			maxHeight="80vh"
			resizeKey="modal-checkpoints"
			defaultSize={{ width: 640, height: 520 }}
			minSize={{ width: 420, height: 320 }}
			closeOnBackdropClick
			testId="checkpoints-modal"
			contentClassName="flex-1 min-h-0 flex flex-col select-none"
			headerActions={<EscCloseButton theme={theme} onClose={onClose} />}
		>
			{/* Take a checkpoint - the common action, so it is never behind a click. */}
			<div
				className="px-4 py-3 border-b shrink-0 space-y-2"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<input
						className="flex-1 min-w-0 px-2 py-1.5 rounded text-sm bg-transparent outline-none border"
						style={{ color: theme.colors.textMain, borderColor: theme.colors.border }}
						placeholder="Name this checkpoint (optional)"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !busy) {
								e.preventDefault();
								void handleCreate();
							}
						}}
						data-testid="checkpoints-label-input"
					/>
					<button
						type="button"
						onClick={() => void handleCreate()}
						disabled={busy !== null}
						className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						data-testid="checkpoints-create"
					>
						{busy === 'create' ? <Spinner size={12} /> : <Camera className="w-3.5 h-3.5" />}
						Take Checkpoint
					</button>
				</div>
				<label
					className="flex items-center gap-2 text-xs cursor-pointer"
					style={{ color: theme.colors.textDim }}
				>
					<input
						type="checkbox"
						checked={includeIgnored}
						onChange={(e) => setIncludeIgnored(e.target.checked)}
						data-testid="checkpoints-include-ignored"
					/>
					{/* The tradeoff is stated rather than implied: this is the difference
					    between snapshotting a .env and snapshotting node_modules. */}
					Include ignored files (.env, build output) - larger snapshot
				</label>
				{branch && (
					<div
						className="flex items-center gap-1.5 text-[11px]"
						style={{ color: theme.colors.textDim }}
					>
						<GitBranch className="w-3 h-3" />
						<span className="font-mono truncate">{branch}</span>
					</div>
				)}
			</div>

			{error && (
				<div
					className="px-4 py-2 text-xs border-b select-text shrink-0"
					style={{ color: theme.colors.error, borderColor: theme.colors.border }}
					data-testid="checkpoints-error"
				>
					{error}
				</div>
			)}

			{/* The filter only earns its row once the list is long enough to need it. */}
			{checkpoints.length > 8 && (
				<div className="px-2 shrink-0 border-b" style={{ borderColor: theme.colors.border }}>
					<FilterInput
						theme={theme}
						value={query}
						onChange={setQuery}
						placeholder="Filter checkpoints..."
						resultLabel={`${filtered.length} of ${checkpoints.length}`}
					/>
				</div>
			)}

			<div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
				{loading && (
					<div
						className="flex items-center gap-2 px-4 py-3 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						<Spinner size={14} />
						Loading checkpoints...
					</div>
				)}

				{!loading && filtered.length === 0 && (
					<div className="px-4 py-6 text-sm text-center" style={{ color: theme.colors.textDim }}>
						{checkpoints.length === 0
							? 'No checkpoints yet. Take one before letting an agent try something ambitious.'
							: 'No checkpoints match your filter.'}
					</div>
				)}

				{filtered.map((checkpoint) => (
					<div
						key={checkpoint.id}
						className="px-4 py-2.5 border-b flex items-center gap-3"
						style={{ borderColor: theme.colors.border }}
						data-testid={`checkpoints-row-${checkpoint.id}`}
					>
						<History className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
						<div className="min-w-0 flex-1">
							<div
								className="text-sm truncate select-text"
								style={{ color: theme.colors.textMain }}
								title={checkpoint.label}
							>
								{checkpoint.label}
							</div>
							<div
								className="flex items-center gap-2 text-[11px] mt-0.5"
								style={{ color: theme.colors.textDim }}
							>
								<span>{formatRelativeTime(checkpoint.createdAt)}</span>
								<span>{describeCheckpointOrigin(checkpoint.origin)}</span>
								{checkpoint.branch && (
									<span className="font-mono truncate">{checkpoint.branch}</span>
								)}
								{checkpoint.includesIgnored && (
									<MiniBadge theme={theme} label="Ignored" title="Includes ignored files" />
								)}
							</div>
						</div>
						<button
							type="button"
							onClick={() => handleRestore(checkpoint)}
							disabled={busy !== null}
							className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors disabled:opacity-50"
							style={{ color: theme.colors.textMain }}
							title="Restore the working tree to this checkpoint"
							data-testid={`checkpoints-restore-${checkpoint.id}`}
						>
							{busy === checkpoint.id ? (
								<Spinner size={12} />
							) : (
								<RotateCcw className="w-3.5 h-3.5" />
							)}
							Restore
						</button>
						<button
							type="button"
							onClick={() => handleDelete(checkpoint)}
							disabled={busy !== null}
							className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
							style={{ color: theme.colors.textDim }}
							title="Delete this checkpoint"
							aria-label={`Delete checkpoint ${checkpoint.label}`}
							data-testid={`checkpoints-delete-${checkpoint.id}`}
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</div>
				))}
			</div>
		</Modal>
	);
}

export default CheckpointsModal;
