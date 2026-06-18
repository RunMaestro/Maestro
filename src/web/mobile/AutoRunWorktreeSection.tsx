/**
 * AutoRunWorktreeSection — mobile counterpart to desktop's WorktreeRunSection.
 *
 * Lets the user toggle "Dispatch to a separate worktree" before launching an
 * Auto Run, pick a base branch from the session's git repo, name the new
 * branch, and optionally request a PR on completion. The composed config is
 * sent to the desktop via `configure_auto_run`'s `worktree` field — the
 * desktop handles the actual `git worktree add` + checkout + (optionally) PR
 * creation, exactly the same path the desktop's WorktreeRunSection feeds.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { sanitizeGitBranchName } from '../../shared/gitUtils';
import { webLogger } from '../utils/logger';
import type { LaunchWorktreeConfig, WorktreeSummary } from '../hooks/useAutoRun';

/**
 * Discriminated state emitted by `AutoRunWorktreeSection.onChange` so the
 * parent sheet can distinguish "user left this off" from "user enabled it but
 * the form is invalid" — only the former should silently fall back to a normal
 * Auto Run launch. `enabled-loading` is the brief window between toggle-on and
 * `loadBranches()` resolving; the parent should disable launch but suppress
 * "branch name required" warnings during this period.
 */
export type AutoRunWorktreeState =
	| { status: 'disabled' }
	| { status: 'enabled-loading' }
	| { status: 'enabled-valid'; config: LaunchWorktreeConfig }
	| { status: 'enabled-invalid'; reason: string };

export interface AutoRunWorktreeSectionProps {
	/** Whether the session's cwd is a git repo (gates the section). */
	isGitRepo: boolean;
	/** Base path where worktrees are stored (configured on desktop). */
	worktreeBasePath: string | null;
	/** Loader for the base-branch picker. */
	loadBranches: () => Promise<{ branches: string[]; currentBranch?: string }>;
	/** Loader for existing worktrees on disk (currently informational only). */
	loadWorktrees: () => Promise<WorktreeSummary[]>;
	/** Emits the composed worktree state (disabled / valid / invalid). */
	onChange: (state: AutoRunWorktreeState) => void;
}

