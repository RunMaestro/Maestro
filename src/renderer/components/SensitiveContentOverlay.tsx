/**
 * SensitiveContentOverlay - Renders background highlights behind a textarea.
 * This overlay displays colored backgrounds for detected sensitive content (PII, secrets)
 * while allowing the textarea text to remain fully visible and editable.
 *
 * Architecture:
 * - Positioned behind a transparent textarea (z-index layering)
 * - Mirrors the textarea's font, padding, and line-height exactly
 * - Syncs scroll position with the textarea
 * - Renders colored background spans at the exact character positions of findings
 */

import { memo, useRef } from 'react';
import type { InputScanFinding } from '../../main/preload/security';

interface SensitiveContentOverlayProps {
	/** The input text being displayed */
	text: string;
	/** Detected findings with character positions */
	findings: InputScanFinding[];
	/** Current scroll position of the textarea */
	scrollTop: number;
	/** Whether in terminal mode (affects left padding for $ prefix) */
	isTerminalMode: boolean;
	/** Whether the input area is expanded (affects maxHeight) */
	isExpanded?: boolean;
}

// Single consistent color for all sensitive content highlights
export const HIGHLIGHT_BG = 'rgba(168, 85, 247, 0.5)'; // Purple - increased opacity for better visibility

/**
 * Render text with highlighted backgrounds for findings.
 * For InputArea: text is transparent (overlay behind textarea)
 * For PromptComposerModal: text is visible (overlay on top of textarea)
 * Exported for use in PromptComposerModal.
 */
export function renderTextWithHighlights(
	text: string,
	findings: InputScanFinding[],
	options: { textColor?: string; showText?: boolean } = {}
): React.ReactNode[] {
	const { textColor = 'transparent', showText = false } = options;

	if (findings.length === 0) {
		return [
			<span key="all" style={{ color: 'transparent' }}>
				{text}
			</span>,
		];
	}

	const result: React.ReactNode[] = [];
	let lastEnd = 0;

	// Sort findings by start position and handle overlaps
	const sortedFindings = [...findings].sort((a, b) => a.start - b.start);

	for (let i = 0; i < sortedFindings.length; i++) {
		const finding = sortedFindings[i];

		// Skip if this finding overlaps with previous (already processed)
		if (finding.start < lastEnd) {
			continue;
		}

		// Add transparent text before this finding
		if (finding.start > lastEnd) {
			result.push(
				<span key={`text-${i}`} style={{ color: 'transparent' }}>
					{text.slice(lastEnd, finding.start)}
				</span>
			);
		}

		// Add highlighted span for this finding
		result.push(
			<span
				key={`highlight-${i}`}
				style={{
					color: showText ? textColor : 'transparent',
					backgroundColor: HIGHLIGHT_BG,
					borderRadius: '2px',
				}}
			>
				{text.slice(finding.start, finding.end)}
			</span>
		);

		lastEnd = finding.end;
	}

	// Add remaining transparent text
	if (lastEnd < text.length) {
		result.push(
			<span key="text-end" style={{ color: 'transparent' }}>
				{text.slice(lastEnd)}
			</span>
		);
	}

	return result;
}

export const SensitiveContentOverlay = memo(function SensitiveContentOverlay({
	text,
	findings,
	scrollTop,
	isTerminalMode,
	isExpanded = false,
}: SensitiveContentOverlayProps) {
	const overlayRef = useRef<HTMLDivElement>(null);

	// Don't render if no findings
	if (findings.length === 0) {
		return null;
	}

	const content = renderTextWithHighlights(text, findings);

	return (
		<div
			ref={overlayRef}
			className="absolute inset-0 pointer-events-none"
			style={{
				// Clip content that scrolls outside bounds
				overflow: 'hidden',
				// Match the textarea height exactly
				minHeight: '3.5rem',
				maxHeight: isExpanded ? '50vh' : '11rem',
				// Position behind the textarea
				zIndex: 0,
			}}
			aria-hidden="true"
		>
			{/* Inner scrollable content that moves with the textarea */}
			<div
				style={{
					// Match textarea styling exactly - must match InputArea.tsx textarea classes
					fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
					fontSize: '0.875rem', // text-sm (14px)
					lineHeight: '1.25rem', // text-sm default line-height (20px)
					// Match textarea padding exactly - pl-3 pt-3 pr-3
					paddingLeft: isTerminalMode ? '0.375rem' : '0.75rem',
					paddingTop: '0.75rem',
					paddingRight: '0.75rem',
					// Sync scroll with textarea - move content up as user scrolls
					transform: `translateY(-${scrollTop}px)`,
					// Ensure text wrapping matches textarea
					whiteSpace: 'pre-wrap',
					wordWrap: 'break-word',
					overflowWrap: 'break-word',
				}}
			>
				{content}
			</div>
		</div>
	);
});

SensitiveContentOverlay.displayName = 'SensitiveContentOverlay';

export default SensitiveContentOverlay;
