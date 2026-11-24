/**
 * BrowserDesignModeLayer - the host overlay a browser tab shows while Design
 * Mode is on.
 *
 * It covers the webview, so the page never sees the pointer while the user is
 * picking: its own click handlers cannot fire, and it cannot fake a pick (see
 * the trust model in `utils/designModePicker.ts`). The overlay asks the guest
 * what sits under the pointer, draws the outline itself in theme colors, and on
 * a click or Enter shows a pick card where the user can add a note before the
 * element goes into the agent's message.
 *
 * Design Mode is sticky per browser tab (`BrowserTab.designMode`). The host
 * mounts this layer only while the tab is the active surface and unmounts it
 * otherwise, so each return to the tab is a fresh layer (focus, center probe).
 * A finished page load (`pageLoadCount`) is not an exit: the layer probes the
 * new document at the same point.
 *
 * Keys (the overlay holds focus): Enter picks, ArrowUp / ArrowDown walk to the
 * parent / back toward the child, Escape drops a drag in progress, closes the
 * card, or leaves Design Mode. In the card (from the note): Enter adds to the
 * message, Cmd/Ctrl+Enter adds and keeps picking, Alt/Option+Enter queues the
 * pick as its own message and keeps picking, Shift+Enter is a newline.
 *
 * Drag to pick a region, as in a screenshot tool: press on the page and move
 * more than DRAG_THRESHOLD_PX, and a dashed box follows the pointer from the
 * press point, with its size. The release asks the guest for the region (its
 * screenshot and the outermost elements in it) and opens the card for it. A
 * shorter move is a click, which picks the element. Each drag is a pick of its
 * own, so "Add and Pick Another" after each one stages a chip per region. The
 * drag is followed on the window (see `followDrag`), so it goes on, held at
 * the page's edge, when the pointer leaves the page.
 *
 * Hold Space to use the page (click a link, scroll, type): the overlay lets
 * the pointer through to the page and hides its outline, and picking resumes
 * when Space is released. Space in the note or on a focused control is an
 * ordinary key. How the release is heard is explained above `startPassthrough`.
 *
 * The hover label is the outlined element's path, as crumbs
 * (`body > main > section.footer > div`). Clicking a crumb outlines that
 * ancestor, as ArrowUp would, and holds it while the pointer stays near the
 * crumbs, so the move back onto the page to click it does not undo the walk
 * (see `selectAncestor`).
 *
 * Queue (`onQueue`) is for the user who lines up many fixes while the agent
 * works: the pick goes to the agent's execution queue as a message of its own,
 * and the draft is not touched. Like "Add and Pick Another" it stays in Design
 * Mode. Nothing else on this surface shows where the pick went, so it says so
 * with a center flash naming the tab. A host that cannot queue leaves `onQueue`
 * out: the card then has no Queue button and Alt+Enter does nothing.
 *
 * Escape is handled here rather than through the layer stack on purpose: a
 * registered layer makes the browser tab inactive (`layerCount === 0` gates it
 * in MainPanelContent), and an inactive tab unmounts this overlay, card and
 * all. The in-page find bar handles its Escape the same way.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BoxSelect, Hand, ImageOff, MousePointerClick } from 'lucide-react';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { Spinner } from '../ui/Spinner';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { captureException } from '../../utils/sentry';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import {
	captureDesignPick,
	captureDesignRegion,
	designOverlayScale,
	designRegionLabel,
	parseDesignModePassthrough,
	parseDesignModeProbe,
	type DesignModeFrame,
	type DesignModeGuestAccess,
	type DesignModeMiss,
	type DesignModePassthroughReport,
	type DesignModeProbe,
	type DesignModeRect,
	type DesignModeRegion,
	type DesignPickCapture,
} from '../../utils/designModePicker';

export interface BrowserDesignModeLayerProps {
	theme: Theme;
	access: DesignModeGuestAccess;
	/**
	 * Finished page loads in the webview so far. A change means a new document
	 * is under the pointer: the layer drops the old page's outline state and
	 * probes again at the same point.
	 */
	pageLoadCount: number;
	/** Leave Design Mode. */
	onExit: () => void;
	/**
	 * Hand a pick (an element, or a region the user dragged out) to the agent.
	 * `keepPicking` keeps the user picking here; otherwise the caller shows the
	 * message, which takes the tab off screen (Design Mode stays on and re-arms
	 * when the tab is shown again). Resolves false when nothing was delivered
	 * (the card stays open).
	 */
	onDeliver: (capture: DesignPickCapture, note: string, keepPicking: boolean) => Promise<boolean>;
	/**
	 * Queue a pick as its own message and stay in Design Mode. Resolves the name
	 * of the tab it was queued on, or null when nothing was queued (the card
	 * stays open). Leave it out where the host cannot queue.
	 */
	onQueue?: (capture: DesignPickCapture, note: string) => Promise<{ tabName: string } | null>;
}

interface Point {
	x: number;
	y: number;
}

/**
 * Hold Space to use the page. 'page': Space is down and the page gets the
 * pointer. 'away': Space is still down, but the pointer was seen outside the
 * page, so the layer takes the pointer back to notice its return.
 */
type Passthrough = 'off' | 'page' | 'away';

/** The space bar, on any layout and with any modifiers. */
function isSpaceKey(event: { key: string; code: string }): boolean {
	return event.key === ' ' || event.code === 'Space';
}

/**
 * An auto-repeat of Space heard this recently means the key is still down.
 * Repeats come every 30-90 ms at the usual settings; a slower setting only
 * makes the fallback resume picking early, and the next repeat starts using
 * the page again.
 */
const SPACE_STILL_HELD_MS = 500;

/** A guest CSS box scaled to overlay (webview DIP) pixels. */
function toLayerRect(rect: DesignModeRect, scale: number): DesignModeRect {
	return {
		x: rect.x * scale,
		y: rect.y * scale,
		width: rect.width * scale,
		height: rect.height * scale,
	};
}

/**
 * `W x H` in guest CSS pixels, rounded: an overlay box at its overlay scale,
 * or a guest box at scale 1.
 */
function sizeText(box: DesignModeRect, scale: number): string {
	return `${Math.round(box.width / scale)} x ${Math.round(box.height / scale)}`;
}

/**
 * How far the pointer must move with the button down before a press on the
 * page becomes a drag (a region). A press that moves this little or less is a
 * click, which picks the element.
 */
const DRAG_THRESHOLD_PX = 4;

