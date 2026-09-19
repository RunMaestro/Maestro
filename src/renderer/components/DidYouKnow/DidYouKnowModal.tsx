import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { getElementRect, getSpotlightClipPath } from '../../utils/spotlight';
import { DID_YOU_KNOW_TIPS, type DidYouKnowTip } from '../../../shared/didYouKnow';
import './tipTransition.css';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Lightbulb } from 'lucide-react';
import { resolveEncoreFeatures } from '../../../shared/encoreFeatureDefaults';
import { resolveUiSurface } from '../../../shared/uiSurfaces';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useIsTopLayer } from '../../hooks/ui/useIsTopLayer';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { isEditingTextTarget } from '../../utils/editableTarget';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useSettingsStore } from '../../stores/settingsStore';
import { useModalStore, type ModalId } from '../../stores/modalStore';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { OrnateFrame } from './OrnateFrame';
import { TipArtwork } from './TipArtwork';
import { TipCard } from './TipCard';
import { useDidYouKnowRotation } from './useDidYouKnowRotation';

interface DidYouKnowModalProps {
	theme: Theme;
	isOpen: boolean;
	startTipId?: string;
	onClose: () => void;
}

/** Mount rotation only while visible, giving each opening its own browsing history. */
export function DidYouKnowModal(props: DidYouKnowModalProps) {
	return props.isOpen ? <DidYouKnowModalContent {...props} /> : null;
}

