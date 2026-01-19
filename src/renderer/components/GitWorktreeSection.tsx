import { useState, useRef } from 'react';
import { GitBranch, AlertTriangle, Loader2, ChevronDown } from 'lucide-react';
import type { Theme, WorktreeValidationState, GhCliStatus } from '../types';
import { useClickOutside } from '../hooks';

// Re-export types for backward compatibility
export type { WorktreeValidationState, GhCliStatus } from '../types';

/**
 * Props for GitWorktreeSection component
 */
export interface GitWorktreeSectionProps {
	theme: Theme;
	// Worktree configuration state
	worktreeEnabled: boolean;
	setWorktreeEnabled: (enabled: boolean) => void;
	worktreeBaseDir: string; // User-selected base directory
	setWorktreeBaseDir: (path: string) => void;
	computedWorktreePath: string; // baseDir + branchName (read-only display)
	branchName: string;
	setBranchName: (name: string) => void;
	createPROnCompletion: boolean;
	setCreatePROnCompletion: (create: boolean) => void;
	prTargetBranch: string;
	setPrTargetBranch: (branch: string) => void;
	// Validation and available data
	worktreeValidation: WorktreeValidationState;
	availableBranches: string[];
	ghCliStatus: GhCliStatus | null;
	// SSH remote support
	sshRemoteId?: string;
}

/**
 * GitWorktreeSection - Git worktree configuration UI for batch runs
 *
 * Features:
 * - Enable/disable worktree toggle with gh CLI availability check
 * - Worktree path input with browse button
 * - Branch name input
 * - Worktree validation warnings (branch mismatch, different repo, uncommitted changes)
 * - PR creation checkbox with target branch selector
 *
 * Extracted from BatchRunnerModal.tsx (~302 lines)
 */
