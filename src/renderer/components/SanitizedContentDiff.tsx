/**
 * SanitizedContentDiff
 *
 * Displays a visual diff between original and sanitized content.
 * Shows inline or side-by-side comparison highlighting what was changed.
 *
 * Features:
 * - Side-by-side or inline diff view modes
 * - Highlights replaced/removed parts in original text
 * - Highlights replacement placeholders in sanitized text
 * - Supports multiple findings with different colors by type
 * - Copy buttons for original and sanitized content
 */

import React, { memo, useState, useCallback, useMemo } from 'react';
import {
	ArrowLeftRight,
	ArrowDown,
	Copy,
	Check,
	X,
	EyeOff,
	Eye,
	ChevronDown,
	ChevronUp,
} from 'lucide-react';
import type { Theme } from '../types';
import type { Finding } from './FindingDetails';
import { safeClipboardWrite } from '../utils/clipboard';

export interface SanitizedContentDiffProps {
	theme: Theme;
	/** Original content before sanitization (optional if findings-only mode) */
	originalContent?: string;
	/** Sanitized content after LLM Guard processing (optional if findings-only mode) */
	sanitizedContent?: string;
	/** List of findings that were applied */
	findings: Finding[];
	/** View mode: side-by-side or inline */
	viewMode?: 'side-by-side' | 'inline';
	/** Whether to show in compact mode (less padding, smaller text) */
	compact?: boolean;
	/** Callback when the component is closed */
	onClose?: () => void;
	/** Maximum height before scrolling (default: 400px) */
	maxHeight?: number;
}

// Sort findings by start position
const sortFindingsByPosition = (findings: Finding[]): Finding[] => {
	return [...findings].sort((a, b) => a.start - b.start);
};

// Get color for finding type
const getHighlightColor = (type: string): { bg: string; text: string } => {
	// High severity: injection, jailbreak
	if (type.includes('INJECTION') || type.includes('JAILBREAK')) {
		return { bg: 'rgba(239, 68, 68, 0.3)', text: '#ef4444' };
	}
	// Secrets
	if (
		type.startsWith('SECRET_') ||
		type.includes('PASSWORD') ||
		type.includes('TOKEN') ||
		type.includes('KEY')
	) {
		return { bg: 'rgba(245, 158, 11, 0.3)', text: '#f59e0b' };
	}
	// PII
	if (type.startsWith('PII_')) {
		return { bg: 'rgba(139, 92, 246, 0.3)', text: '#8b5cf6' };
	}
	// Invisible characters
	if (type.startsWith('INVISIBLE_')) {
		return { bg: 'rgba(236, 72, 153, 0.3)', text: '#ec4899' };
	}
	// Default
	return { bg: 'rgba(59, 130, 246, 0.3)', text: '#3b82f6' };
};

// Segment type for rendering
interface TextSegment {
	type: 'normal' | 'removed' | 'added';
	text: string;
	findingType?: string;
	replacement?: string;
}

// Build segments from original content and findings
const buildOriginalSegments = (content: string, findings: Finding[]): TextSegment[] => {
	const sortedFindings = sortFindingsByPosition(findings);
	const segments: TextSegment[] = [];
	let currentPos = 0;

	for (const finding of sortedFindings) {
		// Only process findings with replacements (i.e., actually sanitized)
		// Use explicit undefined check to allow empty-string replacements (deletions)
		if (finding.replacement === undefined) continue;

		// Add normal text before this finding
		if (finding.start > currentPos) {
			segments.push({
				type: 'normal',
				text: content.slice(currentPos, finding.start),
			});
		}

		// Add the removed (original) text
		if (finding.start >= 0 && finding.end <= content.length) {
			segments.push({
				type: 'removed',
				text: content.slice(finding.start, finding.end),
				findingType: finding.type,
				replacement: finding.replacement,
			});
		}

		currentPos = finding.end;
	}

	// Add remaining normal text
	if (currentPos < content.length) {
		segments.push({
			type: 'normal',
			text: content.slice(currentPos),
		});
	}

	return segments;
};

