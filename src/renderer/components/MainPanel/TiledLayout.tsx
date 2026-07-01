import React from 'react';

import { TerminalOutput } from '../TerminalOutput';
import { useSettingsStore } from '../../stores/settingsStore';
import { updateSessionWith } from '../../stores/sessionStore';
import {
	findLeafById,
	focusPaneInSession,
	resolveTabRefTitle,
	tabRefKey,
	updateGroupInSession,
	updateSplitSizes,
} from '../../utils/panelLayout';
import { writeTabTilePayload } from '../../utils/tabDragPayload';
import { useThrottledCallback } from '../../hooks/utils/useThrottle';
import type {
	PaneRects,
	PanelLayoutNode,
	Session,
	TabGroup,
	Theme,
	UnifiedTabRef,
} from '../../types';

/**
 * Registry the recursive layout nodes use to report their transparent slot
 * elements up to the TiledLayout root, which measures them together and
 * publishes a PaneRects map. Terminal/browser leaves register their content
 * slot; the root's ResizeObserver + layout effect keep the rects current.
 */
interface PaneSlotRegistry {
	register: (key: string, el: HTMLElement | null) => void;
}
const PaneSlotContext = React.createContext<PaneSlotRegistry | null>(null);

// Lazy-loaded to match MainPanelContent: FilePreview pulls the full markdown /
// syntax-highlighting stack into the bundle, so it stays code-split behind first
// open here too.
const FilePreview = React.lazy(() =>
	import('../FilePreview').then((m) => ({ default: m.FilePreview }))
);

/**
 * Recursive renderer for a tiled TabGroup. Walks the group's layout tree and
 * renders each leaf's referenced tab side by side. Leaves reference existing
 * tabs (see PanelLayoutNode), so this component resolves each ref back to its
 * live tab in the session and reuses the same view components MainPanelContent
 * uses (TerminalOutput for AI, FilePreview for files). Terminal and browser
 * leaves render a transparent slot (title bar + focus ring only): their live
 * content is the keep-alive overlay MainPanelContent mounts, which this layout
 * repositions onto each slot's rect via `onPaneRectsChange` (Phase 04).
 *
 * Interactive (Phase 02): sibling panes have draggable dividers (direct-DOM
 * during drag, committed to the group's layout on mouseup, mirroring
 * useResizablePanel), clicking a pane focuses it, and the focused pane gets an
 * accent ring. A `zoomedPaneId` renders a single pane full-panel (a temporary,
 * non-persisted maximize handled by the caller).
 */
export interface TiledLayoutProps {
	group: TabGroup;
	session: Session;
	theme: Theme;
	/** When set, only this leaf renders (full-panel maximize/zoom). */
	zoomedPaneId?: string | null;
	/**
	 * Called whenever the terminal/browser leaf rectangles change (layout edits,
	 * container/pane resize, divider drags). MainPanelContent uses the published
	 * PaneRects to position the keep-alive terminal/browser overlays onto each
	 * pane instead of filling the whole panel. Empty map when no such leaves.
	 */
	onPaneRectsChange?: (rects: PaneRects) => void;
}

/**
 * Fallback shown when a leaf references a tab that no longer exists (e.g. the
 * underlying AI/file tab was closed while still in the layout). The layout
 * self-heals on the next edit; this keeps the pane from rendering blank.
 */
