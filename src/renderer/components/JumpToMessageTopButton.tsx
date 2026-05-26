/**
 * JumpToMessageTopButton
 *
 * Bottom-left "jump to top of this message" affordance shared between the
 * AI terminal log items and the group chat message bubbles. Hides itself
 * when the target message is already fully visible within its scroll
 * container — the button would otherwise be a no-op and is just visual
 * noise.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import type { Theme } from '../types';
import { scrollMessageToTop } from '../utils/messageScrollNavigation';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface JumpToMessageTopButtonProps {
	/** Ref to the scrolling viewport that contains the message. */
	scrollContainerRef: RefObject<HTMLElement | null>;
	/** Explicit ref to the message element. Preferred when available. */
	messageRef?: RefObject<HTMLElement | null>;
	/**
	 * Fallback CSS selector resolved via `closest()` from the button itself.
	 * Use when each message isn't a discrete component with its own ref.
	 */
	messageAncestorSelector?: string;
	theme: Theme;
}

export function JumpToMessageTopButton({
	scrollContainerRef,
	messageRef,
	messageAncestorSelector,
	theme,
}: JumpToMessageTopButtonProps) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [target, setTarget] = useState<HTMLElement | null>(null);
	const [fullyVisible, setFullyVisible] = useState(false);

	// Resolve the message element once mounted.
	useEffect(() => {
		if (messageRef?.current) {
			setTarget(messageRef.current);
			return;
		}
		if (messageAncestorSelector && buttonRef.current) {
			setTarget(buttonRef.current.closest<HTMLElement>(messageAncestorSelector));
		}
	}, [messageRef, messageAncestorSelector]);

	// Observe full-visibility relative to the scroll container.
	useEffect(() => {
		const root = scrollContainerRef.current;
		if (!target || !root) return;
		const observer = new IntersectionObserver(
			([entry]) => setFullyVisible(entry.intersectionRatio >= 0.999),
			{ root, threshold: [0, 0.5, 0.999, 1] }
		);
		observer.observe(target);
		return () => observer.disconnect();
	}, [target, scrollContainerRef]);

	return (
		<button
			ref={buttonRef}
			type="button"
			onClick={() => {
				const container = scrollContainerRef.current;
				if (container && target) scrollMessageToTop(container, target);
			}}
			className="absolute bottom-2 left-2 p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
			style={{
				color: theme.colors.textDim,
				transition: 'opacity 0.15s ease-in-out',
				display: fullyVisible ? 'none' : undefined,
			}}
			title={`Jump to top of this message (${formatShortcutKeys(['Shift', 'ArrowUp'])} for previous)`}
			aria-label="Jump to top of this message"
		>
			<ArrowUp className="w-3.5 h-3.5" />
		</button>
	);
}
