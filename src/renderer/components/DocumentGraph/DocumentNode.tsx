/**
 * DocumentNode - Custom React Flow node for displaying markdown document information.
 *
 * Renders a card-like node showing document metadata:
 * - Title prominently at top
 * - Stats row: line count, word count, file size
 * - Optional description (truncated with ellipsis)
 *
 * Styled with theme colors and supports selection/hover states.
 */

import React, { memo, useMemo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { FileText, Hash, AlignLeft, HardDrive, AlertTriangle, FileWarning } from 'lucide-react';
import type { Theme } from '../../types';
import type { DocumentNodeData } from './graphDataBuilder';

/**
 * Extended node data including theme and search state for styling
 */
export interface DocumentNodeProps extends NodeProps<
	DocumentNodeData & {
		theme: Theme;
		searchActive?: boolean;
		searchMatch?: boolean;
		brokenLinks?: string[];
		isLargeFile?: boolean;
		/** Dynamic character limit for description/preview (from settings) */
		previewCharLimit?: number;
	}
> {
	// Props come from React Flow - data, selected, etc.
}

/**
 * Maximum characters for title before truncation
 */
const MAX_TITLE_LENGTH = 40;

/**
 * Default maximum characters for description/preview before truncation
 * This can be overridden via the previewCharLimit setting
 */
const DEFAULT_PREVIEW_CHAR_LIMIT = 100;

/**
 * Truncate text with ellipsis if exceeding max length
 */
function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength).trim() + '...';
}

/**
 * Custom React Flow node for rendering markdown documents in the graph
 */
