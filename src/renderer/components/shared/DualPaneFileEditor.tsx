/**
 * DualPaneFileEditor — shared split-pane editor chrome.
 *
 * A file-list on the left and an editor on the right, with:
 *   - Optional category grouping with collapsible headers
 *   - Optional "+" button above the list for creating new items
 *   - Modified indicator (dot) on list rows and optional badge in the editor header
 *   - Editor header action slot (extra buttons like preview/help/expand)
 *   - Editor body supplied by the consumer via `renderEditorBody` (textarea + whatever extras)
 *   - Optional help overlay that replaces the split view
 *   - Action row: primary (Save), optional secondary (Reset/Delete), optional Open in Finder
 *   - Unsaved-changes guard before switching selection
 *
 * Consumers (Maestro Prompts, Memory Viewer) pass in the data + editor body;
 * this component owns the chrome and common styling.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../../constants/themes';
import { getOpenInLabel } from '../../utils/platformUtils';
import { formatTokensCompact } from '../../../shared/formatters';
import './DualPaneFileEditor.css';

export interface DualPaneFileEditorItem {
	id: string;
	label: string;
	description?: string;
	category?: string;
	isModified?: boolean;
	/**
	 * Optional second-state indicator for items where the upstream/bundled
	 * source has changed since the user customized it. Renders a warning-colored
	 * dot in place of (not in addition to) the modified dot.
	 */
	hasDefaultDrifted?: boolean;
}

export interface DualPaneFileEditorAction {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	loading?: boolean;
	loadingLabel?: string;
	variant?: 'primary' | 'secondary' | 'danger';
	title?: string;
}

export interface DualPaneFileEditorProps {
	theme: Theme;

	/** Full list of items (flat). If `categories` is provided the list is grouped. */
	items: DualPaneFileEditorItem[];

	/** Currently selected item id (or null for none). */
	selectedId: string | null;

	/** Select handler — consumer should guard unsaved changes before accepting. */
	onSelect: (id: string) => void;

	/** Display name lookup by category key. If omitted the list renders flat. */
	categories?: Record<string, { label: string }>;

	/** Optional collapsed-categories state (Set of category keys). */
	collapsedCategories?: Set<string>;

	/** Toggle handler for a category. */
	onToggleCategory?: (category: string) => void;

	/** Optional "+" button above the list. */
	onCreateNewItem?: () => void;

	/** Title for the "+" button (tooltip + aria). */
	createNewItemLabel?: string;

	/** Render prop supplying the editor body (textarea, autocomplete, preview, etc.) */
	renderEditorBody: () => React.ReactNode;

	/** Header title above the editor body (e.g., the selected file's id). */
	editorTitle?: string;

	/** Description shown below the title (hidden when editor is expanded). */
	editorDescription?: string;

	/** Live token count for the edited document — shown next to the editor title. */
	editorTokenCount?: number;

	/** Extra buttons in the editor header row (preview, help, expand toggles). */
	editorHeaderActions?: React.ReactNode;

	/** Whether to show a "Modified" badge below the title. */
	showModifiedBadge?: boolean;

	/**
	 * Whether to show a "Default Updated" badge below the title (alongside the
	 * Modified badge when both apply). Indicates the bundled/upstream default
	 * has changed since the user saved their customization.
	 */
	showDefaultDriftedBadge?: boolean;

	/** Primary action button (e.g., Save). */
	primaryAction: DualPaneFileEditorAction;

	/** Optional secondary action button (e.g., Reset to Default, Delete). */
	secondaryAction?: DualPaneFileEditorAction;

	/** Optional "Open in Finder" — supplies the absolute path. */
	openInFinderPath?: string | null;

	/** Success message shown above the editor body. */
	successMessage?: string | null;

	/** Error message shown above the editor body. */
	errorMessage?: string | null;

	/** Optional row above the split view (title bar, description, help button, stats). */
	header?: React.ReactNode;

	/** Help-panel content. When `showHelp` is true, the entire split view is replaced with this. */
	helpPanel?: React.ReactNode;

	/** Show the help panel instead of the split view. */
	showHelp?: boolean;

	/** Collapse the list pane (consumer-owned toggle for an expanded editor view). */
	isExpanded?: boolean;

	/** Message when no item is selected. */
	emptyStateMessage?: string;

	/**
	 * Optional localStorage key for persisting the list pane width across reloads.
	 * When omitted, the width resets to the default on every mount.
	 */
	listWidthStorageKey?: string;
}

const DEFAULT_LIST_WIDTH = 220;
const MIN_LIST_WIDTH = 120;
const MAX_LIST_WIDTH = 600;

function readStoredWidth(key: string | undefined): number {
	if (!key || typeof window === 'undefined') return DEFAULT_LIST_WIDTH;
	const raw = window.localStorage.getItem(key);
	if (!raw) return DEFAULT_LIST_WIDTH;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_LIST_WIDTH;
	return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, parsed));
}