function buildDefaultBranchName(baseBranch: string): string {
	const today = new Date();
	const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(
		2,
		'0'
	)}`;
	return sanitizeGitBranchName(`auto-run-${baseBranch}-${mmdd}`, { allowIncomplete: true });
}

export function AutoRunWorktreeSection({
	isGitRepo,
	worktreeBasePath,
	loadBranches,
	loadWorktrees,
	onChange,
}: AutoRunWorktreeSectionProps) {
	const colors = useThemeColors();

	const isConfigured = isGitRepo && !!worktreeBasePath;

	const [enabled, setEnabled] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [baseBranch, setBaseBranch] = useState('');
	const [newBranchName, setNewBranchName] = useState('');
	const [createPR, setCreatePR] = useState(false);
	const [branchLoadStatus, setBranchLoadStatus] = useState<'idle' | 'loading' | 'error'>('idle');
	const [existingWorktrees, setExistingWorktrees] = useState<WorktreeSummary[]>([]);

	// Fetch branches when toggled on so the picker is populated.
	useEffect(() => {
		if (!enabled || !isConfigured) return;
		let cancelled = false;
		setBranchLoadStatus('loading');

		loadBranches()
			.then(({ branches: list, currentBranch }) => {
				if (cancelled) return;
				const sorted = [...list].sort((a, b) => {
					if (currentBranch) {
						if (a === currentBranch && b !== currentBranch) return -1;
						if (a !== currentBranch && b === currentBranch) return 1;
					}
					const aIsMain = a === 'main' || a === 'master';
					const bIsMain = b === 'main' || b === 'master';
					if (aIsMain && !bIsMain) return -1;
					if (!aIsMain && bIsMain) return 1;
					return a.localeCompare(b);
				});
				setBranches(sorted);
				if (sorted.length > 0) {
					const defaultBranch = currentBranch || sorted[0];
					setBaseBranch(defaultBranch);
					setNewBranchName(buildDefaultBranchName(defaultBranch));
					setBranchLoadStatus('idle');
				} else {
					setBranchLoadStatus('error');
				}
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				webLogger.error(
					`Failed to load branches: ${err instanceof Error ? err.message : String(err)}`,
					'AutoRunWorktreeSection'
				);
				setBranches([]);
				setBranchLoadStatus('error');
			});

		return () => {
			cancelled = true;
		};
	}, [enabled, isConfigured, loadBranches]);

	// Surface existing worktrees as informational chips so the user knows what
	// already exists before naming a new one. Failures here are non-fatal — the
	// chip just stays hidden — but we still log so we don't lose the signal.
	useEffect(() => {
		if (!enabled || !isConfigured) {
			setExistingWorktrees([]);
			return;
		}
		let cancelled = false;
		loadWorktrees()
			.then((list) => {
				if (cancelled) return;
				setExistingWorktrees(list);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				webLogger.error(
					`Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`,
					'AutoRunWorktreeSection'
				);
				setExistingWorktrees([]);
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, isConfigured, loadWorktrees]);

	// Compute path preview from basePath + branchName (matches desktop's behavior).
	const worktreePathPreview = useMemo(() => {
		if (!enabled || !worktreeBasePath || !newBranchName.trim()) return null;
		const trimmed = worktreeBasePath.replace(/\/+$/, '');
		return `${trimmed}/${newBranchName.trim()}`;
	}, [enabled, worktreeBasePath, newBranchName]);

	// Propagate the discriminated state to the parent whenever any field
	// changes. The parent uses `status === 'enabled-invalid'` to block launch
	// instead of silently falling back to a non-worktree run.
	useEffect(() => {
		if (!enabled || !isConfigured) {
			onChange({ status: 'disabled' });
			return;
		}
		// While branches are still loading — including the brief gap between
		// toggle-on and `setBranchLoadStatus('loading')` actually committing —
		// `newBranchName` is empty and `baseBranch` is unset. Don't fire
		// spurious "Branch name is required" / "Base branch is required"
		// warnings during that window. The successful-load handler populates
		// `branches` and the failure handler flips to `error`, so an empty
		// `branches` array with no error means we haven't completed a load yet.
		if (branchLoadStatus === 'error') {
			onChange({ status: 'enabled-invalid', reason: 'Could not load branches' });
			return;
		}
		if (branches.length === 0) {
			onChange({ status: 'enabled-loading' });
			return;
		}
		const branchClean = newBranchName.trim();
		if (!branchClean) {
			onChange({ status: 'enabled-invalid', reason: 'Branch name is required' });
			return;
		}
		if (!worktreePathPreview) {
			onChange({ status: 'enabled-invalid', reason: 'Worktree path could not be computed' });
			return;
		}
		// Guard against PR creation with an empty target branch. Without this,
		// "Create PR on completion" can latch on before loadBranches resolves
		// (baseBranch is still '') and emit a config that the desktop's PR
		// creation step would silently dispatch with prTargetBranch: ''.
		if (createPR && !baseBranch) {
			onChange({ status: 'enabled-invalid', reason: 'Base branch is required for PR creation' });
			return;
		}
		onChange({
			status: 'enabled-valid',
			config: {
				enabled: true,
				path: worktreePathPreview,
				branchName: branchClean,
				createPROnCompletion: createPR,
				prTargetBranch: baseBranch,
			},
		});
	}, [
		enabled,
		isConfigured,
		branchLoadStatus,
		branches,
		worktreePathPreview,
		newBranchName,
		baseBranch,
		createPR,
		onChange,
	]);

	const handleToggle = useCallback(() => {
		if (!isConfigured) return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setEnabled((prev) => !prev);
	}, [isConfigured]);

	const handleBaseBranchChange = useCallback((branch: string) => {
		setBaseBranch(branch);
		setNewBranchName(buildDefaultBranchName(branch));
	}, []);

	const handleBranchNameChange = useCallback((value: string) => {
		setNewBranchName(sanitizeGitBranchName(value, { allowIncomplete: true }));
	}, []);

	const handleCreatePRChange = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setCreatePR((prev) => !prev);
	}, []);

	if (!isGitRepo) {
		// Hidden entirely for non-git sessions — matches desktop UX.
		return null;
	}

	// Don't surface "Branch name is required" while branches are still loading —
	// the input populates from the seeded default once loadBranches resolves.
	// Without this gate, the warning flashes briefly on every toggle-on.
	const branchNameMissing = enabled && branchLoadStatus !== 'loading' && !newBranchName.trim();

	return (
		<div style={{ marginBottom: '20px' }}>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: '10px',
				}}
			>
				<span
					style={{
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
					}}
				>
					Run in Worktree
				</span>
			</div>

			<button
				onClick={handleToggle}
				disabled={!isConfigured}
				role="switch"
				aria-checked={enabled}
				aria-label="Dispatch to a separate worktree"
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					width: '100%',
					padding: '12px 14px',
					borderRadius: '10px',
					border: `1px solid ${enabled && isConfigured ? colors.accent : colors.border}`,
					backgroundColor: enabled && isConfigured ? `${colors.accent}10` : colors.bgSidebar,
					color: colors.textMain,
					cursor: isConfigured ? 'pointer' : 'not-allowed',
					opacity: isConfigured ? 1 : 0.5,
					touchAction: 'manipulation',
					WebkitTapHighlightColor: 'transparent',
					outline: 'none',
					minHeight: '44px',
				}}
			>
				<span style={{ fontSize: '14px', fontWeight: 500 }}>Dispatch to a separate worktree</span>
				<div
					style={{
						width: '44px',
						height: '26px',
						borderRadius: '13px',
						backgroundColor: enabled && isConfigured ? colors.accent : `${colors.textDim}30`,
						padding: '2px',
						transition: 'background-color 0.2s ease',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '22px',
							height: '22px',
							borderRadius: '11px',
							backgroundColor: 'white',
							transition: 'transform 0.2s ease',
							transform: enabled && isConfigured ? 'translateX(18px)' : 'translateX(0)',
							boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
						}}
					/>
				</div>
			</button>

			{!isConfigured && (
				<div
					style={{
						fontSize: '12px',
						color: colors.textDim,
						marginTop: '8px',
						paddingLeft: '4px',
					}}
				>
					Configure a Worktree base path on the desktop to enable this option.
				</div>
			)}

			{enabled && isConfigured && (
				<div
					data-testid="worktree-config-panel"
					style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}
				>
					{/* Base branch */}
					<label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
						<span style={{ fontSize: '12px', color: colors.textDim }}>Base Branch</span>
						<select
							value={baseBranch}
							onChange={(e) => handleBaseBranchChange(e.target.value)}
							disabled={branches.length === 0}
							aria-label="Base branch"
							style={{
								width: '100%',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${branchLoadStatus === 'error' ? colors.error : colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								fontSize: '14px',
								outline: 'none',
								WebkitAppearance: 'none',
								boxSizing: 'border-box',
								minHeight: '44px',
							}}
						>
							{branches.length === 0 && (
								<option value="">
									{branchLoadStatus === 'error' ? 'Failed to load' : 'Loading...'}
								</option>
							)}
							{branches.map((b) => (
								<option key={b} value={b}>
									{b}
								</option>
							))}
						</select>
						{branchLoadStatus === 'error' && (
							<span style={{ fontSize: '12px', color: colors.error }}>Could not load branches</span>
						)}
					</label>

					{/* New branch name */}
					<label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
						<span style={{ fontSize: '12px', color: colors.textDim }}>Worktree Branch Name</span>
						<input
							type="text"
							value={newBranchName}
							onChange={(e) => handleBranchNameChange(e.target.value)}
							aria-label="Worktree branch name"
							style={{
								width: '100%',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${branchNameMissing ? colors.warning : colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								fontSize: '14px',
								outline: 'none',
								WebkitAppearance: 'none',
								boxSizing: 'border-box',
								minHeight: '44px',
							}}
						/>
						{branchNameMissing && (
							<span style={{ fontSize: '12px', color: colors.warning }}>
								Branch name is required
							</span>
						)}
						{worktreePathPreview && (
							<span
								style={{
									fontSize: '11px',
									fontFamily: 'monospace',
									color: colors.textDim,
									opacity: 0.7,
									wordBreak: 'break-all',
								}}
								title={worktreePathPreview}
							>
								{worktreePathPreview}
							</span>
						)}
					</label>

					{existingWorktrees.length > 0 && (
						<div
							style={{
								fontSize: '11px',
								color: colors.textDim,
								padding: '6px 10px',
								borderRadius: '8px',
								backgroundColor: colors.bgSidebar,
								border: `1px solid ${colors.border}`,
							}}
						>
							{existingWorktrees.length} existing worktree
							{existingWorktrees.length === 1 ? '' : 's'} —{' '}
							{existingWorktrees
								.map((w) => w.branch || w.path.split('/').pop() || w.path)
								.slice(0, 3)
								.join(', ')}
							{existingWorktrees.length > 3 ? '…' : ''}
						</div>
					)}

					{/* Create PR checkbox */}
					<button
						onClick={handleCreatePRChange}
						role="checkbox"
						aria-checked={createPR}
						aria-label="Automatically create PR when complete"
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '12px',
							padding: '12px 14px',
							borderRadius: '10px',
							border: `1px solid ${createPR ? colors.accent : colors.border}`,
							backgroundColor: createPR ? `${colors.accent}10` : colors.bgSidebar,
							color: colors.textMain,
							width: '100%',
							textAlign: 'left',
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							outline: 'none',
							minHeight: '44px',
						}}
					>
						<div
							style={{
								width: '22px',
								height: '22px',
								borderRadius: '6px',
								border: `2px solid ${createPR ? colors.accent : colors.textDim}`,
								backgroundColor: createPR ? colors.accent : 'transparent',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								flexShrink: 0,
							}}
						>
							{createPR && (
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="white"
									strokeWidth="3"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
							)}
						</div>
						<span style={{ fontSize: '14px', fontWeight: 500 }}>
							Automatically create PR when complete
						</span>
					</button>
				</div>
			)}
		</div>
	);
}

export default AutoRunWorktreeSection;
