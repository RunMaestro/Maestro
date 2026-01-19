/**
 * CollapsibleJsonViewer - A beautiful collapsible JSON tree viewer
 *
 * Features:
 * - Expandable/collapsible nodes for objects and arrays
 * - Syntax highlighting for different value types
 * - Copy-to-clipboard for values
 * - Theme-aware styling
 */

import React, { useState, useCallback, memo } from 'react';
import { ChevronRight, ChevronDown, Copy, Check } from 'lucide-react';
import type { Theme } from '../types';

interface CollapsibleJsonViewerProps {
	data: unknown;
	theme: Theme;
	/** Initial expansion level (default: 2) */
	initialExpandLevel?: number;
	/** Maximum string length before truncation (default: 100) */
	maxStringLength?: number;
	/** Root label (optional) */
	rootLabel?: string;
}

interface JsonNodeProps {
	keyName: string | null;
	value: unknown;
	theme: Theme;
	depth: number;
	initialExpandLevel: number;
	maxStringLength: number;
	isLast: boolean;
}

/**
 * Get the type color for a JSON value
 */
function getValueColor(value: unknown, theme: Theme): string {
	if (value === null) return theme.colors.warning;
	if (value === undefined) return theme.colors.textDim;
	switch (typeof value) {
		case 'string':
			return theme.colors.success;
		case 'number':
			return theme.colors.accent;
		case 'boolean':
			return theme.colors.warning;
		default:
			return theme.colors.textMain;
	}
}

/**
 * Format a value for display
 */
function formatValue(value: unknown, maxLength: number): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';

	switch (typeof value) {
		case 'string': {
			const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			if (escaped.length > maxLength) {
				return `"${escaped.substring(0, maxLength)}..."`;
			}
			return `"${escaped}"`;
		}
		case 'number':
		case 'boolean':
			return String(value);
		default:
			return String(value);
	}
}

/**
 * Check if a value is expandable (object or array)
 */
function isExpandable(value: unknown): value is object {
	return value !== null && typeof value === 'object';
}

/**
 * Get preview text for collapsed objects/arrays
 */
function getPreview(value: unknown): string {
	if (Array.isArray(value)) {
		return `Array(${value.length})`;
	}
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length <= 3) {
			return `{ ${keys.join(', ')} }`;
		}
		return `{ ${keys.slice(0, 3).join(', ')}, ... }`;
	}
	return '';
}

/**
 * Copy button component with feedback
 */
const CopyButton = memo(({ value, theme }: { value: unknown; theme: Theme }) => {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			try {
				const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			} catch (err) {
				console.error('Failed to copy:', err);
			}
		},
		[value]
	);

	return (
		<button
			onClick={handleCopy}
			className="ml-2 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity"
			style={{ color: theme.colors.textDim }}
			title="Copy value"
		>
			{copied ? (
				<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
			) : (
				<Copy className="w-3 h-3" />
			)}
		</button>
	);
});

CopyButton.displayName = 'CopyButton';

/**
 * Individual JSON node component
 */
