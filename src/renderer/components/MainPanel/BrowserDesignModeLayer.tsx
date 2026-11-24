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
import { ImageOff, MousePointerClick } from 'lucide-react';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { Spinner } from '../ui/Spinner';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { captureException } from '../../utils/sentry';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import {
	captureDesignPick,
	designOverlayScale,
	parseDesignModeProbe,
	type DesignModeFrame,
	type DesignModeCapture,
	type DesignModeGuestAccess,
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
		depthRef.current = 0;
		setMissed(false);
		const active = document.activeElement;
		if (!active || active === document.body) focusLayer();
		void probe();
	}, [pageLoadCount, focusLayer, probe]);

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
		// Enter and the arrows act on the page only when the layer itself has
		// focus; on a focused control (the banner's ESC pill) they keep their
		// native meaning, so Enter on that pill exits rather than picks.
		const onLayer = event.target === event.currentTarget;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onExit();
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

	// While the card is open the outline stays on the picked element.
	const scaleNow = card ? card.scale : (hover?.scale ?? 1);
	const outline = card
		? toLayerRect(card.pick.rect, card.scale)
		: hover
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
			aria-label="Design Mode: pick an element in the page"
			className="absolute inset-0 z-10 outline-none select-none"
			style={{ cursor: card ? 'default' : 'crosshair' }}
			data-browser-design-mode=""
			data-testid="browser-tab-design-mode-layer"
			onKeyDown={handleLayerKeyDown}
			onMouseMove={(event) => {
				if (card) return;
				const point = pointFromEvent(event);
				if (!point) return;
				pointRef.current = point;
				depthRef.current = 0;
				setMissed(false);
				void probe();
			}}
			onMouseDown={(event) => {
				// Keep focus on the layer (a click must not land in the webview).
				if (card) return;
				event.preventDefault();
				focusLayer();
			}}
			onClick={(event) => {
				if (card || event.button !== 0) return;
				const point = pointFromEvent(event);
				if (!point) return;
				// Resolve the element at the click itself: the pointer may have
				// moved, or the page re-rendered, since the last outline.
				pointRef.current = point;
				void pick();
			}}
			onContextMenu={(event) => event.preventDefault()}
			onWheel={(event) => {
				if (card) return;
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
				) : (
					<MousePointerClick className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				)}
				<span className="truncate">
					{missed ? 'Nothing to pick there.' : 'Design Mode: click an element.'}
					<span style={{ color: theme.colors.textDim }}> Arrows: parent / child. Enter: pick.</span>
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
