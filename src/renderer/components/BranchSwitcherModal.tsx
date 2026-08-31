/**
 * BranchSwitcherModal - fuzzy branch picker for the header git pill.
 *
 * Same interaction model as the command palette: type to fuzzy-filter, arrow
 * keys to move, Enter to check out. Checkout failures (dirty tree, conflicting
 * local changes) are shown inline instead of closing the modal, so the user can
 * read git's reason and pick another branch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, GitBranch, Search } from 'lucide-react';
import { Modal, ModalSubtitle } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { EscCloseButton } from './ui/EscCloseButton';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { fuzzyMatchWithScore } from '../utils/search';
import { useListNavigation } from '../hooks';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { useGitDetail } from '../contexts/GitStatusContext';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useSessionStore } from '../stores/sessionStore';
import type { BranchSwitcherModalData } from '../stores/modalStore';
import type { Theme } from '../types';

export interface BranchSwitcherModalProps {
	theme: Theme;
	data: BranchSwitcherModalData;
	onClose: () => void;
}

/** git's message when a name matches no local branch - i.e. it lives on origin only. */
function isUnknownBranchError(error: string): boolean {
	return /did not match any file|pathspec|unknown revision/i.test(error);
}

export function BranchSwitcherModal({ theme, data, onClose }: BranchSwitcherModalProps) {
	const { sessionId, cwd, sshRemoteId, currentBranch } = data;
	const { refreshGitStatus } = useGitDetail();

	// Whose repo is about to change branches. Reachable by right-clicking any
	// Left Bar row, so the target is often not the highlighted agent, and this
	// modal's `customHeader` is a bare search field that names nothing.
	// Subscribe to the name alone, never the Session - a whole-session
	// subscription would re-render this list on every unrelated token update.
	const agentName = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.name);

	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState('');
	const [checkingOut, setCheckingOut] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const inputRef = useRef<HTMLInputElement>(null);
	useFocusOnMount(inputRef);

	useEffect(() => {
		let cancelled = false;
		void gitService.getBranches(cwd, sshRemoteId).then((result) => {
			if (cancelled) return;
			setBranches(result);
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [cwd, sshRemoteId]);

	const filtered = useMemo(() => {
		const query = search.trim();
		if (!query) {
			// Current branch first, then alphabetical - the list you'd expect
			// before you've typed anything.
			return [...branches].sort((a, b) => {
				if (a === currentBranch) return -1;
				if (b === currentBranch) return 1;
				return a.localeCompare(b);
			});
		}
		return branches
			.map((branch) => ({ branch, ...fuzzyMatchWithScore(branch, query) }))
			.filter((r) => r.matches)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.branch);
	}, [branches, search, currentBranch]);

	const handleCheckout = useCallback(
		async (branch: string) => {
			if (!branch || branch === currentBranch) {
				onClose();
				return;
			}
			setCheckingOut(branch);
			setError(null);
			let result = await gitService.checkoutBranch(cwd, branch, false, sshRemoteId);
			// Older gits (or repos with checkout.guess disabled) won't auto-create a
			// tracking branch for an origin-only name - do it explicitly.
			if (!result.success && isUnknownBranchError(result.error ?? '')) {
				result = await gitService.checkoutBranch(cwd, branch, true, sshRemoteId);
			}
			setCheckingOut(null);
			if (!result.success) {
				setError(result.error || 'Checkout failed');
				return;
			}
			await refreshGitStatus();
			notifyCenterFlash({ message: `Switched to ${branch}`, color: 'theme' });
			onClose();
		},
		[cwd, sshRemoteId, currentBranch, refreshGitStatus, onClose]
	);

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: filtered.length,
		onSelect: (index) => {
			const branch = filtered[index];
			if (branch) void handleCheckout(branch);
		},
		enabled: !checkingOut,
	});

	/**
	 * Keep the selected branch in view.
	 *
	 * A STABLE ref plus an effect keyed on the selection, not an inline arrow ref
	 * on the row. An inline arrow is a new identity on every render, so React
	 * detaches and reattaches it - and therefore re-scrolls - on every render,
	 * including renders caused by hovering a different row or typing in the
	 * search box. Deleting the old ref outright was not an option here: unlike
	 * FileSearchModal there is no virtualizer `scrollToIndex` to fall back on, so
	 * that would have removed keyboard follow entirely.
	 *
	 * `block: 'nearest'` with no smooth animation, so a row already on screen
	 * does not slide under the pointer.
	 */
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
	}, [selectedIndex]);

	return (
		<Modal
			theme={theme}
			title="Switch Branch"
			// No `subtitle` here on purpose: `customHeader` REPLACES the default
			// header entirely, so the prop would never render. The agent name is
			// in the custom header below instead.
			priority={MODAL_PRIORITIES.BRANCH_SWITCHER}
			onClose={onClose}
			width={520}
			maxHeight="70vh"
			resizeKey="modal-branch-switcher"
			defaultSize={{ width: 520, height: 420 }}
			minSize={{ width: 360, height: 240 }}
			closeOnBackdropClick
			testId="branch-switcher-modal"
			contentClassName="flex-1 min-h-0 flex flex-col"
			customHeader={
				<div
					className="p-4 border-b flex items-center gap-3 shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					<input
						ref={inputRef}
						className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
						placeholder="Switch to branch..."
						style={{ color: theme.colors.textMain }}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={handleKeyDown}
						data-testid="branch-switcher-input"
					/>
					<ModalSubtitle theme={theme} subtitle={agentName} />
					<EscCloseButton theme={theme} onClose={onClose} />
				</div>
			}
		>
			{error && (
				<div
					className="px-4 py-2 text-xs border-b select-text"
					style={{ color: theme.colors.error, borderColor: theme.colors.border }}
					data-testid="branch-switcher-error"
				>
					{error}
				</div>
			)}

			<div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin py-2 select-none">
				{loading && (
					<div
						className="flex items-center gap-2 px-4 py-3 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						<Spinner size={14} />
						Loading branches...
					</div>
				)}

				{!loading && filtered.length === 0 && (
					<div className="px-4 py-3 text-sm" style={{ color: theme.colors.textDim }}>
						{branches.length === 0 ? 'No branches found' : 'No branches match your search'}
					</div>
				)}

				{filtered.map((branch, index) => {
					const isSelected = index === selectedIndex;
					const isCurrent = branch === currentBranch;
					return (
						<button
							key={branch}
							ref={isSelected ? selectedItemRef : undefined}
							onClick={() => void handleCheckout(branch)}
							onMouseEnter={() => setSelectedIndex(index)}
							className="w-full text-left px-4 py-2 flex items-center gap-3 transition-colors outline-none"
							style={{
								backgroundColor: isSelected ? theme.colors.accentDim : 'transparent',
								color: theme.colors.textMain,
							}}
						>
							<GitBranch
								className="w-3.5 h-3.5 shrink-0"
								style={{ color: isCurrent ? theme.colors.accent : theme.colors.textDim }}
							/>
							<span className="font-mono text-sm truncate">{branch}</span>
							{isCurrent && (
								<span
									className="ml-auto flex items-center gap-1 text-[10px] uppercase font-bold shrink-0"
									style={{ color: theme.colors.accent }}
								>
									<Check className="w-3 h-3" />
									Current
								</span>
							)}
							{checkingOut === branch && <Spinner size={12} className="ml-auto shrink-0" />}
						</button>
					);
				})}
			</div>
		</Modal>
	);
}

export default BranchSwitcherModal;
