/**
 * QuickActionsMenu - Full command palette for the mobile web interface
 *
 * Features:
 * - Search input with real-time filtering
 * - Actions organized by category with section headers
 * - Keyboard navigation (Arrow keys, Enter, Escape)
 * - Recent actions tracked in localStorage
 * - Touch-friendly hit targets (minimum 44pt)
 * - Accessible with proper ARIA roles
 *
 * Wrapped in `ResponsiveModal` so it renders as a bottom sheet on phones and
 * a centered card at tablet+. Escape, backdrop click, and focus trap are
 * inherited from `ResponsiveModal`. The search input auto-focuses on open
 * via a nested rAF (command-palette UX: typing should work immediately).
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { ResponsiveModal } from '../components';
import { MIN_TOUCH_TARGET } from './constants';

/** Represents a single action in the command palette */
export interface CommandPaletteAction {
	id: string;
	label: string;
	category: string;
	icon: React.ReactNode;
	shortcut?: string;
	action: () => void;
	available?: () => boolean;
}

/** Category display order */
const CATEGORY_ORDER = ['Navigation', 'Agent', 'Auto Run', 'Group Chat', 'Cue', 'Settings', 'View'];

/** localStorage key for recent actions */
const RECENT_ACTIONS_KEY = 'maestro-command-palette-recent';
const MAX_RECENT_ACTIONS = 5;

export interface QuickActionsMenuProps {
	/** Whether the menu is visible */
	isOpen: boolean;
	/** Callback when the menu should close */
	onClose: () => void;
	/** Available actions to display */
	actions: CommandPaletteAction[];
}

/** Load recent action IDs from localStorage */
function loadRecentActions(): string[] {
	try {
		const stored = localStorage.getItem(RECENT_ACTIONS_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECENT_ACTIONS);
		}
	} catch {
		// Ignore parse errors
	}
	return [];
}

/** Save a used action to recent actions */
function saveRecentAction(actionId: string): void {
	try {
		const recent = loadRecentActions().filter((id) => id !== actionId);
		recent.unshift(actionId);
		localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_ACTIONS)));
	} catch {
		// Ignore storage errors
	}
}

/**
 * QuickActionsMenu component
 *
 * A command palette providing quick access to all app actions. Rendered via
 * `ResponsiveModal`, so it's a bottom sheet on phones and a centered card at
 * tablet+.
 */
