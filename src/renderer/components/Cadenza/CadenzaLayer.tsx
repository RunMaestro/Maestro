/**
 * CadenzaLayer - single, app-wide layer for cadenza views: free-floating,
 * draggable windows the agent spawns to display/track work and (soon) drive
 * decisions. Mounted once near the app root (App.tsx); subscribes to
 * cadenzaStore. Presentational only - cadenzas are created/updated/closed
 * through the CLI/web bridge.
 *
 * Each card is absolutely positioned (cascades on open, drag the header to
 * move), shows the owning agent for fleet attribution, and can collapse to its
 * title bar. View types: tracker | file | markdown | image | code | view | decision.
 * Color mapping mirrors CenterFlash so cadenzas read consistently per theme.
 */

import {
	memo,
	useCallback,
	useEffect,
	useState,
	type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	Activity,
	FileText,
	ExternalLink,
	ScrollText,
	Image as ImageIcon,
	LayoutGrid,
	Code2,
	Monitor,
	ListChecks,
	ChevronDown,
	ChevronRight,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { CadenzaColor, CadenzaViewType } from '../../../shared/cadenza-types';
import { useCadenzaStore, type CadenzaView } from '../../stores/cadenzaStore';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { getBasename, getParentDir } from '../../../shared/formatters';
import { Markdown } from '../Markdown';
import { LocalImage } from '../Markdown/components/LocalImage';
import { CadenzaBlocks } from './CadenzaBlocks';
import { ConcertoHtmlPreview } from '../Concerto/ConcertoHtmlPreview';

interface CadenzaLayerProps {
	theme: Theme;
	/** True when rendered inside the desktop HUD window (a separate renderer with
	 *  no in-app event listeners), so interactions route to main via IPC. */
	isHud?: boolean;
}

/** Fallback orange - no theme defines this slot (matches CenterFlash). */
const ORANGE_HEX = '#f97316';

const ICON_FOR_TYPE: Record<CadenzaViewType, LucideIcon> = {
	tracker: Activity,
	file: FileText,
	markdown: ScrollText,
	image: ImageIcon,
	code: Code2,
	view: LayoutGrid,
	html: Monitor,
	decision: ListChecks,
};

/** Content types render a wider window; status/pin types stay compact. */
const CARD_WIDTH_COMPACT = 300;
const CARD_WIDTH_CONTENT = 420;
/** Content windows scroll internally rather than growing without bound. */
const CONTENT_MAX_HEIGHT = 380;

function colorValue(color: CadenzaColor, theme: Theme): string {
	switch (color) {
		case 'green':
			return theme.colors.success;
		case 'yellow':
			return theme.colors.warning;
		case 'orange':
			return ORANGE_HEX;
		case 'red':
			return theme.colors.error;
		case 'theme':
		default:
			return theme.colors.accent;
	}
}

/** Expand a file cadenza into its agent's real File Preview tab. */
function expandFile(view: CadenzaView, isHud: boolean): void {
	if (!view.sessionId || !view.path) return;
	if (isHud) {
		// The HUD is a separate window with no in-app listeners; route to the main
		// window through the preload bridge, which raises Maestro and opens the tab.
		window.maestro?.process?.openCadenzaFileTab?.(view.sessionId, view.path);
		return;
	}
	// In-app: reuse the CLI/remote file-open path; useAppRemoteEventListeners
	// switches to the agent and opens the file in a preview tab.
	window.dispatchEvent(
		new CustomEvent('maestro:openFileTab', {
			detail: { sessionId: view.sessionId, filePath: view.path },
		})
	);
}

/** Reply to the owning agent with a decision option's value (live prompt inject). */
function sendDecision(view: CadenzaView, value: string): void {
	if (!view.sessionId) return;
	window.maestro?.process?.sendCadenzaDecision?.(view.sessionId, value);
}

const CadenzaCard = memo(function CadenzaCard({
	view,
	theme,
	isHud,
	onClose,
}: {
	view: CadenzaView;
	theme: Theme;
	isHud: boolean;
	onClose: (id: string) => void;
}) {
	const accent = colorValue(view.color, theme);
	// Bridge payloads are not runtime-validated, so an unknown viewType must
	// degrade to a generic card icon rather than crash the whole layer.
	const Icon = ICON_FOR_TYPE[view.viewType] ?? Activity;
	const canExpand = view.viewType === 'file' && !!view.sessionId && !!view.path;
	const isContent =
		view.viewType === 'markdown' ||
		view.viewType === 'image' ||
		view.viewType === 'code' ||
		view.viewType === 'view' ||
		view.viewType === 'html' ||
		view.viewType === 'decision';
	const [collapsed, setCollapsed] = useState(false);
	const moveCadenza = useCadenzaStore((s) => s.moveCadenza);
	// Pulse this card when a chat chip points at it (flashItem).
	const isFlashed = useCadenzaStore((s) => s.flashedId === view.id);
	const startDrag = usePointerDrag();

	/** Drag the whole card by its header (ignore drags starting on a button).
	 *  Clamped on both ends so the header (the only handle + close button) can
	 *  never be dragged out of reach past any viewport edge. */
	const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		const originX = view.x ?? 0;
		const originY = view.y ?? 0;
		const cardWidth = isContent ? CARD_WIDTH_CONTENT : CARD_WIDTH_COMPACT;
		startDrag(
			e,
			(dx, dy) => {
				const maxX = Math.max(0, window.innerWidth - cardWidth);
				const maxY = Math.max(0, window.innerHeight - 40);
				moveCadenza(
					view.id,
					Math.min(Math.max(0, originX + dx), maxX),
					Math.min(Math.max(0, originY + dy), maxY)
				);
			},
			{ ignoreButtons: true }
		);
	};

	return (
		<div
			data-cadenza-card
			onMouseDown={(e) => {
				// In the HUD window, prevent the mousedown from grabbing DOM focus:
				// on Windows that focus grab activates the HUD window and deactivates
				// the app beneath (e.g. a browser loses focus). Buttons still fire on
				// click; skip content marked select-text so text selection still works.
				if (isHud && !(e.target as HTMLElement).closest('.select-text')) {
					e.preventDefault();
				}
			}}
			className="pointer-events-auto overflow-hidden rounded-xl select-none"
			style={{
				position: 'absolute',
				left: view.x ?? 24,
				top: view.y ?? 96,
				backgroundColor: theme.colors.bgSidebar,
				backgroundImage: `linear-gradient(135deg, ${accent}14 0%, ${accent}08 100%)`,
				border: isFlashed ? `2px solid ${accent}` : `1px solid ${accent}55`,
				boxShadow: isFlashed
					? `0 0 0 3px ${accent}66, 0 12px 28px -10px ${accent}55`
					: `0 12px 28px -10px ${accent}33, 0 0 0 1px ${theme.colors.border}44`,
				transition: 'box-shadow 0.25s ease, border-color 0.25s ease',
				width: isContent ? CARD_WIDTH_CONTENT : CARD_WIDTH_COMPACT,
			}}
		>
			<div
				className="flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing"
				onPointerDown={onDragStart}
			>
				<div
					className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-md"
					style={{ backgroundColor: `${accent}26`, color: accent }}
				>
					<Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
				</div>
				<div
					className="flex-1 min-w-0 text-xs font-semibold truncate"
					style={{ color: theme.colors.textMain }}
					title={view.title}
				>
					{view.title}
				</div>
				{view.sourcePlugin && (
					<span
						className="flex-shrink-0 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
						style={{ maxWidth: 120, backgroundColor: `${accent}1f`, color: accent }}
						title={`from ${view.sourcePlugin}`}
					>
						from {view.sourcePlugin}
					</span>
				)}
				{view.sourceAgent && (
					<span
						className="flex-shrink-0 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
						style={{ maxWidth: 88, backgroundColor: `${accent}1f`, color: accent }}
						title={`opened by ${view.sourceAgent}`}
					>
						{view.sourceAgent}
					</span>
				)}
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-opacity opacity-70 hover:opacity-100"
					style={{ color: theme.colors.textDim }}
					title={collapsed ? 'Expand' : 'Collapse'}
					aria-label={collapsed ? 'Expand cadenza' : 'Collapse cadenza'}
				>
					{collapsed ? (
						<ChevronRight className="w-3.5 h-3.5" strokeWidth={2.5} />
					) : (
						<ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
					)}
				</button>
				{canExpand && (
					<button
						type="button"
						onClick={() => expandFile(view, isHud)}
						className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-opacity opacity-70 hover:opacity-100"
						style={{ color: theme.colors.textDim }}
						title="Open in a File Preview tab"
						aria-label="Open in a File Preview tab"
					>
						<ExternalLink className="w-3.5 h-3.5" strokeWidth={2.5} />
					</button>
				)}
				<button
					type="button"
					onClick={() => onClose(view.id)}
					className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-opacity opacity-70 hover:opacity-100"
					style={{ color: theme.colors.textDim }}
					title="Close"
					aria-label="Close cadenza"
				>
					<X className="w-3.5 h-3.5" strokeWidth={2.5} />
				</button>
			</div>

			{!collapsed && (
				<>
					{view.viewType === 'tracker' && view.body !== undefined && (
						<div
							className="px-3 pb-2.5 pt-0.5 text-xs font-mono whitespace-pre-wrap break-words select-text"
							style={{ color: theme.colors.textDim }}
						>
							{view.body}
						</div>
					)}

					{view.viewType === 'file' && view.path && (
						<div className="px-3 pb-2.5 pt-0.5 select-text">
							<div
								className="text-xs font-mono truncate"
								style={{ color: theme.colors.textMain }}
								title={view.path}
							>
								{getBasename(view.path)}
							</div>
							<div
								className="text-[11px] font-mono truncate"
								style={{ color: theme.colors.textDim }}
							>
								{getParentDir(view.path)}
							</div>
						</div>
					)}

					{(view.viewType === 'markdown' || view.viewType === 'code') &&
						view.body !== undefined && (
							<div
								className="px-3 pb-2.5 pt-0.5 select-text overflow-auto"
								style={{ maxHeight: CONTENT_MAX_HEIGHT }}
							>
								<Markdown content={view.body} theme={theme} preset="chat" />
							</div>
						)}

					{view.viewType === 'image' && view.path && (
						<div className="flex justify-center px-3 pb-2.5 pt-0.5">
							<LocalImage
								src={view.path}
								alt={view.title}
								theme={theme}
								maxHeight={CONTENT_MAX_HEIGHT}
								draggable={false}
							/>
						</div>
					)}

					{view.viewType === 'view' && view.body !== undefined && (
						<div
							className="px-3 pb-2.5 pt-0.5 select-text overflow-auto"
							style={{ maxHeight: CONTENT_MAX_HEIGHT }}
						>
							<CadenzaBlocks spec={view.body} theme={theme} />
						</div>
					)}

					{view.viewType === 'html' && view.body !== undefined && (
						<div className="overflow-hidden" style={{ height: CONTENT_MAX_HEIGHT }}>
							<ConcertoHtmlPreview
								surface="cadenza"
								id={view.id}
								revision={view.timestamp}
								title={view.title}
								minHeight={CONTENT_MAX_HEIGHT}
							/>
						</div>
					)}

					{view.viewType === 'decision' && (
						<div className="px-3 pb-3 pt-0.5">
							{view.body !== undefined && (
								<div
									className="mb-2.5 text-xs whitespace-pre-wrap break-words select-text"
									style={{ color: theme.colors.textDim }}
								>
									{view.body}
								</div>
							)}
							<div className="flex flex-wrap gap-1.5">
								{(view.options ?? []).map((opt, i) => (
									<button
										key={i}
										type="button"
										onClick={() => {
											sendDecision(view, opt.value);
											onClose(view.id);
										}}
										className="rounded-md px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-80"
										style={{
											backgroundColor: `${accent}26`,
											color: accent,
											border: `1px solid ${accent}55`,
										}}
										title={`Reply "${opt.value}" to ${view.sourceAgent ?? 'the agent'}`}
									>
										{opt.label}
									</button>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
});

export const CadenzaLayer = memo(function CadenzaLayer({
	theme,
	isHud = false,
}: CadenzaLayerProps) {
	const cadenzas = useCadenzaStore((s) => s.cadenzas);
	const removeCadenza = useCadenzaStore((s) => s.removeCadenza);

	// HUD only: report each card's hit region to the main process, which polls the
	// cursor against them to toggle click-through (cross-platform - no reliance on
	// Linux-unsupported mouse-move forwarding).
	const reportCardRects = useCallback(() => {
		if (!isHud) return;
		const rects = Array.from(document.querySelectorAll('[data-cadenza-card]')).map((el) => {
			const r = el.getBoundingClientRect();
			return { x: r.left, y: r.top, width: r.width, height: r.height };
		});
		window.maestro?.process?.setCadenzaHudCardRects?.(rects);
	}, [isHud]);

	// Observer setup is keyed on the SET of cards (ids), not the array identity, so
	// a drag (which rewrites the array every pointermove) doesn't tear down and
	// rebuild the ResizeObserver each frame. The observer still catches resizes
	// (collapse); drag-time position changes re-report via the light effect below.
	const cardIds = cadenzas.map((c) => c.id).join(',');
	useEffect(() => {
		if (!isHud) return;
		const raf = requestAnimationFrame(reportCardRects);
		const observer = new ResizeObserver(reportCardRects);
		document.querySelectorAll('[data-cadenza-card]').forEach((el) => observer.observe(el));
		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
		};
	}, [isHud, cardIds, reportCardRects]);

	// Light: re-report on any position change (drag) without rebuilding the observer.
	useEffect(() => {
		reportCardRects();
	}, [cadenzas, reportCardRects]);

	if (cadenzas.length === 0) return null;

	return createPortal(
		<div className="fixed inset-0 pointer-events-none" style={{ zIndex: 100000 }}>
			{cadenzas.map((view) => (
				<CadenzaCard
					key={view.id}
					view={view}
					theme={theme}
					isHud={isHud}
					onClose={removeCadenza}
				/>
			))}
		</div>,
		document.body
	);
});
