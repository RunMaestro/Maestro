import { memo, useMemo, useRef, useState, useCallback } from 'react';
import { ChevronUp, User } from 'lucide-react';
import type { Theme } from '../../types';
import { useClickOutside } from '../../hooks/ui/useClickOutside';

/**
 * Synthetic key used to represent entries with no `userName` - a turn typed at
 * the desktop, where Web Login never applies.
 */
export const DESKTOP_USER_KEY = '__desktop__';

export interface UserSourceFilterProps {
	/**
	 * Counts of entries by user key. Use `DESKTOP_USER_KEY` for entries without
	 * a `userName`. Order is preserved when rendering - pass an already-sorted
	 * Map for stable display.
	 */
	userCounts: Map<string, number>;
	/**
	 * Display label per user key, when the account has a display name that
	 * differs from its username. Missing keys fall back to the key itself.
	 */
	userLabels?: Map<string, string>;
	/** Currently selected user key, or `null` for "all senders". */
	selectedUser: string | null;
	onSelect: (user: string | null) => void;
	theme: Theme;
}

function labelForUser(user: string, labels: Map<string, string> | undefined): string {
	if (user === DESKTOP_USER_KEY) return 'Desktop';
	return labels?.get(user) ?? user;
}

/**
 * Sender picker rendered at the bottom of the History panel, beside the host
 * picker it is modeled on. Defaults to "All Senders"; click to expand a popover
 * anchored above the button. Only rendered by the parent when more than one
 * sender is present in the loaded window - see `HistoryPanel`.
 */
export const UserSourceFilter = memo(function UserSourceFilter({
	userCounts,
	userLabels,
	selectedUser,
	onSelect,
	theme,
}: UserSourceFilterProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useClickOutside(containerRef, () => setOpen(false), open);

	const handleSelect = useCallback(
		(user: string | null) => {
			onSelect(user);
			setOpen(false);
		},
		[onSelect]
	);

	// Trigger label: sender name with parenthesized count when a specific
	// sender is selected; just "All Senders" (no count) when not.
	const triggerLabel = useMemo(() => {
		if (!selectedUser) return 'All Senders';
		const count = userCounts.get(selectedUser) ?? 0;
		return `${labelForUser(selectedUser, userLabels)} (${count})`;
	}, [selectedUser, userCounts, userLabels]);

	return (
		<div ref={containerRef} className="relative">
			{open && (
				<div
					className="absolute left-0 right-0 bottom-full mb-1 rounded border-2 overflow-hidden z-50"
					style={{
						// Same elevation treatment as the host picker: the popover has
						// to read as ABOVE the entry list rather than blending into it.
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.accent,
						boxShadow: `0 8px 24px -4px ${theme.colors.bgMain}, 0 0 0 1px ${theme.colors.bgMain}`,
						backdropFilter: 'blur(8px)',
					}}
				>
					<button
						className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-white/10 transition-colors"
						style={{
							color: selectedUser === null ? theme.colors.accent : theme.colors.textMain,
							fontWeight: selectedUser === null ? 600 : 400,
						}}
						onClick={() => handleSelect(null)}
					>
						<User className="w-3 h-3 flex-shrink-0" />
						<span className="font-mono">All Senders</span>
					</button>
					<div className="h-px" style={{ backgroundColor: theme.colors.border }} />
					{[...userCounts.entries()].map(([user, count]) => {
						const isSelected = user === selectedUser;
						return (
							<button
								key={user}
								className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-white/10 transition-colors"
								style={{
									color: isSelected ? theme.colors.accent : theme.colors.textMain,
									fontWeight: isSelected ? 600 : 400,
								}}
								onClick={() => handleSelect(user)}
							>
								<User className="w-3 h-3 flex-shrink-0" />
								<span className="font-mono truncate min-w-0">
									{labelForUser(user, userLabels)} ({count})
								</span>
							</button>
						);
					})}
				</div>
			)}

			<button
				onClick={() => setOpen((v) => !v)}
				className="w-full px-3 py-1.5 rounded border flex items-center justify-between text-xs transition-colors hover:bg-white/5"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: open ? theme.colors.accent : theme.colors.border,
					color: selectedUser ? theme.colors.accent : theme.colors.textMain,
				}}
				title="Filter by who sent the turn"
			>
				<span className="flex items-center gap-2 min-w-0">
					<User className="w-3 h-3 flex-shrink-0" />
					<span className="font-mono truncate">{triggerLabel}</span>
				</span>
				<ChevronUp
					className="w-3 h-3 flex-shrink-0 transition-transform"
					style={{
						transform: open ? 'rotate(0deg)' : 'rotate(180deg)',
						color: theme.colors.textDim,
					}}
				/>
			</button>
		</div>
	);
});
