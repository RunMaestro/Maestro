import { useState, useEffect, useRef } from 'react';
import { X, GitBranch, FolderOpen, Plus, Loader2, AlertTriangle, Server } from 'lucide-react';
import type { Theme, Session, GhCliStatus } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface WorktreeConfigModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	session: Session;
	// Callbacks
	onSaveConfig: (config: { basePath: string; watchEnabled: boolean }) => void;
	onCreateWorktree: (branchName: string, basePath: string) => void;
	onDisableConfig: () => void;
}

/**
 * Validates that a directory exists (works over SSH for remote sessions)
 */
async function validateDirectory(path: string, sshRemoteId?: string): Promise<boolean> {
	if (!path.trim()) return false;
	try {
		await window.maestro.fs.readDir(path, sshRemoteId);
		return true;
	} catch {
		return false;
	}
}

/**
 * WorktreeConfigModal - Modal for configuring worktrees on a parent session
 *
 * Features:
 * - Set worktree base directory
 * - Toggle file watching
 * - Create new worktree with branch name
 */
export function WorktreeConfigModal({
	isOpen,
	onClose,
	theme,
	session,
	onSaveConfig,
	onCreateWorktree,
	onDisableConfig,
}: WorktreeConfigModalProps) {
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Form state
	const [basePath, setBasePath] = useState(session.worktreeConfig?.basePath || '');
	const [watchEnabled, setWatchEnabled] = useState(session.worktreeConfig?.watchEnabled ?? true);
	const [newBranchName, setNewBranchName] = useState('');
	const [isCreating, setIsCreating] = useState(false);
	const [isValidating, setIsValidating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canDisable = !!(session.worktreeConfig?.basePath || basePath.trim());

	// gh CLI status
	const [ghCliStatus, setGhCliStatus] = useState<GhCliStatus | null>(null);

	// SSH remote awareness - check both runtime sshRemoteId and configured sessionSshRemoteConfig
	// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
	// we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
	const sshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
	const isRemoteSession = !!sshRemoteId;

	// Register with layer stack for Escape handling
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.WORKTREE_CONFIG,
				onEscape: () => onCloseRef.current(),
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

	// Check gh CLI status and load config on open
	useEffect(() => {
		if (isOpen) {
			checkGhCli();
			setBasePath(session.worktreeConfig?.basePath || '');
			setWatchEnabled(session.worktreeConfig?.watchEnabled ?? true);
			setNewBranchName('');
			setError(null);
		}
	}, [isOpen, session.worktreeConfig]);

	const checkGhCli = async () => {
		try {
			const status = await window.maestro.git.checkGhCli();
			setGhCliStatus(status);
		} catch {
			setGhCliStatus({ installed: false, authenticated: false });
		}
	};

	const handleBrowse = async () => {
		// Browse is only available for local sessions
		if (isRemoteSession) return;
		const result = await window.maestro.dialog.selectFolder();
		if (result) {
			setBasePath(result);
		}
	};

	const handleSave = async () => {
		if (!basePath.trim()) {
			setError('Please select a worktree directory');
			return;
		}

		// Validate directory exists (via SSH for remote sessions)
		setIsValidating(true);
		setError(null);
		try {
			const exists = await validateDirectory(basePath.trim(), sshRemoteId);
			if (!exists) {
				setError(
					isRemoteSession
						? 'Directory not found on remote server. Please enter a valid path.'
						: 'Directory not found. Please select a valid directory.'
				);
				return;
			}
			onSaveConfig({ basePath: basePath.trim(), watchEnabled });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to validate directory');
		} finally {
			setIsValidating(false);
		}
	};

	const handleCreateWorktree = async () => {
		if (!basePath.trim()) {
			setError('Please select a worktree directory first');
			return;
		}
		if (!newBranchName.trim()) {
			setError('Please enter a branch name');
			return;
		}

		setIsCreating(true);
		setError(null);

		try {
			// Save config first to ensure it's persisted
			onSaveConfig({ basePath: basePath.trim(), watchEnabled });
			// Then create the worktree, passing the basePath
			await onCreateWorktree(newBranchName.trim(), basePath.trim());
			setNewBranchName('');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create worktree');
		} finally {
			setIsCreating(false);
		}
	};

	const handleDisable = () => {
		setBasePath('');
		setWatchEnabled(true);
		setNewBranchName('');
		setError(null);
		onDisableConfig();
		onClose();
	};

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60" onClick={onClose} />

			{/* Modal */}
			<div
				className="relative w-full max-w-lg rounded-lg shadow-2xl border max-h-[80vh] flex flex-col"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-4 py-3 border-b shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<GitBranch className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="font-bold" style={{ color: theme.colors.textMain }}>
							Worktree Configuration
						</h2>
					</div>
					<button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors">
						<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</button>
				</div>

				{/* Content */}
				<div className="p-4 space-y-4 overflow-y-auto flex-1">
					{/* gh CLI warning */}
					{ghCliStatus !== null && !ghCliStatus.installed && (
						<div
							className="flex items-start gap-2 p-3 rounded border"
							style={{
								backgroundColor: theme.colors.warning + '10',
								borderColor: theme.colors.warning,
							}}
						>
							<AlertTriangle
								className="w-4 h-4 mt-0.5 shrink-0"
								style={{ color: theme.colors.warning }}
							/>
							<div className="text-sm">
								<p style={{ color: theme.colors.warning }}>GitHub CLI recommended</p>
								<p className="mt-1" style={{ color: theme.colors.textDim }}>
									Install{' '}
									<button
										type="button"
										className="underline hover:opacity-80"
										style={{ color: theme.colors.accent }}
										onClick={() => window.maestro.shell.openExternal('https://cli.github.com')}
									>
										GitHub CLI
									</button>{' '}
									for best worktree support.
								</p>
							</div>
						</div>
					)}

					{/* SSH Remote indicator */}
					{isRemoteSession && (
						<div
							className="flex items-center gap-2 px-3 py-2 rounded border"
							style={{
								backgroundColor: theme.colors.accent + '15',
								borderColor: theme.colors.accent + '40',
							}}
						>
							<Server className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								Remote session — enter the path on the remote server
							</span>
						</div>
					)}

					{/* Worktree Base Directory */}
					<div>
						<label
							className="text-xs font-bold uppercase mb-1.5 block"
							style={{ color: theme.colors.textDim }}
						>
							Worktree Directory
						</label>
						<div className="flex gap-2">
							<input
								type="text"
								value={basePath}
								onChange={(e) => setBasePath(e.target.value)}
								placeholder={isRemoteSession ? '/home/user/worktrees' : '/path/to/worktrees'}
								className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
							<button
								onClick={handleBrowse}
								disabled={isRemoteSession}
								className={`px-3 py-2 rounded border transition-colors text-sm flex items-center gap-2 ${
									isRemoteSession ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'
								}`}
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								title={
									isRemoteSession
										? 'Browse is not available for remote sessions'
										: 'Browse for directory'
								}
							>
								<FolderOpen className="w-4 h-4" />
								Browse
							</button>
						</div>
						<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
							{isRemoteSession
								? 'Path on the remote server where worktrees will be created'
								: 'Base directory where worktrees will be created'}
						</p>
					</div>

					{/* Watch Toggle */}
					<div className="flex items-center justify-between">
						<div>
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Watch for new worktrees
							</div>
							<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
								Auto-detect worktrees created outside Maestro
							</p>
						</div>
						<button
							onClick={() => setWatchEnabled(!watchEnabled)}
							className={`relative w-10 h-5 rounded-full transition-colors ${
								watchEnabled ? 'bg-green-500' : 'bg-gray-600 hover:bg-gray-500'
							}`}
						>
							<div
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									watchEnabled ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Divider */}
					<div className="border-t" style={{ borderColor: theme.colors.border }} />

					{/* Create New Worktree */}
					<div>
						<label
							className="text-xs font-bold uppercase mb-1.5 block"
							style={{ color: theme.colors.textDim }}
						>
							Create New Worktree
						</label>
						<div className="flex gap-2">
							<input
								type="text"
								value={newBranchName}
								onChange={(e) => setNewBranchName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && newBranchName.trim()) {
										handleCreateWorktree();
									}
								}}
								placeholder="feature-xyz"
								className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								disabled={!basePath || isCreating}
							/>
							<button
								onClick={handleCreateWorktree}
								disabled={!basePath || !newBranchName.trim() || isCreating}
								className={`px-3 py-2 rounded text-sm font-medium flex items-center gap-2 transition-colors ${
									basePath && newBranchName.trim() && !isCreating
										? 'hover:opacity-90'
										: 'opacity-50 cursor-not-allowed'
								}`}
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								{isCreating ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Plus className="w-4 h-4" />
								)}
								Create
							</button>
						</div>
					</div>

					{/* Error message */}
					{error && (
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
								{error}
							</p>
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					className="flex items-center justify-end gap-2 px-4 py-3 border-t shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						onClick={handleDisable}
						disabled={!canDisable || isCreating || isValidating}
						className={`px-4 py-2 rounded text-sm font-medium border transition-colors ${
							canDisable && !isCreating && !isValidating
								? 'hover:opacity-90'
								: 'opacity-50 cursor-not-allowed'
						}`}
						style={{
							borderColor: theme.colors.error,
							color: theme.colors.error,
						}}
					>
						Disable
					</button>
					<button
						onClick={onClose}
						className="px-4 py-2 rounded text-sm hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textMain }}
					>
						Cancel
					</button>
					<button
						onClick={handleSave}
						disabled={isValidating || isCreating}
						className={`px-4 py-2 rounded text-sm font-medium transition-colors flex items-center gap-2 ${
							isValidating || isCreating ? 'opacity-70' : 'hover:opacity-90'
						}`}
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{isValidating && <Loader2 className="w-4 h-4 animate-spin" />}
						{isValidating ? 'Validating...' : 'Save Configuration'}
					</button>
				</div>
			</div>
		</div>
	);
}

export default WorktreeConfigModal;