export function QuickActionsMenu({ isOpen, onClose, actions }: QuickActionsMenuProps) {
	const colors = useThemeColors();
	const searchRef = useRef<HTMLInputElement>(null);
	const [searchQuery, setSearchQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

	// Filter to only available actions
	const availableActions = useMemo(
		() => actions.filter((a) => !a.available || a.available()),
		[actions]
	);

	// Filter actions by search query
	const filteredActions = useMemo(() => {
		if (!searchQuery.trim()) return availableActions;
		const query = searchQuery.toLowerCase();
		return availableActions.filter(
			(a) => a.label.toLowerCase().includes(query) || a.category.toLowerCase().includes(query)
		);
	}, [availableActions, searchQuery]);

	// Build the display list: recent actions first (when no search), then by category
	const displayList = useMemo(() => {
		const items: Array<
			{ type: 'header'; label: string } | { type: 'action'; action: CommandPaletteAction }
		> = [];

		if (!searchQuery.trim()) {
			// Show recent actions at top
			const recentIds = loadRecentActions();
			const recentActions = recentIds
				.map((id) => filteredActions.find((a) => a.id === id))
				.filter((a): a is CommandPaletteAction => !!a);

			if (recentActions.length > 0) {
				items.push({ type: 'header', label: 'Recent' });
				for (const action of recentActions) {
					items.push({ type: 'action', action });
				}
			}
		}

		// Group remaining actions by category
		const byCategory = new Map<string, CommandPaletteAction[]>();
		for (const action of filteredActions) {
			const existing = byCategory.get(action.category) || [];
			existing.push(action);
			byCategory.set(action.category, existing);
		}

		// Add categories in defined order
		for (const category of CATEGORY_ORDER) {
			const categoryActions = byCategory.get(category);
			if (categoryActions && categoryActions.length > 0) {
				items.push({ type: 'header', label: category });
				for (const action of categoryActions) {
					items.push({ type: 'action', action });
				}
			}
		}

		// Add any remaining categories not in the predefined order
		for (const [category, categoryActions] of byCategory) {
			if (!CATEGORY_ORDER.includes(category) && categoryActions.length > 0) {
				items.push({ type: 'header', label: category });
				for (const action of categoryActions) {
					items.push({ type: 'action', action });
				}
			}
		}

		return items;
	}, [filteredActions, searchQuery]);

	// Get only action items (for keyboard navigation indexing)
	const actionItems = useMemo(
		() =>
			displayList.filter(
				(item): item is { type: 'action'; action: CommandPaletteAction } => item.type === 'action'
			),
		[displayList]
	);

	// Reset state when menu opens. ResponsiveModal schedules a single rAF to
	// focus its dialog container; a nested rAF here runs after that and
	// re-claims focus for the search field — command-palette UX where typing
	// should work immediately on open.
	useEffect(() => {
		if (!isOpen) return;
		setSearchQuery('');
		setSelectedIndex(0);
		let innerHandle: number | null = null;
		const outerHandle = requestAnimationFrame(() => {
			innerHandle = requestAnimationFrame(() => {
				searchRef.current?.focus();
			});
		});
		return () => {
			cancelAnimationFrame(outerHandle);
			if (innerHandle !== null) cancelAnimationFrame(innerHandle);
		};
	}, [isOpen]);

	// Scroll selected item into view
	useEffect(() => {
		const el = itemRefs.current.get(selectedIndex);
		if (el) {
			el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	}, [selectedIndex]);

	// Reset selection when filter changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [searchQuery]);

	// Execute an action
	const executeAction = useCallback(
		(action: CommandPaletteAction) => {
			saveRecentAction(action.id);
			onClose();
			action.action();
		},
		[onClose]
	);

	// Keyboard navigation. Escape is handled by ResponsiveModal itself; this
	// listener only covers Arrow keys and Enter for the command-palette flow.
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			switch (event.key) {
				case 'ArrowDown':
					event.preventDefault();
					setSelectedIndex((prev) => (prev < actionItems.length - 1 ? prev + 1 : 0));
					break;
				case 'ArrowUp':
					event.preventDefault();
					setSelectedIndex((prev) => (prev > 0 ? prev - 1 : actionItems.length - 1));
					break;
				case 'Enter':
					event.preventDefault();
					if (actionItems[selectedIndex]) {
						executeAction(actionItems[selectedIndex].action);
					}
					break;
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, actionItems, selectedIndex, executeAction]);

	// Track the action index separately for keyboard selection highlighting
	let actionIndex = -1;

	return (
		<ResponsiveModal
			isOpen={isOpen}
			onClose={onClose}
			title="Command Palette"
			zIndex={300}
			footer={
				<div
					style={{
						display: 'flex',
						gap: '12px',
						justifyContent: 'center',
						width: '100%',
					}}
				>
					<span style={{ fontSize: '11px', color: colors.textDim }}>
						<kbd
							style={{
								fontFamily: 'monospace',
								padding: '1px 4px',
								backgroundColor: `${colors.textDim}15`,
								borderRadius: '3px',
							}}
						>
							↑↓
						</kbd>{' '}
						navigate
					</span>
					<span style={{ fontSize: '11px', color: colors.textDim }}>
						<kbd
							style={{
								fontFamily: 'monospace',
								padding: '1px 4px',
								backgroundColor: `${colors.textDim}15`,
								borderRadius: '3px',
							}}
						>
							⏎
						</kbd>{' '}
						select
					</span>
					<span style={{ fontSize: '11px', color: colors.textDim }}>
						<kbd
							style={{
								fontFamily: 'monospace',
								padding: '1px 4px',
								backgroundColor: `${colors.textDim}15`,
								borderRadius: '3px',
							}}
						>
							esc
						</kbd>{' '}
						close
					</span>
				</div>
			}
		>
			{/* Search input */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '10px',
					backgroundColor: colors.bgMain,
					borderRadius: '10px',
					padding: '0 12px',
					border: `1px solid ${colors.border}`,
					marginBottom: '12px',
				}}
			>
				{/* Search icon */}
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke={colors.textDim}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ flexShrink: 0 }}
				>
					<circle cx="11" cy="11" r="8" />
					<line x1="21" y1="21" x2="16.65" y2="16.65" />
				</svg>
				<input
					ref={searchRef}
					type="text"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					placeholder="Search actions..."
					aria-label="Search actions"
					style={{
						flex: 1,
						backgroundColor: 'transparent',
						border: 'none',
						outline: 'none',
						color: colors.textMain,
						fontSize: '15px',
						padding: '10px 0',
						fontFamily: 'inherit',
					}}
				/>
				{searchQuery && (
					<button
						onClick={() => setSearchQuery('')}
						aria-label="Clear search"
						style={{
							background: 'none',
							border: 'none',
							color: colors.textDim,
							cursor: 'pointer',
							padding: '4px',
							display: 'flex',
							alignItems: 'center',
						}}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				)}
			</div>

			{/* Action list */}
			<div
				role="listbox"
				aria-label="Actions"
				style={{
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				{displayList.length === 0 && (
					<div
						style={{
							padding: '24px 16px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						No matching actions
					</div>
				)}

				{displayList.map((item, i) => {
					if (item.type === 'header') {
						return (
							<div
								key={`header-${item.label}-${i}`}
								style={{
									padding: '10px 4px 4px',
									fontSize: '11px',
									fontWeight: 600,
									textTransform: 'uppercase',
									letterSpacing: '0.5px',
									color: colors.textDim,
								}}
								aria-hidden="true"
							>
								{item.label}
							</div>
						);
					}

					actionIndex++;
					const currentActionIndex = actionIndex;
					const isSelected = currentActionIndex === selectedIndex;

					return (
						<button
							key={item.action.id}
							ref={(el) => {
								if (el) {
									itemRefs.current.set(currentActionIndex, el);
								} else {
									itemRefs.current.delete(currentActionIndex);
								}
							}}
							role="option"
							aria-selected={isSelected}
							onClick={() => executeAction(item.action)}
							onMouseEnter={() => setSelectedIndex(currentActionIndex)}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '12px',
								width: '100%',
								padding: '10px 8px',
								minHeight: `${MIN_TOUCH_TARGET}px`,
								backgroundColor: isSelected ? `${colors.accent}15` : 'transparent',
								border: 'none',
								borderRadius: '6px',
								color: colors.textMain,
								fontSize: '14px',
								textAlign: 'left',
								cursor: 'pointer',
								transition: 'background-color 100ms ease',
								WebkitTapHighlightColor: 'transparent',
							}}
							onTouchStart={(e) => {
								e.currentTarget.style.backgroundColor = `${colors.accent}20`;
							}}
							onTouchEnd={(e) => {
								e.currentTarget.style.backgroundColor = isSelected
									? `${colors.accent}15`
									: 'transparent';
							}}
						>
							<span
								style={{
									color: colors.accent,
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									width: '24px',
									height: '24px',
									flexShrink: 0,
								}}
							>
								{item.action.icon}
							</span>
							<span style={{ flex: 1, minWidth: 0 }}>{item.action.label}</span>
							{item.action.shortcut && (
								<span
									style={{
										fontSize: '11px',
										color: colors.textDim,
										backgroundColor: `${colors.textDim}15`,
										padding: '2px 6px',
										borderRadius: '4px',
										fontFamily: 'monospace',
										flexShrink: 0,
									}}
								>
									{item.action.shortcut}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</ResponsiveModal>
	);
}

export default QuickActionsMenu;
