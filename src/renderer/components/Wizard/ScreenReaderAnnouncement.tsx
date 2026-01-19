/**
 * ScreenReaderAnnouncement.tsx
 *
 * A component for announcing important state changes to screen readers.
 * Uses ARIA live regions to provide accessible notifications for wizard
 * screen changes and important state updates.
 *
 * The component is visually hidden but accessible to screen readers,
 * following WCAG 2.1 guidelines for accessible notifications.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Politeness level for announcements
 * - 'polite': Waits for current speech to finish (for non-urgent updates)
 * - 'assertive': Interrupts current speech (for urgent/important updates)
 */
export type AnnouncementPoliteness = 'polite' | 'assertive';

interface ScreenReaderAnnouncementProps {
	/** The message to announce to screen readers */
	message: string;
	/** Politeness level - 'polite' (default) or 'assertive' for urgent announcements */
	politeness?: AnnouncementPoliteness;
	/** Optional key to force re-announcement of the same message */
	announceKey?: string | number;
}

/**
 * ScreenReaderAnnouncement - Visually hidden live region for screen reader announcements
 *
 * This component uses a technique of toggling content to ensure screen readers
 * announce even repeated messages. The component is visually hidden using
 * accessible CSS techniques (not display:none which would hide from screen readers).
 *
 * @example
 * ```tsx
 * // Announce step changes
 * <ScreenReaderAnnouncement
 *   message={`Step ${currentStep} of ${totalSteps}: ${stepTitle}`}
 *   announceKey={currentStep}
 * />
 *
 * // Urgent announcement
 * <ScreenReaderAnnouncement
 *   message="Error: Failed to validate directory"
 *   politeness="assertive"
 * />
 * ```
 */
export function ScreenReaderAnnouncement({
	message,
	politeness = 'polite',
	announceKey,
}: ScreenReaderAnnouncementProps): JSX.Element {
	// Use a toggle state to force re-announcement of the same message
	// Screen readers may ignore duplicate content, so we alternate between two regions
	const [toggle, setToggle] = useState(false);
	const prevMessageRef = useRef<string>('');
	const prevKeyRef = useRef<string | number | undefined>(undefined);

	useEffect(() => {
		// Only toggle if the message or key has changed
		if (message !== prevMessageRef.current || announceKey !== prevKeyRef.current) {
			prevMessageRef.current = message;
			prevKeyRef.current = announceKey;
			// Toggle to trigger re-render and re-announcement
			setToggle((prev) => !prev);
		}
	}, [message, announceKey]);

	// The visually-hidden styles ensure the element is:
	// - Not visible on screen (but not display:none)
	// - Still accessible to screen readers
	// - Not affecting layout
	const visuallyHiddenStyles: React.CSSProperties = {
		position: 'absolute',
		width: '1px',
		height: '1px',
		margin: '-1px',
		padding: '0',
		overflow: 'hidden',
		clip: 'rect(0, 0, 0, 0)',
		whiteSpace: 'nowrap',
		border: '0',
	};

	return (
		<>
			{/* Primary announcement region */}
			<div role="status" aria-live={politeness} aria-atomic="true" style={visuallyHiddenStyles}>
				{toggle ? message : ''}
			</div>
			{/* Secondary announcement region (for toggling) */}
			<div role="status" aria-live={politeness} aria-atomic="true" style={visuallyHiddenStyles}>
				{!toggle ? message : ''}
			</div>
		</>
	);
}

/**
 * Hook to manage announcement messages with automatic debouncing
 *
 * @example
 * ```tsx
 * const { announce, announcementProps } = useAnnouncement();
 *
 * // Later in your code:
 * announce('Agent selected: Claude Code');
 *
 * // In your JSX:
 * <ScreenReaderAnnouncement {...announcementProps} />
 * ```
 */
export function useAnnouncement(debounceMs: number = 100) {
	const [message, setMessage] = useState('');
	const [key, setKey] = useState(0);
	const [politenessLevel, setPolitenessLevel] = useState<AnnouncementPoliteness>('polite');
	const timeoutRef = useRef<number | null>(null);

	const announce = (newMessage: string, politeness: AnnouncementPoliteness = 'polite') => {
		// Clear any pending announcement
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// Debounce to avoid rapid announcements
		timeoutRef.current = window.setTimeout(() => {
			setMessage(newMessage);
			setPolitenessLevel(politeness);
			setKey((prev) => prev + 1);
		}, debounceMs);
	};

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	return {
		announce,
		announcementProps: {
			message,
			announceKey: key,
			politeness: politenessLevel,
		},
	};
}

export default ScreenReaderAnnouncement;
