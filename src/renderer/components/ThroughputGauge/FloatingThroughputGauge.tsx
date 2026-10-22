/**
 * FloatingThroughputGauge - the card the Throughput Gauge lives in.
 *
 * Floats over the Main Window like the media player (`FloatingMediaPlayer`),
 * follows the user across agents and tabs, is dragged by its title strip and
 * resized by its corner grip. It opens parked bottom-left above the composer so
 * it never lands on the media player, which opens bottom-right.
 *
 * Position and size are remembered per layout (`throughputGaugeStore.rects`),
 * written when a drag or resize ends, never per pointer move. Every rect the
 * card draws goes through `fitGaugeRect`, on each drag step, on window resize,
 * and when the custom title strip appears, so the card stays on screen and out
 * from under the strip's OS drag region.
 *
 * The body is `ThroughputGaugeBody`, shared with the desktop widget window: one
 * gauge for the chosen metric, or In, Out, and Combined side by side on ONE
 * shared scale so the three read against each other at a glance.
 *
 * Two ways out: the X in the title strip, and Escape while focus is inside the
 * card. The card is focusable but out of the tab order and never takes focus on
 * its own, so showing it from the hotkey, palette, or menu leaves the caret in
 * the composer, and an always-visible widget never swallows Escape app-wide.
 */

import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Gauge, GripVertical, Settings, X } from 'lucide-react';

import {
	fitGaugeRect,
	gaugeLiftsToasts,
	GAUGE_DEFAULT_SIZE,
	resolveGaugeRect,
	sameGaugeRect,
	type GaugeRect,
	type GaugeViewport,
} from './gaugeGeometry';
import { ThroughputGaugeBody } from './ThroughputGaugeBody';
import { ThroughputGaugeSettingsPopover } from './ThroughputGaugeSettingsPopover';
import { GhostIconButton } from '../ui/GhostIconButton';
import { shortcutSuffix } from '../ui/ShortcutHint';
import { ModalResizeGrip } from '../ui/ModalResizeGrip';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useToastAvoidZone } from '../../hooks/ui/useToastAvoidZone';
import { useMobileLandscape } from '../../hooks/remote/useMobileLandscape';
import { useViewportBreakpoint } from '../../hooks/ui/useViewportBreakpoint';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { APP_TITLE_STRIP_HEIGHT, shouldShowAppTitleStrip } from '../../utils/appTitleStrip';
import type { Theme } from '../../types';

/** Same layer as the media player: above the panels, below modals and toasts. */
const FLOAT_Z_INDEX = 60;

interface FloatingThroughputGaugeProps {
	theme: Theme;
}