/** The box between two overlay points, whichever way the drag went. */
function boxBetween(a: Point, b: Point): DesignModeRect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(a.x - b.x),
		height: Math.abs(a.y - b.y),
	};
}

/**
 * A point held inside the overlay, so a drag that leaves the page stops at its
 * edge. A frame of no size (no layout) has no edge to hold it to.
 */
function clampToFrame(point: Point, frame: DesignModeFrame): Point {
	return {
		x: frame.width > 0 ? Math.min(Math.max(point.x, 0), frame.width) : point.x,
		y: frame.height > 0 ? Math.min(Math.max(point.y, 0), frame.height) : point.y,
	};
}

/** `5 elements`, `1 element`, `12+ elements` (the page's list was cut), or `no elements`. */
function regionElementCount(region: DesignModeRegion): string {
	const count = region.elements.length;
	if (count === 0) return 'no elements';
	if (region.elementsTruncated) return `${count}+ elements`;
	return count === 1 ? '1 element' : `${count} elements`;
}

/**
 * A capture that failed (a screenshot that did not come, a guest gone
 * mid-pick) is not an expected outcome, so it is reported, never thrown.
 */
function reportCaptureError(error: unknown): void {
	captureException(error, { tags: { surface: 'browser-design-mode' } });
}

/** Room the hover label needs above an element; with less it goes below it. */
const LABEL_ROOM_PX = 22;

/**
 * How far the hover label reaches over the outlined element's edge. With no
 * gap between them, the pointer can move from the element onto its crumbs
 * without crossing another element, whose probe would move the label away.
 */
const LABEL_OVERLAP_PX = 2;

/**
 * How near its crumbs the pointer must stay for an ancestor picked from them
 * to stay outlined (see `selectAncestor`).
 */
const CRUMB_HOLD_REACH_PX = 48;

/** Where a hover label sits: on the element's top edge, or under it near the top of the page. */
interface LabelSpot {
	/** The label's left edge in overlay pixels, before it slides left to fit. */
	left: number;
	/** The y of the element edge the label rests on. */
	edge: number;
	above: boolean;
}

function labelSpotFor(outline: DesignModeRect): LabelSpot {
	const above = outline.y > LABEL_ROOM_PX;
	return {
		left: Math.max(0, outline.x),
		edge: above ? outline.y : outline.y + outline.height,
		above,
	};
}

/**
 * Lays a hover label at `spot`. The row spans the overlay with a spacer
 * `spot.left` wide in front of the label, and only the spacer can shrink, so a
 * label that would run off the right edge slides left to fit.
 */
function LabelAt({ spot, children }: { spot: LabelSpot; children: React.ReactNode }) {
	return (
		<div
			className="absolute inset-x-0 flex pointer-events-none"
			style={
				spot.above
					? { top: spot.edge + LABEL_OVERLAP_PX, transform: 'translateY(-100%)' }
					: { top: spot.edge - LABEL_OVERLAP_PX }
			}
		>
			<div className="min-w-0" style={{ flex: `0 1 ${spot.left}px` }} />
			{children}
		</div>
	);
}

interface DesignModeCrumbsProps {
	theme: Theme;
	probe: DesignModeProbe;
	/** `W x H` of the outlined element, guest CSS pixels. */
	size: string;
	/** Outline the ancestor this many levels above the hit element. */
	onSelect: (depth: number) => void;
}

/**
 * The hover label: the outlined element's path, farthest first
 * (`body > main > section.footer > div`), then its size. Each ancestor is a
 * button; the outlined element is the last crumb. The labels are page data,
 * drawn as plain text.
 */