// Build segments from sanitized content and findings
const buildSanitizedSegments = (content: string, findings: Finding[]): TextSegment[] => {
	// For sanitized content, we need to find the replacement text positions
	// Since replacements may be different lengths, we need to track offset adjustments

	const sortedFindings = sortFindingsByPosition(findings).filter(
		(f) => f.replacement !== undefined
	);

	if (sortedFindings.length === 0) {
		return [{ type: 'normal', text: content }];
	}

	const segments: TextSegment[] = [];
	let currentPos = 0;

	// Calculate cumulative offset due to length differences
	let offset = 0;

	for (const finding of sortedFindings) {
		// Use explicit undefined check to allow empty-string replacements (deletions)
		if (finding.replacement === undefined) continue;

		const originalLength = finding.end - finding.start;
		const replacementLength = finding.replacement.length;
		const adjustedStart = finding.start + offset;
		const adjustedEnd = adjustedStart + replacementLength;

		// Add normal text before this replacement
		if (adjustedStart > currentPos) {
			segments.push({
				type: 'normal',
				text: content.slice(currentPos, adjustedStart),
			});
		}

		// Add the replacement text (marked as added)
		if (adjustedStart >= 0 && adjustedEnd <= content.length) {
			segments.push({
				type: 'added',
				text: content.slice(adjustedStart, adjustedEnd),
				findingType: finding.type,
			});
		}

		currentPos = adjustedEnd;
		offset += replacementLength - originalLength;
	}

	// Add remaining normal text
	if (currentPos < content.length) {
		segments.push({
			type: 'normal',
			text: content.slice(currentPos),
		});
	}

	return segments;
};

// Inline diff segment rendering
interface InlineSegment {
	type: 'normal' | 'removed' | 'added';
	text: string;
	findingType?: string;
}

// Build inline diff segments (showing removed and added inline)
const buildInlineSegments = (
	originalContent: string,
	sanitizedContent: string,
	findings: Finding[]
): InlineSegment[] => {
	const sortedFindings = sortFindingsByPosition(findings).filter(
		(f) => f.replacement !== undefined
	);

	if (sortedFindings.length === 0) {
		return [{ type: 'normal', text: originalContent }];
	}

	const segments: InlineSegment[] = [];
	let currentPos = 0;

	for (const finding of sortedFindings) {
		// Use explicit undefined check to allow empty-string replacements (deletions)
		if (finding.replacement === undefined) continue;

		// Add normal text before this finding
		if (finding.start > currentPos) {
			segments.push({
				type: 'normal',
				text: originalContent.slice(currentPos, finding.start),
			});
		}

		// Add the removed text (strikethrough)
		segments.push({
			type: 'removed',
			text: originalContent.slice(finding.start, finding.end),
			findingType: finding.type,
		});

		// Add the replacement text
		segments.push({
			type: 'added',
			text: finding.replacement,
			findingType: finding.type,
		});

		currentPos = finding.end;
	}

	// Add remaining normal text
	if (currentPos < originalContent.length) {
		segments.push({
			type: 'normal',
			text: originalContent.slice(currentPos),
		});
	}

	return segments;
};

/**
 * FindingsOnlyDiff Component
 *
 * Displays a diff view based solely on findings when full content isn't available.
 * Shows each finding with its original value and replacement side-by-side.
 */
