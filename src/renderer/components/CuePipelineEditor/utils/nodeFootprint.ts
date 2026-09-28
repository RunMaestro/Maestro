/**
 * The footprint of a pipeline node, and of the card drawn around a whole
 * pipeline.
 *
 * Three places need to know how much room a node actually occupies: the
 * renderer that sizes the translucent group card (`convertToReactFlowNodes`),
 * the drag handler that keeps two dropped pipelines from landing on each other
 * (`resolveNonOverlappingPipelineOffset`), and the masonry packer that deals
 * cards into columns (`arrangePipelineGroups`). They used to answer the
 * question differently: the packer sized a node from its text, while the
 * renderer and the overlap test used a flat `NODE_BG_WIDTH`. A node whose name
 * is long - a shell command named after the script it runs - therefore drew
 * outside the card that was supposed to contain it, because the card had been
 * measured as if the node were 320px wide.
 *
 * So the answer lives here, once, and every caller asks the same function.
 *
 * Two things make a node bigger than the box ReactFlow positions:
 *
 * - Its width is text-driven (`width: max-content`), so it is only known for
 *   certain after the DOM measures it. `estimateNodeWidth` derives it from the
 *   same text the node components render, erring WIDE on purpose.
 * - Its chrome hangs OUTSIDE that box: connection handles sit centred on the
 *   left and right borders, and the badges ("in: <agent>", the instance count,
 *   the enabled dot) are pinned a few pixels past a corner. None of that is in
 *   the node's own rect, but all of it is visible, so a card that stops at the
 *   rect clips it.
 */

import type {
	AgentNodeData,
	CommandNodeData,
	PipelineNode,
	TriggerNodeData,
} from '../../../../shared/cue-pipeline-types';
import {
	getTriggerConfigSummary,
	summarizeCommandNode,
} from '../../../../shared/cue-pipeline-summary';

// Canonical node footprint: the box that always encloses a rendered node of
// ordinary width. Real nodes are a touch shorter (60px for a trigger, 80px for
// the rest), so the height always over-covers; the width is a FLOOR, not a
// maximum, and `estimateNodeWidth` grows past it for long labels.
export const NODE_BG_WIDTH = 320;
export const NODE_BG_HEIGHT = 100;
/** Breathing room between the outermost node footprint and the card border. */
export const PIPELINE_GROUP_PADDING = 28;

/**
 * How far a node's chrome reaches beyond the node's own rect. The widest
 * offender is a connection handle: 16px across, pinned at `-8`, so it is
 * centred on the border with 8px outside, plus the 2px `boxShadow` ring that
 * draws around it. Every badge on every node type sits within that same 10px
 * (the deepest is pinned at `-8` with a 1px border), so one symmetric
 * allowance covers all four sides.
 *
 * This is deliberately NOT folded into `PIPELINE_GROUP_PADDING`: the padding is
 * a visual choice someone may want to tune, and tuning it must not be able to
 * clip the handles.
 */
export const NODE_CHROME_OVERHANG = 10;

// ─── Width estimation (layout without a DOM) ────────────────────────────────
// Nodes render at `width: max-content`, so their true width is text-driven and
// only known after ReactFlow measures the DOM. Automatic layout passes (load
// heal, structural-change heal) run BEFORE or WITHOUT measurement, so they
// estimate from the same text the node components render. The estimate is
// deliberately floored at NODE_BG_WIDTH: short labels keep today's uniform
// column pitch (uniformity reads as a grid), while long labels - a shell
// command's `$ …` summary, a long agent name - widen their column so the next
// one clears them instead of overlapping (the naive fixed-pitch overlap bug).
// Estimation errs WIDE on purpose: an overestimate costs a few px of gutter,
// an underestimate stacks one node on top of another.

// Approximate advance width per character as a fraction of font size. The app
// themes render nodes in monospace-leaning faces (~0.6em); 0.66 adds the
// err-wide margin.
const CHAR_EM = 0.66;
// Fixed horizontal chrome shared by content nodes: 32px drag rail + content
// padding + trailing icon column (gear / play / handles) + borders.
const NODE_CHROME = 110;

// CHAR_EM alone is a guess about a font the USER chooses. Pick a wide UI face in
// Typography settings and every label renders wider than the guess, which the
// load heal (the one pass that has no measurements to fall back on) turns into
// nodes drawn on top of each other on the very first paint. When a DOM is around
// we can do better than guess: measure the real advance width with a canvas
// context in the app's own font. Falls back to CHAR_EM outside the browser
// (unit tests, jsdom without canvas), and the two are unioned so the estimate
// can only ever get WIDER - an overestimate costs a few px of gutter, an
// underestimate stacks one node on another.
let textCtx: CanvasRenderingContext2D | null | undefined;
let cachedFontFamily = '';
let cachedFontFamilyAt = 0;
/** Re-read the app font this often; it changes only when the user edits
 *  Typography settings, and getComputedStyle forces a style recalc. */
