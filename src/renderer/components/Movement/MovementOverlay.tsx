/**
 * MovementOverlay - the agent-composed "living view" as an in-app floating layer.
 *
 * This is the sweet spot between a cadenza (tiny floating card) and a full
 * window: panels float ABOVE the Maestro UI, in the same window, so the user
 * sees them while working - no OS window (no focus-steal / multi-monitor issues)
 * and no full-window mode switch. Rendered via a portal as a `pointer-events-none`
 * layer so it never blocks the app except where a panel actually is.
 *
 * Panels are free-placed (agent sets x/y), draggable by the header, and
 * resizable by the corner. Each renders a BlockView tree. The agent drives them
 * over the `movement` bridge; the user can drag, resize, close, or stash them all.
 */

import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, Eye, EyeOff, LayoutGrid, Minus } from 'lucide-react';
import type { Theme } from '../../types';
import { useMovementStore, type MovementItem } from '../../stores/movementStore';
import { BlockView } from '../BlockView';
import { ConcertoHtmlPreview } from '../Concerto/ConcertoHtmlPreview';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';

interface MovementOverlayProps {
	theme: Theme;
}

/** Above app content; below momentary overlays (Center Flash) which sit at 100000. */
const MOVEMENT_Z = 90000;
/** Auto-height panels scroll internally past this; resized panels use their height. */
const AUTO_MAX_HEIGHT = 560;

const MovementPanel = memo(function MovementPanel({
	item,
	theme,
}: {
	item: MovementItem;
	theme: Theme;
}) {
	const moveItem = useMovementStore((s) => s.moveItem);
	const resizeItem = useMovementStore((s) => s.resizeItem);
	const removeItem = useMovementStore((s) => s.removeItem);
	const setItemMinimized = useMovementStore((s) => s.setItemMinimized);
	const setMeasuredHeight = useMovementStore((s) => s.setMeasuredHeight);
	const surfaceItem = useMovementStore((s) => s.surfaceItem);
	// Pulse this panel when a chat chip points at it (flashItem).
	const isFlashed = useMovementStore((s) => s.flashedId === item.id);
	const startDrag = usePointerDrag();

	const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		surfaceItem(item.id);
		const ox = item.x;
		const oy = item.y;
		startDrag(e, (dx, dy) => moveItem(item.id, ox + dx, oy + dy), { ignoreButtons: true });
	};

	const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		surfaceItem(item.id);
		const ow = item.width;
		// Measure current rendered height so an auto-sized panel resizes smoothly.
		const oh = item.height ?? frameRef.current?.offsetHeight ?? 240;
		startDrag(e, (dx, dy) => resizeItem(item.id, ow + dx, oh + dy), { stopPropagation: true });
	};

	const frameRef = useRef<HTMLDivElement>(null);
	const isHtml = item.viewType === 'html';
	const onClose = () => {
		window.maestro.process.releaseConcertoHtmlDocument?.('movement', item.id);
		removeItem(item.id);
	};

	// Report the panel's real rendered height to the store so `movement state`
	// gives the agent an accurate footprint (even for auto-sized panels).
	useEffect(() => {
		const el = frameRef.current;
		if (!el) return;
		const report = () => setMeasuredHeight(item.id, el.offsetHeight);
		report();
		const ro = new ResizeObserver(report);
		ro.observe(el);
		return () => ro.disconnect();
	}, [item.id, setMeasuredHeight]);

	return (
		<div
			ref={frameRef}
			data-movement-id={item.id}
			aria-hidden={item.minimized || undefined}
			className="pointer-events-auto absolute rounded-xl overflow-hidden select-none"
			style={{
				visibility: item.minimized ? 'hidden' : 'visible',
				left: item.x,
				top: item.y,
				width: item.width,
				height: item.height,
				backgroundColor: theme.colors.bgSidebar,
				border: isFlashed ? `2px solid ${theme.colors.accent}` : `1px solid ${theme.colors.border}`,
				boxShadow: isFlashed
					? `0 0 0 3px ${theme.colors.accent}66, 0 16px 40px -16px rgba(0,0,0,0.6)`
					: `0 16px 40px -16px rgba(0,0,0,0.6)`,
				transition: 'box-shadow 0.25s ease, border-color 0.25s ease',
			}}
		>
			<div
				className="flex items-center gap-2 px-3 py-1.5 cursor-grab active:cursor-grabbing"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
				onPointerDown={onDragStart}
			>
				<div
					className="flex-1 min-w-0 text-sm font-semibold truncate"
					style={{ color: theme.colors.textMain }}
					title={item.title}
				>
					{item.title ?? item.id}
				</div>
				{item.sourcePlugin && (
					<span
						className="flex-shrink-0 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
						style={{
							maxWidth: 120,
							backgroundColor: `${theme.colors.accent}1f`,
							color: theme.colors.accent,
						}}
						title={`from ${item.sourcePlugin}`}
					>
						from {item.sourcePlugin}
					</span>
				)}
				<button
					type="button"
					onClick={() => setItemMinimized(item.id, true)}
					className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-opacity opacity-70 hover:opacity-100"
					style={{ color: theme.colors.textDim }}
					title={`Minimize ${item.title ?? item.id}`}
					aria-label={`Minimize ${item.title ?? item.id}`}
				>
					<Minus className="w-3.5 h-3.5" strokeWidth={2.5} />
				</button>
				<button
					type="button"
					onClick={onClose}
					className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-opacity opacity-70 hover:opacity-100"
					style={{ color: theme.colors.textDim }}
					title="Close panel"
					aria-label="Close movement panel"
				>
					<X className="w-3.5 h-3.5" strokeWidth={2.5} />
				</button>
			</div>
			<div
				className={isHtml ? 'overflow-hidden select-text' : 'p-4 overflow-auto select-text'}
				style={{
					height: item.height ? 'calc(100% - 34px)' : undefined,
					maxHeight: item.height ? undefined : AUTO_MAX_HEIGHT,
				}}
			>
				{isHtml ? (
					<ConcertoHtmlPreview
						surface="movement"
						id={item.id}
						revision={item.timestamp}
						title={item.title ?? item.id}
						minHeight={item.height ? 0 : 480}
					/>
				) : (
					<BlockView spec={item.spec} theme={theme} />
				)}
			</div>
			{/* Resize handle (bottom-right corner). */}
			<div
				onPointerDown={onResizeStart}
				className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
				style={{
					background: `linear-gradient(135deg, transparent 50%, ${theme.colors.textDim}66 50%)`,
				}}
				title="Resize"
				aria-label="Resize panel"
			/>
		</div>
	);
});

