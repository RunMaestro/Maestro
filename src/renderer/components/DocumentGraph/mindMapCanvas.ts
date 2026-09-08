/**
 * Canvas painting for the Document Graph mind map.
 *
 * Node cards, pills, icons, links, and the open-file icon box live here so the
 * painted glyph and the click hit test cannot drift. Zoom, pan, and pointer
 * handling stay in MindMap.
 */

import type { Theme } from '../../types';
import type { MindMapNode } from './MindMap';
import {
	NODE_PILL_CHAR_WIDTH,
	NODE_PILL_CHROME_WIDTH,
	NODE_HEADER_HEIGHT,
	NODE_SUBHEADER_HEIGHT,
	DESC_LINE_HEIGHT,
	CHARS_PER_LINE,
	UNGROUPED_LOBE_ID,
} from './mindMapLayouts';
import { isPreviewOff } from './previewCharLimit';
import { clusterColor } from './clusterColors';

/** Node corner radius */
export const NODE_BORDER_RADIUS = 12;
/** Open icon size */
const OPEN_ICON_SIZE = 14;
/** Open icon padding from node edge */
const OPEN_ICON_PADDING = 8;

/**
 * The graph's historical font stack, and the default when the Document Graph
 * font setting is unset. Kept so an untouched install renders unchanged.
 */
const DEFAULT_GRAPH_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Where the open-file icon sits inside a document node, in canvas space.
 *
 * Shared by the renderer and the click hit test so the two cannot drift: the
 * icon is centred in the title band, which is the header strip on a full card
 * and the whole node once previews are off and the node is a pill.
 */
export function openIconRect(
	node: Pick<MindMapNode, 'x' | 'y' | 'width' | 'height'>,
	previewCharLimit: number
): { x: number; y: number; size: number } {
	const bandHeight = isPreviewOff(previewCharLimit)
		? node.height
		: Math.min(node.height, NODE_HEADER_HEIGHT);
	return {
		x: node.x + node.width / 2 - OPEN_ICON_SIZE - OPEN_ICON_PADDING,
		y: node.y - node.height / 2 + (bandHeight - OPEN_ICON_SIZE) / 2,
		size: OPEN_ICON_SIZE,
	};
}

/**
 * Truncate text to a maximum length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 3) + '...';
}

/**
 * Draw a rounded rectangle path
 */