function PaneMissingTab({ theme }: { theme: Theme }) {
	return (
		<div
			className="flex-1 flex items-center justify-center select-none"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div
				className="text-xs text-center px-4 py-2 rounded"
				style={{
					color: theme.colors.textDim,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				This tab is no longer available
			</div>
		</div>
	);
}

/** Render a single leaf's tab content, reusing existing view components. */
function PaneContent({
	tab,
	session,
	theme,
}: {
	tab: UnifiedTabRef;
	session: Session;
	theme: Theme;
}) {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const shortcuts = useSettingsStore((s) => s.shortcuts);

	// Local, per-pane refs. In this static read/display prototype the panes are not
	// interactive (no input wiring, no output search), so search state and setters
	// are inert - the display renderer still needs the props to satisfy its API.
	const outputRef = React.useRef<HTMLDivElement>(null);
	const inputRef = React.useRef<HTMLTextAreaElement>(null);
	const logsEndRef = React.useRef<HTMLDivElement>(null);
	const noop = React.useCallback(() => {}, []);

	if (tab.type === 'ai') {
		const aiTab = session.aiTabs?.find((t) => t.id === tab.id);
		if (!aiTab) return <PaneMissingTab theme={theme} />;
		// Scope the session to this pane's AI tab so TerminalOutput renders the
		// correct conversation (it reads logs off the active tab).
		const paneSession: Session = { ...session, activeTabId: aiTab.id, inputMode: 'ai' };
		return (
			<div className="flex-1 overflow-hidden flex flex-col select-text">
				<TerminalOutput
					ref={outputRef}
					session={paneSession}
					theme={theme}
					fontFamily={fontFamily}
					activeFocus="main"
					outputSearchOpen={false}
					outputSearchQuery=""
					outputSearchRegex={false}
					setOutputSearchOpen={noop}
					setOutputSearchQuery={noop}
					setOutputSearchRegex={noop}
					setActiveFocus={noop}
					setLightboxImage={noop}
					inputRef={inputRef}
					logsEndRef={logsEndRef}
					maxOutputLines={maxOutputLines}
					markdownEditMode={chatRawTextMode}
					setMarkdownEditMode={noop}
					projectRoot={session.fullPath}
				/>
			</div>
		);
	}

	if (tab.type === 'file') {
		const fileTab = session.filePreviewTabs?.find((t) => t.id === tab.id);
		if (!fileTab) return <PaneMissingTab theme={theme} />;
		return (
			<div className="flex-1 overflow-hidden select-text">
				<React.Suspense fallback={null}>
					<FilePreview
						file={{ name: fileTab.name, path: fileTab.path, content: fileTab.content }}
						onClose={noop}
						isTabMode={true}
						theme={theme}
						shortcuts={shortcuts}
						markdownEditMode={false}
						setMarkdownEditMode={noop}
					/>
				</React.Suspense>
			</div>
		);
	}

	// Terminal and browser tabs are kept-alive overlays mounted at the panel level
	// (their PTY scrollback / <webview> DOM must survive tab switches), so a tiled
	// pane can't host their React tree inline. Instead we render a transparent slot
	// that reserves the pane's content box and reports its rect up via the registry;
	// MainPanelContent positions the matching overlay onto that rect.
	return <PaneOverlaySlot tab={tab} />;
}

/**
 * Transparent placeholder for terminal/browser leaves. Reserves the pane's
 * content box and registers its element so the TiledLayout root can measure it
 * and publish the rect. The live guest is the keep-alive overlay that sits on
 * top of this slot (positioned by MainPanelContent).
 */
function PaneOverlaySlot({ tab }: { tab: UnifiedTabRef }) {
	const registry = React.useContext(PaneSlotContext);
	const key = tabRefKey(tab);
	return <div className="flex-1 min-w-0 min-h-0" ref={(el) => registry?.register(key, el)} />;
}

/** A single leaf pane: a title bar (doubles as a drag handle) atop the content. */
function PaneFrame({
	node,
	group,
	session,
	theme,
	isFocused,
}: {
	node: Extract<PanelLayoutNode, { kind: 'leaf' }>;
	group: TabGroup;
	session: Session;
	theme: Theme;
	isFocused: boolean;
}) {
	const title = resolveTabRefTitle(session, node.tab);
	// Clicking anywhere in the pane focuses it (matches single-view "click to
	// focus" and routes AI input to this pane). Cheap object-equality no-op when
	// this pane is already focused, so idle clicks don't churn the store.
	const focusThisPane = React.useCallback(() => {
		if (group.focusedPaneId === node.id) return;
		updateSessionWith(session.id, (s) => focusPaneInSession(s, group.id, node.id));
	}, [group.focusedPaneId, group.id, node.id, session.id]);

	// Dragging the title bar carries a `source: 'pane'` tiling payload so a drop
	// onto the tab bar promotes this pane back to a standalone tab (and text/plain
	// so the drag has a native fallback). The group + leaf ids let the tab bar's
	// drop handler target the right group and auto-dissolve it below two panes.
	const handleTitleDragStart = React.useCallback(
		(e: React.DragEvent) => {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', node.tab.id);
			writeTabTilePayload(e.dataTransfer, {
				ref: node.tab,
				source: 'pane',
				groupId: group.id,
				leafId: node.id,
			});
		},
		[group.id, node.id, node.tab]
	);

	return (
		<div
			className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
			onMouseDown={focusThisPane}
			// Tags this pane's box so the drop-zone overlay can hit-test a tab drag
			// against it (read via document.querySelectorAll in PaneDropZones).
			data-pane-leaf-id={node.id}
			style={{
				// Accent ring on the focused pane; a plain border otherwise. Same
				// accent token active/selected states use elsewhere - no hardcoded colors.
				border: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
				boxShadow: isFocused ? `inset 0 0 0 1px ${theme.colors.accent}` : undefined,
			}}
		>
			{/* Title bar - brighter (accent text) when this pane holds focus. Also a
			    drag handle: drag it to the tab bar to promote this pane out. */}
			<div
				className="shrink-0 px-2 py-1 text-xs font-medium truncate select-none cursor-grab active:cursor-grabbing"
				style={{
					backgroundColor: isFocused ? theme.colors.bgActivity : theme.colors.bgSidebar,
					color: isFocused ? theme.colors.accent : theme.colors.textMain,
					borderBottom: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
				}}
				title={title}
				draggable
				onDragStart={handleTitleDragStart}
			>
				{title}
			</div>
			<PaneContent tab={node.tab} session={session} theme={theme} />
		</div>
	);
}

/**
 * Draggable divider between two sibling panes in a split. Mirrors
 * useResizablePanel: during the drag it writes flex-grow directly onto the two
 * neighboring pane wrappers (no re-render per frame), and on mouseup it commits
 * the final fractional sizes to the group's layout via a single store update.
 */
function SplitDivider({
	direction,
	theme,
	onDrag,
	onCommit,
}: {
	direction: 'row' | 'column';
	theme: Theme;
	/** clientX/Y delta from drag start; returns nothing (caller applies to DOM). */
	onDrag: (delta: number) => void;
	onCommit: () => void;
}) {
	const [isDragging, setIsDragging] = React.useState(false);

	const onMouseDown = React.useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragging(true);
			const start = direction === 'row' ? e.clientX : e.clientY;

			const handleMove = (moveEvent: MouseEvent) => {
				const current = direction === 'row' ? moveEvent.clientX : moveEvent.clientY;
				onDrag(current - start);
			};
			const handleUp = () => {
				setIsDragging(false);
				onCommit();
				document.removeEventListener('mousemove', handleMove);
				document.removeEventListener('mouseup', handleUp);
			};
			document.addEventListener('mousemove', handleMove);
			document.addEventListener('mouseup', handleUp);
		},
		[direction, onDrag, onCommit]
	);

	const isRow = direction === 'row';
	return (
		<div
			onMouseDown={onMouseDown}
			className={`shrink-0 ${isRow ? 'cursor-col-resize' : 'cursor-row-resize'}`}
			style={{
				[isRow ? 'width' : 'height']: '4px',
				backgroundColor: isDragging ? theme.colors.accent : 'transparent',
			}}
			// Wider transparent hit area is handled by the 4px band; keep the visual
			// subtle until hover/drag so the layout reads clean.
		/>
	);
}

