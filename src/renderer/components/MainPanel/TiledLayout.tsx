import React from 'react';

import { TerminalOutput } from '../TerminalOutput';
import { useSettingsStore } from '../../stores/settingsStore';
import { updateSessionWith } from '../../stores/sessionStore';
import { getTabDisplayName } from '../../utils/tabHelpers';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import {
	findLeafById,
	focusPaneInSession,
	updateGroupInSession,
	updateSplitSizes,
} from '../../utils/panelLayout';
import type { PanelLayoutNode, Session, TabGroup, Theme, UnifiedTabRef } from '../../types';

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
 * leaves show a placeholder for now - their keep-alive overlay repositioning is
 * deferred to a later phase.
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
}

/** Resolve a leaf's display title from the live tab it references. */
function resolveLeafTitle(tab: UnifiedTabRef, session: Session): string {
	switch (tab.type) {
		case 'ai': {
			const aiTab = session.aiTabs?.find((t) => t.id === tab.id);
			return aiTab ? getTabDisplayName(aiTab) : 'AI';
		}
		case 'file': {
			const fileTab = session.filePreviewTabs?.find((t) => t.id === tab.id);
			return fileTab ? fileTab.name : 'File';
		}
		case 'terminal': {
			const index = session.terminalTabs?.findIndex((t) => t.id === tab.id) ?? -1;
			const terminalTab = index >= 0 ? session.terminalTabs[index] : undefined;
			return terminalTab ? getTerminalTabDisplayName(terminalTab, index) : 'Terminal';
		}
		case 'browser': {
			const browserTab = session.browserTabs?.find((t) => t.id === tab.id);
			return browserTab
				? (browserTab.customTitle ?? browserTab.title ?? browserTab.url)
				: 'Browser';
		}
		default:
			return 'Tab';
	}
}

/** Placeholder shown for tab kinds whose tiled rendering lands in a later phase. */
function PaneComingSoon({ theme, label }: { theme: Theme; label: string }) {
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
				Tiling for {label} tabs arrives in a later phase
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
		if (!aiTab) return <PaneComingSoon theme={theme} label="this" />;
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
		if (!fileTab) return <PaneComingSoon theme={theme} label="this" />;
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

	if (tab.type === 'terminal') return <PaneComingSoon theme={theme} label="terminal" />;
	return <PaneComingSoon theme={theme} label="browser" />;
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
	const title = resolveLeafTitle(node.tab, session);
	// Clicking anywhere in the pane focuses it (matches single-view "click to
	// focus" and routes AI input to this pane). Cheap object-equality no-op when
	// this pane is already focused, so idle clicks don't churn the store.
	const focusThisPane = React.useCallback(() => {
		if (group.focusedPaneId === node.id) return;
		updateSessionWith(session.id, (s) => focusPaneInSession(s, group.id, node.id));
	}, [group.focusedPaneId, group.id, node.id, session.id]);

	return (
		<div
			className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
			onMouseDown={focusThisPane}
			style={{
				// Accent ring on the focused pane; a plain border otherwise. Same
				// accent token active/selected states use elsewhere - no hardcoded colors.
				border: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
				boxShadow: isFocused ? `inset 0 0 0 1px ${theme.colors.accent}` : undefined,
			}}
		>
			{/* Title bar - brighter (accent text) when this pane holds focus. */}
			<div
				className="shrink-0 px-2 py-1 text-xs font-medium truncate select-none"
				style={{
					backgroundColor: isFocused ? theme.colors.bgActivity : theme.colors.bgSidebar,
					color: isFocused ? theme.colors.accent : theme.colors.textMain,
					borderBottom: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
				}}
				title={title}
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
}: TiledLayoutProps) {
	// Zoom/maximize: render only the focused (zoomed) leaf full-panel. Non-persisted
	// and controlled by the caller; fall back to the full layout if the id is stale.
	const zoomedLeaf = zoomedPaneId != null ? findLeafById(group.layout, zoomedPaneId) : null;

	return (
		<div className="flex-1 min-h-0 overflow-hidden flex flex-col" data-tour="tiled-layout">
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
	);
});