export function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number
): void {
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + width - radius, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
	ctx.lineTo(x + width, y + height - radius);
	ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
	ctx.lineTo(x + radius, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
}

/**
 * Draw an "external link" icon (square with arrow)
 */
function drawOpenIcon(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	color: string
): void {
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.5;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	const padding = size * 0.15;
	const boxSize = size - padding * 2;

	// Draw square
	ctx.beginPath();
	ctx.rect(x + padding, y + padding + boxSize * 0.25, boxSize * 0.75, boxSize * 0.75);
	ctx.stroke();

	// Draw arrow pointing up-right
	const arrowStart = { x: x + padding + boxSize * 0.35, y: y + padding + boxSize * 0.65 };
	const arrowEnd = { x: x + padding + boxSize, y: y + padding };

	ctx.beginPath();
	ctx.moveTo(arrowStart.x, arrowStart.y);
	ctx.lineTo(arrowEnd.x, arrowEnd.y);
	ctx.stroke();

	// Arrow head
	ctx.beginPath();
	ctx.moveTo(arrowEnd.x - boxSize * 0.3, arrowEnd.y);
	ctx.lineTo(arrowEnd.x, arrowEnd.y);
	ctx.lineTo(arrowEnd.x, arrowEnd.y + boxSize * 0.3);
	ctx.stroke();
}

/**
 * Draw a folder icon
 */
function drawFolderIcon(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	color: string
): void {
	ctx.fillStyle = color;
	ctx.strokeStyle = color;
	ctx.lineWidth = 1;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	const w = size;
	const h = size * 0.75;
	const tabWidth = w * 0.35;
	const tabHeight = h * 0.2;
	const cornerRadius = 1.5;

	// Draw folder shape
	ctx.beginPath();
	// Start at bottom left
	ctx.moveTo(x + cornerRadius, y + h);
	// Bottom edge
	ctx.lineTo(x + w - cornerRadius, y + h);
	// Bottom right corner
	ctx.quadraticCurveTo(x + w, y + h, x + w, y + h - cornerRadius);
	// Right edge
	ctx.lineTo(x + w, y + tabHeight + cornerRadius);
	// Top right corner
	ctx.quadraticCurveTo(x + w, y + tabHeight, x + w - cornerRadius, y + tabHeight);
	// Top edge (right of tab)
	ctx.lineTo(x + tabWidth + cornerRadius, y + tabHeight);
	// Tab right corner
	ctx.lineTo(x + tabWidth, y + cornerRadius);
	// Tab top corner
	ctx.quadraticCurveTo(x + tabWidth, y, x + tabWidth - cornerRadius, y);
	// Tab top edge
	ctx.lineTo(x + cornerRadius, y);
	// Top left corner
	ctx.quadraticCurveTo(x, y, x, y + cornerRadius);
	// Left edge
	ctx.lineTo(x, y + h - cornerRadius);
	// Bottom left corner
	ctx.quadraticCurveTo(x, y + h, x + cornerRadius, y + h);
	ctx.closePath();
	ctx.fill();
}

/**
 * Draw a bezier curve link between two nodes
 */
export function drawLink(
	ctx: CanvasRenderingContext2D,
	sourceX: number,
	sourceY: number,
	targetX: number,
	targetY: number,
	color: string,
	lineWidth: number,
	isDashed: boolean = false
): void {
	ctx.strokeStyle = color;
	ctx.lineWidth = lineWidth;

	if (isDashed) {
		ctx.setLineDash([6, 4]);
	} else {
		ctx.setLineDash([]);
	}

	// Calculate control points for smooth bezier curve
	const dx = Math.abs(targetX - sourceX);
	const controlOffset = Math.min(dx * 0.5, 100);

	ctx.beginPath();
	ctx.moveTo(sourceX, sourceY);

	// Use quadratic bezier for horizontal-ish connections
	if (Math.abs(sourceY - targetY) < 20) {
		ctx.lineTo(targetX, targetY);
	} else {
		// Use cubic bezier for better curves
		const cp1x = sourceX + (sourceX < targetX ? controlOffset : -controlOffset);
		const cp2x = targetX + (targetX < sourceX ? controlOffset : -controlOffset);
		ctx.bezierCurveTo(cp1x, sourceY, cp2x, targetY, targetX, targetY);
	}

	ctx.stroke();
	ctx.setLineDash([]);
}

/**
 * Wrap text to fit within a maximum width, returning lines
 */
function wrapText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxLines: number = 2
): string[] {
	const words = text.split(' ');
	const lines: string[] = [];
	let currentLine = '';

	for (const word of words) {
		const testLine = currentLine ? `${currentLine} ${word}` : word;
		const metrics = ctx.measureText(testLine);

		if (metrics.width > maxWidth && currentLine) {
			lines.push(currentLine);
			currentLine = word;
			if (lines.length >= maxLines) break;
		} else {
			currentLine = testLine;
		}
	}

	if (currentLine && lines.length < maxLines) {
		lines.push(currentLine);
	}

	// If we hit maxLines and there's more text, add ellipsis to last line
	if (lines.length === maxLines && currentLine && !lines.includes(currentLine)) {
		const lastLine = lines[maxLines - 1];
		lines[maxLines - 1] = lastLine.slice(0, Math.max(0, lastLine.length - 3)) + '...';
	}

	return lines;
}

/**
 * Render a document node on the canvas with themed header
 */