/** Recursively render one layout node (leaf -> PaneFrame, split -> flex row/col). */
function LayoutNode({
	node,
	group,
	session,
	theme,
}: {
	node: PanelLayoutNode;
	group: TabGroup;
	session: Session;
	theme: Theme;
}) {
	// Refs to each child wrapper so the divider drag can set flex-grow directly.
	const childRefs = React.useRef<(HTMLDivElement | null)[]>([]);
	// Live sizes during a drag (committed to the store on mouseup).
	const dragSizesRef = React.useRef<number[] | null>(null);

	if (node.kind === 'leaf') {
		return (
			<PaneFrame
				node={node}
				group={group}
				session={session}
				theme={theme}
				isFocused={group.focusedPaneId === node.id}
			/>
		);
	}

	const isRow = node.direction === 'row';

	// Resize between child i and child i+1: shift weight from one to the other,
	// clamped so neither collapses. Writes flex-grow straight onto the DOM for a
	// smooth drag; the committed value goes to the store on release.
	const applyDrag = (dividerIndex: number, delta: number) => {
		const container = childRefs.current[dividerIndex]?.parentElement;
		if (!container) return;
		const axisPx = isRow ? container.clientWidth : container.clientHeight;
		if (axisPx <= 0) return;
		const deltaFrac = delta / axisPx;
		const MIN = 0.05;
		const base = node.sizes;
		const a = base[dividerIndex];
		const b = base[dividerIndex + 1];
		// Constrain the shift so both neighbors stay at/above MIN.
		const shift = Math.max(-(a - MIN), Math.min(b - MIN, deltaFrac));
		const next = [...base];
		next[dividerIndex] = a + shift;
		next[dividerIndex + 1] = b - shift;
		dragSizesRef.current = next;
		const first = childRefs.current[dividerIndex];
		const second = childRefs.current[dividerIndex + 1];
		if (first) first.style.flexGrow = String(next[dividerIndex]);
		if (second) second.style.flexGrow = String(next[dividerIndex + 1]);
	};

	const commitDrag = () => {
		const sizes = dragSizesRef.current;
		dragSizesRef.current = null;
		if (!sizes) return;
		updateSessionWith(session.id, (s) =>
			updateGroupInSession(s, group.id, (g) => ({
				...g,
				layout: updateSplitSizes(g.layout, node.id, sizes),
			}))
		);
	};

	return (
		<div className={`flex flex-1 min-w-0 min-h-0 ${isRow ? 'flex-row' : 'flex-col'}`}>
			{node.children.map((child, index) => (
				<React.Fragment key={child.id}>
					{index > 0 && (
						<SplitDivider
							direction={node.direction}
							theme={theme}
							onDrag={(delta) => applyDrag(index - 1, delta)}
							onCommit={commitDrag}
						/>
					)}
					<div
						ref={(el) => {
							childRefs.current[index] = el;
						}}
						className="flex min-w-0 min-h-0 overflow-hidden"
						style={{ flexGrow: node.sizes[index], flexBasis: 0 }}
					>
						<LayoutNode node={child} group={group} session={session} theme={theme} />
					</div>
				</React.Fragment>
			))}
		</div>
	);
}

