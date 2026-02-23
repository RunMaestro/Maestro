import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { GitBranch, Info } from 'lucide-react';
import type { Theme, Session, WorktreeRunTarget } from '../types';
import { gitService } from '../services/git';
import { getStatusColor } from '../utils/theme';

interface WorktreeRunSectionProps {
	theme: Theme;
	activeSession: Session;
	sessions: Session[];
	worktreeTarget: WorktreeRunTarget | null;
	onWorktreeTargetChange: (target: WorktreeRunTarget | null) => void;
	onOpenWorktreeConfig: () => void;
}

export function WorktreeRunSection({
	theme,
	activeSession,
	sessions,
	worktreeTarget,
	onWorktreeTargetChange,
	onOpenWorktreeConfig,
}: WorktreeRunSectionProps) {
	// Worktree children of the active session
	const worktreeChildren = sessions.filter(
		(s) => s.parentSessionId === activeSession.id
	);

	// Detect configuration via new worktreeConfig, legacy worktreeParentPath, or existing children
	const isConfigured = !!(
		activeSession.worktreeConfig ||
		activeSession.worktreeParentPath ||
		worktreeChildren.length > 0
	);
	const isEnabled = worktreeTarget !== null;

	const [createPROnCompletion, setCreatePROnCompletion] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [baseBranch, setBaseBranch] = useState('');
	const [newBranchName, setNewBranchName] = useState('');
	const [selectedValue, setSelectedValue] = useState('');
	const [availableWorktrees, setAvailableWorktrees] = useState<Array<{ path: string; name: string; branch: string | null }>>([]);
	const [isScanning, setIsScanning] = useState(false);
	const [branchLoadError, setBranchLoadError] = useState(false);

	const sshRemoteId = activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;

	// Fetch branches when "Create New Worktree" is selected
	useEffect(() => {
		if (selectedValue !== '__create_new__') return;

		let cancelled = false;
		setBranchLoadError(false);
		gitService.getBranches(activeSession.cwd).then((result) => {
			if (cancelled) return;
			// Sort so main/master appears first
			const sorted = [...result].sort((a, b) => {
				const aIsMain = a === 'main' || a === 'master';
				const bIsMain = b === 'main' || b === 'master';
				if (aIsMain && !bIsMain) return -1;
				if (!aIsMain && bIsMain) return 1;
				return a.localeCompare(b);
			});
			setBranches(sorted);
			if (sorted.length > 0 && !baseBranch) {
				setBaseBranch(sorted[0]);
				const mmdd = `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
				setNewBranchName(`auto-run-${sorted[0]}-${mmdd}`);
			}
		}).catch(() => {
			if (!cancelled) {
				setBranchLoadError(true);
				setBranches([]);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [selectedValue, activeSession.cwd]);

	// Scan for available worktrees on disk when toggle is enabled
	useEffect(() => {
		const basePath = activeSession.worktreeConfig?.basePath;
		if (!isEnabled || !basePath) {
			setAvailableWorktrees([]);
			return;
		}

		let cancelled = false;
		setIsScanning(true);

		window.maestro.git.scanWorktreeDirectory(basePath, sshRemoteId).then((result) => {
			if (cancelled) return;
			// Filter out worktrees already open in Maestro
			const openPaths = new Set(
				worktreeChildren.map((s) => s.cwd)
			);
			const filtered = result.gitSubdirs.filter(
				(wt) => !openPaths.has(wt.path)
			);
			setAvailableWorktrees(filtered);
			setIsScanning(false);
		}).catch(() => {
			if (!cancelled) {
				setAvailableWorktrees([]);
				setIsScanning(false);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [isEnabled, activeSession.worktreeConfig?.basePath, sshRemoteId, worktreeChildren.length]);

	// Detect when no worktrees are available and auto-select "Create New Worktree"
	const hasNoWorktrees = isEnabled && !isScanning && worktreeChildren.length === 0 && availableWorktrees.length === 0;
	useEffect(() => {
		if (hasNoWorktrees && selectedValue !== '__create_new__') {
			setSelectedValue('__create_new__');
			onWorktreeTargetChange({
				mode: 'create-new',
				createPROnCompletion: createPROnCompletion,
			});
		}
	}, [hasNoWorktrees]);

	// Update branch name when base branch changes
	const handleBaseBranchChange = useCallback(
		(branch: string) => {
			setBaseBranch(branch);
			const mmdd = `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
			setNewBranchName(`auto-run-${branch}-${mmdd}`);
		},
		[]
	);

	// Propagate state changes to parent
	const emitChange = useCallback(
		(
			value: string,
			prFlag: boolean
		) => {
			if (value === '__create_new__') {
				onWorktreeTargetChange({
					mode: 'create-new',
					baseBranch: baseBranch || undefined,
					newBranchName: newBranchName || undefined,
					createPROnCompletion: prFlag,
				});
			} else if (value.startsWith('__closed__:')) {
				onWorktreeTargetChange({
					mode: 'existing-closed',
					worktreePath: value.slice('__closed__:'.length),
					createPROnCompletion: prFlag,
				});
			} else if (value) {
				onWorktreeTargetChange({
					mode: 'existing-open',
					sessionId: value,
					createPROnCompletion: prFlag,
				});
			}
		},
		[baseBranch, newBranchName, onWorktreeTargetChange]
	);

	// Keep parent in sync when create-new fields change
	useEffect(() => {
		if (selectedValue === '__create_new__' && isEnabled) {
			onWorktreeTargetChange({
				mode: 'create-new',
				baseBranch: baseBranch || undefined,
				newBranchName: newBranchName || undefined,
				createPROnCompletion: createPROnCompletion,
			});
		}
	}, [baseBranch, newBranchName]);

	const handleToggle = useCallback(() => {
		if (isEnabled) {
			// Turning off
			setSelectedValue('');
			onWorktreeTargetChange(null);
		} else {
			// Turning on — select first available worktree child if any
			const firstAvailable = worktreeChildren.find(
				(s) => s.state !== 'busy' && s.state !== 'connecting'
			);
			const defaultValue = firstAvailable?.id || '__create_new__';
			setSelectedValue(defaultValue);
			if (defaultValue === '__create_new__') {
				onWorktreeTargetChange({
					mode: 'create-new',
					createPROnCompletion: createPROnCompletion,
				});
			} else {
				onWorktreeTargetChange({
					mode: 'existing-open',
					sessionId: defaultValue,
					createPROnCompletion: createPROnCompletion,
				});
			}
		}
	}, [isEnabled, worktreeChildren, createPROnCompletion, onWorktreeTargetChange]);

	const handleSelectChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			const val = e.target.value;
			setSelectedValue(val);
			emitChange(val, createPROnCompletion);
		},
		[emitChange, createPROnCompletion]
	);

	const handlePRChange = useCallback(
		(checked: boolean) => {
			setCreatePROnCompletion(checked);
			if (isEnabled && selectedValue) {
				emitChange(selectedValue, checked);
			}
		},
		[isEnabled, selectedValue, emitChange]
	);

	// Resolve the currently selected open agent for the state indicator
	const selectedOpenAgent = useMemo(() => {
		if (!selectedValue || selectedValue === '__create_new__' || selectedValue.startsWith('__closed__:')) return null;
		return worktreeChildren.find((s) => s.id === selectedValue) || null;
	}, [selectedValue, worktreeChildren]);

	// Compute worktree path preview for create-new mode
	const worktreePathPreview = useMemo(() => {
		const basePath = activeSession.worktreeConfig?.basePath;
		if (!basePath || selectedValue !== '__create_new__' || !newBranchName.trim()) return null;
		return `${basePath}/${newBranchName.trim()}`;
	}, [activeSession.worktreeConfig?.basePath, selectedValue, newBranchName]);

	return (
		<div className="mb-6 flex flex-col gap-3">
			{/* Toggle with info icon */}
			<div className="flex items-center gap-2 self-start">
				<button
					onClick={isConfigured ? handleToggle : undefined}
					disabled={!isConfigured}
					className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-colors ${
						!isConfigured
							? 'opacity-40 cursor-not-allowed'
							: isEnabled
								? 'border-accent'
								: 'border-border hover:bg-white/5'
					}`}
					style={{
						borderColor: isEnabled && isConfigured ? theme.colors.accent : theme.colors.border,
						backgroundColor: isEnabled && isConfigured
							? theme.colors.accent + '15'
							: 'transparent',
					}}
				>
					<GitBranch
						className="w-3.5 h-3.5"
						style={{
							color: isEnabled && isConfigured
								? theme.colors.accent
								: theme.colors.textDim,
						}}
					/>
					<span
						className="text-xs font-medium"
						style={{
							color: isEnabled && isConfigured
								? theme.colors.accent
								: theme.colors.textMain,
						}}
					>
						Run in Worktree
					</span>
				</button>
				<span title="Dispatch this Auto Run to a separate worktree agent instead of the current one">
					<Info
						className="w-3.5 h-3.5 shrink-0"
						style={{ color: theme.colors.textDim }}
					/>
				</span>
			</div>

			{/* Configure prompt when worktrees aren't set up */}
			{!isConfigured && (
				<span
					className="text-xs cursor-pointer hover:underline pl-1"
					style={{ color: theme.colors.accent }}
					onClick={onOpenWorktreeConfig}
				>
					Configure Worktrees to enable this feature →
				</span>
			)}

			{isConfigured && isEnabled && (
				<div className="flex flex-col gap-3 animate-slide-down">
					{/* Agent selector */}
					<select
						value={selectedValue}
						onChange={handleSelectChange}
						className="w-full rounded-lg border px-3 py-1.5 text-sm outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						{worktreeChildren.length > 0 && (
							<optgroup label="Open in Maestro">
								{worktreeChildren.map((s) => {
									const isBusy =
										s.state === 'busy' || s.state === 'connecting';
									return (
										<option
											key={s.id}
											value={s.id}
											disabled={isBusy}
										>
											{s.name}{' '}
											({s.worktreeBranch || 'unknown branch'})
											{isBusy ? ' — busy' : ''}
										</option>
									);
								})}
							</optgroup>
						)}
						{(availableWorktrees.length > 0 || isScanning) && (
							<optgroup label="Available Worktrees">
								{isScanning && (
									<option disabled>Scanning...</option>
								)}
								{availableWorktrees.map((wt) => (
									<option
										key={wt.path}
										value={'__closed__:' + wt.path}
									>
										{wt.branch || wt.name}
									</option>
								))}
							</optgroup>
						)}
						{hasNoWorktrees && (
							<option disabled value="">No worktrees found — create one below</option>
						)}
						<option value="__create_new__">Create New Worktree</option>
					</select>

					{/* State color indicator for selected open agent */}
					{selectedOpenAgent && (
						<div className="flex items-center gap-1.5 pl-1" data-testid="agent-state-indicator">
							<div
								className={`w-2 h-2 rounded-full shrink-0 ${
									selectedOpenAgent.state === 'busy' || selectedOpenAgent.state === 'connecting'
										? 'animate-pulse'
										: ''
								}`}
								style={{
									backgroundColor: getStatusColor(selectedOpenAgent.state, theme),
								}}
							/>
							<span
								className="text-[11px]"
								style={{ color: theme.colors.textDim }}
							>
								{selectedOpenAgent.name} — {
									selectedOpenAgent.state === 'idle' ? 'ready' :
									selectedOpenAgent.state === 'busy' ? 'busy' :
									selectedOpenAgent.state === 'connecting' ? 'connecting' :
									selectedOpenAgent.state === 'error' ? 'error' :
									'waiting'
								}
							</span>
						</div>
					)}

					{/* Create New inputs */}
					{selectedValue === '__create_new__' && (
						<div className="flex flex-col gap-2 pl-1">
							<label className="flex flex-col gap-1">
								<span
									className="text-xs"
									style={{ color: theme.colors.textDim }}
								>
									Base Branch
								</span>
								<select
									value={baseBranch}
									onChange={(e) =>
										handleBaseBranchChange(e.target.value)
									}
									disabled={branchLoadError}
									className="w-full rounded-lg border px-3 py-1.5 text-sm outline-none"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: branchLoadError ? theme.colors.error : theme.colors.border,
										color: theme.colors.textMain,
									}}
								>
									{branches.map((b) => (
										<option key={b} value={b}>
											{b}
										</option>
									))}
								</select>
								{branchLoadError && (
									<span
										className="text-xs"
										style={{ color: theme.colors.error }}
									>
										Could not load branches
									</span>
								)}
							</label>
							<label className="flex flex-col gap-1">
								<span
									className="text-xs"
									style={{ color: theme.colors.textDim }}
								>
									Branch Name
								</span>
								<input
									type="text"
									value={newBranchName}
									onChange={(e) =>
										setNewBranchName(e.target.value)
									}
									className="w-full rounded-lg border px-3 py-1.5 text-sm outline-none"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: !newBranchName.trim() ? theme.colors.warning : theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
								{!newBranchName.trim() && (
									<span
										className="text-xs"
										style={{ color: theme.colors.warning }}
									>
										Branch name is required
									</span>
								)}
								{worktreePathPreview && (
									<span
										className="text-[10px] font-mono truncate"
										style={{ color: theme.colors.textDim, opacity: 0.7 }}
										title={worktreePathPreview}
									>
										{worktreePathPreview}
									</span>
								)}
							</label>
						</div>
					)}

					{/* PR Checkbox */}
					<label className="flex items-center gap-2 cursor-pointer">
						<div
							className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
							role="checkbox"
							aria-checked={createPROnCompletion}
							tabIndex={0}
							style={{
								borderColor: createPROnCompletion
									? theme.colors.accent
									: theme.colors.border,
								backgroundColor: createPROnCompletion
									? theme.colors.accent
									: 'transparent',
							}}
							onClick={(e) => {
								e.preventDefault();
								handlePRChange(!createPROnCompletion);
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									handlePRChange(!createPROnCompletion);
								}
							}}
						>
							{createPROnCompletion && (
								<svg
									className="w-3 h-3 text-white"
									viewBox="0 0 12 12"
									fill="none"
								>
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
							className="text-xs"
							style={{ color: theme.colors.textDim }}
							onClick={() => handlePRChange(!createPROnCompletion)}
						>
							Automatically create PR when complete
						</span>
					</label>
				</div>
			)}
		</div>
	);
}