export function renderDocumentNode(
	ctx: CanvasRenderingContext2D,
	node: MindMapNode,
	theme: Theme,
	isHovered: boolean,
	matchesSearch: boolean,
	searchActive: boolean,
	previewCharLimit: number = 100,
	// The Document Graph font setting. Canvas needs a real family string - it
	// cannot read a CSS variable - so it is threaded in rather than inherited.
	// The historical stack is the default, so an unset setting renders exactly
	// as before.
	fontFamily: string = DEFAULT_GRAPH_FONT
): void {
	const {
		x,
		y,
		width,
		height,
		label,
		description,
		contentPreview,
		filePath,
		isSelected,
		isFocused,
		isOrphan,
		clusterId,
		clusterIndex,
	} = node;
	// Use description (frontmatter) or fall back to contentPreview (plaintext)
	const previewText = description || contentPreview;

	// Calculate opacity based on search state
	const alpha = searchActive && !matchesSearch ? 0.3 : 1;
	ctx.globalAlpha = alpha;

	const nodeLeft = x - width / 2;
	const nodeTop = y - height / 2;

	// Header fill, shared by the full card and the pill form below.
	const headerFill =
		isFocused || isSelected
			? theme.colors.accent
			: isHovered
				? `${theme.colors.accent}CC`
				: `${theme.colors.accent}99`;
	// A node in a lobe takes its lobe's colour on the border, so membership is
	// readable without tracing the hull back - which is exactly what a node
	// near two hull edges makes hard. Selection, focus, and the orphan warning
	// all outrank it: those say something about THIS node, and the cluster tint
	// is only saying which group it is in.
	// The ungrouped pile is deliberately left untinted: it is not a group, and
	// giving it a colour of its own would present "these belong to nothing" as
	// just another finding.
	const clusterStroke =
		clusterIndex !== undefined && clusterId !== UNGROUPED_LOBE_ID
			? clusterColor(theme.colors.accent, clusterIndex)
			: null;
	const borderStroke =
		isFocused || isSelected
			? theme.colors.accent
			: isOrphan
				? theme.colors.warning
				: isHovered
					? `${theme.colors.accent}80`
					: (clusterStroke ?? theme.colors.border);

	// Previews off: the node is a filename pill. No body box, no folder
	// sub-header, no preview text - just enough to read the graph's shape.
	if (isPreviewOff(previewCharLimit)) {
		const radius = height / 2;
		ctx.fillStyle = headerFill;
		roundRect(ctx, nodeLeft, nodeTop, width, height, radius);
		ctx.fill();

		ctx.strokeStyle = borderStroke;
		ctx.lineWidth = isFocused || isSelected ? 2 : 1;
		if (isOrphan && !isFocused && !isSelected) ctx.setLineDash([6, 4]);
		roundRect(ctx, nodeLeft, nodeTop, width, height, radius);
		ctx.stroke();
		ctx.setLineDash([]);

		ctx.fillStyle = '#FFFFFF';
		ctx.font = `600 12px ${fontFamily}`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		const pillTitleWidth = width - NODE_PILL_CHROME_WIDTH;
		ctx.fillText(
			truncateText(label, Math.floor(pillTitleWidth / NODE_PILL_CHAR_WIDTH)),
			nodeLeft + 14,
			nodeTop + height / 2
		);

		const pillIcon = openIconRect(node, previewCharLimit);
		drawOpenIcon(
			ctx,
			pillIcon.x,
			pillIcon.y,
			pillIcon.size,
			isHovered ? '#FFFFFF' : 'rgba(255,255,255,0.7)'
		);

		ctx.globalAlpha = 1;
		return;
	}

	// Draw body background first
	const bodyColor = theme.colors.bgActivity;
	ctx.fillStyle = bodyColor;
	roundRect(ctx, nodeLeft, nodeTop, width, height, NODE_BORDER_RADIUS);
	ctx.fill();

	// Draw header background (accent colored)
	ctx.fillStyle = headerFill;

	// Draw header with rounded top corners only
	ctx.beginPath();
	ctx.moveTo(nodeLeft + NODE_BORDER_RADIUS, nodeTop);
	ctx.lineTo(nodeLeft + width - NODE_BORDER_RADIUS, nodeTop);
	ctx.quadraticCurveTo(nodeLeft + width, nodeTop, nodeLeft + width, nodeTop + NODE_BORDER_RADIUS);
	ctx.lineTo(nodeLeft + width, nodeTop + NODE_HEADER_HEIGHT);
	ctx.lineTo(nodeLeft, nodeTop + NODE_HEADER_HEIGHT);
	ctx.lineTo(nodeLeft, nodeTop + NODE_BORDER_RADIUS);
	ctx.quadraticCurveTo(nodeLeft, nodeTop, nodeLeft + NODE_BORDER_RADIUS, nodeTop);
	ctx.closePath();
	ctx.fill();

	// Draw sub-header background (lighter accent) for folder path
	const subHeaderColor =
		isFocused || isSelected ? `${theme.colors.accent}40` : `${theme.colors.accent}25`;
	ctx.fillStyle = subHeaderColor;
	ctx.fillRect(nodeLeft, nodeTop + NODE_HEADER_HEIGHT, width, NODE_SUBHEADER_HEIGHT);

	// Draw border around entire node. An orphan gets a dashed warning-colored
	// border: it sits in its own band already, but the band alone reads as "a
	// row at the bottom" rather than "these connect to nothing", and the two
	// must stay distinguishable once the user pans away from the layout.
	ctx.strokeStyle = borderStroke;
	ctx.lineWidth = isFocused || isSelected ? 2 : 1;
	if (isOrphan && !isFocused && !isSelected) ctx.setLineDash([6, 4]);
	roundRect(ctx, nodeLeft, nodeTop, width, height, NODE_BORDER_RADIUS);
	ctx.stroke();
	ctx.setLineDash([]);

	// Title text (in header, white or light colored for contrast)
	ctx.fillStyle = '#FFFFFF';
	ctx.font = `600 12px ${fontFamily}`;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	const maxTitleWidth = width - OPEN_ICON_SIZE - OPEN_ICON_PADDING * 3 - 12;
	const titleText = truncateText(label, Math.floor(maxTitleWidth / 7)); // Approximate char width
	ctx.fillText(titleText, nodeLeft + 12, nodeTop + NODE_HEADER_HEIGHT / 2);

	// Open file icon (in header, right side)
	const headerIcon = openIconRect(node, previewCharLimit);
	drawOpenIcon(
		ctx,
		headerIcon.x,
		headerIcon.y,
		headerIcon.size,
		isHovered ? '#FFFFFF' : 'rgba(255,255,255,0.7)'
	);

	// Sub-header: folder icon and path
	const subHeaderY = nodeTop + NODE_HEADER_HEIGHT;
	const folderIconSize = 12;
	const folderIconX = nodeLeft + 10;
	const folderIconY = subHeaderY + (NODE_SUBHEADER_HEIGHT - folderIconSize * 0.75) / 2;
	const folderColor = isFocused || isSelected ? theme.colors.accent : `${theme.colors.accent}CC`;
	drawFolderIcon(ctx, folderIconX, folderIconY, folderIconSize, folderColor);

	// Folder path text (extract directory from filePath)
	if (filePath) {
		const pathParts = filePath.split('/');
		pathParts.pop(); // Remove filename
		const folderPath = pathParts.length > 0 ? pathParts.join('/') : './';

		ctx.fillStyle = theme.colors.textDim;
		ctx.font = `10px ${fontFamily}`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';

		const maxPathWidth = width - folderIconSize - 24;
		const pathText = truncateText(folderPath || './', Math.floor(maxPathWidth / 5.5));
		ctx.fillText(
			pathText,
			folderIconX + folderIconSize + 6,
			subHeaderY + NODE_SUBHEADER_HEIGHT / 2
		);
	}

	// Preview text (description or content preview, in body, if present)
	if (previewText) {
		ctx.fillStyle = theme.colors.textDim;
		ctx.font = `11px ${fontFamily}`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';

		const bodyPadding = 10;
		const maxDescWidth = width - bodyPadding * 2;
		// Truncate preview text based on character limit before wrapping
		const truncatedPreview =
			previewText.length > previewCharLimit
				? previewText.slice(0, previewCharLimit).trim() + '...'
				: previewText;
		// Calculate max lines based on character limit (same formula as calculateNodeHeight)
		const estimatedMaxLines = Math.max(
			2,
			Math.min(Math.ceil(previewCharLimit / CHARS_PER_LINE), 15)
		);
		const descLines = wrapText(ctx, truncatedPreview, maxDescWidth, estimatedMaxLines);

		const lineHeight = DESC_LINE_HEIGHT;
		const descStartY = nodeTop + NODE_HEADER_HEIGHT + NODE_SUBHEADER_HEIGHT + bodyPadding;

		descLines.forEach((line, i) => {
			ctx.fillText(line, nodeLeft + bodyPadding, descStartY + i * lineHeight);
		});
	}

	ctx.globalAlpha = 1;
}