export const TiledLayout = React.memo(function TiledLayout({
	group,
	session,
	theme,
	zoomedPaneId,
	onPaneRectsChange,
}: TiledLayoutProps) {
	// Zoom/maximize: render only the focused (zoomed) leaf full-panel. Non-persisted
	// and controlled by the caller; fall back to the full layout if the id is stale.
	const zoomedLeaf = zoomedPaneId != null ? findLeafById(group.layout, zoomedPaneId) : null;

	// Root container the pane rects are measured against, and the live registry of
	// terminal/browser slot elements (populated by PaneOverlaySlot ref callbacks).
	const containerRef = React.useRef<HTMLDivElement>(null);
	const slotsRef = React.useRef<Map<string, HTMLElement>>(new Map());
	// One ResizeObserver watches the container + every registered slot; a resize on
	// any of them (divider drag, window resize, panel show/hide) re-measures.
	const observerRef = React.useRef<ResizeObserver | null>(null);
	// Latest published keys, so we can emit an empty map exactly once when the last
	// terminal/browser leaf goes away (avoids leaving a stale overlay positioned).
	const lastKeysRef = React.useRef<string>('');

	// Keep the callback in a ref so the throttled measurer has a stable identity
	// (the callback prop may change identity every render in the parent).
	const onChangeRef = React.useRef(onPaneRectsChange);
	onChangeRef.current = onPaneRectsChange;

	const measure = React.useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		const base = container.getBoundingClientRect();
		const rects: PaneRects = new Map();
		for (const [key, el] of slotsRef.current) {
			if (!el.isConnected) continue;
			const r = el.getBoundingClientRect();
			rects.set(key, {
				top: r.top - base.top,
				left: r.left - base.left,
				width: r.width,
				height: r.height,
			});
		}
		const keys = [...rects.keys()].sort().join(',');
		// Skip publishing when nothing is registered and nothing was before, so an
		// AI/file-only group never churns the parent with empty-map updates.
		if (rects.size === 0 && lastKeysRef.current === '') return;
		lastKeysRef.current = keys;
		onChangeRef.current?.(rects);
	}, []);

	// Throttle geometry publishes so a divider drag (many resize ticks) doesn't
	// thrash the parent's state or the overlay repositioning.
	const throttledMeasure = useThrottledCallback(measure, 16);

	const registry = React.useMemo<PaneSlotRegistry>(
		() => ({
			register(key, el) {
				const observer = observerRef.current;
				const prev = slotsRef.current.get(key);
				if (prev && prev !== el && observer) observer.unobserve(prev);
				if (el) {
					slotsRef.current.set(key, el);
					if (observer) observer.observe(el);
				} else {
					slotsRef.current.delete(key);
				}
				// Slot mount/unmount changes the set of panes, so re-measure now (a
				// leading throttled call fires immediately) and reflect the new set.
				throttledMeasure();
			},
		}),
		[throttledMeasure]
	);

	// Set up the ResizeObserver against the container + already-registered slots,
	// and re-measure on every layout change (group.layout / zoom identity shift).
	React.useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const observer = new ResizeObserver(() => throttledMeasure());
		observerRef.current = observer;
		observer.observe(container);
		for (const el of slotsRef.current.values()) observer.observe(el);
		// Measure once synchronously after layout so overlays land on first paint.
		measure();
		return () => {
			observer.disconnect();
			observerRef.current = null;
		};
	}, [measure, throttledMeasure]);

	// Re-measure whenever the layout tree or zoom target changes (panes added,
	// removed, resized via keyboard, or maximized) - geometry shifts without a
	// container resize event in those cases.
	React.useLayoutEffect(() => {
		measure();
	}, [measure, group.layout, zoomedPaneId]);

	// On unmount (group closed / switched away), clear any published rects so the
	// overlays fall back to standalone positioning with no orphaned geometry.
	React.useEffect(() => {
		return () => {
			if (lastKeysRef.current !== '') {
				lastKeysRef.current = '';
				onChangeRef.current?.(new Map());
			}
		};
	}, []);

	return (
		<PaneSlotContext.Provider value={registry}>
			<div
				ref={containerRef}
				className="flex-1 min-h-0 overflow-hidden flex flex-col"
				data-tour="tiled-layout"
			>
				{zoomedLeaf && zoomedLeaf.kind === 'leaf' ? (
					<PaneFrame
						node={zoomedLeaf}
						group={group}
						session={session}
						theme={theme}
						isFocused={true}
					/>
				) : (
					<LayoutNode node={group.layout} group={group} session={session} theme={theme} />
				)}
			</div>
		</PaneSlotContext.Provider>
	);
});