const FindingsOnlyDiff = memo(function FindingsOnlyDiff({
	theme,
	findings,
	compact,
	onClose,
	maxHeight,
}: {
	theme: Theme;
	findings: Finding[];
	compact?: boolean;
	onClose?: () => void;
	maxHeight?: number;
}) {
	const [copiedAll, setCopiedAll] = useState(false);

	const sanitizedFindings = findings.filter((f) => f.replacement !== undefined);

	const handleCopyAll = useCallback(async () => {
		const summary = sanitizedFindings
			.map((f) => `${f.type}: "${f.value}" → "${f.replacement}"`)
			.join('\n');
		const success = await safeClipboardWrite(summary);
		if (success) {
			setCopiedAll(true);
			setTimeout(() => setCopiedAll(false), 2000);
		}
	}, [sanitizedFindings]);

	const textSize = compact ? 'text-[11px]' : 'text-xs';

	return (
		<div
			className="rounded border overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
		>
			{/* Header */}
			<div
				className="flex items-center justify-between gap-2 px-3 py-2 border-b"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<div className="flex items-center gap-2">
					<Eye className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
						Content Changes
					</span>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						({sanitizedFindings.length} change{sanitizedFindings.length !== 1 ? 's' : ''})
					</span>
				</div>

				<div className="flex items-center gap-2">
					<button
						onClick={handleCopyAll}
						className="flex items-center gap-1 text-[10px] px-2 py-1 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						title="Copy all changes"
					>
						{copiedAll ? (
							<>
								<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
								<span>Copied</span>
							</>
						) : (
							<>
								<Copy className="w-3 h-3" />
								<span>Copy All</span>
							</>
						)}
					</button>
					{onClose && (
						<button
							onClick={onClose}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							title="Close diff view"
						>
							<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						</button>
					)}
				</div>
			</div>

			{/* Changes List */}
			<div
				className="overflow-auto"
				style={{ maxHeight: maxHeight ? `${maxHeight}px` : undefined }}
			>
				{sanitizedFindings.map((finding, idx) => {
					const colors = getHighlightColor(finding.type);
					return (
						<div
							key={idx}
							className="border-b last:border-b-0"
							style={{ borderColor: theme.colors.border }}
						>
							{/* Finding Type Header */}
							<div
								className="flex items-center gap-2 px-3 py-1.5"
								style={{ backgroundColor: colors.bg }}
							>
								<span className={`${textSize} font-bold uppercase`} style={{ color: colors.text }}>
									{finding.type.replace(/_/g, ' ')}
								</span>
								<span
									className="text-[10px] px-1.5 py-0.5 rounded"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
								>
									{(finding.confidence * 100).toFixed(0)}% confidence
								</span>
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									pos {finding.start}–{finding.end}
								</span>
							</div>

							{/* Original → Replacement */}
							<div
								className="grid grid-cols-2 divide-x"
								style={{ borderColor: theme.colors.border }}
							>
								{/* Original */}
								<div className="p-2">
									<div
										className="text-[10px] uppercase mb-1 flex items-center gap-1"
										style={{ color: theme.colors.error }}
									>
										<span>Original</span>
									</div>
									<div
										className={`font-mono ${textSize} p-2 rounded break-all`}
										style={{
											backgroundColor: 'rgba(239, 68, 68, 0.1)',
											color: theme.colors.error,
											textDecoration: 'line-through',
										}}
									>
										{finding.value}
									</div>
								</div>

								{/* Replacement */}
								<div className="p-2">
									<div
										className="text-[10px] uppercase mb-1 flex items-center gap-1"
										style={{ color: theme.colors.success }}
									>
										<span>Replacement</span>
									</div>
									<div
										className={`font-mono ${textSize} p-2 rounded break-all`}
										style={{
											backgroundColor: 'rgba(34, 197, 94, 0.1)',
											color: theme.colors.success,
										}}
									>
										{finding.replacement}
									</div>
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{/* Footer */}
			<div
				className="flex items-center justify-between px-3 py-1.5 border-t text-[10px]"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgSidebar,
					color: theme.colors.textDim,
				}}
			>
				<span>
					Showing {sanitizedFindings.length} sanitization{sanitizedFindings.length !== 1 ? 's' : ''}
				</span>
			</div>
		</div>
	);
});

/**
 * SanitizedContentDiff Component
 *
 * Displays original and sanitized content with visual highlighting
 * of the changes made by LLM Guard.
 *
 * If original/sanitized content is not provided, falls back to a findings-only view.
 */
export const SanitizedContentDiff = memo(function SanitizedContentDiff({
	theme,
	originalContent,
	sanitizedContent,
	findings,
	viewMode = 'side-by-side',
	compact = false,
	onClose,
	maxHeight = 400,
}: SanitizedContentDiffProps) {
	const [mode, setMode] = useState<'side-by-side' | 'inline'>(viewMode);
	const [copiedOriginal, setCopiedOriginal] = useState(false);
	const [copiedSanitized, setCopiedSanitized] = useState(false);
	const [showLegend, setShowLegend] = useState(!compact);

	// Check if we have full content or just findings
	const hasFullContent = originalContent !== undefined && sanitizedContent !== undefined;

	// Build segments for rendering (only if we have full content)
	const originalSegments = useMemo(
		() => (hasFullContent ? buildOriginalSegments(originalContent!, findings) : []),
		[originalContent, findings, hasFullContent]
	);

	const sanitizedSegments = useMemo(
		() => (hasFullContent ? buildSanitizedSegments(sanitizedContent!, findings) : []),
		[sanitizedContent, findings, hasFullContent]
	);

	const inlineSegments = useMemo(
		() =>
			hasFullContent ? buildInlineSegments(originalContent!, sanitizedContent!, findings) : [],
		[originalContent, sanitizedContent, findings, hasFullContent]
	);

	// Copy handlers
	const handleCopyOriginal = useCallback(async () => {
		if (!originalContent) return;
		const success = await safeClipboardWrite(originalContent);
		if (success) {
			setCopiedOriginal(true);
			setTimeout(() => setCopiedOriginal(false), 2000);
		}
	}, [originalContent]);

	const handleCopySanitized = useCallback(async () => {
		if (!sanitizedContent) return;
		const success = await safeClipboardWrite(sanitizedContent);
		if (success) {
			setCopiedSanitized(true);
			setTimeout(() => setCopiedSanitized(false), 2000);
		}
	}, [sanitizedContent]);

	// Get unique finding types for legend
	const uniqueTypes = useMemo(() => {
		const types = new Set<string>();
		findings.forEach((f) => {
			if (f.replacement !== undefined) types.add(f.type);
		});
		return Array.from(types);
	}, [findings]);

	// No changes to show
	if (findings.filter((f) => f.replacement !== undefined).length === 0) {
		return (
			<div
				className="p-4 rounded border text-center"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
			>
				<EyeOff className="w-6 h-6 mx-auto mb-2 opacity-50" />
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					No sanitization changes to display
				</p>
			</div>
		);
	}

	// If no full content, show findings-only view
	if (!hasFullContent) {
		return (
			<FindingsOnlyDiff
				theme={theme}
				findings={findings}
				compact={compact}
				onClose={onClose}
				maxHeight={maxHeight}
			/>
		);
	}

	const textSize = compact ? 'text-[11px]' : 'text-xs';
	const padding = compact ? 'p-2' : 'p-3';

	return (
		<div
			className="rounded border overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
		>
			{/* Header */}
			<div
				className="flex items-center justify-between gap-2 px-3 py-2 border-b"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<div className="flex items-center gap-2">
					<Eye className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
						Content Changes
					</span>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						({findings.filter((f) => f.replacement !== undefined).length} change
						{findings.filter((f) => f.replacement !== undefined).length !== 1 ? 's' : ''})
					</span>
				</div>

				<div className="flex items-center gap-2">
					{/* View Mode Toggle */}
					<div
						className="flex items-center rounded overflow-hidden text-[10px]"
						style={{
							border: `1px solid ${theme.colors.border}`,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						<button
							onClick={() => setMode('side-by-side')}
							className="px-2 py-1 flex items-center gap-1 transition-colors"
							style={{
								backgroundColor: mode === 'side-by-side' ? theme.colors.accent : 'transparent',
								color: mode === 'side-by-side' ? '#ffffff' : theme.colors.textDim,
							}}
							title="Side-by-side view"
						>
							<ArrowLeftRight className="w-3 h-3" />
							<span>Side-by-Side</span>
						</button>
						<button
							onClick={() => setMode('inline')}
							className="px-2 py-1 flex items-center gap-1 transition-colors"
							style={{
								backgroundColor: mode === 'inline' ? theme.colors.accent : 'transparent',
								color: mode === 'inline' ? '#ffffff' : theme.colors.textDim,
							}}
							title="Inline view"
						>
							<ArrowDown className="w-3 h-3" />
							<span>Inline</span>
						</button>
					</div>

					{/* Close Button */}
					{onClose && (
						<button
							onClick={onClose}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							title="Close diff view"
						>
							<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						</button>
					)}
				</div>
			</div>

			{/* Legend */}
			{uniqueTypes.length > 0 && (
				<div
					className="border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<button
						onClick={() => setShowLegend(!showLegend)}
						className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						<span>Legend ({uniqueTypes.length} types)</span>
						{showLegend ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
					</button>
					{showLegend && (
						<div className="flex flex-wrap gap-2 px-3 pb-2">
							{uniqueTypes.map((type) => {
								const colors = getHighlightColor(type);
								return (
									<span
										key={type}
										className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
										style={{ backgroundColor: colors.bg, color: colors.text }}
									>
										{type.replace(/_/g, ' ')}
									</span>
								);
							})}
							<span
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
								style={{
									backgroundColor: 'rgba(239, 68, 68, 0.15)',
									color: theme.colors.error,
									textDecoration: 'line-through',
								}}
							>
								Removed
							</span>
							<span
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
								style={{
									backgroundColor: 'rgba(34, 197, 94, 0.15)',
									color: theme.colors.success,
								}}
							>
								Added
							</span>
						</div>
					)}
				</div>
			)}

			{/* Content */}
			{mode === 'side-by-side' ? (
				<div className="grid grid-cols-2 divide-x" style={{ borderColor: theme.colors.border }}>
					{/* Original (Before) */}
					<div className="flex flex-col">
						<div
							className="flex items-center justify-between px-3 py-1.5 border-b"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: 'rgba(239, 68, 68, 0.1)',
							}}
						>
							<span
								className="text-[10px] font-bold uppercase"
								style={{ color: theme.colors.error }}
							>
								Original
							</span>
							<button
								onClick={handleCopyOriginal}
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Copy original content"
							>
								{copiedOriginal ? (
									<>
										<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
										<span>Copied</span>
									</>
								) : (
									<>
										<Copy className="w-3 h-3" />
										<span>Copy</span>
									</>
								)}
							</button>
						</div>
						<div
							className={`${padding} overflow-auto font-mono ${textSize} whitespace-pre-wrap break-all`}
							style={{
								maxHeight: `${maxHeight}px`,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							{originalSegments.map((segment, idx) => {
								if (segment.type === 'removed') {
									const colors = getHighlightColor(segment.findingType || '');
									return (
										<span
											key={idx}
											className="px-0.5 rounded"
											style={{
												backgroundColor: 'rgba(239, 68, 68, 0.2)',
												textDecoration: 'line-through',
												textDecorationColor: theme.colors.error,
												color: theme.colors.error,
											}}
											title={`${segment.findingType}: ${segment.text} → ${segment.replacement}`}
										>
											{segment.text}
										</span>
									);
								}
								return <span key={idx}>{segment.text}</span>;
							})}
						</div>
					</div>

					{/* Sanitized (After) */}
					<div className="flex flex-col">
						<div
							className="flex items-center justify-between px-3 py-1.5 border-b"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: 'rgba(34, 197, 94, 0.1)',
							}}
						>
							<span
								className="text-[10px] font-bold uppercase"
								style={{ color: theme.colors.success }}
							>
								Sanitized
							</span>
							<button
								onClick={handleCopySanitized}
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Copy sanitized content"
							>
								{copiedSanitized ? (
									<>
										<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
										<span>Copied</span>
									</>
								) : (
									<>
										<Copy className="w-3 h-3" />
										<span>Copy</span>
									</>
								)}
							</button>
						</div>
						<div
							className={`${padding} overflow-auto font-mono ${textSize} whitespace-pre-wrap break-all`}
							style={{
								maxHeight: `${maxHeight}px`,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							{sanitizedSegments.map((segment, idx) => {
								if (segment.type === 'added') {
									const colors = getHighlightColor(segment.findingType || '');
									return (
										<span
											key={idx}
											className="px-0.5 rounded"
											style={{
												backgroundColor: 'rgba(34, 197, 94, 0.2)',
												color: theme.colors.success,
											}}
											title={`Replaced with: ${segment.text}`}
										>
											{segment.text}
										</span>
									);
								}
								return <span key={idx}>{segment.text}</span>;
							})}
						</div>
					</div>
				</div>
			) : (
				/* Inline View */
				<div className="flex flex-col">
					<div
						className="flex items-center justify-between px-3 py-1.5 border-b"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						<span
							className="text-[10px] font-bold uppercase"
							style={{ color: theme.colors.textMain }}
						>
							Inline Diff
						</span>
						<div className="flex items-center gap-2">
							<button
								onClick={handleCopyOriginal}
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Copy original content"
							>
								<Copy className="w-3 h-3" />
								<span>Original</span>
							</button>
							<button
								onClick={handleCopySanitized}
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Copy sanitized content"
							>
								<Copy className="w-3 h-3" />
								<span>Sanitized</span>
							</button>
						</div>
					</div>
					<div
						className={`${padding} overflow-auto font-mono ${textSize} whitespace-pre-wrap break-all`}
						style={{
							maxHeight: `${maxHeight}px`,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						{inlineSegments.map((segment, idx) => {
							if (segment.type === 'removed') {
								return (
									<span
										key={idx}
										className="px-0.5 rounded"
										style={{
											backgroundColor: 'rgba(239, 68, 68, 0.2)',
											textDecoration: 'line-through',
											textDecorationColor: theme.colors.error,
											color: theme.colors.error,
										}}
										title={`Removed: ${segment.findingType}`}
									>
										{segment.text}
									</span>
								);
							}
							if (segment.type === 'added') {
								return (
									<span
										key={idx}
										className="px-0.5 rounded"
										style={{
											backgroundColor: 'rgba(34, 197, 94, 0.2)',
											color: theme.colors.success,
										}}
										title={`Added: ${segment.findingType}`}
									>
										{segment.text}
									</span>
								);
							}
							return <span key={idx}>{segment.text}</span>;
						})}
					</div>
				</div>
			)}

			{/* Footer with character count */}
			<div
				className="flex items-center justify-between px-3 py-1.5 border-t text-[10px]"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgSidebar,
					color: theme.colors.textDim,
				}}
			>
				<span>
					Original: {originalContent.length} chars → Sanitized: {sanitizedContent.length} chars
				</span>
				<span>
					{originalContent.length !== sanitizedContent.length && (
						<>
							{sanitizedContent.length < originalContent.length ? '-' : '+'}
							{Math.abs(originalContent.length - sanitizedContent.length)} chars
						</>
					)}
				</span>
			</div>
		</div>
	);
});

export default SanitizedContentDiff;
