import { useState } from 'react';
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
	const { tip, index, total, canGoBack, goNext, goBack, dismissForever } = useDidYouKnowRotation({
		startTipId,
	});
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
	useModalLayer(MODAL_PRIORITIES.DID_YOU_KNOW, 'Did You Know', onClose);

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
			} else if (e.key === 'Enter' && canOpenSurface) {
				e.preventDefault();
				openSurface();
			}
		},
		{ enabled: isTopLayer && !!tip }
	);

	if (!tip) return null;

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-black/60 p-4 select-none"
			style={{ zIndex: MODAL_PRIORITIES.DID_YOU_KNOW }}
		>
			<section
				role="dialog"
				aria-modal="true"
				aria-label="Did You Know"
				className="dyk-dialog my-auto w-full max-w-[760px] shrink-0 rounded-xl p-5 shadow-2xl"
				style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
			>
				<header className="flex items-center gap-2 text-sm">
					<Lightbulb className="h-4 w-4" style={{ color: theme.colors.accent }} aria-hidden />
					<h1 className="font-semibold">Did You Know?</h1>
					<span className="ml-auto mr-2 text-xs" style={{ color: theme.colors.textDim }}>
						{index} of {total}
					</span>
					<EscCloseButton theme={theme} onClose={onClose} />
				</header>
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
				{/* One grid cell sizes itself to the tallest placard at the actual width/font.
				    Hidden cards remain in layout, but are inert and absent from the accessibility tree. */}
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
				<footer className="dyk-footer mt-6 grid items-center gap-2 text-sm">
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
					{/* Documentation and primary action wiring follow in subsequent tasks. */}
					{tip.docsSlug && (
						<button type="button" disabled className="dyk-docs rounded px-2 py-2 opacity-50">
							Read more
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
					{canOpenSurface && (
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