export function GitWorktreeSection({
	theme,
	worktreeEnabled,
	setWorktreeEnabled,
	worktreeBaseDir,
	setWorktreeBaseDir,
	computedWorktreePath,
	branchName,
	setBranchName,
	createPROnCompletion,
	setCreatePROnCompletion,
	prTargetBranch,
	setPrTargetBranch,
	worktreeValidation,
	availableBranches,
	ghCliStatus,
	sshRemoteId,
}: GitWorktreeSectionProps) {
	// SSH remote awareness
	const isRemoteSession = !!sshRemoteId;
	// Branch dropdown state
	const [showBranchDropdown, setShowBranchDropdown] = useState(false);
	const branchDropdownRef = useRef<HTMLDivElement>(null);

	// Close branch dropdown when clicking outside
	useClickOutside(branchDropdownRef, () => setShowBranchDropdown(false), showBranchDropdown);

	// Handle browse button click for base directory
	const handleBrowseBaseDir = async () => {
		// Browse is only available for local sessions
		if (isRemoteSession) return;
		const result = await window.maestro.dialog.selectFolder();
		if (result) {
			setWorktreeBaseDir(result);
		}
	};

	return (
		<div className="mb-6">
			<div className="flex items-center gap-2 mb-3">
				<GitBranch className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
					Git Worktree
				</label>
				<span
					className="text-[10px] px-2 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
				>
					enables parallel work
				</span>
			</div>

			{/* Enable Worktree Toggle */}
			<div className="flex items-center gap-3 mb-4">
				<button
					onClick={() => ghCliStatus?.installed && setWorktreeEnabled(!worktreeEnabled)}
					disabled={!ghCliStatus?.installed}
					className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
						!ghCliStatus?.installed
							? 'opacity-50 cursor-not-allowed'
							: worktreeEnabled
								? 'border-accent'
								: 'border-border hover:bg-white/5'
					}`}
					style={{
						borderColor:
							worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent : theme.colors.border,
						backgroundColor:
							worktreeEnabled && ghCliStatus?.installed
								? theme.colors.accent + '15'
								: 'transparent',
					}}
				>
					<div
						className={`w-4 h-4 rounded border flex items-center justify-center ${
							worktreeEnabled && ghCliStatus?.installed ? 'bg-accent border-accent' : ''
						}`}
						style={{
							borderColor:
								worktreeEnabled && ghCliStatus?.installed
									? theme.colors.accent
									: theme.colors.border,
							backgroundColor:
								worktreeEnabled && ghCliStatus?.installed ? theme.colors.accent : 'transparent',
						}}
					>
						{worktreeEnabled && ghCliStatus?.installed && (
							<svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
								<path
									d="M2 6L5 9L10 3"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						)}
					</div>
					<span
						className="text-sm font-medium"
						style={{
							color:
								worktreeEnabled && ghCliStatus?.installed
									? theme.colors.accent
									: theme.colors.textMain,
						}}
					>
						Enable Worktree
					</span>
				</button>

				{/* GitHub CLI not installed warning - shown inline with disabled toggle */}
				{ghCliStatus !== null && !ghCliStatus.installed && (
					<div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
						<AlertTriangle className="w-4 h-4 shrink-0" style={{ color: theme.colors.warning }} />
						<span>
							Install{' '}
							<button
								type="button"
								className="underline hover:opacity-80"
								style={{ color: theme.colors.accent }}
								onClick={(e) => {
									e.stopPropagation();
									window.maestro.shell.openExternal('https://cli.github.com');
								}}
							>
								GitHub CLI
							</button>{' '}
							to enable worktree features
						</span>
					</div>
				)}

				{/* Still checking gh CLI status */}
				{ghCliStatus === null && (
					<div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
						<Loader2 className="w-3 h-3 animate-spin" />
						Checking GitHub CLI...
					</div>
				)}
			</div>

			{/* Worktree Configuration (only shown when enabled) */}
			{worktreeEnabled && (
				<div
					className="rounded-lg border p-4 space-y-4"
					style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
				>
					{/* Worktree Base Directory */}
					<div>
						<label
							className="text-xs font-medium mb-1.5 block"
							style={{ color: theme.colors.textDim }}
						>
							Worktree Directory
						</label>
						<div className="flex gap-2">
							<input
								type="text"
								value={worktreeBaseDir}
								onChange={(e) => setWorktreeBaseDir(e.target.value)}
								placeholder={isRemoteSession ? '/home/user/worktrees' : '/path/to/worktrees'}
								className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
							<button
								onClick={handleBrowseBaseDir}
								disabled={isRemoteSession}
								className={`px-3 py-2 rounded border transition-colors text-sm ${
									isRemoteSession ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'
								}`}
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								title={
									isRemoteSession
										? 'Browse is not available for remote sessions'
										: 'Browse for directory'
								}
							>
								Browse
							</button>
						</div>
						<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
							{isRemoteSession
								? 'Path on the remote server where worktrees will be created'
								: 'Base directory where worktrees will be created'}
						</p>
					</div>

					{/* Branch Name */}
					<div>
						<label
							className="text-xs font-medium mb-1.5 block"
							style={{ color: theme.colors.textDim }}
						>
							Branch Name
						</label>
						<input
							type="text"
							value={branchName}
							onChange={(e) => setBranchName(e.target.value)}
							placeholder="feature-xyz"
							className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
					</div>

					{/* Computed Worktree Path (read-only preview) */}
					{computedWorktreePath && (
						<div>
							<label
								className="text-xs font-medium mb-1.5 block"
								style={{ color: theme.colors.textDim }}
							>
								Worktree Path (computed)
							</label>
							<input
								type="text"
								value={computedWorktreePath}
								readOnly
								className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm cursor-default"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textDim,
									opacity: 0.7,
								}}
							/>
						</div>
					)}

					{/* Validation Warnings */}
					{worktreeValidation.checking && (
						<div
							className="flex items-center gap-2 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<div className="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
							Checking worktree...
						</div>
					)}

					{/* Info: Existing worktree with same branch (no mismatch) */}
					{!worktreeValidation.checking &&
						worktreeValidation.exists &&
						!worktreeValidation.branchMismatch &&
						worktreeValidation.sameRepo &&
						worktreeValidation.currentBranch && (
							<div
								className="flex items-center gap-2 p-3 rounded border"
								style={{
									backgroundColor: theme.colors.accent + '10',
									borderColor: theme.colors.accent + '40',
								}}
							>
								<GitBranch className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
								<p className="text-sm" style={{ color: theme.colors.textMain }}>
									Existing worktree on branch "{worktreeValidation.currentBranch}"
								</p>
							</div>
						)}

					{/* Warning: Worktree exists with different branch */}
					{!worktreeValidation.checking &&
						worktreeValidation.exists &&
						worktreeValidation.branchMismatch &&
						worktreeValidation.sameRepo && (
							<div
								className="flex items-start gap-2 p-3 rounded border"
								style={{
									backgroundColor: worktreeValidation.hasUncommittedChanges
										? theme.colors.error + '10'
										: theme.colors.warning + '10',
									borderColor: worktreeValidation.hasUncommittedChanges
										? theme.colors.error
										: theme.colors.warning,
								}}
							>
								<AlertTriangle
									className="w-4 h-4 mt-0.5 shrink-0"
									style={{
										color: worktreeValidation.hasUncommittedChanges
											? theme.colors.error
											: theme.colors.warning,
									}}
								/>
								<div className="text-sm">
									<p
										style={{
											color: worktreeValidation.hasUncommittedChanges
												? theme.colors.error
												: theme.colors.warning,
										}}
									>
										Worktree exists with branch "{worktreeValidation.currentBranch}"
									</p>
									<p style={{ color: theme.colors.textDim }}>
										Will checkout to "{branchName}"
										{worktreeValidation.hasUncommittedChanges && (
											<span style={{ color: theme.colors.error }}>
												{' '}
												(uncommitted changes will block checkout)
											</span>
										)}
									</p>
								</div>
							</div>
						)}

					{/* Error: Worktree belongs to different repo */}
					{!worktreeValidation.checking &&
						worktreeValidation.exists &&
						!worktreeValidation.sameRepo && (
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
									This path contains a worktree for a different repository. Please choose a
									different path.
								</p>
							</div>
						)}

					{/* Create PR on Completion */}
					<div className="pt-2 border-t" style={{ borderColor: theme.colors.border }}>
						{!ghCliStatus?.authenticated ? (
							// gh CLI installed but not authenticated
							<div
								className="flex items-center gap-2 text-xs"
								style={{ color: theme.colors.textDim }}
							>
								<AlertTriangle
									className="w-4 h-4 shrink-0"
									style={{ color: theme.colors.warning }}
								/>
								<span>
									Run{' '}
									<code
										className="px-1 py-0.5 rounded"
										style={{ backgroundColor: theme.colors.bgActivity }}
									>
										gh auth login
									</code>{' '}
									to enable automatic PR creation
								</span>
							</div>
						) : (
							// gh CLI installed and authenticated - show the checkbox
							<div className="flex items-center gap-3">
								<button
									onClick={() => setCreatePROnCompletion(!createPROnCompletion)}
									className="flex items-center gap-2"
								>
									<div
										className={`w-4 h-4 rounded border flex items-center justify-center ${
											createPROnCompletion ? 'bg-accent border-accent' : ''
										}`}
										style={{
											borderColor: createPROnCompletion ? theme.colors.accent : theme.colors.border,
											backgroundColor: createPROnCompletion ? theme.colors.accent : 'transparent',
										}}
									>
										{createPROnCompletion && (
											<svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
												<path
													d="M2 6L5 9L10 3"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										)}
									</div>
									<span className="text-sm" style={{ color: theme.colors.textMain }}>
										Create PR on completion
									</span>
								</button>
								{/* Target branch selector */}
								<div className="relative" ref={branchDropdownRef}>
									<button
										onClick={() => setShowBranchDropdown(!showBranchDropdown)}
										className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textDim }}
										title="Select target branch for PR"
									>
										<span>→</span>
										<span style={{ color: theme.colors.textMain }}>{prTargetBranch}</span>
										<ChevronDown className="w-3 h-3" />
									</button>
									{showBranchDropdown && availableBranches.length > 0 && (
										<div
											className="absolute bottom-full left-0 mb-1 w-48 max-h-48 overflow-y-auto rounded-lg border shadow-xl"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												borderColor: theme.colors.border,
											}}
										>
											{availableBranches.map((branch) => (
												<button
													key={branch}
													onClick={() => {
														setPrTargetBranch(branch);
														setShowBranchDropdown(false);
													}}
													className={`w-full text-left px-3 py-2 text-xs hover:bg-white/10 transition-colors ${
														branch === prTargetBranch ? 'bg-white/5' : ''
													}`}
													style={{
														color:
															branch === prTargetBranch
																? theme.colors.accent
																: theme.colors.textMain,
													}}
												>
													{branch}
												</button>
											))}
										</div>
									)}
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
