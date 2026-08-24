/**
 * MovementStage - the agent-composed "living view", rendered inside the
 * Concerto stage window (components/Concerto/ConcertoStageModal).
 *
 * This is the sweet spot between a cadenza (tiny floating card) and an OS
 * window: panels float on one shared stage - free-placed (the agent sets x/y),
 * draggable by the header, resizable from every edge and corner, minimizable to
 * the stage taskbar - with no focus-steal and no multi-monitor problems. Each
 * panel renders a BlockView tree or an isolated HTML document. The agent drives
 * them over the `movement` bridge; the user drags, resizes, minimizes, or closes
 * them.
 *
 * The stage fills its container and reports that container's size as the
 * viewport the agent lays out against, so panel coordinates and `movement state`
 * agree with what is on screen at whatever size the user dragged the window to.
 */

import {
	memo,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from 'react';
import { LayoutGrid, Minus, Music2, X } from 'lucide-react';
import type { Theme } from '../../types';
import {
	MOVEMENT_ITEM_MIN_HEIGHT,
	MOVEMENT_ITEM_MIN_WIDTH,
	useMovementStore,
	type MovementItem,
	type MovementItemBounds,
} from '../../stores/movementStore';
import { BlockView } from '../BlockView';
import { ConcertoHtmlPreview } from '../Concerto/ConcertoHtmlPreview';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { useDebouncedCallback } from '../../hooks/utils/useThrottle';
import { ResizeHandles } from '../ui/ResizeHandles';
import type { ModalResizeDirection } from '../../hooks/ui/useResizableModal';

interface MovementStageProps {
	theme: Theme;
}

/** Auto-height panels scroll internally past this; resized panels use their height. */
const AUTO_MAX_HEIGHT = 560;
/** Keep a hover-open taskbar available through small pointer slips. */
const TASKBAR_COLLAPSE_DELAY_MS = 1500;

function resizedBounds(
	direction: ModalResizeDirection,
	start: MovementItemBounds,
	deltaX: number,
	deltaY: number
): MovementItemBounds {
	let { x, y, width, height } = start;

	if (direction.includes('e')) width = Math.max(MOVEMENT_ITEM_MIN_WIDTH, width + deltaX);
	if (direction.includes('s')) height = Math.max(MOVEMENT_ITEM_MIN_HEIGHT, height + deltaY);
	if (direction.includes('w')) {
		const right = x + width;
		width = Math.max(MOVEMENT_ITEM_MIN_WIDTH, width - deltaX);
		x = right - width;
		if (x < 0) {
			x = 0;
			width = right;
		}
	}
	if (direction.includes('n')) {
		const bottom = y + height;
		height = Math.max(MOVEMENT_ITEM_MIN_HEIGHT, height - deltaY);
		y = bottom - height;
		if (y < 0) {
			y = 0;
			height = bottom;
		}
	}

	return { x, y, width, height };
}

const MovementPanel = memo(function MovementPanel({
	item,
	theme,
	z,
}: {
	item: MovementItem;
	theme: Theme;
	z: number;
}) {
	const moveItem = useMovementStore((s) => s.moveItem);
	const resizeItem = useMovementStore((s) => s.resizeItem);
	const dismissItem = useMovementStore((s) => s.dismissItem);
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

	const onResizeStart = (direction: ModalResizeDirection, e: ReactPointerEvent<HTMLDivElement>) => {
		surfaceItem(item.id);
		// Measure current rendered height so an auto-sized panel resizes smoothly.
		const startBounds = {
			x: item.x,
			y: item.y,
			width: item.width,
			height: item.height ?? frameRef.current?.offsetHeight ?? 240,
		};
		startDrag(e, (dx, dy) => resizeItem(item.id, resizedBounds(direction, startBounds, dx, dy)), {
			stopPropagation: true,
		});
	};

	const frameRef = useRef<HTMLDivElement>(null);
	const isHtml = item.viewType === 'html';
	const hasHtml = Boolean(item.html);
	const onClose = () => {
		window.maestro.process.releaseConcertoHtmlDocument?.('movement', item.id);
		dismissItem(item.id);
	};

	// Report the panel's real rendered height to the store so `movement state`
	// gives the agent an accurate footprint (even for auto-sized panels).
	useEffect(() => {
		const el = frameRef.current;
		if (!el) return;
		// A stage that is closed (or a minimized panel) measures zero. Reporting
		// that would tell `movement state` the panel has no footprint at all, so
		// keep the last real measurement until the panel is on screen again.
		const report = () => {
			if (el.offsetHeight > 0) setMeasuredHeight(item.id, el.offsetHeight);
		};
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
			className="absolute rounded-xl overflow-hidden select-none"
			style={{
				visibility: item.minimized ? 'hidden' : 'visible',
				zIndex: z,
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
					<div className="relative h-full w-full">
						{hasHtml ? (
							<ConcertoHtmlPreview
								surface="movement"
								id={item.id}
								revision={item.timestamp}
								title={item.title ?? item.id}
								minHeight={item.height ? 0 : 480}
							/>
						) : (
							<div
								data-testid="movement-preparing-shell"
								className="h-full min-h-[240px] w-full overflow-hidden p-6"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
								}}
								aria-live="polite"
							>
								<div
									className="flex h-full flex-col rounded-lg border p-5"
									style={{ borderColor: theme.colors.border }}
								>
									<div
										className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em]"
										style={{ color: theme.colors.accent }}
									>
										<Music2 className="h-4 w-4 animate-pulse" />
										Composing
									</div>
									<div
										className="mt-6 h-8 w-2/3 animate-pulse rounded"
										style={{ backgroundColor: `${theme.colors.accent}24` }}
									/>
									<div
										className="mt-4 h-3 w-full animate-pulse rounded"
										style={{ backgroundColor: theme.colors.bgActivity }}
									/>
									<div
										className="mt-2 h-3 w-4/5 animate-pulse rounded"
										style={{ backgroundColor: theme.colors.bgActivity }}
									/>
									<div className="mt-auto grid grid-cols-3 gap-3">
										{[0, 1, 2].map((slot) => (
											<div
												key={slot}
												className="h-20 animate-pulse rounded-md"
												style={{ backgroundColor: `${theme.colors.accent}12` }}
											/>
										))}
									</div>
								</div>
							</div>
						)}
						{item.preparing && hasHtml && (
							<div
								data-testid="movement-revising-badge"
								className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide shadow-lg"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									borderColor: theme.colors.border,
									color: theme.colors.accent,
								}}
							>
								<Music2 className="h-3 w-3 animate-pulse" />
								Revising
							</div>
						)}
					</div>
				) : (
					<BlockView spec={item.spec} theme={theme} />
				)}
			</div>
			<ResizeHandles
				onPointerResizeStart={onResizeStart}
				accentColor={theme.colors.accent}
				contained
				testIdPrefix="movement-resize-handle"
			/>
		</div>
	);
});

