import { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, GitBranch, Search, Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { gitService } from '../../services/git';
import { notifyToast } from '../../stores/notificationStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';

interface BranchSwitcherDropdownProps {
	cwd: string;
	currentBranch: string;
	theme: Theme;
	sshRemoteId?: string;
	/** Element the dropdown should be anchored under. Required for portal positioning. */
	anchorEl: HTMLElement | null;
	onClose: () => void;
	onSwitched: () => void;
}

const DROPDOWN_WIDTH = 320;

export function BranchSwitcherDropdown({
	cwd,
	currentBranch,
	theme,
	sshRemoteId,
	anchorEl,
	onClose,
	onSwitched,
}: BranchSwitcherDropdownProps) {
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState('');
	const [highlight, setHighlight] = useState(0);
	const [switching, setSwitching] = useState<string | null>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useModalLayer(MODAL_PRIORITIES.BRANCH_SWITCHER, 'Branch switcher', onClose, {
		focusTrap: 'lenient',
		blocksLowerLayers: false,
	});

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		gitService
			.getBranches(cwd, sshRemoteId)
			.then((b) => {
				if (cancelled) return;
				setBranches(b);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, sshRemoteId]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Compute viewport position from anchor rect; recompute on resize/scroll.
	useLayoutEffect(() => {
		if (!anchorEl) return;
		const update = () => {
			const r = anchorEl.getBoundingClientRect();
			const left = Math.max(8, Math.min(r.left, window.innerWidth - DROPDOWN_WIDTH - 8));
			setPos({ top: r.bottom + 6, left });
		};
		update();
		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);
		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('scroll', update, true);
		};
	}, [anchorEl]);

	// Click-outside to close (ignore clicks on the anchor itself).
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (containerRef.current?.contains(target)) return;
			if (anchorEl?.contains(target)) return;
			onClose();
		};
		const id = window.setTimeout(() => window.addEventListener('mousedown', handler), 0);
		return () => {
			window.clearTimeout(id);
			window.removeEventListener('mousedown', handler);
		};
	}, [onClose, anchorEl]);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return branches;
		return branches.filter((b) => b.toLowerCase().includes(q));
	}, [branches, filter]);

	useEffect(() => {
		setHighlight(0);
	}, [filter]);

	const doSwitch = useCallback(
		async (branch: string) => {
			if (branch === currentBranch || switching) return;
			setSwitching(branch);
			try {
				const result = await gitService.switchBranch(cwd, branch, sshRemoteId);
				if (result.success) {
					notifyCenterFlash({
						message: `Switched to ${branch}`,
						color: 'green',
					});
					onSwitched();
					onClose();
				} else {
					notifyToast({
						color: 'red',
						title: 'Branch switch failed',
						message: result.stderr.trim() || 'git switch returned a non-zero exit code.',
						dismissible: true,
					});
				}
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Branch switch failed',
					message: err instanceof Error ? err.message : String(err),
					dismissible: true,
				});
			} finally {
				setSwitching(null);
			}
		},
		[cwd, sshRemoteId, currentBranch, switching, onSwitched, onClose]
	);

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setHighlight((h) => Math.min(h + 1, filtered.length - 1));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setHighlight((h) => Math.max(h - 1, 0));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const target = filtered[highlight];
			if (target) doSwitch(target);
		}
	};

	if (!pos) return null;

	const dropdown = (
		<div
			ref={containerRef}
			className="rounded shadow-xl"
			style={{
				position: 'fixed',
				top: pos.top,
				left: pos.left,
				width: DROPDOWN_WIDTH,
				zIndex: 9999,
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
			}}
			role="dialog"
			aria-label="Switch branch"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Search */}
			<div
				className="flex items-center gap-2 px-3 py-2 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				<input
					ref={inputRef}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Filter branches…"
					className="flex-1 bg-transparent outline-none text-sm"
					style={{ color: theme.colors.textMain }}
				/>
			</div>

			{/* List */}
			<div className="max-h-72 overflow-y-auto py-1">
				{loading ? (
					<div className="px-3 py-4 flex items-center justify-center">
						<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
					</div>
				) : filtered.length === 0 ? (
					<div className="px-3 py-4 text-xs text-center" style={{ color: theme.colors.textDim }}>
						No matching branches
					</div>
				) : (
					filtered.map((branch, i) => {
						const isCurrent = branch === currentBranch;
						const isHighlighted = i === highlight;
						const isSwitching = switching === branch;
						return (
							<button
								key={branch}
								onMouseEnter={() => setHighlight(i)}
								onClick={() => doSwitch(branch)}
								disabled={isCurrent || !!switching}
								className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
									isCurrent ? 'cursor-default' : 'cursor-pointer'
								}`}
								style={{
									backgroundColor: isHighlighted ? theme.colors.bgActivity : 'transparent',
									color: isCurrent ? theme.colors.textDim : theme.colors.textMain,
								}}
								title={isCurrent ? 'Already on this branch' : `Switch to ${branch}`}
							>
								<GitBranch className="w-3 h-3 shrink-0 text-orange-500" />
								<span className="font-mono truncate flex-1">{branch}</span>
								{isSwitching && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
								{isCurrent && !isSwitching && (
									<Check className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
								)}
							</button>
						);
					})
				)}
			</div>

			{/* Footer */}
			<div
				className="px-3 py-1.5 border-t text-[10px] flex items-center justify-between"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<span>↑↓ navigate · Enter switch · Esc close</span>
				<span>{filtered.length}</span>
			</div>
		</div>
	);

	return createPortal(dropdown, document.body);
}