function DidYouKnowModalContent({ theme, startTipId, onClose }: DidYouKnowModalProps) {
	const {
		tip,
		index,
		total,
		canGoBack,
		goNext,
		goBack,
		dismissForever,
		isReading,
		openDocs,
		exitReading,
	} = useDidYouKnowRotation({ startTipId });
	const cardRef = useRef<HTMLElement>(null);
	const [spotlightRect, setSpotlightRect] = useState<DOMRect | null>(null);
	const [showSpotlight, setShowSpotlight] = useState(false);
	const [spotlightPosition, setSpotlightPosition] = useState<CSSProperties>();
	const selector = tip?.spotlightSelector;
	// Poll only while this tip is mounted: panels can collapse, scroll, or animate
	// without changing React state here. Avoid the tour helper's missing-target warning.
	const readSpotlightRect = useCallback(() => {
		if (!selector) return null;
		const visibleSelectors = selector.split(',').filter((part) => {
			const element = document.querySelector(part.trim());
			if (
				!element ||
				element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false
			)
				return false;
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return (
				style.visibility !== 'hidden' &&
				style.display !== 'none' &&
				style.opacity !== '0' &&
				rect.width > 0 &&
				rect.height > 0 &&
				rect.right > 0 &&
				rect.bottom > 0 &&
				rect.left < window.innerWidth &&
				rect.top < window.innerHeight
			);
		});
		return visibleSelectors.length ? getElementRect(visibleSelectors.join(',')) : null;
	}, [selector]);
	useEffect(() => {
		setShowSpotlight(false);
		const update = () => {
			const rect = readSpotlightRect();
			setSpotlightRect((previous) =>
				previous?.x === rect?.x &&
				previous?.y === rect?.y &&
				previous?.width === rect?.width &&
				previous?.height === rect?.height
					? previous
					: rect
			);
			if (!rect) setShowSpotlight(false);
		};
		update();
		if (!selector) return;
		const timer = window.setInterval(update, 150);
		return () => window.clearInterval(timer);
	}, [selector, readSpotlightRect, tip?.id]);
	useEffect(() => {
		if (!showSpotlight) return;
		const dismiss = () => setShowSpotlight(false);
		const timer = window.setTimeout(dismiss, 2500);
		// Capture sees even stopped events, but the opening click has already
		// passed this phase before React installs these listeners.
		window.addEventListener('click', dismiss, true);
		window.addEventListener('keydown', dismiss, true);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener('click', dismiss, true);
			window.removeEventListener('keydown', dismiss, true);
		};
	}, [showSpotlight]);
	useEffect(() => {
		if (!showSpotlight || !spotlightRect) return;
		const card = cardRef.current?.getBoundingClientRect();
		if (!card) return;
		const rect = spotlightRect;
		if (
			card.right < rect.left - 16 ||
			card.left > rect.right + 16 ||
			card.bottom < rect.top - 16 ||
			card.top > rect.bottom + 16
		)
			return;
		// Pick the largest free strip; constrain and scroll the card on small screens.
		const width = window.innerWidth;
		const height = window.innerHeight;
		const spaces = [
			{ left: 16, top: 16, width: rect.left - 32, height: height - 32 },
			{ left: rect.right + 16, top: 16, width: width - rect.right - 32, height: height - 32 },
			{ left: 16, top: 16, width: width - 32, height: rect.top - 32 },
			{ left: 16, top: rect.bottom + 16, width: width - 32, height: height - rect.bottom - 32 },
		]
			.filter((space) => space.width >= 160 && space.height >= 100)
			.sort(
				(a, b) =>
					Math.min(b.width, card.width) * Math.min(b.height, card.height) -
					Math.min(a.width, card.width) * Math.min(a.height, card.height)
			);
		const space = spaces[0];
		setSpotlightPosition(
			space
				? {
						left: space.left,
						top: space.top,
						right: 'auto',
						bottom: 'auto',
						transform: 'none',
						width: Math.min(space.width, card.width),
						maxHeight: space.height,
					}
				: { opacity: 0, pointerEvents: 'none' }
		);
	}, [showSpotlight, spotlightRect]);
	const spotlightActive = showSpotlight && !!spotlightRect;
	const passive = isReading || spotlightActive;
	const [transition, setTransition] = useState<{
		previous: DidYouKnowTip | null;
		direction: 'next' | 'back';
	}>({ previous: null, direction: 'next' });
	const navigate = (direction: 'next' | 'back') => {
		if (direction === 'back' && !canGoBack) return;
		const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		setTransition({ previous: reducedMotion ? null : tip, direction });
		if (direction === 'next') goNext();
		else goBack();
	};
	const outgoingTip = transition.previous?.id !== tip?.id ? transition.previous : null;
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	useModalLayer(MODAL_PRIORITIES.DID_YOU_KNOW, 'Did You Know', onClose, {
		blocksLowerLayers: !passive,
		capturesFocus: !passive,
		focusTrap: passive ? 'none' : 'strict',
		blocksAppShortcuts: !passive,
	});

	const isTopLayer = useIsTopLayer(MODAL_PRIORITIES.DID_YOU_KNOW);
	const surface = tip?.surface ? resolveUiSurface(tip.surface) : null;
	const enabledFeatures = resolveEncoreFeatures(encoreFeatures);
	const needsEncore = tip?.encore && !enabledFeatures[tip.encore];
	// A tip may only offer a gated surface if this action can enable its gate.
	const canOpenSurface =
		surface &&
		(!surface.encore || enabledFeatures[surface.encore] || surface.encore === tip?.encore);
	const openSurface = () => {
		if (!tip || !canOpenSurface) return;
		if (tip.encore) {
			const { encoreFeatures: currentFeatures, setEncoreFeatures } = useSettingsStore.getState();
			if (!resolveEncoreFeatures(currentFeatures)[tip.encore]) {
				setEncoreFeatures({ ...currentFeatures, [tip.encore]: true });
			}
		}
		onClose();
		useModalStore.getState().openModal(surface.modal as ModalId);
	};

	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			if (
				(passive && (!(e.target instanceof Node) || !cardRef.current?.contains(e.target))) ||
				e.defaultPrevented ||
				e.isComposing ||
				e.metaKey ||
				e.ctrlKey ||
				e.altKey ||
				e.shiftKey ||
				isEditingTextTarget(e.target)
			)
				return;

			if (e.key === 'ArrowRight') {
				e.preventDefault();
				navigate('next');
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				navigate('back');
			} else if (
				e.key === 'Enter' &&
				!isReading &&
				canOpenSurface &&
				!(e.target instanceof Element && e.target.closest('button, a, [role="button"]'))
			) {
				e.preventDefault();
				openSurface();
			}
		},
		{ enabled: isTopLayer && !!tip }
	);

	if (!tip) return null;

	return createPortal(
		<div
			className="dyk-overlay fixed inset-0 select-none"
			data-reading={isReading}
			data-spotlight={spotlightActive}
			style={{ zIndex: MODAL_PRIORITIES.DID_YOU_KNOW }}
		>
			{spotlightRect && (
				<div className="dyk-spotlight" data-active={spotlightActive} aria-hidden="true">
					<div
						className="absolute inset-0"
						style={{
							background: 'rgb(0 0 0 / 65%)',
							clipPath: getSpotlightClipPath(spotlightRect),
						}}
					/>
					<div
						className="dyk-spotlight-ring"
						style={{
							left: spotlightRect.x - 8,
							top: spotlightRect.y - 8,
							width: spotlightRect.width + 16,
							height: spotlightRect.height + 16,
							color: theme.colors.accent,
						}}
					/>
				</div>
			)}
			<section
				ref={cardRef}
				role="dialog"
				aria-modal={!passive}
				aria-label="Did You Know"
				className="dyk-dialog rounded-xl p-5 shadow-2xl"
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					...(spotlightActive ? spotlightPosition : {}),
				}}
			>
				<header className="flex items-center gap-2 text-sm">
					<Lightbulb className="h-4 w-4" style={{ color: theme.colors.accent }} aria-hidden />
					<h1 className="font-semibold">Did You Know?</h1>
					<span className="ml-auto mr-2 text-xs" style={{ color: theme.colors.textDim }}>
						{index} of {total}
					</span>
					<EscCloseButton theme={theme} onClose={onClose} />
				</header>
				{!isReading && (
					<OrnateFrame className="my-4">
						{outgoingTip && (
							<div
								key={`out-${outgoingTip.id}`}
								className="dyk-art dyk-exit"
								data-direction={transition.direction}
								aria-hidden
							>
								<TipArtwork tip={outgoingTip} theme={theme} />
							</div>
						)}
						<div
							key={tip.id}
							className={`dyk-art ${outgoingTip ? 'dyk-enter' : ''}`}
							data-direction={transition.direction}
						>
							<TipArtwork tip={tip} theme={theme} />
						</div>
					</OrnateFrame>
				)}
				{/* One grid cell sizes itself to the tallest placard at the actual width/font.
				    Hidden cards remain in layout, but are inert and absent from the accessibility tree. */}
				{isReading ? (
					<div className="my-4 space-y-2 select-text">
						<h2 className="text-lg font-semibold">{tip.title}</h2>
						<p className="text-sm leading-relaxed">{tip.headline}</p>
					</div>
				) : (
					<div className="dyk-copy-stack">
						{DID_YOU_KNOW_TIPS.map((entry) => {
							const active = entry.id === tip.id;
							const outgoing = outgoingTip && entry.id === outgoingTip.id;
							return (
								<div
									key={entry.id}
									data-tip-id={entry.id}
									data-direction={transition.direction}
									className={`dyk-copy ${active && outgoingTip ? 'dyk-enter' : outgoing ? 'dyk-exit' : ''}`}
									style={{ visibility: active || outgoing ? undefined : 'hidden' }}
									aria-hidden={!active || undefined}
									{...(!active && { inert: '' as unknown as boolean })}
								>
									<TipCard
										tip={entry}
										theme={theme}
										shortcuts={shortcuts}
										tabShortcuts={tabShortcuts}
										encoreFeatures={encoreFeatures}
										fontFamily={fontFamily}
									/>
								</div>
							);
						})}
					</div>
				)}
				<footer className="dyk-footer mt-6 grid items-center gap-2 text-sm">
					{spotlightRect && (
						<button
							type="button"
							className="dyk-show-me rounded px-2 py-2 hover:bg-white/10"
							onClick={() => {
								const rect = readSpotlightRect();
								setSpotlightRect(rect);
								setSpotlightPosition(undefined);
								setShowSpotlight(!!rect);
							}}
						>
							Show me
						</button>
					)}
					{!isReading && (
						<button
							type="button"
							className="rounded py-2 text-xs hover:underline"
							style={{ color: theme.colors.textDim }}
							onClick={() => {
								dismissForever();
								onClose();
							}}
						>
							Don't show this again
						</button>
					)}
					{(isReading || tip.docsSlug) && (
						<button
							type="button"
							onClick={isReading ? exitReading : openDocs}
							className="dyk-docs rounded px-2 py-2 hover:bg-white/10"
						>
							{isReading ? 'Back to tips' : 'Read more'}
						</button>
					)}
					<button
						type="button"
						aria-label="Previous tip"
						title="Previous tip"
						disabled={!canGoBack}
						onClick={() => navigate('back')}
						className="dyk-back rounded p-2 hover:bg-white/10 disabled:opacity-30"
					>
						<ArrowLeft className="h-4 w-4" aria-hidden />
					</button>
					<button
						type="button"
						aria-label="Next tip"
						title="Next tip"
						onClick={() => navigate('next')}
						className="dyk-next rounded p-2 hover:bg-white/10"
					>
						<ArrowRight className="h-4 w-4" aria-hidden />
					</button>
					{!isReading && canOpenSurface && (
						<button
							type="button"
							onClick={openSurface}
							className="dyk-action rounded px-3 py-2 font-medium hover:opacity-90"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						>
							{needsEncore ? 'Turn on' : 'Open'} {surface.label}
						</button>
					)}
				</footer>
			</section>
		</div>,
		document.body
	);
}
