import { useRef, useState, useEffect, useCallback } from 'react';
import { ListOrdered, Command, MessageSquare } from 'lucide-react';
import type { Session, Theme } from '../types';

interface ExecutionQueueIndicatorProps {
	session: Session;
	theme: Theme;
	onClick: () => void; // Opens the ExecutionQueueBrowser modal
	onSwitchTab?: (sessionId: string, tabId?: string) => void; // Jumps to a specific tab
}

/**
 * Compact indicator showing the number of items queued for execution.
 * Appears above the input area when items are queued.
 * Clicking the left ("N items queued") or right ("Click to view") regions opens
 * the ExecutionQueueBrowser modal for full queue management. Clicking an
 * individual tab pill jumps to that tab.
 */
export function ExecutionQueueIndicator({
	session,
	theme,
	onClick,
	onSwitchTab,
}: ExecutionQueueIndicatorProps) {
	const queue = session.executionQueue || [];
	const containerRef = useRef<HTMLDivElement>(null);
	const [maxVisiblePills, setMaxVisiblePills] = useState(3);

	// Count items by type
	const messageCount = queue.filter((item) => item.type === 'message').length;
	const commandCount = queue.filter((item) => item.type === 'command').length;

	// Group by tab to show tab-specific counts. Keyed by tabId so a pill can jump
	// to its tab; tabName is kept for display.
	const tabGroups = queue.reduce(
		(acc, item) => {
			const tabId = item.tabId || 'unknown';
			if (!acc[tabId]) {
				acc[tabId] = { tabId, tabName: item.tabName || 'Unknown', count: 0 };
			}
			acc[tabId].count += 1;
			return acc;
		},
		{} as Record<string, { tabId: string; tabName: string; count: number }>
	);

	const tabs = Object.values(tabGroups);

	// Calculate how many pills we can show and their max width based on available space
	const [maxPillWidth, setMaxPillWidth] = useState<number | null>(null);

	const calculateMaxPills = useCallback(() => {
		if (!containerRef.current) return;

		const containerWidth = containerRef.current.clientWidth;

		// Fixed elements take roughly:
		// - Icon: ~20px
		// - "X items queued": ~100px
		// - Tab count icon: ~30px
		// - Type breakdown: ~60px
		// - "Click to view": ~80px
		// - Gaps and padding: ~50px
		// Total fixed: ~340px
		const fixedWidth = 340;

		// "+N" indicator is roughly 30px
		const plusIndicatorWidth = 30;

		const availableWidth = containerWidth - fixedWidth - plusIndicatorWidth;

		// Calculate how many pills to show and their width
		const numTabs = tabs.length;
		if (numTabs === 0) {
			setMaxVisiblePills(0);
			setMaxPillWidth(null);
			return;
		}

		// Minimum pill width (padding + some text)
		const minPillWidth = 60;
		// Maximum pills to show
		const maxPossiblePills = Math.min(5, numTabs);

		// Try to fit as many pills as possible, starting from max
		let pillsToShow = maxPossiblePills;
		let pillWidth: number | null = null;

		for (let n = maxPossiblePills; n >= 1; n--) {
			const widthPerPill = availableWidth / n;
			if (widthPerPill >= minPillWidth) {
				pillsToShow = n;
				// Only set max width if we need to constrain (when there's overflow potential)
				pillWidth = widthPerPill > 200 ? null : widthPerPill;
				break;
			}
		}

		// If even 1 pill doesn't fit, show 0 pills
		if (availableWidth < minPillWidth) {
			pillsToShow = 0;
			pillWidth = null;
		}

		setMaxVisiblePills(pillsToShow);
		setMaxPillWidth(pillWidth);
	}, [tabs.length]);

	// Use ResizeObserver to recalculate when container size changes
	useEffect(() => {
		if (!containerRef.current) return;

		const observer = new ResizeObserver(() => {
			calculateMaxPills();
		});

		observer.observe(containerRef.current);

		// Initial calculation
		calculateMaxPills();

		return () => observer.disconnect();
	}, [calculateMaxPills, queue.length, tabs.length]);

	if (queue.length === 0) {
		return null;
	}

	return (
		<div
			ref={containerRef}
			className="w-full mb-2 px-3 py-2 rounded-lg border flex items-center gap-2 text-sm"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
		>
			{/* Left region: opens the queue browser */}
			<button
				type="button"
				onClick={onClick}
				className="flex items-center gap-2 transition-all hover:opacity-90"
				title="View execution queue"
			>
				<ListOrdered className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.warning }} />

				<span className="text-left whitespace-nowrap">
					<span className="font-semibold">{queue.length}</span>{' '}
					{queue.length === 1 ? 'item' : 'items'} queued
				</span>

				{/* Item type breakdown */}
				<div className="flex items-center gap-2 text-xs opacity-70 flex-shrink-0">
					{messageCount > 0 && (
						<span className="flex items-center gap-1">
							<MessageSquare className="w-3 h-3" />
							{messageCount}
						</span>
					)}
					{commandCount > 0 && (
						<span className="flex items-center gap-1">
							<Command className="w-3 h-3" />
							{commandCount}
						</span>
					)}
				</div>
			</button>

			{/* Spacer to push pills to the right */}
			<div className="flex-1" />

			{/* Tab pills - dynamically show as many as fit, then +N more.
			    Each pill jumps to its tab. */}
			<div className="flex items-center gap-1 flex-shrink-0">
				{tabs.slice(0, maxVisiblePills).map((tab) => {
					const countSuffix = tab.count > 1 ? ` (${tab.count})` : '';
					const fullText = tab.tabName + countSuffix;
					const canJump = !!onSwitchTab && tab.tabId !== 'unknown';
					return (
						<button
							key={tab.tabId}
							type="button"
							onClick={canJump ? () => onSwitchTab?.(session.id, tab.tabId) : undefined}
							disabled={!canJump}
							className={`px-1.5 py-0.5 rounded text-xs font-mono overflow-hidden text-ellipsis transition-all ${
								canJump ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'
							}`}
							style={{
								backgroundColor: theme.colors.accent + '30',
								color: theme.colors.textMain,
								maxWidth: maxPillWidth ? `${maxPillWidth}px` : undefined,
								whiteSpace: 'nowrap',
							}}
							title={canJump ? `Jump to ${fullText}` : fullText}
						>
							{fullText}
						</button>
					);
				})}
				{tabs.length > maxVisiblePills && (
					<span
						className="px-1.5 py-0.5 rounded text-xs whitespace-nowrap"
						style={{
							backgroundColor: maxVisiblePills === 0 ? theme.colors.accent + '30' : 'transparent',
							color: maxVisiblePills === 0 ? theme.colors.textMain : theme.colors.textDim,
						}}
					>
						+{tabs.length - maxVisiblePills}
					</span>
				)}
			</div>

			{/* Right region: opens the queue browser */}
			<button
				type="button"
				onClick={onClick}
				className="text-xs opacity-50 flex-shrink-0 whitespace-nowrap transition-all hover:opacity-80"
				title="View execution queue"
			>
				Click to view
			</button>
		</div>
	);
}
