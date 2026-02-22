import React, { useState, useEffect, useCallback } from 'react';
import { GitBranch } from 'lucide-react';
import type { Theme, Session, WorktreeRunTarget } from '../types';
import { gitService } from '../services/git';

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
	const isConfigured = !!activeSession.worktreeConfig;
	const isEnabled = worktreeTarget !== null;

	const [createPROnCompletion, setCreatePROnCompletion] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [baseBranch, setBaseBranch] = useState('');
	const [newBranchName, setNewBranchName] = useState('');
	const [selectedValue, setSelectedValue] = useState('');

	// Worktree children of the active session
	const worktreeChildren = sessions.filter(
		(s) => s.parentSessionId === activeSession.id
	);

	// Fetch branches when "Create New Worktree" is selected
	useEffect(() => {
		if (selectedValue !== '__create_new__') return;

		let cancelled = false;
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
		});

		return () => {
			cancelled = true;
		};
	}, [selectedValue, activeSession.cwd]); // eslint-disable-line react-hooks/exhaustive-deps

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
	}, [baseBranch, newBranchName]); // eslint-disable-line react-hooks/exhaustive-deps

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

	// Not-configured state
	if (!isConfigured) {
		return (
			<div className="mb-6">
				<span
					className="text-sm cursor-pointer hover:underline"
					style={{ color: theme.colors.accent }}
					onClick={onOpenWorktreeConfig}
				>
					Configure Worktrees to enable this feature →
				</span>
			</div>
		);
	}

	return (
		<div className="mb-6 flex flex-col gap-3">
			{/* Toggle */}
			<button
				onClick={handleToggle}
				className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-colors self-start ${
					isEnabled ? 'border-accent' : 'border-border hover:bg-white/5'
				}`}
				style={{
					borderColor: isEnabled ? theme.colors.accent : theme.colors.border,
					backgroundColor: isEnabled
						? theme.colors.accent + '15'
						: 'transparent',
				}}
			>
				<GitBranch
					className="w-3.5 h-3.5"
					style={{
						color: isEnabled
							? theme.colors.accent
							: theme.colors.textDim,
					}}
				/>
				<span
					className="text-xs font-medium"
					style={{
						color: isEnabled
							? theme.colors.accent
							: theme.colors.textMain,
					}}
				>
					Run in Worktree
				</span>
			</button>

			{isEnabled && (
				<>
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
						<option value="__create_new__">Create New Worktree</option>
					</select>

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
									className="w-full rounded-lg border px-3 py-1.5 text-sm outline-none"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								>
									{branches.map((b) => (
										<option key={b} value={b}>
											{b}
										</option>
									))}
								</select>
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
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
							</label>
						</div>
					)}

					{/* PR Checkbox */}
					<label className="flex items-center gap-2 cursor-pointer">
						<div
							className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
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
				</>
			)}
		</div>
	);
}