const DesignModeCrumbs = React.forwardRef<HTMLDivElement, DesignModeCrumbsProps>(
	function DesignModeCrumbs({ theme, probe, size, onSelect }, ref) {
		const farthestFirst = probe.ancestors
			.map((label, index) => ({ label, depth: probe.depth + index + 1 }))
			.reverse();
		const separator = (
			<span aria-hidden="true" style={{ color: theme.colors.textDim }}>
				&gt;
			</span>
		);
		return (
			<div
				ref={ref}
				className="pointer-events-auto shrink-0 max-w-full overflow-hidden flex items-center justify-end gap-1 rounded px-1.5 py-0.5 text-xs-plus font-mono whitespace-nowrap border shadow"
				style={
					{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						cursor: 'default',
						// The theme's own hover wash (FontSizeStepper does the same).
						'--design-crumb-hover-bg': theme.colors.bgActivity,
					} as React.CSSProperties
				}
				// Over the crumbs the outline stays put, so they can be reached, and a
				// click on them never picks the element underneath (as on the banner).
				onMouseMove={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
				role="navigation"
				aria-label="Outlined element path"
				data-testid="browser-tab-design-mode-crumbs"
			>
				{probe.ancestorsTruncated ? (
					<>
						<span style={{ color: theme.colors.textDim }} title="More ancestors above">
							…
						</span>
						{separator}
					</>
				) : null}
				{farthestFirst.map(({ label, depth }) => (
					<React.Fragment key={depth}>
						{/* Mouse only: the arrows walk the same chain from the keyboard, and
						    a tab stop in a row that changes on every move would not last. */}
						<button
							type="button"
							tabIndex={-1}
							className="shrink-0 max-w-[12rem] truncate rounded px-0.5 hover:bg-[var(--design-crumb-hover-bg)]"
							title={label}
							onClick={() => onSelect(depth)}
							data-testid="browser-tab-design-mode-crumb"
						>
							{label}
						</button>
						{separator}
					</React.Fragment>
				))}
				<span
					className="shrink-0 max-w-[16rem] truncate px-0.5 font-semibold"
					style={{ color: theme.colors.accent }}
					title={probe.label}
					aria-current="true"
				>
					{probe.label}
				</span>
				<span className="shrink-0 ml-1" style={{ color: theme.colors.textDim }}>
					{size}
				</span>
			</div>
		);
	}
);

/**
 * The region box: a dashed accent edge over a light accent wash, ringed in
 * the page background so it reads on any page, with its size on a label like
 * the hover label. Drawn while the user drags it out and while its card is
 * open.
 */
function DesignModeMarquee({
	theme,
	box,
	size,
}: {
	theme: Theme;
	/** The box, overlay pixels. */
	box: DesignModeRect;
	/** `W x H` in guest CSS pixels. */
	size: string;
}) {
	return (
		<>
			<div
				className="absolute pointer-events-none"
				style={{
					left: box.x,
					top: box.y,
					width: box.width,
					height: box.height,
					borderWidth: 1,
					borderStyle: 'dashed',
					borderColor: theme.colors.accent,
					boxShadow: `0 0 0 1px ${theme.colors.bgMain}`,
					backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 12%, transparent)`,
				}}
				data-testid="browser-tab-design-mode-marquee"
			/>
			<LabelAt spot={labelSpotFor(box)}>
				<div
					className="shrink-0 rounded px-1.5 py-0.5 text-xs-plus font-mono whitespace-nowrap border shadow"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					data-testid="browser-tab-design-mode-marquee-size"
				>
					{size}
				</div>
			</LabelAt>
		</>
	);
}

export function BrowserDesignModeLayer({
	theme,
	access,
	pageLoadCount,
	onExit,
	onDeliver,
	onQueue,
}: BrowserDesignModeLayerProps) {
	const layerRef = useRef<HTMLDivElement | null>(null);
	const noteRef = useRef<HTMLTextAreaElement | null>(null);
	const accessRef = useRef(access);
	accessRef.current = access;
	const pointRef = useRef<Point | null>(null);
	const depthRef = useRef(0);
	const pendingProbeRef = useRef(false);
	const probeInFlightRef = useRef(false);
	// Bumped on every request (pointer move, arrow key, scroll). A reply is only
	// applied while it is still the newest one, so a slow reply for an older
	// point or depth cannot undo an ArrowUp the user pressed meanwhile.
	const probeSeqRef = useRef(0);
	const mountedRef = useRef(true);

	// `scale` is overlay pixels per guest CSS pixel (designOverlayScale);
	// `point` is where the probe asked, which its crumbs are walked from.
	const [hover, setHover] = useState<{
		probe: DesignModeProbe;
		scale: number;
		point: Point;
	} | null>(null);
	// An ancestor chosen from the crumbs stays outlined while the pointer is near
	// them (see selectAncestor). The ref is for handlers; the spot, where the
	// crumbs stay meanwhile, drives the render.
	const holdingRef = useRef(false);
	const [heldSpot, setHeldSpot] = useState<LabelSpot | null>(null);
	const crumbsRef = useRef<HTMLDivElement | null>(null);
	// Where the hover label was drawn last, for a crumb click to keep it there.
	const labelSpotRef = useRef<LabelSpot | null>(null);
	const [picking, setPicking] = useState(false);
	// What the card is for (an element or a region) plus the overlay scale at
	// pick time, so its frozen outline is scaled right even when no hover
	// outline preceded it.
	const [card, setCard] = useState<{ capture: DesignPickCapture; scale: number } | null>(null);
	// A ref, not the `picking` state: a click and an Enter in the same tick must
	// not both start a pick.
	const pickingRef = useRef(false);
	// A press on the page, from mousedown to its release: where it went down
	// (overlay px), and whether it moved far enough to be a drag (a region)
	// rather than a click (an element). See followDrag for how it is followed.
	const pressRef = useRef<{ start: Point; dragging: boolean } | null>(null);
	// The region box being dragged out (overlay px) and the scale its size is
	// read at. It stays up, frozen, while the region is captured.
	const [marquee, setMarquee] = useState<{ box: DesignModeRect; scale: number } | null>(null);
	// The release of a drag (or of a press Escape dropped) still makes a click
	// on the layer; that click must not pick the element under it. Cleared by
	// the click, or by the next press when the click landed elsewhere.
	const swallowClickRef = useRef(false);
	// Overlay px per guest CSS px at the last probe: what a drag's size is read
	// at, since nothing probes while it runs.
	const scaleRef = useRef(1);
	const [note, setNote] = useState('');
	const [delivering, setDelivering] = useState(false);
	const [missed, setMissed] = useState(false);
	// Hold Space to use the page. The state drives the render; handlers read
	// the ref, which moves at once.
	const [passthrough, setPassthroughState] = useState<Passthrough>('off');
	const passthroughRef = useRef<Passthrough>('off');
	// Bumped on every start and end, so a guest reply can only end the
	// passthrough that asked for it.
	const passthroughSeqRef = useRef(0);
	// When the layer last heard Space auto-repeat (see SPACE_STILL_HELD_MS).
	const spaceRepeatAtRef = useRef(0);
	const setPassthrough = useCallback((next: Passthrough) => {
		passthroughRef.current = next;
		setPassthroughState(next);
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// The overlay's own size: the guest scales points by its viewport over this.
	const layerFrame = useCallback(
		(): DesignModeFrame => ({
			width: layerRef.current?.clientWidth ?? 0,
			height: layerRef.current?.clientHeight ?? 0,
		}),
		[]
	);

	// One probe in flight at a time; a move during a probe re-runs it once with
	// the newest point and depth instead of queueing one per mousemove.
	const probe = useCallback(async () => {
		probeSeqRef.current += 1;
		// While the page has the pointer, or a drag draws its box, there is no
		// outline to draw (the bump above still drops a reply in flight).
		if (passthroughRef.current !== 'off' || pressRef.current?.dragging) return;
		pendingProbeRef.current = true;
		if (probeInFlightRef.current) return;
		probeInFlightRef.current = true;
		try {
			while (pendingProbeRef.current && mountedRef.current) {
				pendingProbeRef.current = false;
				const point = pointRef.current;
				if (!point) break;
				const seq = probeSeqRef.current;
				const frame = layerFrame();
				let reply: unknown = null;
				try {
					reply = await accessRef.current.run({
						type: 'probe',
						x: point.x,
						y: point.y,
						frame,
						depth: depthRef.current,
					});
				} catch {
					// Mid-navigation the guest has no document to ask; the next move
					// or key press probes again.
					reply = null;
				}
				if (!mountedRef.current) return;
				// Superseded while in flight: drop it; the loop runs again with the
				// newest request because probe() set the pending flag.
				if (seq !== probeSeqRef.current) continue;
				const parsed = parseDesignModeProbe(reply);
				const scale = parsed ? designOverlayScale(frame, parsed.viewport) : 1;
				if (parsed) {
					// Clamp to what the guest could walk (no parent above <body>).
					depthRef.current = parsed.depth;
					scaleRef.current = scale;
				}
				setHover(parsed ? { probe: parsed, scale, point } : null);
			}
		} finally {
			probeInFlightRef.current = false;
		}
	}, []);

	const focusLayer = useCallback(() => {
		layerRef.current?.focus({ preventScroll: true });
	}, []);

	const releaseHold = useCallback(() => {
		if (!holdingRef.current) return;
		holdingRef.current = false;
		setHeldSpot(null);
	}, []);

	// Drop a press without picking anything: Escape, a release this window
	// never heard, the app going to the background, a page load. Its release
	// still makes a click, which must not pick either. True when there was one.
	const cancelPress = useCallback((): boolean => {
		const press = pressRef.current;
		if (!press) return false;
		pressRef.current = null;
		swallowClickRef.current = true;
		if (press.dragging) {
			setMarquee(null);
			// Back to outlining what is under the pointer.
			void probe();
		}
		return true;
	}, [probe]);

	// A crumb click outlines that ancestor, as pressing ArrowUp that many times
	// from the element the crumbs were drawn for would, and holds it: the crumbs
	// stay where they are, and while the pointer stays near them the outline
	// does not follow it, so a click there (or Enter) picks the ancestor rather
	// than the element under the click. Without the hold, the move back onto the
	// page to click would reset the walk first. Moving further away lets go and
	// the outline follows the pointer again. The arrows walk on from a held
	// ancestor.
	const selectAncestor = useCallback(
		(point: Point, depth: number) => {
			if (passthroughRef.current !== 'off' || pickingRef.current) return;
			pointRef.current = point;
			depthRef.current = depth;
			holdingRef.current = true;
			const spot = labelSpotRef.current;
			setHeldSpot((held) => held ?? spot);
			setMissed(false);
			void probe();
		},
		[probe]
	);

	// Whether a pointer at client (x, y) is near enough to the crumbs to keep a
	// held ancestor.
	const nearCrumbs = (x: number, y: number): boolean => {
		const box = crumbsRef.current?.getBoundingClientRect();
		if (!box) return false;
		return (
			x >= box.left - CRUMB_HOLD_REACH_PX &&
			x <= box.right + CRUMB_HOLD_REACH_PX &&
			y >= box.top - CRUMB_HOLD_REACH_PX &&
			y <= box.bottom + CRUMB_HOLD_REACH_PX
		);
	};

	// Keyboard focus back on the layer after using the page: from the page (the
	// user clicked into it) or from nowhere, never from a host control the user
	// is in (the address bar).
	const reclaimFocus = useCallback(() => {
		const access = accessRef.current;
		const fromPage = access.focused();
		if (fromPage) access.blur();
		const active = document.activeElement;
		if (fromPage || !active || active === document.body) focusLayer();
	}, [focusLayer]);

	// Where the page last saw the pointer, as an overlay point. The layer hears
	// no moves while the page has the pointer, so only the page knows.
	const layerPointFrom = useCallback(
		(report: DesignModePassthroughReport | null): Point | null => {
			if (!report?.point) return null;
			const scale = designOverlayScale(layerFrame(), report.viewport);
			return { x: report.point.x * scale, y: report.point.y * scale };
		},
		[layerFrame]
	);

	// Back to picking, from the element under the pointer.
	const resumePicking = useCallback(
		(report: DesignModePassthroughReport | null) => {
			const point = layerPointFrom(report);
			if (point) pointRef.current = point;
			depthRef.current = 0;
			void probe();
		},
		[layerPointFrom, probe]
	);

	// The page stops watching (and swallowing) Space. Null when it could not be
	// asked or had no watch open.
	const endGuestWatch = useCallback(
		(): Promise<DesignModePassthroughReport | null> =>
			accessRef.current
				.run({ type: 'endPassthrough' })
				.then(parseDesignModePassthrough, () => null),
		[]
	);

	const stopPassthrough = useCallback(() => {
		passthroughSeqRef.current += 1;
		setPassthrough('off');
		reclaimFocus();
	}, [setPassthrough, reclaimFocus]);

	// Hold Space to use the page. While Space is down the layer stops taking
	// the pointer (`pointer-events: none`), so the page gets clicks, hovers and
	// the wheel, and the outline is hidden. Hearing the release is the hard
	// part: once the user clicks into the page, keyboard focus is in the guest,
	// whose keys never reach this document. The smallest mix that covers it:
	//  1. A host keyup (window, capture): focus stayed in this document (the
	//     user hovered or scrolled the page without clicking into it).
	//  2. The page's Space watch (`passthrough` in designModeGuestCall): the
	//     page reports the release, and swallows the held key meanwhile. A page
	//     can answer early or never; a reply only ENDS passthrough, never picks.
	//  3. A host window blur while the page does not hold focus: the app lost
	//     focus, so the release lands in another app. (The watch ends on the
	//     page's own blur.)
	//  4. A finished page load: the document that watched for the release is
	//     gone with the old page.
	//  5. The fallback: once the host sees the pointer outside the page, the
	//     layer takes the pointer back, and the next move over it resumes
	//     picking, with Space up. Space is known to be down only while the
	//     layer hears it auto-repeat, and then its release reaches 1, so the
	//     page just gets the pointer back.
	// Every end takes keyboard focus back from the page (or from nowhere), so a
	// Space still held starts it again on its next auto-repeat, and that release
	// comes through 1. Not used: the browser-tab shortcut forwarding
	// (onBrowserTabShortcutKey) carries modifier chords on keydown with no tab
	// identity, so a bare Space keyup there would mean an IPC message for every
	// space typed in any browser tab.
	const startPassthrough = useCallback(() => {
		const session = ++passthroughSeqRef.current;
		// Drop a probe reply in flight: it would outline an element over the page.
		probeSeqRef.current += 1;
		// Picking resumes from the element under the pointer, not a held ancestor.
		releaseHold();
		setPassthrough('page');
		setHover(null);
		setMissed(false);
		void accessRef.current.run({ type: 'passthrough' }).then(
			(reply) => {
				if (!mountedRef.current || passthroughSeqRef.current !== session) return;
				stopPassthrough();
				resumePicking(parseDesignModePassthrough(reply));
			},
			// The page could not be asked (mid-navigation): 1, 3, 4 and 5 still
			// end it.
			() => undefined
		);
	}, [releaseHold, setPassthrough, stopPassthrough, resumePicking]);

	// The host heard the release (1, 3, 4). Resume at once at the last point,
	// then move to where the page saw the pointer, unless the user moved it over
	// the layer meanwhile.
	const endPassthroughHere = useCallback(() => {
		if (passthroughRef.current === 'off') return;
		stopPassthrough();
		resumePicking(null);
		const seq = probeSeqRef.current;
		void endGuestWatch().then((report) => {
			if (mountedRef.current && probeSeqRef.current === seq && layerPointFrom(report)) {
				resumePicking(report);
			}
		});
	}, [stopPassthrough, resumePicking, endGuestWatch, layerPointFrom]);

	// 1. Always attached, so a quick tap (its keyup before the next render) is
	// heard too.
	useEventListener(
		'keyup',
		(event) => {
			if (passthroughRef.current === 'off' || !isSpaceKey(event as KeyboardEvent)) return;
			endPassthroughHere();
		},
		{ capture: true }
	);

	// 3. Clicking into the page may blur this window too, so decide once focus
	// has settled: only a window whose page does not hold focus ends it.
	useEventListener('blur', (event) => {
		if (event.target !== window || passthroughRef.current === 'off') return;
		const session = passthroughSeqRef.current;
		window.setTimeout(() => {
			if (!mountedRef.current || passthroughSeqRef.current !== session) return;
			if (!accessRef.current.focused()) endPassthroughHere();
		}, 0);
	});

	// 5. The host sees the pointer only where the page is not, so a move outside
	// the layer means the pointer left the page.
	useEventListener(
		'mousemove',
		(event) => {
			const layer = layerRef.current;
			if (!layer || passthroughRef.current !== 'page') return;
			const { target, clientX, clientY } = event as MouseEvent;
			if (target instanceof Node && layer.contains(target)) return;
			const box = layer.getBoundingClientRect();
			const over =
				clientX >= box.left && clientX < box.right && clientY >= box.top && clientY < box.bottom;
			if (!over) setPassthrough('away');
		},
		{ capture: true, enabled: passthrough === 'page' }
	);

	// Gone while Space is down (Escape, a tab switch): the page must not keep
	// swallowing Space.
	useEffect(
		() => () => {
			if (passthroughRef.current !== 'off') void endGuestWatch();
		},
		[endGuestWatch]
	);

	// Start at the center so a keyboard-only user has an element to walk from.
	useEffect(() => {
		const layer = layerRef.current;
		if (!layer) return;
		focusLayer();
		pointRef.current = { x: layer.clientWidth / 2, y: layer.clientHeight / 2 };
		void probe();
	}, [focusLayer, probe]);

	// A new page loaded under the overlay (a link, a reload, the agent
	// navigating). The outline, its label and the walked depth describe the old
	// document, so start again from the element at the same point. A page that
	// focuses itself on load is pushed back out by the host's focus guard,
	// which leaves focus nowhere; take it back then, so Escape and the arrows
	// still work, but never from a control the user is in (address bar, note).
	const seenPageLoadRef = useRef(pageLoadCount);
	useEffect(() => {
		if (seenPageLoadRef.current === pageLoadCount) return;
		seenPageLoadRef.current = pageLoadCount;
		setMissed(false);
		// A box dragged over the old page does not frame the new one.
		cancelPress();
		// 4. A load while the user holds Space (they clicked a link): the old
		// page's Space watch is gone, so the load ends it. That also takes focus
		// back from the page, where the click left it.
		if (passthroughRef.current !== 'off') {
			endPassthroughHere();
			return;
		}
		releaseHold();
		depthRef.current = 0;
		const active = document.activeElement;
		if (!active || active === document.body) focusLayer();
		void probe();
	}, [pageLoadCount, focusLayer, probe, endPassthroughHere, releaseHold, cancelPress]);

	useEffect(() => {
		if (card) noteRef.current?.focus();
	}, [card]);

	// A client point as an overlay point (not held inside the overlay).
	const layerPointAt = (clientX: number, clientY: number): Point | null => {
		const layer = layerRef.current;
		if (!layer) return null;
		const bounds = layer.getBoundingClientRect();
		return { x: clientX - bounds.left, y: clientY - bounds.top };
	};

	const pointFromEvent = (event: React.MouseEvent | React.WheelEvent): Point | null =>
		layerPointAt(event.clientX, event.clientY);

	// One capture at a time, from a click, Enter, or a drag's release: it opens
	// the card for what the guest reported, or says there was nothing to pick.
	// Resolves whether a card opened.
	const openCard = useCallback(
		async (
			capture: (frame: DesignModeFrame) => Promise<DesignPickCapture | DesignModeMiss | null>
		): Promise<boolean> => {
			if (pickingRef.current) return false;
			// The pick is the held ancestor's hand-off; the card takes over from here.
			releaseHold();
			pickingRef.current = true;
			setPicking(true);
			setMissed(false);
			try {
				const frame = layerFrame();
				const result = await capture(frame);
				if (!mountedRef.current) return false;
				if (!result || typeof result === 'string') {
					setMissed(true);
					return false;
				}
				const viewport = 'region' in result ? result.region.viewport : result.pick.viewport;
				setNote('');
				setCard({ capture: result, scale: designOverlayScale(frame, viewport) });
				return true;
			} catch (error) {
				// The guest went away mid-pick (navigation, crash): nothing to show.
				reportCaptureError(error);
				if (mountedRef.current) setMissed(true);
				return false;
			} finally {
				pickingRef.current = false;
				if (mountedRef.current) setPicking(false);
			}
		},
		[releaseHold, layerFrame]
	);

	// The element at the point, walked up `depthRef` levels. A failed
	// screenshot still opens the card: the HTML and styles are the bulk of it.
	const pick = useCallback(async () => {
		const point = pointRef.current;
		if (!point) return;
		await openCard((frame) =>
			captureDesignPick(
				accessRef.current,
				{ type: 'describe', x: point.x, y: point.y, depth: depthRef.current, frame },
				reportCaptureError
			)
		);
	}, [openCard]);

	// The region a drag framed (overlay px): the guest scales it by the frame
	// as it does a point, clips it to its viewport, and lists the elements in
	// it. The box stays up, frozen, until the card takes over drawing it.
	const pickRegion = useCallback(
		async (box: DesignModeRect) => {
			// A drag that came back to where it started frames nothing.
			const opened =
				box.width >= 1 &&
				box.height >= 1 &&
				(await openCard((frame) =>
					captureDesignRegion(
						accessRef.current,
						{ type: 'region', ...box, frame },
						reportCaptureError
					)
				));
			if (!mountedRef.current) return;
			setMarquee(null);
			// No card: back to outlining what is under the pointer.
			if (!opened) void probe();
		},
		[openCard, probe]
	);

	// A press moved past DRAG_THRESHOLD_PX: from here it draws a region, and
	// what the pointer outlined (or a held ancestor) is not the pick.
	const startDrag = useCallback(() => {
		probeSeqRef.current += 1; // drop a probe reply in flight
		releaseHold();
		setHover(null);
		setMissed(false);
	}, [releaseHold]);

	// A press is followed on the window, not on the layer, and in the capture
	// phase, so it is seen before any handler in the layer: a drag goes on when
	// the pointer leaves the page (its box held at the page's edge), and its
	// release is heard wherever it lands. Chromium keeps sending a document the
	// moves and the release of a press that began in it, even outside the
	// window. A move with the button up means the release went to another app.
	const followDrag = (event: Event) => {
		const press = pressRef.current;
		if (!press) return;
		const mouse = event as MouseEvent;
		if ((mouse.buttons & 1) === 0) {
			cancelPress();
			return;
		}
		const point = layerPointAt(mouse.clientX, mouse.clientY);
		if (!point) return;
		if (!press.dragging) {
			const moved = Math.hypot(point.x - press.start.x, point.y - press.start.y);
			if (moved <= DRAG_THRESHOLD_PX) return;
			press.dragging = true;
			startDrag();
		}
		const end = clampToFrame(point, layerFrame());
		pointRef.current = end;
		setMarquee({ box: boxBetween(press.start, end), scale: scaleRef.current });
	};

	// The release: a drag picks its region; a press that never became one is a
	// click, which the layer's click handler picks.
	const endPress = (event: Event) => {
		const press = pressRef.current;
		const mouse = event as MouseEvent;
		if (!press || mouse.button !== 0) return;
		pressRef.current = null;
		if (!press.dragging) return;
		swallowClickRef.current = true;
		const point = layerPointAt(mouse.clientX, mouse.clientY);
		const end = point ? clampToFrame(point, layerFrame()) : (pointRef.current ?? press.start);
		// Enter and the arrows go on from where the drag ended.
		pointRef.current = end;
		depthRef.current = 0;
		void pickRegion(boxBetween(press.start, end));
	};

	useEventListener('mousemove', followDrag, { capture: true });
	useEventListener('mouseup', endPress, { capture: true });

	// The app went to the background mid-press: its release lands elsewhere.
	useEventListener('blur', (event) => {
		if (event.target === window) cancelPress();
	});

	const dropCard = useCallback(() => {
		setCard(null);
		setNote('');
	}, []);

	const closeCard = useCallback(() => {
		dropCard();
		focusLayer();
		void probe();
	}, [dropCard, focusLayer, probe]);

	// One hand-off at a time: Add, Add and Pick Another and Queue share this
	// guard, so a double press (or a click and Alt+Enter in the same tick) sends
	// the pick once, not twice. A ref, not the `delivering` state, which only
	// drives the disabled buttons: state is not re-read until the next render.
	const handingOffRef = useRef(false);
	const handOff = useCallback(
		async (send: (capture: DesignPickCapture) => Promise<void>) => {
			if (!card || handingOffRef.current) return;
			handingOffRef.current = true;
			setDelivering(true);
			try {
				await send(card.capture);
			} finally {
				handingOffRef.current = false;
				if (mountedRef.current) setDelivering(false);
			}
		},
		[card]
	);

	const deliver = useCallback(
		(keepPicking: boolean) =>
			handOff(async (capture) => {
				const ok = await onDeliver(capture, note, keepPicking);
				if (!ok || !mountedRef.current) return;
				if (keepPicking) {
					closeCard();
					return;
				}
				// The host is showing the chat, which unmounts this layer once the
				// tab is off screen. Drop the card, but leave focus to the host:
				// taking it back here would race the composer's focus request.
				dropCard();
			}),
		[handOff, note, onDeliver, closeCard, dropCard]
	);

	const queue = useCallback(async () => {
		if (!onQueue) return;
		await handOff(async (capture) => {
			const queued = await onQueue(capture, note);
			if (!queued) return; // The card stays open; the host already said why.
			// The pick is queued whether or not the layer is still mounted, so the
			// user is told either way.
			notifyCenterFlash({ message: `Queued for ${queued.tabName}`, color: 'green' });
			if (mountedRef.current) closeCard();
		});
	}, [handOff, note, onQueue, closeCard]);

	const handleLayerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (card) {
			// Focus can fall back to the layer when the user clicks the card's
			// background; Escape must still close the card from there.
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				closeCard();
			}
			return; // Otherwise the card's own handlers own the keyboard.
		}
		const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
		// Enter, Space and the arrows act on the page only when the layer itself
		// has focus; on a focused control (the banner's ESC pill) they keep their
		// native meaning, so Enter on that pill exits rather than picks.
		const onLayer = event.target === event.currentTarget;
		// Mid-press: Escape drops it (and the drag it became) and stays in Design
		// Mode, so the release picks nothing; every other key waits for the
		// release. Space is still taken, so nothing behind the layer scrolls.
		if (pressRef.current) {
			if (event.key === 'Escape' || (isSpaceKey(event) && plain && onLayer)) {
				event.preventDefault();
				event.stopPropagation();
				if (event.key === 'Escape') cancelPress();
			}
			return;
		}
		if (isSpaceKey(event) && plain && onLayer) {
			// Every press and auto-repeat is taken, so nothing behind the layer
			// scrolls. A repeat starts it too: that is a Space still held after
			// an end (see startPassthrough). Never during a pick in flight, whose
			// card would open under a layer that lets clicks through.
			event.preventDefault();
			event.stopPropagation();
			if (event.repeat) spaceRepeatAtRef.current = Date.now();
			if (passthroughRef.current === 'off' && !pickingRef.current) startPassthrough();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onExit();
		} else if (passthroughRef.current !== 'off') {
			// Using the page: Enter and the arrows wait for the release, as there
			// is no outline to act on.
			return;
		} else if (event.key === 'Enter' && plain && onLayer) {
			event.preventDefault();
			event.stopPropagation();
			void pick();
		} else if (
			(event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
			plain &&
			!event.shiftKey &&
			onLayer
		) {
			event.preventDefault();
			event.stopPropagation();
			depthRef.current = Math.max(0, depthRef.current + (event.key === 'ArrowUp' ? 1 : -1));
			void probe();
		}
	};

	const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeCard();
		} else if (
			event.key === 'Enter' &&
			event.target === noteRef.current &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			// Only from the note: Enter on a focused card button must run that
			// button (Back to picking, Add and Pick Another), not Add to Message.
			event.preventDefault();
			event.stopPropagation();
			// Alt/Option+Enter queues. With Cmd/Ctrl also held it is still the
			// keep-picking chord, as it was before Queue existed.
			if (event.altKey && !event.metaKey && !event.ctrlKey) void queue();
			else void deliver(event.metaKey || event.ctrlKey);
		}
	};

	// While the card is open, a picked element keeps its outline and a picked
	// region its dashed box. Otherwise a drag draws its box, or the outline
	// follows the pointer, except while the user holds Space: the page is in use.
	const usingPage = passthrough !== 'off';
	const pickedElement = card && 'pick' in card.capture ? card.capture.pick : null;
	const pickedRegion = card && 'region' in card.capture ? card.capture.region : null;
	let outline: DesignModeRect | null = null;
	let regionBox: { box: DesignModeRect; scale: number } | null = null;
	if (card) {
		if (pickedRegion) {
			regionBox = { box: toLayerRect(pickedRegion.rect, card.scale), scale: card.scale };
		} else if (pickedElement) {
			outline = toLayerRect(pickedElement.rect, card.scale);
		}
	} else if (marquee) {
		regionBox = marquee;
	} else if (hover && !usingPage) {
		outline = toLayerRect(hover.probe.rect, hover.scale);
	}
	// The box is up and its region not yet asked for: the button is still down.
	const dragging = !!marquee && !card && !picking;
	const scaleNow = card ? card.scale : (hover?.scale ?? 1);
	// The hover label is the crumb row; the card's frozen outline is labeled by
	// its tag alone. A held ancestor keeps its crumbs where they were clicked.
	const crumbs = !card && outline ? hover : null;
	const labelSpot = outline ? ((crumbs && heldSpot) ?? labelSpotFor(outline)) : null;
	labelSpotRef.current = labelSpot;
	const outlineSize = outline ? sizeText(outline, scaleNow) : '';
	const keepPickingKeys = formatShortcutKeys(['Meta', 'Enter']);
	const queueKeys = formatShortcutKeys(['Alt', 'Enter']);

	return (
		<div
			ref={layerRef}
			tabIndex={0}
			role="application"
			aria-label={
				usingPage
					? 'Design Mode: using the page'
					: 'Design Mode: pick an element, or drag to pick a region'
			}
			className="absolute inset-0 z-10 outline-none select-none"
			// Using the page: clicks, hovers and the wheel go through to the page.
			style={{
				cursor: card ? 'default' : 'crosshair',
				pointerEvents: passthrough === 'page' ? 'none' : undefined,
			}}
			data-browser-design-mode=""
			data-testid="browser-tab-design-mode-layer"
			onKeyDown={handleLayerKeyDown}
			onMouseMove={(event) => {
				if (card) return;
				// A drag draws its box (followDrag); nothing is outlined meanwhile.
				if (pressRef.current?.dragging) return;
				// The page has the pointer (in the app the layer does not even
				// hear this move).
				if (passthroughRef.current === 'page') return;
				if (passthroughRef.current === 'away') {
					// 5. The pointer is back from outside. Still repeating here:
					// Space is down, so the page gets the pointer again.
					if (Date.now() - spaceRepeatAtRef.current < SPACE_STILL_HELD_MS) {
						setPassthrough('page');
						return;
					}
					// Otherwise resume picking here. A Space still held (its repeats
					// went to the page) starts it again on its next auto-repeat.
					stopPassthrough();
					void endGuestWatch();
				}
				// A held ancestor stays outlined while the pointer is near its crumbs.
				if (holdingRef.current) {
					if (nearCrumbs(event.clientX, event.clientY)) return;
					releaseHold();
				}
				const point = pointFromEvent(event);
				if (!point) return;
				pointRef.current = point;
				depthRef.current = 0;
				setMissed(false);
				void probe();
			}}
			onMouseDown={(event) => {
				// A new press: a click the last one left unclaimed is moot.
				swallowClickRef.current = false;
				// Keep focus on the layer (a click must not land in the webview).
				if (card || passthroughRef.current !== 'off') return;
				event.preventDefault();
				focusLayer();
				// A press on the page itself may become a drag; one on the banner
				// or the crumbs is a click on that control. None starts while a
				// pick is in flight.
				if (event.button !== 0 || event.target !== event.currentTarget) return;
				if (pickingRef.current) return;
				const start = pointFromEvent(event);
				if (start) pressRef.current = { start, dragging: false };
			}}
			onClick={(event) => {
				// The release that ended a drag (or a press Escape dropped) is not
				// a pick.
				if (swallowClickRef.current) {
					swallowClickRef.current = false;
					return;
				}
				if (card || passthroughRef.current !== 'off' || event.button !== 0) return;
				// A held ancestor is what the outline shows, so the click picks it,
				// walked from the point its crumbs were drawn for.
				if (holdingRef.current) {
					void pick();
					return;
				}
				const point = pointFromEvent(event);
				if (!point) return;
				// Resolve the element at the click itself: the pointer may have
				// moved, or the page re-rendered, since the last outline.
				pointRef.current = point;
				void pick();
			}}
			onContextMenu={(event) => event.preventDefault()}
			onWheel={(event) => {
				// Mid-drag the page holds still under the box being framed.
				if (card || passthroughRef.current !== 'off' || pressRef.current?.dragging) return;
				const point = pointFromEvent(event);
				if (!point) return;
				const frame = layerFrame();
				// The page moves under a held ancestor, and its crumbs with it.
				releaseHold();
				pointRef.current = point;
				void accessRef.current
					.run({
						type: 'scroll',
						x: point.x,
						y: point.y,
						dx: event.deltaX,
						dy: event.deltaY,
						frame,
					})
					.catch(() => null)
					.then(() => probe());
			}}
		>
			{outline ? (
				<>
					<div
						className="absolute pointer-events-none rounded-sm"
						// Drawn just outside the element so its own edge stays visible,
						// with a ring in the page background so the accent still reads
						// on an element of the same hue.
						style={{
							left: outline.x - 2,
							top: outline.y - 2,
							width: outline.width + 4,
							height: outline.height + 4,
							border: `2px solid ${theme.colors.accent}`,
							boxShadow: `0 0 0 1px ${theme.colors.bgMain}, inset 0 0 0 1px ${theme.colors.bgMain}`,
							backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 14%, transparent)`,
						}}
						data-testid="browser-tab-design-mode-outline"
					/>
					{labelSpot && pickedElement ? (
						<LabelAt spot={labelSpot}>
							<div
								className="shrink-0 max-w-full truncate rounded px-1.5 py-0.5 text-xs-plus font-mono border shadow"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{pickedElement.tagName}
								<span style={{ color: theme.colors.textDim }}>
									{'  '}
									{outlineSize}
								</span>
							</div>
						</LabelAt>
					) : labelSpot && crumbs ? (
						<LabelAt spot={labelSpot}>
							<DesignModeCrumbs
								ref={crumbsRef}
								theme={theme}
								probe={crumbs.probe}
								size={outlineSize}
								onSelect={(depth) => selectAncestor(crumbs.point, depth)}
							/>
						</LabelAt>
					) : null}
				</>
			) : null}

			{regionBox ? (
				<DesignModeMarquee
					theme={theme}
					box={regionBox.box}
					size={sizeText(regionBox.box, regionBox.scale)}
				/>
			) : null}

			<div
				className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-md border px-3 py-1 shadow-md text-xs whitespace-nowrap max-w-[calc(100%-1rem)]"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.accent,
					color: theme.colors.textMain,
					cursor: 'default',
				}}
				onMouseMove={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
				data-testid="browser-tab-design-mode-banner"
				role="status"
			>
				{picking ? (
					<Spinner size={14} color={theme.colors.accent} />
				) : dragging ? (
					<BoxSelect className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				) : usingPage ? (
					<Hand className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				) : (
					<MousePointerClick className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				)}
				<span className="truncate">
					{dragging ? (
						'Release to pick the region. Esc: cancel.'
					) : usingPage ? (
						'Using the page - release Space to pick'
					) : (
						<>
							{missed ? 'Nothing to pick there.' : 'Design Mode: click an element.'}
							<span style={{ color: theme.colors.textDim }}>
								{' '}
								Space: use the page. Drag: region. Arrows: parent / child.
							</span>
						</>
					)}
				</span>
				<EscCloseButton
					theme={theme}
					onClose={onExit}
					label="Exit Design Mode (Esc)"
					testId="browser-tab-design-mode-cancel"
				/>
			</div>

			{card ? (
				<div
					className="absolute bottom-3 left-1/2 -translate-x-1/2 w-[min(32rem,calc(100%-1.5rem))] rounded-lg border shadow-xl p-3 flex flex-col gap-2 select-text"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						cursor: 'default',
					}}
					onMouseDown={(event) => event.stopPropagation()}
					onMouseMove={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
					onWheel={(event) => event.stopPropagation()}
					onKeyDown={handleCardKeyDown}
					role="dialog"
					aria-label={pickedRegion ? 'Picked region' : 'Picked element'}
					data-testid="browser-tab-design-mode-card"
				>
					<div className="flex items-start gap-3">
						<div
							className="shrink-0 w-24 h-16 rounded border flex items-center justify-center overflow-hidden"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						>
							{card.capture.screenshot ? (
								<img
									src={card.capture.screenshot}
									alt={`Screenshot of the picked ${pickedRegion ? 'region' : 'element'}`}
									className="max-w-full max-h-full object-contain"
								/>
							) : (
								<ImageOff
									className="w-5 h-5"
									style={{ color: theme.colors.textDim }}
									aria-label={
										pickedRegion
											? 'No screenshot: the capture failed'
											: 'No screenshot: the element is off screen'
									}
								/>
							)}
						</div>
						{pickedRegion ? (
							<div className="min-w-0 flex-1">
								<div
									className="text-sm font-medium truncate"
									data-testid="browser-tab-design-mode-region-title"
								>
									{designRegionLabel(pickedRegion)}, {regionElementCount(pickedRegion)}
								</div>
								{/* What the page listed, as plain text: selectors are page data. */}
								{pickedRegion.elements.length > 0 ? (
									<ul
										className="mt-0.5 max-h-20 overflow-y-auto text-xs font-mono leading-relaxed"
										style={{ color: theme.colors.textDim }}
										aria-label="Elements in the region"
										data-testid="browser-tab-design-mode-region-elements"
									>
										{pickedRegion.elements.map((element, index) => (
											<li
												key={index}
												className="truncate"
												title={element.selector || element.tagName}
											>
												{element.selector || element.tagName}
											</li>
										))}
									</ul>
								) : null}
							</div>
						) : pickedElement ? (
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium truncate" title={pickedElement.selector}>
									<code>{pickedElement.selector || pickedElement.tagName}</code>
								</div>
								<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
									{sizeText(pickedElement.rect, 1)} px
									{card.capture.screenshot
										? ', screenshot attached'
										: ', no screenshot (off screen)'}
								</div>
							</div>
						) : null}
						<EscCloseButton
							theme={theme}
							onClose={closeCard}
							label="Back to picking (Esc)"
							testId="browser-tab-design-mode-card-close"
						/>
					</div>
					<textarea
						ref={noteRef}
						value={note}
						onChange={(event) => setNote(event.target.value)}
						rows={2}
						placeholder="Note (optional): what should change?"
						aria-label="Note for the agent"
						className="w-full resize-none rounded border px-2 py-1.5 text-sm outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						data-testid="browser-tab-design-mode-note"
					/>
					<div className="flex flex-wrap items-center justify-end gap-2">
						{onQueue ? (
							<button
								type="button"
								onClick={() => void queue()}
								disabled={delivering}
								className="px-2.5 py-1 rounded text-xs border transition-colors disabled:opacity-50"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								title={`Queue as its own message and pick another element (${queueKeys})`}
								data-testid="browser-tab-design-mode-queue"
							>
								Queue
							</button>
						) : null}
						<button
							type="button"
							onClick={() => void deliver(true)}
							disabled={delivering}
							className="px-2.5 py-1 rounded text-xs border transition-colors disabled:opacity-50"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title={`Add to the message and pick another element (${keepPickingKeys})`}
							data-testid="browser-tab-design-mode-add-another"
						>
							Add and Pick Another
						</button>
						<button
							type="button"
							onClick={() => void deliver(false)}
							disabled={delivering}
							className="px-2.5 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
							title="Add to the agent's message (Enter)"
							data-testid="browser-tab-design-mode-add"
						>
							Add to Message
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