export const FloatingThroughputGauge = memo(function FloatingThroughputGauge({
	theme,
}: FloatingThroughputGaugeProps) {
	const { metric, scope, layout, style } = useSettingsStore((s) => s.throughputGaugeSettings);
	const rates = useThroughputGaugeStore((s) => s.rates);
	const peak = useThroughputGaugeStore((s) => s.peak);
	const history = useThroughputGaugeStore((s) => s.history);
	const hide = useThroughputGaugeStore((s) => s.hide);
	const toggleKeys = useSettingsStore((s) => s.shortcuts.toggleThroughputGauge?.keys);
	const saveRect = useThroughputGaugeStore((s) => s.setRect);
	const activeAgentName = useSessionStore((s) =>
		scope === 'active' ? (selectActiveSession(s)?.name ?? null) : null
	);

	const frameRef = useRef<HTMLDivElement | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const gearRef = useRef<HTMLButtonElement>(null);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);

	// The popover holds focus while open, so closing it drops focus on <body>
	// and the next Escape would not reach the card. Hand it back to the frame,
	// but only when it was lost: an outside click that closed the popover keeps
	// focus wherever that click put it.
	const settingsWereOpenRef = useRef(false);
	useLayoutEffect(() => {
		const wasOpen = settingsWereOpenRef.current;
		settingsWereOpenRef.current = settingsOpen;
		if (!wasOpen || settingsOpen) return;
		const active = document.activeElement;
		if (!active || active === document.body) frameRef.current?.focus({ preventScroll: true });
	}, [settingsOpen]);

	/**
	 * Escape hides the card, scoped to the card the way `FloatingMediaPlayer`
	 * scopes it: the gauge floats over a workspace the user keeps typing in, so
	 * Escape belongs to it only while focus is inside it. An open gear popover
	 * is the innermost thing Escape can close, so it goes first; it normally
	 * answers the key itself, and this branch covers a press on the frame.
	 */
	const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
		e.preventDefault();
		e.stopPropagation();
		if (settingsOpen) setSettingsOpen(false);
		else hide();
	};

	// Asked through the same predicate AppShell uses to draw the strip, so the
	// two cannot disagree about where the drag region is.
	const useNativeTitleBar = useSettingsStore((s) => s.useNativeTitleBar);
	const isMobileLandscape = useMobileLandscape();
	const { isMdDown: isMdDownViewport } = useViewportBreakpoint();
	const topInset = shouldShowAppTitleStrip({
		isMobileLandscape,
		useNativeTitleBar,
		isMdDownViewport,
	})
		? APP_TITLE_STRIP_HEIGHT
		: 0;
	const topInsetRef = useRef(topInset);
	topInsetRef.current = topInset;
	const viewport = useCallback(
		(): GaugeViewport => ({
			width: window.innerWidth,
			height: window.innerHeight,
			top: topInsetRef.current,
		}),
		[]
	);

	// The live rect, tagged with its layout. A layout switch swaps in that
	// layout's remembered rect (or its default) during render.
	const [geometry, setGeometry] = useState(() => ({
		layout,
		rect: resolveGaugeRect(layout, useThroughputGaugeStore.getState().rects[layout], viewport()),
	}));
	if (geometry.layout !== layout) {
		setGeometry({
			layout,
			rect: resolveGaugeRect(layout, useThroughputGaugeStore.getState().rects[layout], viewport()),
		});
	}
	const rect = geometry.rect;
	const setRect = (next: GaugeRect) => setGeometry({ layout, rect: next });

	const [gesture, setGesture] = useState<'move' | 'resize' | null>(null);
	const startDrag = usePointerDrag();

	/**
	 * Run one move or resize gesture. `next` maps the pointer delta to a rect;
	 * the result is fitted on every step and saved once, when the gesture ends.
	 * Escape puts the card back where the gesture started.
	 */
	const runGesture = (
		e: ReactPointerEvent<HTMLElement>,
		kind: 'move' | 'resize',
		next: (origin: GaugeRect, dx: number, dy: number) => GaugeRect
	) => {
		const origin = rect;
		let latest = origin;
		startDrag(
			e,
			(dx, dy) => {
				setGesture(kind);
				latest = fitGaugeRect(next(origin, dx, dy), layout, viewport());
				setRect(latest);
			},
			{
				ignoreButtons: kind === 'move',
				stopPropagation: kind === 'resize',
				onEnd: () => {
					setGesture(null);
					if (latest !== origin) saveRect(layout, latest);
				},
				onCancel: () => {
					setGesture(null);
					setRect(origin);
				},
			}
		);
	};

	const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
		// Grabbing the title strip claims focus, so the Escape that follows goes
		// to the card the user is holding, not the surface behind it.
		frameRef.current?.focus({ preventScroll: true });
		runGesture(e, 'move', (origin, dx, dy) => ({
			...origin,
			left: origin.left + dx,
			top: origin.top + dy,
		}));
	};

	const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) =>
		runGesture(e, 'resize', (origin, dx, dy) => ({
			...origin,
			width: origin.width + dx,
			height: origin.height + dy,
		}));

	const defaultSize = GAUGE_DEFAULT_SIZE[layout];
	const resetSize = () => {
		const next = fitGaugeRect({ ...rect, ...defaultSize }, layout, viewport());
		setRect(next);
		saveRect(layout, next);
	};

	// A smaller window, or the title strip appearing, can leave the card partly
	// off screen or under the strip; pull it back in. Not saved: the remembered
	// rect is the user's choice and comes back when the window grows again.
	const refit = useCallback(
		() =>
			setGeometry((prev) => {
				const fitted = fitGaugeRect(prev.rect, prev.layout, viewport());
				return sameGaugeRect(fitted, prev.rect) ? prev : { ...prev, rect: fitted };
			}),
		[viewport]
	);
	useEventListener('resize', refit);
	useEffect(refit, [topInset, refit]);

	// Toasts step over the card when it sits low enough to be covered by them.
	const avoidToastsRef = useToastAvoidZone(`${rect.left},${rect.top},${rect.width},${rect.height}`);
	const liftsToasts = gaugeLiftsToasts(rect, viewport());
	// One element, two owners: the frame ref (focus) and, only while the card
	// sits low, the toast avoid zone.
	const setFrame = useCallback(
		(element: HTMLDivElement | null) => {
			frameRef.current = element;
			avoidToastsRef(liftsToasts ? element : null);
		},
		[avoidToastsRef, liftsToasts]
	);

	return (
		<div
			ref={setFrame}
			data-testid="floating-throughput-gauge"
			data-layout={layout}
			data-style={style}
			// Focusable but not in the tab order: -1 is enough to hold focus after a
			// click, which is what scopes Escape to the card.
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			className="fixed flex flex-col rounded-lg shadow-2xl border overflow-hidden select-none outline-none"
			style={
				{
					left: rect.left,
					top: rect.top,
					width: rect.width,
					height: rect.height,
					zIndex: FLOAT_Z_INDEX,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					// The OS would swallow clicks on any part of the card that ever
					// overlapped the title strip's drag region. Opt the card out.
					WebkitAppRegion: 'no-drag',
				} as CSSProperties
			}
		>
			{/* Title strip doubles as the drag handle. */}
			<div
				className="shrink-0 flex items-center gap-1.5 pl-1 pr-1.5 h-8 border-b"
				style={{
					borderColor: theme.colors.border,
					cursor: gesture === 'move' ? 'grabbing' : 'grab',
				}}
				onPointerDown={onDragStart}
				title="Drag to move"
				data-testid="throughput-gauge-drag-handle"
			>
				<GripVertical
					className="w-3.5 h-4 shrink-0 opacity-60"
					style={{ color: theme.colors.textDim }}
					aria-hidden
				/>
				<Gauge
					className="w-3.5 h-3.5 shrink-0"
					style={{ color: theme.colors.accent }}
					aria-hidden
				/>
				<span
					className="text-xs font-medium truncate flex-1"
					style={{ color: theme.colors.textMain }}
				>
					Throughput
				</span>
				<GhostIconButton
					ref={gearRef}
					onClick={() => setSettingsOpen((open) => !open)}
					title="Gauge settings"
					ariaLabel="Throughput gauge settings"
					pressed={settingsOpen}
					color={settingsOpen ? theme.colors.accent : theme.colors.textDim}
					testId="throughput-gauge-settings-button"
				>
					<Settings className="w-3.5 h-3.5" />
				</GhostIconButton>
				<GhostIconButton
					onClick={hide}
					title={`Hide gauge${shortcutSuffix(toggleKeys)}`}
					ariaLabel="Hide throughput gauge"
					color={theme.colors.textDim}
					testId="throughput-gauge-close"
				>
					<X className="w-3.5 h-3.5" />
				</GhostIconButton>
			</div>

			<div className="flex-1 min-h-0 flex flex-col px-2 pt-1 pb-1.5">
				<ThroughputGaugeBody
					theme={theme}
					metric={metric}
					scope={scope}
					layout={layout}
					style={style}
					rates={rates}
					peak={peak}
					history={history}
					activeAgentName={activeAgentName}
				/>
			</div>

			<ModalResizeGrip
				theme={theme}
				label="Resize throughput gauge"
				onResizePointerDown={onResizeStart}
				onReset={resetSize}
				canReset={rect.width !== defaultSize.width || rect.height !== defaultSize.height}
			/>

			{settingsOpen && (
				<ThroughputGaugeSettingsPopover theme={theme} anchorRef={gearRef} onClose={closeSettings} />
			)}
		</div>
	);
});
