/**
 * ExternalLinkNode - Custom React Flow node for displaying external link domains.
 *
 * Renders a compact node showing:
 * - Domain name prominently (www. stripped)
 * - Link count badge if multiple links to same domain
 * - Globe icon to distinguish from document nodes
 * - Tooltip showing all full URLs on hover
 *
 * Uses dashed border and smaller size to visually differentiate from document nodes.
 * Styled with theme colors and supports selection/hover states.
 */

import React, { memo, useMemo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Globe, ExternalLink as ExternalLinkIcon } from 'lucide-react';
import type { Theme } from '../../types';
import type { ExternalLinkNodeData } from './graphDataBuilder';

/**
 * Extended node data including theme and search state for styling
 */
export interface ExternalLinkNodeProps extends NodeProps<
	ExternalLinkNodeData & {
		theme: Theme;
		searchActive?: boolean;
		searchMatch?: boolean;
	}
> {
	// Props come from React Flow - data, selected, etc.
}

/**
 * Custom React Flow node for rendering external link domains in the graph
 */
export const ExternalLinkNode = memo(function ExternalLinkNode({
	data,
	selected,
}: ExternalLinkNodeProps) {
	const { domain, linkCount, urls, theme, searchActive, searchMatch } = data;

	// Determine if this node should be dimmed (search active but not matching)
	const isDimmed = searchActive && !searchMatch;
	// Determine if this node should be highlighted (search active and matching)
	const isHighlighted = searchActive && searchMatch;

	// Build tooltip text showing all URLs
	const tooltipText = useMemo(() => {
		if (urls.length === 1) return urls[0];
		return urls.join('\n');
	}, [urls]);

	// Memoize styles to prevent unnecessary recalculations
	const containerStyle = useMemo(
		() => ({
			backgroundColor: theme.colors.bgSidebar,
			borderColor: isHighlighted
				? theme.colors.accent
				: selected
					? theme.colors.accent
					: theme.colors.border,
			borderWidth: isHighlighted ? 2 : selected ? 2 : 1,
			borderStyle: 'dashed' as const,
			borderRadius: 12,
			padding: 8,
			minWidth: 100,
			maxWidth: 160,
			boxShadow: isHighlighted
				? `0 0 0 3px ${theme.colors.accent}40, 0 4px 12px ${theme.colors.accentDim}`
				: selected
					? `0 4px 12px ${theme.colors.accentDim}`
					: '0 2px 6px rgba(0, 0, 0, 0.1)',
			transition: 'all 0.2s ease',
			cursor: 'pointer',
			display: 'flex' as const,
			alignItems: 'center' as const,
			justifyContent: 'center' as const,
			gap: 6,
			position: 'relative' as const,
			opacity: isDimmed ? 0.35 : 1,
			filter: isDimmed ? 'grayscale(50%)' : 'none',
		}),
		[theme.colors, selected, isDimmed, isHighlighted]
	);

	const domainStyle = useMemo(
		() => ({
			color: theme.colors.textMain,
			fontSize: 12,
			fontWeight: 500,
			lineHeight: 1.3,
			overflow: 'hidden' as const,
			textOverflow: 'ellipsis' as const,
			whiteSpace: 'nowrap' as const,
			maxWidth: 110,
		}),
		[theme.colors.textMain]
	);

	const badgeStyle = useMemo(
		() => ({
			backgroundColor: theme.colors.accent,
			color: theme.colors.accentForeground,
			fontSize: 10,
			fontWeight: 600,
			borderRadius: 8,
			padding: '2px 6px',
			minWidth: 18,
			textAlign: 'center' as const,
			position: 'absolute' as const,
			top: -6,
			right: -6,
		}),
		[theme.colors.accent, theme.colors.accentForeground]
	);

	const handleStyle = useMemo(
		() => ({
			backgroundColor: theme.colors.textDim,
			borderColor: theme.colors.bgSidebar,
			width: 6,
			height: 6,
		}),
		[theme.colors]
	);

	const iconStyle = useMemo(
		() => ({
			color: theme.colors.textDim,
			flexShrink: 0,
		}),
		[theme.colors.textDim]
	);

	return (
		<div
			className={`external-link-node${isHighlighted ? ' search-highlight' : ''}`}
			style={containerStyle}
			title={tooltipText}
		>
			{/* Input handle (for incoming edges from documents) - not connectable by user drag */}
			<Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />

			{/* Globe icon */}
			<Globe size={14} style={iconStyle} />

			{/* Domain name */}
			<div style={domainStyle}>{domain}</div>

			{/* External link indicator icon */}
			<ExternalLinkIcon size={10} style={iconStyle} />

			{/* Link count badge (only show if more than 1) */}
			{linkCount > 1 && (
				<div style={badgeStyle} title={`${linkCount} links to this domain`}>
					{linkCount}
				</div>
			)}

			{/* No output handle - external links are leaf nodes */}
		</div>
	);
});

export default ExternalLinkNode;