export const MovementStage = memo(function MovementStage({ theme }: MovementStageProps) {
	const items = useMovementStore((s) => s.items);
	const surfaceItem = useMovementStore((s) => s.surfaceItem);
	const setItemMinimized = useMovementStore((s) => s.setItemMinimized);
	const setViewport = useMovementStore((s) => s.setViewport);
	const [taskbarHovered, setTaskbarHovered] = useState(false);
	const [taskbarFocused, setTaskbarFocused] = useState(false);
	const [taskbarPinned, setTaskbarPinned] = useState(false);
	const { debouncedCallback: finishTaskbarHover, cancel: cancelTaskbarCollapse } =
		useDebouncedCallback(() => setTaskbarHovered(false), TASKBAR_COLLAPSE_DELAY_MS);
	const taskbarExpanded = taskbarHovered || taskbarFocused || taskbarPinned;
	const taskbarItems = [...items].sort((a, b) => a.taskbarOrder - b.taskbarOrder);
	const stageRef = useRef<HTMLDivElement>(null);

	// The agent lays out against the stage, not the window, so report the
	// container's own size. Zero-size reports are skipped: the stage measures 0
	// while its window is closed, and publishing that would tell the agent it has
	// nowhere to place a panel.
	useLayoutEffect(() => {
		const el = stageRef.current;
		if (!el) return;
		const report = (width: number, height: number) => {
			if (width > 0 && height > 0) setViewport(Math.round(width), Math.round(height));
		};
		const rect = el.getBoundingClientRect();
		report(rect.width, rect.height);
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver((entries) => {
			const box = entries[entries.length - 1]?.contentRect;
			if (box) report(box.width, box.height);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [setViewport]);

	return (
		<div
			ref={stageRef}
			data-testid="movement-stage-root"
			className="relative w-full h-full overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgMain,
				backgroundImage: `radial-gradient(${theme.colors.border}55 1px, transparent 1px)`,
				backgroundSize: '20px 20px',
			}}
		>
			{items.length === 0 && (
				<div
					data-testid="movement-stage-empty"
					className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center"
				>
					<Music2 className="h-8 w-8" style={{ color: theme.colors.accent, opacity: 0.7 }} />
					<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						The stage is empty
					</div>
					<div className="text-xs max-w-md" style={{ color: theme.colors.textDim }}>
						Ask an agent for something worth looking at - a board to play on, a dashboard, a mockup,
						a simulator - and it composes the view here.
					</div>
				</div>
			)}
			<div data-testid="movement-panels">
				{items.map((item, index) => (
					<MovementPanel key={item.id} item={item} theme={theme} z={index + 1} />
				))}
			</div>
			{/* Nothing to launch and nothing to restore on an empty stage, so the
			    taskbar stays out of the way until the first panel exists. */}
			{items.length > 0 && (
				<div
					data-testid="movement-taskbar-anchor"
					className="absolute bottom-3 right-3"
					style={{ zIndex: items.length + 1 }}
					onMouseEnter={() => {
						cancelTaskbarCollapse();
						setTaskbarHovered(true);
					}}
					onMouseLeave={finishTaskbarHover}
					onFocus={() => setTaskbarFocused(true)}
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) setTaskbarFocused(false);
					}}
				>
					<div
						data-testid="movement-taskbar"
						className="h-10 flex items-center gap-1 overflow-hidden rounded-full p-1 shadow-xl transition-[width,opacity] duration-200"
						style={{
							width: taskbarExpanded ? 'min(760px, calc(100% - 24px))' : 44,
							backgroundColor: theme.colors.bgSidebar,
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.border}`,
							opacity: taskbarExpanded ? 1 : 0.78,
						}}
					>
						<button
							type="button"
							onClick={() => setTaskbarPinned((pinned) => !pinned)}
							className="relative flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full transition-colors"
							style={{
								color: taskbarPinned ? theme.colors.accent : theme.colors.textDim,
								backgroundColor: taskbarPinned ? `${theme.colors.accent}1f` : 'transparent',
							}}
							title={taskbarPinned ? 'Unpin Concerto taskbar' : 'Pin Concerto taskbar open'}
							aria-label={taskbarPinned ? 'Unpin Concerto taskbar' : 'Pin Concerto taskbar open'}
							aria-expanded={taskbarExpanded}
							aria-pressed={taskbarPinned}
						>
							<LayoutGrid className="w-3.5 h-3.5" strokeWidth={2.5} />
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
							{taskbarItems.map((item) => {
								const label = item.title ?? item.id;
								const isFront = !item.minimized && item.id === items[items.length - 1]?.id;
								return (
									<button
										key={item.id}
										type="button"
										onClick={() => {
											if (item.minimized) surfaceItem(item.id);
											else setItemMinimized(item.id, true);
										}}
										tabIndex={taskbarExpanded ? 0 : -1}
										className="min-w-0 max-w-36 flex-shrink flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors"
										style={{
											backgroundColor: isFront
												? `${theme.colors.accent}24`
												: theme.colors.bgActivity,
											color: item.minimized ? theme.colors.textDim : theme.colors.textMain,
										}}
										title={item.minimized ? `Restore ${label}` : `Minimize ${label}`}
										aria-label={item.minimized ? `Restore ${label}` : `Minimize ${label}`}
									>
										<span
											className="w-1.5 h-1.5 flex-shrink-0 rounded-full"
											style={{
												backgroundColor: item.minimized
													? theme.colors.textDim
													: theme.colors.accent,
											}}
										/>
										<span className="truncate">{label}</span>
									</button>
								);
							})}
						</div>
					</div>
				</div>
			)}
		</div>
	);
});