/**
 * Render an external node on the canvas
 */
export function renderExternalNode(
	ctx: CanvasRenderingContext2D,
	node: MindMapNode,
	theme: Theme,
	isHovered: boolean,
	matchesSearch: boolean,
	searchActive: boolean,
	fontFamily: string = DEFAULT_GRAPH_FONT
): void {
	const { x, y, width, height, domain, isSelected, isFocused } = node;

	// Calculate opacity based on search state
	const alpha = searchActive && !matchesSearch ? 0.3 : 1;

	ctx.globalAlpha = alpha;

	// Pill background
	ctx.fillStyle = theme.colors.bgMain;
	roundRect(ctx, x - width / 2, y - height / 2, width, height, height / 2);
	ctx.fill();

	// Border
	ctx.strokeStyle =
		isFocused || isSelected
			? theme.colors.accent
			: isHovered
				? theme.colors.textDim
				: `${theme.colors.border}80`;
	ctx.lineWidth = 1;
	roundRect(ctx, x - width / 2, y - height / 2, width, height, height / 2);
	ctx.stroke();

	// Domain text
	ctx.fillStyle = theme.colors.textDim;
	ctx.font = `11px ${fontFamily}`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(truncateText(domain || '', 18), x, y);

	ctx.globalAlpha = 1;
}