export const DocumentNode = memo(function DocumentNode({ data, selected }: DocumentNodeProps) {
	const {
		title,
		lineCount,
		wordCount,
		size,
		description,
		contentPreview,
		filePath,
		theme,
		searchActive,
		searchMatch,
		brokenLinks,
		isLargeFile,
		previewCharLimit,
	} = data;

	// Check if this document has broken links
	const hasBrokenLinks = brokenLinks && brokenLinks.length > 0;

	// Determine if this node should be dimmed (search active but not matching)
	const isDimmed = searchActive && !searchMatch;
	// Determine if this node should be highlighted (search active and matching)
	const isHighlighted = searchActive && searchMatch;

	// Memoize styles to prevent unnecessary recalculations
	const containerStyle = useMemo(
		() => ({
			backgroundColor: theme.colors.bgActivity,
			borderColor: isHighlighted
				? theme.colors.accent
				: selected
					? theme.colors.accent
					: theme.colors.border,
			borderWidth: isHighlighted ? 2 : selected ? 2 : 1,
			borderStyle: 'solid' as const,
			borderRadius: 8,
			padding: 12,
			minWidth: 200,
			maxWidth: 280,
			boxShadow: isHighlighted
				? `0 0 0 3px ${theme.colors.accent}40, 0 4px 12px ${theme.colors.accentDim}`
				: selected
					? `0 4px 12px ${theme.colors.accentDim}`
					: '0 2px 8px rgba(0, 0, 0, 0.15)',
			transition: 'all 0.2s ease',
			cursor: 'pointer',
			opacity: isDimmed ? 0.35 : 1,
			filter: isDimmed ? 'grayscale(50%)' : 'none',
		}),
		[theme.colors, selected, isDimmed, isHighlighted]
	);

	const titleStyle = useMemo(
		() => ({
			color: theme.colors.textMain,
			fontSize: 14,
			fontWeight: 600,
			marginBottom: 8,
			lineHeight: 1.3,
			overflow: 'hidden' as const,
			textOverflow: 'ellipsis' as const,
			whiteSpace: 'nowrap' as const,
		}),
		[theme.colors.textMain]
	);

	// Use description (frontmatter) or fall back to contentPreview (plaintext)
	const previewText = description || contentPreview;

	const statsRowStyle = useMemo(
		() => ({
			display: 'flex',
			gap: 12,
			marginBottom: previewText ? 8 : 0,
		}),
		[previewText]
	);

	const statItemStyle = useMemo(
		() => ({
			display: 'flex',
			alignItems: 'center' as const,
			gap: 4,
			color: theme.colors.textDim,
			fontSize: 11,
		}),
		[theme.colors.textDim]
	);

	const descriptionStyle = useMemo(
		() => ({
			color: theme.colors.textDim,
			fontSize: 12,
			lineHeight: 1.4,
			opacity: 0.85,
		}),
		[theme.colors.textDim]
	);

	const handleStyle = useMemo(
		() => ({
			backgroundColor: theme.colors.accent,
			borderColor: theme.colors.bgActivity,
			width: 8,
			height: 8,
		}),
		[theme.colors]
	);

	// Warning icon style for broken links indicator
	const warningIconStyle = useMemo(
		() => ({
			color: '#f59e0b', // Amber/warning color
			flexShrink: 0,
		}),
		[]
	);

	// Large file indicator style (blue info color)
	const largeFileIconStyle = useMemo(
		() => ({
			color: '#3b82f6', // Blue info color
			flexShrink: 0,
		}),
		[]
	);

	// Truncate title if too long
	const displayTitle = truncateText(title, MAX_TITLE_LENGTH);
	const isTitleTruncated = title.length > MAX_TITLE_LENGTH;

	// Use dynamic character limit from settings, falling back to default
	const charLimit = previewCharLimit ?? DEFAULT_PREVIEW_CHAR_LIMIT;

	// Truncate preview text (description or content preview) if too long
	const displayPreview = previewText ? truncateText(previewText, charLimit) : null;
	const isPreviewTruncated = previewText ? previewText.length > charLimit : false;

	// Build large file tooltip text
	const largeFileTooltip = isLargeFile
		? `\n\nℹ️ Large file (>1MB) - some links may not be detected`
		: '';

	// Build broken links tooltip text
	const brokenLinksTooltip = hasBrokenLinks
		? `\n\n⚠️ Broken links (${brokenLinks.length}):\n${brokenLinks.map((link) => `  • ${link}`).join('\n')}`
		: '';

	// Build tooltip: show full title if truncated, always show file path, plus status info
	const tooltipText = isTitleTruncated
		? `${title}\n\n${filePath}${largeFileTooltip}${brokenLinksTooltip}`
		: `${filePath}${largeFileTooltip}${brokenLinksTooltip}`;

	return (
		<div
			className={`document-node${isHighlighted ? ' search-highlight' : ''}`}
			style={containerStyle}
			title={tooltipText}
		>
			{/* Input handle (for incoming edges) - not connectable by user drag */}
			<Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />

			{/* Title with document icon and optional warning icon */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
				<FileText size={14} style={{ color: theme.colors.accent, flexShrink: 0 }} />
				<div style={titleStyle}>{displayTitle}</div>
				{hasBrokenLinks && (
					<span
						data-testid="broken-links-warning"
						aria-label={`${brokenLinks.length} broken link${brokenLinks.length > 1 ? 's' : ''}`}
						style={warningIconStyle}
					>
						<AlertTriangle size={14} />
					</span>
				)}
			</div>

			{/* Stats row: lines, words, size, and large file indicator */}
			<div style={statsRowStyle}>
				<div style={statItemStyle} title={`${lineCount} lines`}>
					<Hash size={10} />
					<span>{lineCount}</span>
				</div>
				<div style={statItemStyle} title={`${wordCount} words`}>
					<AlignLeft size={10} />
					<span>{wordCount}</span>
				</div>
				<div style={statItemStyle} title={size}>
					<HardDrive size={10} />
					<span>{size}</span>
				</div>
				{isLargeFile && (
					<span
						data-testid="large-file-indicator"
						style={largeFileIconStyle}
						title="Large file (>1MB) - content truncated for parsing"
					>
						<FileWarning size={12} />
					</span>
				)}
			</div>

			{/* Optional preview text (description or content preview) - shows tooltip with full text when truncated */}
			{displayPreview && (
				<div style={descriptionStyle} title={isPreviewTruncated ? previewText : undefined}>
					{displayPreview}
				</div>
			)}

			{/* Output handle (for outgoing edges) - not connectable by user drag */}
			<Handle type="source" position={Position.Bottom} style={handleStyle} isConnectable={false} />
		</div>
	);
});

export default DocumentNode;