const FONT_FAMILY_TTL_MS = 2000;

function measuringContext(): CanvasRenderingContext2D | null {
	if (textCtx !== undefined) return textCtx;
	textCtx = null;
	try {
		if (typeof document !== 'undefined') {
			textCtx = document.createElement('canvas').getContext('2d');
		}
	} catch {
		// jsdom without a canvas backend: stay on the CHAR_EM approximation.
		textCtx = null;
	}
	return textCtx;
}

function appFontFamily(): string {
	const now = Date.now();
	if (cachedFontFamily && now - cachedFontFamilyAt < FONT_FAMILY_TTL_MS) return cachedFontFamily;
	try {
		cachedFontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
	} catch {
		cachedFontFamily = 'sans-serif';
	}
	cachedFontFamilyAt = now;
	return cachedFontFamily;
}

function textPx(text: string | undefined, fontSize: number, fontWeight = 400): number {
	const approx = (text ?? '').length * fontSize * CHAR_EM;
	if (!text) return approx;
	const ctx = measuringContext();
	if (!ctx) return approx;
	ctx.font = `${fontWeight} ${fontSize}px ${appFontFamily()}`;
	return Math.max(approx, ctx.measureText(text).width);
}

/**
 * Estimate a node's rendered width from its data. Used as the floor for every
 * layout pass (measured widths still win when they're larger) so automatic
 * re-layouts are deterministic: the same node data always yields the same
 * estimate, DOM or no DOM.
 */
export function estimateNodeWidth(node: PipelineNode): number {
	let content = 0;
	switch (node.type) {
		case 'trigger': {
			const data = node.data as TriggerNodeData;
			// 14px icon + 6px gap beside the 12px label; 10px config summary below.
			content = Math.max(
				20 + textPx(data.label, 12, 600),
				textPx(getTriggerConfigSummary(data), 10)
			);
			break;
		}
		case 'agent': {
			const data = node.data as AgentNodeData;
			// 13px semibold title; "(N)" instance suffix adds up to ~4 chars.
			content = Math.max(textPx(`${data.sessionName} (0)`, 13, 600), textPx(data.toolType, 11));
			break;
		}
		case 'command': {
			const data = node.data as CommandNodeData;
			// 12px icon + gap + 13px name + mode badge (~5 chars at 9px + padding);
			// 11px monospace summary below (summarizeCommandNode caps it at 38 chars).
			content = Math.max(
				24 + textPx(data.name, 13, 600) + 46,
				textPx(summarizeCommandNode(data), 11)
			);
			break;
		}
		case 'error':
			// ErrorNode caps itself at maxWidth: 320.
			return NODE_BG_WIDTH;
	}
	return Math.max(NODE_BG_WIDTH, Math.ceil(content + NODE_CHROME));
}
/**
 * A node's horizontal footprint: its measured width when the DOM has supplied
 * one, its estimate otherwise, never below the canonical floor. Measurement and
 * estimate are unioned rather than preferred one over the other, so the answer
 * can only ever get WIDER - an overestimate costs a few pixels of gutter, an
 * underestimate draws one node on top of another.
 */
export function nodeFootprintWidth(node: PipelineNode, nodeWidths?: Map<string, number>): number {
	return Math.max(NODE_BG_WIDTH, nodeWidths?.get(node.id) ?? 0, estimateNodeWidth(node));
}

/** The on-screen rect of a pipeline's group card. */
export interface PipelineCardBounds {
	/** Top-left of the card itself, padding and chrome allowance included. */
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The card that encloses a pipeline: the union of every node's footprint, grown
 * by the chrome that hangs outside those footprints and then by the group
 * padding. Returns null for a pipeline with no nodes - there is no box to draw.
 *
 * `offset` is the pipeline's All-Pipelines-view displacement; pass it to get a
 * rect in screen space, omit it for canonical space.
 */
export function pipelineCardBounds(
	nodes: PipelineNode[],
	opts?: {
		offset?: { x: number; y: number };
		nodeWidths?: Map<string, number>;
	}
): PipelineCardBounds | null {
	if (nodes.length === 0) return null;
	const offsetX = opts?.offset?.x ?? 0;
	const offsetY = opts?.offset?.y ?? 0;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of nodes) {
		const x = node.position.x + offsetX;
		const y = node.position.y + offsetY;
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + nodeFootprintWidth(node, opts?.nodeWidths));
		maxY = Math.max(maxY, y + NODE_BG_HEIGHT);
	}

	const inset = PIPELINE_GROUP_PADDING + NODE_CHROME_OVERHANG;
	return {
		x: minX - inset,
		y: minY - inset,
		width: maxX - minX + 2 * inset,
		height: maxY - minY + 2 * inset,
	};
}