const JsonNode = memo(
	({
		keyName,
		value,
		theme,
		depth,
		initialExpandLevel,
		maxStringLength,
		isLast,
	}: JsonNodeProps) => {
		const [isExpanded, setIsExpanded] = useState(depth < initialExpandLevel);
		const expandable = isExpandable(value);
		const indent = depth * 16;

		const toggleExpand = useCallback(() => {
			if (expandable) {
				setIsExpanded((prev) => !prev);
			}
		}, [expandable]);

		// Render primitive value
		if (!expandable) {
			return (
				<div className="group flex items-center py-0.5" style={{ paddingLeft: indent }}>
					{keyName !== null && (
						<>
							<span style={{ color: theme.colors.accent }}>{`"${keyName}"`}</span>
							<span style={{ color: theme.colors.textDim }}>: </span>
						</>
					)}
					<span style={{ color: getValueColor(value, theme) }}>
						{formatValue(value, maxStringLength)}
					</span>
					{!isLast && <span style={{ color: theme.colors.textDim }}>,</span>}
					<CopyButton value={value} theme={theme} />
				</div>
			);
		}

		// Render expandable value (object or array)
		const isArray = Array.isArray(value);
		const entries = isArray
			? (value as unknown[]).map((v, i) => [String(i), v] as const)
			: Object.entries(value as Record<string, unknown>);
		const isEmpty = entries.length === 0;

		return (
			<div>
				{/* Header row with expand toggle */}
				<div
					className="group flex items-center py-0.5 cursor-pointer hover:bg-white/5 rounded"
					style={{ paddingLeft: indent }}
					onClick={toggleExpand}
				>
					{/* Expand/collapse icon */}
					<span
						className="w-4 h-4 flex items-center justify-center mr-1"
						style={{ color: theme.colors.textDim }}
					>
						{!isEmpty &&
							(isExpanded ? (
								<ChevronDown className="w-3 h-3" />
							) : (
								<ChevronRight className="w-3 h-3" />
							))}
					</span>

					{/* Key name */}
					{keyName !== null && (
						<>
							<span style={{ color: theme.colors.accent }}>{`"${keyName}"`}</span>
							<span style={{ color: theme.colors.textDim }}>: </span>
						</>
					)}

					{/* Opening bracket */}
					<span style={{ color: theme.colors.textMain }}>{isArray ? '[' : '{'}</span>

					{/* Preview or closing bracket for empty/collapsed */}
					{!isExpanded && (
						<>
							{!isEmpty && (
								<span className="mx-1 text-xs" style={{ color: theme.colors.textDim }}>
									{getPreview(value)}
								</span>
							)}
							<span style={{ color: theme.colors.textMain }}>{isArray ? ']' : '}'}</span>
							{!isLast && <span style={{ color: theme.colors.textDim }}>,</span>}
						</>
					)}

					<CopyButton value={value} theme={theme} />
				</div>

				{/* Children (when expanded) */}
				{isExpanded && !isEmpty && (
					<>
						{entries.map(([key, val], idx) => (
							<JsonNode
								key={key}
								keyName={isArray ? null : key}
								value={val}
								theme={theme}
								depth={depth + 1}
								initialExpandLevel={initialExpandLevel}
								maxStringLength={maxStringLength}
								isLast={idx === entries.length - 1}
							/>
						))}
						{/* Closing bracket */}
						<div style={{ paddingLeft: indent }}>
							<span style={{ color: theme.colors.textMain }}>{isArray ? ']' : '}'}</span>
							{!isLast && <span style={{ color: theme.colors.textDim }}>,</span>}
						</div>
					</>
				)}

				{/* Closing bracket for expanded empty */}
				{isExpanded && isEmpty && (
					<div style={{ paddingLeft: indent }}>
						<span style={{ color: theme.colors.textMain }}>{isArray ? ']' : '}'}</span>
						{!isLast && <span style={{ color: theme.colors.textDim }}>,</span>}
					</div>
				)}
			</div>
		);
	}
);

JsonNode.displayName = 'JsonNode';

/**
 * Main CollapsibleJsonViewer component
 */
export const CollapsibleJsonViewer = memo(
	({
		data,
		theme,
		initialExpandLevel = 2,
		maxStringLength = 100,
		rootLabel,
	}: CollapsibleJsonViewerProps) => {
		return (
			<div
				className="font-mono text-xs p-3 rounded-lg overflow-x-auto scrollbar-thin"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<JsonNode
					keyName={rootLabel || null}
					value={data}
					theme={theme}
					depth={0}
					initialExpandLevel={initialExpandLevel}
					maxStringLength={maxStringLength}
					isLast={true}
				/>
			</div>
		);
	}
);

CollapsibleJsonViewer.displayName = 'CollapsibleJsonViewer';

export default CollapsibleJsonViewer;
