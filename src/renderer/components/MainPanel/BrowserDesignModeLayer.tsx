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
 * parent / back toward the child, Escape closes the card or leaves Design
 * Mode. In the card (from the note): Enter adds to the message, Cmd/Ctrl+Enter
 * adds and keeps picking, Alt/Option+Enter queues the pick as its own message
 * and keeps picking, Shift+Enter is a newline.
 *
 * Hold Space to use the page (click a link, scroll, type): the overlay lets
 * the pointer through to the page and hides its outline, and picking resumes
 * when Space is released. Space in the note or on a focused control is an
 * ordinary key. How the release is heard is explained above `startPassthrough`.
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
import { Hand, ImageOff, MousePointerClick } from 'lucide-react';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { Spinner } from '../ui/Spinner';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { captureException } from '../../utils/sentry';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import {
	captureDesignPick,
	designOverlayScale,
	parseDesignModePassthrough,
	parseDesignModeProbe,
	type DesignModeFrame,
	type DesignModeCapture,
	type DesignModeGuestAccess,
	type DesignModePassthroughReport,
	type DesignModeProbe,
	type DesignModeRect,
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
	 * Hand a pick to the agent. `keepPicking` keeps the user picking here;
	 * otherwise the caller shows the message, which takes the tab off screen
	 * (Design Mode stays on and re-arms when the tab is shown again). Resolves
	 * false when nothing was delivered (the card stays open).
	 */
	onDeliver: (capture: DesignModeCapture, note: string, keepPicking: boolean) => Promise<boolean>;
	/**
	 * Queue a pick as its own message and stay in Design Mode. Resolves the name
	 * of the tab it was queued on, or null when nothing was queued (the card
	 * stays open). Leave it out where the host cannot queue.
	 */
	onQueue?: (capture: DesignModeCapture, note: string) => Promise<{ tabName: string } | null>;
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

	// `scale` is overlay pixels per guest CSS pixel (designOverlayScale).
	const [hover, setHover] = useState<{ probe: DesignModeProbe; scale: number } | null>(null);
	const [picking, setPicking] = useState(false);
	// The pick plus the overlay scale at pick time, so the frozen outline is
	// scaled right even when no hover outline preceded it.
	const [card, setCard] = useState<(DesignModeCapture & { scale: number }) | null>(null);
	// A ref, not the `picking` state: a click and an Enter in the same tick must
	// not both start a pick.
	const pickingRef = useRef(false);
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
		// While the page has the pointer there is no outline to draw (the bump
		// above still drops a reply in flight).
		if (passthroughRef.current !== 'off') return;
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
				// Clamp to what the guest could walk (no parent above <body>).
				if (parsed) depthRef.current = parsed.depth;
				setHover(
					parsed ? { probe: parsed, scale: designOverlayScale(frame, parsed.viewport) } : null
				);
			}
		} finally {
			probeInFlightRef.current = false;
		}
	}, []);

	const focusLayer = useCallback(() => {
		layerRef.current?.focus({ preventScroll: true });
	}, []);

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
	}, [setPassthrough, stopPassthrough, resumePicking]);

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
		// 4. A load while the user holds Space (they clicked a link): the old
		// page's Space watch is gone, so the load ends it. That also takes focus
		// back from the page, where the click left it.
		if (passthroughRef.current !== 'off') {
			endPassthroughHere();
			return;
		}
		depthRef.current = 0;
		const active = document.activeElement;
		if (!active || active === document.body) focusLayer();
		void probe();
	}, [pageLoadCount, focusLayer, probe, endPassthroughHere]);

	useEffect(() => {
		if (card) noteRef.current?.focus();
	}, [card]);

	const pointFromEvent = (event: React.MouseEvent | React.WheelEvent): Point | null => {
		const layer = layerRef.current;
		if (!layer) return null;
		const bounds = layer.getBoundingClientRect();
		return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
	};

	const pick = useCallback(async () => {
		const point = pointRef.current;
		if (!point || pickingRef.current) return;
		pickingRef.current = true;
		setPicking(true);
		setMissed(false);
		try {
			const frame = layerFrame();
			const result = await captureDesignPick(
				accessRef.current,
				{ type: 'describe', x: point.x, y: point.y, depth: depthRef.current, frame },
				// A failed capture still delivers the HTML and styles, but it is not
				// an expected outcome, so report it.
				(error) => captureException(error, { tags: { surface: 'browser-design-mode' } })
			);
			if (!mountedRef.current) return;
			if (!result || typeof result === 'string') {
				setMissed(true);
				return;
			}
			setNote('');
			setCard({ ...result, scale: designOverlayScale(frame, result.pick.viewport) });
		} catch (error) {
			// The guest went away mid-pick (navigation, crash): nothing to show.
			captureException(error, { tags: { surface: 'browser-design-mode' } });
			if (mountedRef.current) setMissed(true);
		} finally {
			pickingRef.current = false;
			if (mountedRef.current) setPicking(false);
		}
	}, []);

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
		async (send: (capture: DesignModeCapture) => Promise<void>) => {
			if (!card || handingOffRef.current) return;
			handingOffRef.current = true;
			setDelivering(true);
			try {
				await send({ pick: card.pick, screenshot: card.screenshot });
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

	// While the card is open the outline stays on the picked element. While the
	// user holds Space there is none: the page is in use.
	const usingPage = passthrough !== 'off';
	const scaleNow = card ? card.scale : (hover?.scale ?? 1);
	const outline = card
		? toLayerRect(card.pick.rect, card.scale)
		: hover && !usingPage
			? toLayerRect(hover.probe.rect, hover.scale)
			: null;
	const outlineLabel = card ? card.pick.tagName : hover?.probe.label;
	const keepPickingKeys = formatShortcutKeys(['Meta', 'Enter']);
	const queueKeys = formatShortcutKeys(['Alt', 'Enter']);

	return (
		<div
			ref={layerRef}
			tabIndex={0}
			role="application"
			aria-label={
				usingPage ? 'Design Mode: using the page' : 'Design Mode: pick an element in the page'
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
				const point = pointFromEvent(event);
				if (!point) return;
				pointRef.current = point;
				depthRef.current = 0;
				setMissed(false);
				void probe();
			}}
			onMouseDown={(event) => {
				// Keep focus on the layer (a click must not land in the webview).
				if (card || passthroughRef.current !== 'off') return;
				event.preventDefault();
				focusLayer();
			}}
			onClick={(event) => {
				if (card || passthroughRef.current !== 'off' || event.button !== 0) return;
				const point = pointFromEvent(event);
				if (!point) return;
				// Resolve the element at the click itself: the pointer may have
				// moved, or the page re-rendered, since the last outline.
				pointRef.current = point;
				void pick();
			}}
			onContextMenu={(event) => event.preventDefault()}
			onWheel={(event) => {
				if (card || passthroughRef.current !== 'off') return;
				const point = pointFromEvent(event);
				if (!point) return;
				const frame = layerFrame();
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
					{outlineLabel ? (
						<div
							className="absolute pointer-events-none rounded px-1.5 py-0.5 text-xs-plus font-mono whitespace-nowrap border shadow"
							style={{
								left: Math.max(0, outline.x),
								top: outline.y > 22 ? outline.y - 22 : outline.y + outline.height + 2,
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							{outlineLabel}
							<span style={{ color: theme.colors.textDim }}>
								{'  '}
								{Math.round(outline.width / scaleNow)} x {Math.round(outline.height / scaleNow)}
							</span>
						</div>
					) : null}
				</>
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
				) : usingPage ? (
					<Hand className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				) : (
					<MousePointerClick className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				)}
				<span className="truncate">
					{usingPage ? (
						'Using the page - release Space to pick'
					) : (
						<>
							{missed ? 'Nothing to pick there.' : 'Design Mode: click an element.'}
							<span style={{ color: theme.colors.textDim }}>
								{' '}
								Arrows: parent / child. Enter: pick.
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
					aria-label="Picked element"
					data-testid="browser-tab-design-mode-card"
				>
					<div className="flex items-start gap-3">
						<div
							className="shrink-0 w-24 h-16 rounded border flex items-center justify-center overflow-hidden"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						>
							{card.screenshot ? (
								<img
									src={card.screenshot}
									alt="Screenshot of the picked element"
									className="max-w-full max-h-full object-contain"
								/>
							) : (
								<ImageOff
									className="w-5 h-5"
									style={{ color: theme.colors.textDim }}
									aria-label="No screenshot: the element is off screen"
								/>
							)}
						</div>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium truncate" title={card.pick.selector}>
								<code>{card.pick.selector || card.pick.tagName}</code>
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								{Math.round(card.pick.rect.width)} x {Math.round(card.pick.rect.height)} px
								{card.screenshot ? ', screenshot attached' : ', no screenshot (off screen)'}
							</div>
						</div>
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