export function DualPaneFileEditor({
	theme,
	items,
	selectedId,
	onSelect,
	categories,
	collapsedCategories,
	onToggleCategory,
	onCreateNewItem,
	createNewItemLabel,
	renderEditorBody,
	editorTitle,
	editorDescription,
	editorTokenCount,
	editorHeaderActions,
	showModifiedBadge,
	showDefaultDriftedBadge,
	primaryAction,
	secondaryAction,
	openInFinderPath,
	successMessage,
	errorMessage,
	header,
	helpPanel,
	showHelp,
	isExpanded,
	emptyStateMessage = 'Select a file to edit',
	listWidthStorageKey,
}: DualPaneFileEditorProps): JSX.Element {
	const selectedItem = items.find((i) => i.id === selectedId) ?? null;

	const splitViewRef = useRef<HTMLDivElement | null>(null);
	const [listWidth, setListWidth] = useState<number>(() => readStoredWidth(listWidthStorageKey));
	const [isResizing, setIsResizing] = useState(false);

	// Persist width whenever it settles.
	useEffect(() => {
		if (!listWidthStorageKey || typeof window === 'undefined' || isResizing) return;
		window.localStorage.setItem(listWidthStorageKey, String(listWidth));
	}, [listWidth, listWidthStorageKey, isResizing]);

	const handleResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsResizing(true);
		const container = splitViewRef.current;
		if (!container) return;
		const onMove = (ev: MouseEvent) => {
			const rect = container.getBoundingClientRect();
			const next = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, ev.clientX - rect.left));
			setListWidth(next);
		};
		const onUp = () => {
			setIsResizing(false);
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}, []);

	// Scroll the selected item into view on first reveal (initial mount or
	// when the list re-appears after being hidden by isExpanded/showHelp).
	// We only auto-scroll once per reveal — user-driven selections already
	// scroll via click focus, and we don't want to yank the list on every
	// render.
	const listRef = useRef<HTMLDivElement | null>(null);
	const lastScrolledIdRef = useRef<string | null>(null);
	const listHiddenRef = useRef<boolean>(true);
	useEffect(() => {
		const listVisible = !isExpanded && !showHelp;
		const justRevealed = listHiddenRef.current && listVisible;
		listHiddenRef.current = !listVisible;
		if (!listVisible || !selectedId) return;
		if (!justRevealed && lastScrolledIdRef.current === selectedId) return;
		const node = listRef.current?.querySelector<HTMLElement>(
			`[data-item-id="${CSS.escape(selectedId)}"]`
		);
		node?.scrollIntoView({ block: 'nearest' });
		lastScrolledIdRef.current = selectedId;
	}, [selectedId, isExpanded, showHelp, items]);

	const groupedItems = React.useMemo(() => {
		if (!categories) {
			return null;
		}
		const groups: Record<string, DualPaneFileEditorItem[]> = {};
		for (const item of items) {
			const cat = item.category ?? 'uncategorized';
			if (!groups[cat]) groups[cat] = [];
			groups[cat].push(item);
		}
		return Object.entries(groups).sort(([a], [b]) => {
			const labelA = categories[a]?.label ?? a;
			const labelB = categories[b]?.label ?? b;
			return labelA.localeCompare(labelB);
		});
	}, [items, categories]);

	const renderActionButton = useCallback(
		(action: DualPaneFileEditorAction, fallbackClass: 'save-button' | 'reset-button') => {
			const variant = action.variant ?? (fallbackClass === 'save-button' ? 'primary' : 'secondary');
			const style: React.CSSProperties =
				variant === 'primary'
					? {
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}
					: variant === 'danger'
						? {
								borderColor: theme.colors.error,
								color: theme.colors.error,
							}
						: {
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							};
			return (
				<button
					className={fallbackClass}
					onClick={action.onClick}
					disabled={action.disabled || action.loading}
					title={action.title}
					style={style}
				>
					{action.loading && action.loadingLabel ? action.loadingLabel : action.label}
				</button>
			);
		},
		[theme]
	);

	return (
		<div className="dual-pane-file-editor">
			{header}

			<div
				ref={splitViewRef}
				className="dual-pane-split-view"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Left: list */}
				{!isExpanded && !showHelp && (
					<div
						ref={listRef}
						className="dual-pane-list"
						style={{
							borderColor: theme.colors.border,
							width: `${listWidth}px`,
							minWidth: `${MIN_LIST_WIDTH}px`,
							maxWidth: `${MAX_LIST_WIDTH}px`,
						}}
					>
						{onCreateNewItem && (
							<button
								className="dual-pane-create-button"
								onClick={onCreateNewItem}
								title={createNewItemLabel || 'Create new'}
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								+ {createNewItemLabel || 'New'}
							</button>
						)}

						{groupedItems
							? groupedItems.map(([category, catItems]) => {
									const isCollapsed = collapsedCategories?.has(category) ?? false;
									return (
										<div key={category} className="dual-pane-category">
											<button
												className="dual-pane-category-header"
												onClick={() => onToggleCategory?.(category)}
												style={{ color: theme.colors.textDim }}
											>
												{isCollapsed ? (
													<ChevronRight className="w-3 h-3" />
												) : (
													<ChevronDown className="w-3 h-3" />
												)}
												{categories?.[category]?.label ?? category}
											</button>
											{!isCollapsed && catItems.map((item) => renderListItem(item))}
										</div>
									);
								})
							: items.map((item) => renderListItem(item))}
					</div>
				)}

				{/* Drag handle for resizing the list pane. Hidden in expanded/help views. */}
				{!isExpanded && !showHelp && (
					<div
						className={`dual-pane-resizer${isResizing ? ' dragging' : ''}`}
						onMouseDown={handleResizeStart}
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize list pane"
						style={{ color: theme.colors.textDim }}
					/>
				)}

				{/* Help panel (full-width overlay) */}
				{showHelp && helpPanel && <div className="dual-pane-help-content">{helpPanel}</div>}

				{/* Right: editor */}
				{!showHelp && (
					<div className="dual-pane-editor">
						{selectedItem ? (
							<>
								<div className="dual-pane-editor-header">
									<div className="dual-pane-editor-header-row">
										<div className="dual-pane-editor-header-text">
											{editorTitle && (
												<h3 style={{ color: theme.colors.textMain }}>
													<span>{editorTitle}</span>
													{typeof editorTokenCount === 'number' && (
														<span
															className="dual-pane-editor-token-count"
															style={{ color: theme.colors.textDim }}
															title={`~${editorTokenCount.toLocaleString()} tokens (estimated)`}
														>
															~{formatTokensCompact(editorTokenCount)} tokens
														</span>
													)}
												</h3>
											)}
											{!isExpanded && editorDescription && (
												<p
													className="dual-pane-editor-description"
													style={{ color: theme.colors.textDim }}
												>
													{editorDescription}
												</p>
											)}
										</div>
										{editorHeaderActions && (
											<div className="dual-pane-editor-header-actions">{editorHeaderActions}</div>
										)}
									</div>
									{!isExpanded && (showModifiedBadge || showDefaultDriftedBadge) && (
										<div className="dual-pane-badge-row">
											{showModifiedBadge && (
												<span
													className="dual-pane-modified-badge"
													style={{ backgroundColor: theme.colors.accent }}
												>
													Modified
												</span>
											)}
											{showDefaultDriftedBadge && (
												<span
													className="dual-pane-modified-badge"
													style={{ backgroundColor: theme.colors.warning }}
													title="The bundled default has changed since you saved this customization."
												>
													Default Updated
												</span>
											)}
										</div>
									)}
								</div>

								{successMessage && (
									<div
										className="dual-pane-success-message"
										style={{
											backgroundColor: theme.colors.success + '20',
											color: theme.colors.success,
										}}
									>
										{successMessage}
									</div>
								)}

								{errorMessage && (
									<div
										className="dual-pane-error-message"
										style={{
											backgroundColor: theme.colors.error + '20',
											color: theme.colors.error,
										}}
									>
										{errorMessage}
									</div>
								)}

								<div className="dual-pane-editor-body">{renderEditorBody()}</div>

								<div className="dual-pane-editor-actions">
									{renderActionButton(primaryAction, 'save-button')}
									{secondaryAction && renderActionButton(secondaryAction, 'reset-button')}
									<div className="flex-1" />
									{openInFinderPath && (
										<button
											className="dual-pane-open-folder-button"
											onClick={() => window.maestro?.shell?.openPath(openInFinderPath)}
											style={{
												borderColor: theme.colors.border,
												color: theme.colors.textMain,
											}}
											title={openInFinderPath}
										>
											<ExternalLink className="w-3 h-3" />
											{getOpenInLabel(window.maestro?.platform || 'darwin')}
										</button>
									)}
								</div>
							</>
						) : (
							<div className="dual-pane-no-selection" style={{ color: theme.colors.textDim }}>
								{emptyStateMessage}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);

	function renderListItem(item: DualPaneFileEditorItem): JSX.Element {
		const isSelected = selectedId === item.id;
		return (
			<button
				key={item.id}
				data-item-id={item.id}
				className={`dual-pane-list-item ${isSelected ? 'selected' : ''}`}
				onClick={() => onSelect(item.id)}
				title={item.description}
				style={{
					backgroundColor: isSelected ? theme.colors.accent + '20' : 'transparent',
					color: theme.colors.textMain,
				}}
			>
				<span className="dual-pane-list-item-name">{item.label}</span>
				<span className="dual-pane-list-item-meta">
					{item.isModified && (
						<span
							className="dual-pane-modified-indicator"
							style={{
								color: item.hasDefaultDrifted ? theme.colors.warning : theme.colors.accent,
							}}
							title={
								item.hasDefaultDrifted
									? 'Customized — bundled default has changed since you saved this'
									: 'Customized'
							}
						>
							&bull;
						</span>
					)}
				</span>
			</button>
		);
	}
}
