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
 * Keys (the overlay holds focus): Enter picks, ArrowUp / ArrowDown walk to the
 * parent / back toward the child, Escape closes the card or leaves Design
 * Mode. In the card: Enter adds to the message, Cmd/Ctrl+Enter adds and keeps
 * picking, Shift+Enter is a newline.
 *
 * Escape is handled here rather than through the layer stack on purpose: a
 * registered layer makes the browser tab inactive (`layerCount === 0` gates it
 * in MainPanelContent), and an inactive tab leaves Design Mode. The in-page
 * find bar handles its Escape the same way.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImageOff, MousePointerClick } from 'lucide-react';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { Spinner } from '../ui/Spinner';
import { captureException } from '../../utils/sentry';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { isImeComposing } from '../../utils/ime';
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
	/** Leave Design Mode. */
	onExit: () => void;
	/**
	 * Hand a pick to the agent. `keepPicking` stays in Design Mode on this tab;
	 * otherwise the caller leaves Design Mode and shows the message. Resolves
	 * false when nothing was delivered (the card stays open).
	 */
	onDeliver: (capture: DesignModeCapture, note: string, keepPicking: boolean) => Promise<boolean>;
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
	onExit,
	onDeliver,
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

	const closeCard = useCallback(() => {
		setCard(null);
		setNote('');
		focusLayer();
		void probe();
	}, [focusLayer, probe]);

	const deliver = useCallback(
		async (keepPicking: boolean) => {
			if (!card || delivering) return;
			setDelivering(true);
			try {
				const { pick: picked, screenshot } = card;
				const ok = await onDeliver({ pick: picked, screenshot }, note, keepPicking);
				if (ok && keepPicking && mountedRef.current) closeCard();
			} finally {
				if (mountedRef.current) setDelivering(false);
			}
		},
		[card, delivering, note, onDeliver, closeCard]
	);

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
		} else if (event.key === 'Enter' && plain && onLayer && !isImeComposing(event)) {
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
			!isImeComposing(event)
		) {
			// Only from the note: Enter on a focused card button must run that
			// button (Back to picking, Add and Pick Another), not Add to Message.
			event.preventDefault();
			event.stopPropagation();
			void deliver(event.metaKey || event.ctrlKey);
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
					<div className="flex items-center justify-end gap-2">
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
