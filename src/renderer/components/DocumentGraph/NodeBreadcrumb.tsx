/**
 * NodeBreadcrumb - Displays a breadcrumb path to the currently selected node in the Document Graph.
 *
 * Shows the file path hierarchy for document nodes and domain for external link nodes.
 * Allows clicking on path segments to navigate to parent folders (future enhancement).
 *
 * Features:
 * - Displays full path broken into clickable segments
 * - Theme-aware styling
 * - Smooth transitions when selection changes
 * - Truncates long paths intelligently
 */

import React, { useMemo } from 'react';
import { ChevronRight, FileText, Globe, Home } from 'lucide-react';
import type { Theme } from '../../types';
import type { GraphNodeData, DocumentNodeData, ExternalLinkNodeData } from './graphDataBuilder';

/**
 * Props for the NodeBreadcrumb component
 */
export interface NodeBreadcrumbProps {
	/** Currently selected node data, or null if nothing selected */
	selectedNodeData: (GraphNodeData & { theme: Theme }) | null;
	/** Current theme */
	theme: Theme;
	/** Root path for display context */
	rootPath: string;
	/** Optional callback when a breadcrumb segment is clicked */
	onSegmentClick?: (segmentPath: string) => void;
}

/**
 * Parsed breadcrumb segment for rendering
 */
interface BreadcrumbSegment {
	/** Display label for this segment */
	label: string;
	/** Full path up to and including this segment */
	path: string;
	/** Whether this is the final segment (the selected item) */
	isFinal: boolean;
	/** Segment type for icon rendering */
	type: 'root' | 'folder' | 'file' | 'external';
}

/**
 * Parse a file path into breadcrumb segments
 */
function parsePathToSegments(filePath: string, rootPath: string): BreadcrumbSegment[] {
	const segments: BreadcrumbSegment[] = [];

	// Extract the root folder name from rootPath for display
	const rootName = rootPath.split('/').filter(Boolean).pop() || 'root';

	// Add root segment
	segments.push({
		label: rootName,
		path: '',
		isFinal: false,
		type: 'root',
	});

	// Split file path into parts
	const parts = filePath.split('/').filter(Boolean);

	// Add folder segments
	let currentPath = '';
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		const isLast = i === parts.length - 1;

		segments.push({
			label: isLast ? part.replace(/\.md$/i, '') : part,
			path: currentPath,
			isFinal: isLast,
			type: isLast ? 'file' : 'folder',
		});
	}

	return segments;
}

/**
 * Parse an external domain into breadcrumb segments
 */
function parseExternalToSegments(domain: string): BreadcrumbSegment[] {
	return [
		{
			label: 'External Links',
			path: '',
			isFinal: false,
			type: 'root',
		},
		{
			label: domain,
			path: domain,
			isFinal: true,
			type: 'external',
		},
	];
}

/**
 * Get icon for a breadcrumb segment type
 */
function SegmentIcon({ type, theme }: { type: BreadcrumbSegment['type']; theme: Theme }) {
	const iconStyle = { color: theme.colors.textDim, flexShrink: 0 };
	const iconSize = 12;

	switch (type) {
		case 'root':
			return <Home size={iconSize} style={iconStyle} />;
		case 'file':
			return <FileText size={iconSize} style={{ ...iconStyle, color: theme.colors.accent }} />;
		case 'external':
			return <Globe size={iconSize} style={{ ...iconStyle, color: theme.colors.accent }} />;
		default:
			return null;
	}
}

/**
 * NodeBreadcrumb component - displays path to selected node
 */
export function NodeBreadcrumb({
	selectedNodeData,
	theme,
	rootPath,
	onSegmentClick,
}: NodeBreadcrumbProps) {
	// Parse node data into breadcrumb segments
	const segments = useMemo(() => {
		if (!selectedNodeData) return [];

		if (selectedNodeData.nodeType === 'document') {
			const docData = selectedNodeData as DocumentNodeData & { theme: Theme };
			return parsePathToSegments(docData.filePath, rootPath);
		} else if (selectedNodeData.nodeType === 'external') {
			const extData = selectedNodeData as ExternalLinkNodeData & { theme: Theme };
			return parseExternalToSegments(extData.domain);
		}

		return [];
	}, [selectedNodeData, rootPath]);

	// Don't render if no selection
	if (!selectedNodeData || segments.length === 0) {
		return null;
	}

	const handleSegmentClick = (segment: BreadcrumbSegment) => {
		if (onSegmentClick && !segment.isFinal) {
			onSegmentClick(segment.path);
		}
	};

	return (
		<div
			className="node-breadcrumb flex items-center gap-1 px-3 py-2 text-xs overflow-x-auto"
			style={{
				backgroundColor: `${theme.colors.accent}08`,
				borderBottom: `1px solid ${theme.colors.border}`,
				minHeight: 36,
			}}
			role="navigation"
			aria-label="Selected node path"
		>
			{segments.map((segment, index) => (
				<React.Fragment key={`${segment.path}-${index}`}>
					{/* Separator (chevron) between segments */}
					{index > 0 && (
						<ChevronRight
							size={12}
							style={{ color: theme.colors.textDim, flexShrink: 0, opacity: 0.5 }}
							aria-hidden="true"
						/>
					)}

					{/* Segment button/label */}
					<button
						onClick={() => handleSegmentClick(segment)}
						disabled={segment.isFinal}
						className="flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors whitespace-nowrap"
						style={{
							color: segment.isFinal ? theme.colors.textMain : theme.colors.textDim,
							fontWeight: segment.isFinal ? 500 : 400,
							backgroundColor: 'transparent',
							cursor: segment.isFinal ? 'default' : 'pointer',
						}}
						onMouseEnter={(e) => {
							if (!segment.isFinal) {
								e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
							}
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = 'transparent';
						}}
						title={segment.isFinal ? segment.label : `Go to ${segment.label}`}
						aria-current={segment.isFinal ? 'page' : undefined}
					>
						<SegmentIcon type={segment.type} theme={theme} />
						<span>{segment.label}</span>
					</button>
				</React.Fragment>
			))}
		</div>
	);
}

export default NodeBreadcrumb;