export const MovementOverlay = memo(function MovementOverlay({ theme }: MovementOverlayProps) {
	const items = useMovementStore((s) => s.items);
	const hidden = useMovementStore((s) => s.hidden);
	const setHidden = useMovementStore((s) => s.setHidden);
	const surfaceItem = useMovementStore((s) => s.surfaceItem);
	const setViewport = useMovementStore((s) => s.setViewport);
	const [taskbarHovered, setTaskbarHovered] = useState(false);
	const [taskbarFocused, setTaskbarFocused] = useState(false);
	const taskbarExpanded = taskbarHovered || taskbarFocused;

	// Report the window size to the store (the overlay spans the window), so the
	// agent's `movement state` read knows the space it's composing into.
	useEffect(() => {
		const report = () => setViewport(window.innerWidth, window.innerHeight);
		report();
		window.addEventListener('resize', report);
		return () => window.removeEventListener('resize', report);
	}, [setViewport]);

	if (items.length === 0) return null;

	return createPortal(
		<div className="fixed inset-0 pointer-events-none" style={{ zIndex: MOVEMENT_Z }}>
			<div
				data-testid="movement-panels"
				aria-hidden={hidden || undefined}
				style={{ visibility: hidden ? 'hidden' : 'visible' }}
			>
				{items.map((item) => (
					<MovementPanel key={item.id} item={item} theme={theme} />
				))}
			</div>
			<div
				className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2"
				onMouseEnter={() => setTaskbarHovered(true)}
				onMouseLeave={() => setTaskbarHovered(false)}
				onFocus={() => setTaskbarFocused(true)}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) setTaskbarFocused(false);
				}}
			>
				<div
					data-testid="movement-taskbar"
					className="h-10 flex items-center gap-1 overflow-hidden rounded-full p-1 shadow-xl transition-[width,opacity] duration-200"
					style={{
						width: taskbarExpanded ? 'min(760px, calc(100vw - 24px))' : 44,
						backgroundColor: theme.colors.bgSidebar,
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
						opacity: taskbarExpanded ? 1 : 0.78,
					}}
				>
					<button
						type="button"
						onClick={() => setHidden(!hidden)}
						className="relative flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full transition-colors"
						style={{
							color: hidden ? theme.colors.accent : theme.colors.textDim,
							backgroundColor: hidden ? `${theme.colors.accent}1f` : 'transparent',
						}}
						title={hidden ? 'Show Concerto windows' : 'Hide all Concerto windows'}
						aria-label={hidden ? 'Show Concerto windows' : 'Hide all Concerto windows'}
						aria-expanded={taskbarExpanded}
					>
						{hidden ? (
							<Eye className="w-3.5 h-3.5" strokeWidth={2.5} />
						) : (
							<LayoutGrid className="w-3.5 h-3.5" strokeWidth={2.5} />
						)}
						<span
							className="absolute -right-0.5 -top-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full text-[9px] leading-[14px] text-center font-semibold"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						>
							{items.length}
						</span>
					</button>
					<div
						aria-hidden={!taskbarExpanded}
						aria-label="Concerto taskbar"
						className="min-w-0 flex-1 flex items-center gap-1 overflow-x-auto transition-opacity duration-150"
						style={{
							opacity: taskbarExpanded ? 1 : 0,
							pointerEvents: taskbarExpanded ? 'auto' : 'none',
						}}
					>
						<div
							className="h-5 w-px flex-shrink-0 mx-1"
							style={{ backgroundColor: theme.colors.border }}
						/>
						<span
							className="flex-shrink-0 px-1 text-[10px] font-semibold uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Concertos
						</span>
						{items.map((item, index) => {
							const label = item.title ?? item.id;
							const isFront = !hidden && !item.minimized && index === items.length - 1;
							return (
								<button
									key={item.id}
									type="button"
									onClick={() => surfaceItem(item.id)}
									tabIndex={taskbarExpanded ? 0 : -1}
									className="min-w-0 max-w-36 flex-shrink flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors"
									style={{
										backgroundColor: isFront ? `${theme.colors.accent}24` : theme.colors.bgActivity,
										color: item.minimized || hidden ? theme.colors.textDim : theme.colors.textMain,
									}}
									title={item.minimized || hidden ? `Restore ${label}` : `Bring ${label} to front`}
									aria-label={
										item.minimized || hidden ? `Restore ${label}` : `Bring ${label} to front`
									}
								>
									<span
										className="w-1.5 h-1.5 flex-shrink-0 rounded-full"
										style={{
											backgroundColor:
												item.minimized || hidden ? theme.colors.textDim : theme.colors.accent,
										}}
									/>
									<span className="truncate">{label}</span>
								</button>
							);
						})}
						<button
							type="button"
							onClick={() => setHidden(!hidden)}
							tabIndex={taskbarExpanded ? 0 : -1}
							className="flex-shrink-0 flex items-center gap-1 rounded-full px-2 py-1.5 text-[11px] transition-colors"
							style={{ color: theme.colors.textDim }}
							title={hidden ? 'Show all Concerto windows' : 'Hide all Concerto windows'}
							aria-label={hidden ? 'Show all Concerto windows' : 'Hide all Concerto windows'}
						>
							{hidden ? (
								<Eye className="w-3 h-3" strokeWidth={2.5} />
							) : (
								<EyeOff className="w-3 h-3" strokeWidth={2.5} />
							)}
							{hidden ? 'Show all' : 'Hide all'}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body
	);
});
