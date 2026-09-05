import { useLayoutEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import type { Theme } from '../types';
import { logger } from '../utils/logger';
import { normalizeMermaidSource } from '../../shared/mermaidSource';
import {
	adjustBrightness,
	blendColors,
	hexToRgb,
	readableTextOn,
	transparentize,
} from '../../shared/colorContrast';

// Track theme for mermaid initialization
let lastThemeId: string | null = null;

/**
 * DOMPurify config for Mermaid's rendered SVG.
 *
 * Mermaid renders every flowchart/class/state label as HTML inside a
 * `<foreignObject>` (`flowchart.htmlLabels: true`), so a `<br/>` in a node
 * label is a real `<br>` element, the label text lives in `<div>/<span>/<p>`,
 * and the edge-label background is a styled `<div>`. Two DOMPurify defaults
 * used to delete all of it and leave only the bare text nodes:
 *
 *   1. `USE_PROFILES: { svg: true }` allows SVG tags only, so `div`/`span`/
 *      `p`/`br` are not in the allow-list.
 *   2. `HTML_INTEGRATION_POINTS` defaults to `annotation-xml` alone, so ANY
 *      HTML-namespace child of `<foreignObject>` fails the namespace check
 *      and is force-removed even when its tag is allowed.
 *
 * The visible damage: line breaks vanished ("Visibility only.<br/>Observation"
 * rendered as "Visibility only.Observation"), the surviving text re-wrapped at
 * the foreignObject's width, and anything past the box height mermaid had
 * measured for the ORIGINAL markup was clipped away. Diagram content was
 * silently lost, not just restyled.
 *
 * So: allow the HTML profile and declare `foreignObject` an HTML integration
 * point. This is still a real security boundary - `<script>`, `on*` handlers,
 * `<iframe>`, and `javascript:` URLs are all stripped - and it is the second
 * pass, since mermaid runs its own DOMPurify at `securityLevel: 'strict'`.
 */
export const MERMAID_SANITIZE_CONFIG = {
	USE_PROFILES: { svg: true, svgFilters: true, html: true },
	ADD_TAGS: ['foreignObject'],
	ADD_ATTR: ['xmlns', 'xmlns:xlink', 'xlink:href', 'dominant-baseline', 'text-anchor'],
	HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true },
};

interface MermaidRendererProps {
	chart: string;
	theme: Theme;
}

/**
 * Initialize mermaid with theme-aware settings using the app's color scheme
 * Designed for beautiful, readable diagrams with clear visual hierarchy
 */
const initMermaid = (theme: Theme) => {
	const colors = theme.colors;

	// Determine if this is a dark theme by checking background luminance
	const bgRgb = hexToRgb(colors.bgMain);
	const isDark = bgRgb ? bgRgb.r * 0.299 + bgRgb.g * 0.587 + bgRgb.b * 0.114 < 128 : true;

	// Create vibrant node fills - blend accent with background for a tinted effect
	const primaryNodeBg = transparentize(colors.accent, colors.bgMain, 0.15);
	const secondaryNodeBg = transparentize(colors.success, colors.bgMain, 0.15);
	const tertiaryNodeBg = transparentize(colors.warning, colors.bgMain, 0.12);

	// Create prominent borders that stand out
	const primaryBorder = colors.accent;
	const secondaryBorder = colors.success;
	const tertiaryBorder = colors.warning;

	// Edge label background - slightly lighter/darker than main bg for visibility
	const edgeLabelBg = isDark
		? adjustBrightness(colors.bgMain, 10)
		: adjustBrightness(colors.bgMain, -5);

	// ER attribute rows. Mermaid's base theme derives these from the node fill
	// (rowOdd = lighten(primaryColor, 75)), which lands near-white on a dark
	// theme while the row text stays `nodeTextColor` - light text on a light
	// row. Deriving both zebra stripes from the app background instead keeps
	// them in the same contrast band as every other node fill.
	const rowEven = transparentize(colors.accent, colors.bgMain, 0.06);
	const rowOdd = transparentize(colors.accent, colors.bgMain, 0.18);

	// Every surface a node label can be painted on. The label color has to clear
	// AA against the worst of them, not just the primary fill.
	const nodeTextColor = readableTextOn(colors.textMain, [
		primaryNodeBg,
		secondaryNodeBg,
		tertiaryNodeBg,
		rowEven,
		rowOdd,
	]);

	// Pie slices and git branch labels sit on saturated palette colors rather than
	// on the background, so their text is measured against the whole palette. One
	// color has to serve every slice, so this is a best-worst-case pick.
	const paletteTextColor = readableTextOn(colors.textMain, [
		colors.accent,
		colors.success,
		colors.warning,
		colors.error,
	]);

	// Text drawn directly on the accent (gantt bars, sequence numbers). Themes
	// ship `accentForeground` for exactly this pairing.
	const onAccentColor = readableTextOn(colors.accentForeground, [colors.accent]);

	/**
	 * The twelve mindmap/timeline section fills, and a label color derived
	 * against EACH one.
	 *
	 * Mermaid's mindmap CSS paints section `i` with `cScale{i}` and its label
	 * with `cScaleLabel{i}`. Only `cScale0..5` used to be set here and no
	 * `cScaleLabel*` at all, which broke this twice over:
	 *
	 * 1. Every label fell back to mermaid's derived `labelTextColor`, i.e. the
	 *    theme's own `textMain`, painted straight onto a saturated fill. All 80
	 *    theme/fill pairs failed WCAG AA; three themes were at ratio 1.00, where
	 *    the label is literally the same color as the block behind it.
	 * 2. Indices 6-11 were invented by mermaid from `primaryColor` as `hsl()`
	 *    strings. `hexToRgb` cannot parse those, so `contrastRatio` returns its
	 *    leave-it-alone 21 and any contrast test over them passes vacuously.
	 *
	 * So all twelve are declared, as hex, and each label is measured against its
	 * own fill rather than one best-worst-case pick. Same shape as `pie1..pie12`
	 * above. `readableTextOn` returns the theme's own text color untouched when
	 * it already clears AA and nudges it otherwise, so labels stay tinted
	 * versions of the theme rather than snapping to black or white.
	 */
	const cScaleFills = [
		colors.accent,
		colors.success,
		colors.warning,
		colors.error,
		adjustBrightness(colors.accent, isDark ? 20 : -20),
		adjustBrightness(colors.success, isDark ? 20 : -20),
		adjustBrightness(colors.warning, isDark ? 20 : -20),
		adjustBrightness(colors.error, isDark ? 20 : -20),
		blendColors(colors.accent, colors.success, 0.5),
		blendColors(colors.warning, colors.error, 0.5),
		blendColors(colors.accent, colors.warning, 0.5),
		blendColors(colors.success, colors.error, 0.5),
	];
	const cScaleVars = Object.fromEntries(
		cScaleFills.flatMap((fill, i) => [
			[`cScale${i}`, fill],
			[`cScaleLabel${i}`, readableTextOn(colors.textMain, [fill])],
		])
	);

	// Git branch labels sit on their own known `git{i}` fill, so each gets a
	// color measured against that fill instead of sharing one worst-case pick.
	const gitBranchFills = [colors.accent, colors.success, colors.warning, colors.error];
	const gitBranchLabelVars = Object.fromEntries(
		gitBranchFills.map((fill, i) => [`gitBranchLabel${i}`, readableTextOn(colors.textMain, [fill])])
	);

	// Create theme variables from the app's color scheme
	const themeVariables = {
		// Base colors - primary nodes get accent color treatment
		primaryColor: primaryNodeBg,
		primaryTextColor: nodeTextColor,
		primaryBorderColor: primaryBorder,

		// Secondary colors - use success color for variety
		secondaryColor: secondaryNodeBg,
		secondaryTextColor: nodeTextColor,
		secondaryBorderColor: secondaryBorder,

		// Tertiary colors - use warning for additional variety
		tertiaryColor: tertiaryNodeBg,
		tertiaryTextColor: nodeTextColor,
		tertiaryBorderColor: tertiaryBorder,

		// Background and text
		background: colors.bgMain,
		mainBkg: primaryNodeBg,
		textColor: colors.textMain,
		titleColor: colors.accent,

		// Line colors - use accent with reduced opacity for connection lines
		lineColor: colors.accent,

		// Node colors for flowcharts - prominent styling
		nodeBkg: primaryNodeBg,
		nodeTextColor,
		nodeBorder: primaryBorder,

		// ER diagram attribute rows (zebra striping behind `nodeTextColor`)
		rowEven,
		rowOdd,

		// Cluster (subgraph) colors - subtle distinction
		clusterBkg: transparentize(colors.accent, colors.bgMain, 0.05),
		clusterBorder: colors.accent,

		// Edge labels - clear background so text is readable
		edgeLabelBackground: edgeLabelBg,

		// State diagram colors
		labelColor: colors.textMain,
		labelBackgroundColor: edgeLabelBg,
		altBackground: transparentize(colors.accent, colors.bgMain, 0.08),

		// Sequence diagram colors
		actorBkg: primaryNodeBg,
		actorBorder: primaryBorder,
		actorTextColor: nodeTextColor,
		actorLineColor: colors.accent,
		signalColor: colors.textMain,
		signalTextColor: colors.textMain,
		labelBoxBkgColor: edgeLabelBg,
		labelBoxBorderColor: colors.border,
		labelTextColor: colors.textMain,
		loopTextColor: colors.accent,
		noteBkgColor: transparentize(colors.warning, colors.bgMain, 0.15),
		noteBorderColor: colors.warning,
		noteTextColor: colors.textMain,
		activationBkgColor: transparentize(colors.accent, colors.bgMain, 0.2),
		activationBorderColor: colors.accent,
		sequenceNumberColor: onAccentColor,

		// Class diagram colors
		classText: nodeTextColor,

		// Git graph colors - use vibrant colors
		git0: colors.accent,
		git1: colors.success,
		git2: colors.warning,
		git3: colors.error,
		git4: adjustBrightness(colors.accent, isDark ? 20 : -20),
		git5: adjustBrightness(colors.success, isDark ? 20 : -20),
		git6: adjustBrightness(colors.warning, isDark ? 20 : -20),
		git7: adjustBrightness(colors.error, isDark ? 20 : -20),
		...gitBranchLabelVars,
		gitInv0: colors.bgMain,
		gitInv1: colors.bgMain,
		gitInv2: colors.bgMain,
		gitInv3: colors.bgMain,
		commitLabelColor: colors.textMain,
		commitLabelBackground: edgeLabelBg,

		// Gantt colors
		sectionBkgColor: transparentize(colors.accent, colors.bgMain, 0.1),
		altSectionBkgColor: transparentize(colors.accent, colors.bgMain, 0.05),
		sectionBkgColor2: transparentize(colors.success, colors.bgMain, 0.1),
		taskBkgColor: colors.accent,
		taskTextColor: onAccentColor,
		taskTextLightColor: colors.textMain,
		taskTextOutsideColor: colors.textMain,
		activeTaskBkgColor: adjustBrightness(colors.accent, isDark ? 15 : -15),
		activeTaskBorderColor: colors.accent,
		doneTaskBkgColor: colors.success,
		doneTaskBorderColor: colors.success,
		critBkgColor: colors.error,
		critBorderColor: colors.error,
		gridColor: colors.border,
		todayLineColor: colors.warning,

		// Pie chart colors - vibrant and distinct
		pie1: colors.accent,
		pie2: colors.success,
		pie3: colors.warning,
		pie4: colors.error,
		pie5: adjustBrightness(colors.accent, isDark ? 25 : -25),
		pie6: adjustBrightness(colors.success, isDark ? 25 : -25),
		pie7: adjustBrightness(colors.warning, isDark ? 25 : -25),
		pie8: adjustBrightness(colors.error, isDark ? 25 : -25),
		pie9: blendColors(colors.accent, colors.success, 0.5),
		pie10: blendColors(colors.warning, colors.error, 0.5),
		pie11: blendColors(colors.accent, colors.warning, 0.5),
		pie12: blendColors(colors.success, colors.error, 0.5),
		pieTitleTextColor: colors.textMain,
		pieSectionTextColor: paletteTextColor,
		pieLegendTextColor: colors.textMain,
		pieStrokeColor: colors.bgMain,
		pieStrokeWidth: '2px',

		// Relationship colors for ER diagrams
		relationColor: colors.accent,
		relationLabelColor: colors.textMain,
		relationLabelBackground: edgeLabelBg,

		// Requirement diagram
		requirementBkgColor: primaryNodeBg,
		requirementBorderColor: primaryBorder,
		requirementTextColor: nodeTextColor,

		// Mindmap sections are colored by cScale*/cScaleLabel* below, NOT by a
		// mindmap-specific variable. `mindmapBkg` was set here and is provably
		// dead: the string does not appear anywhere in mermaid 11.15.0's dist.
		// Removed rather than left as a plausible-looking no-op.

		// Quadrant chart
		quadrant1Fill: transparentize(colors.accent, colors.bgMain, 0.15),
		quadrant2Fill: transparentize(colors.success, colors.bgMain, 0.15),
		quadrant3Fill: transparentize(colors.warning, colors.bgMain, 0.15),
		quadrant4Fill: transparentize(colors.error, colors.bgMain, 0.15),
		quadrant1TextFill: colors.textMain,
		quadrant2TextFill: colors.textMain,
		quadrant3TextFill: colors.textMain,
		quadrant4TextFill: colors.textMain,
		quadrantPointFill: colors.accent,
		quadrantPointTextFill: colors.textMain,
		quadrantXAxisTextFill: colors.textMain,
		quadrantYAxisTextFill: colors.textMain,
		quadrantTitleFill: colors.accent,

		// XY Chart
		xyChart: {
			backgroundColor: 'transparent',
			titleColor: colors.accent,
			xAxisTitleColor: colors.textMain,
			yAxisTitleColor: colors.textMain,
			xAxisLabelColor: colors.textDim,
			yAxisLabelColor: colors.textDim,
			xAxisLineColor: colors.border,
			yAxisLineColor: colors.border,
			plotColorPalette: `${colors.accent}, ${colors.success}, ${colors.warning}, ${colors.error}`,
		},

		// Timeline and mindmap sections, with a label color per fill.
		...cScaleVars,

		// Sankey diagram
		sankeyLinkColor: transparentize(colors.accent, colors.bgMain, 0.3),
		sankeyNodeColor: colors.accent,
	};

	mermaid.initialize({
		startOnLoad: false,
		theme: 'base', // Use 'base' theme to fully customize with themeVariables
		themeVariables,
		securityLevel: 'strict',
		suppressErrorRendering: true,
		fontFamily:
			'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
		flowchart: {
			useMaxWidth: true,
			htmlLabels: true,
			curve: 'basis',
			padding: 15,
			nodeSpacing: 50,
			rankSpacing: 50,
		},
		sequence: {
			useMaxWidth: true,
			diagramMarginX: 8,
			diagramMarginY: 8,
			actorMargin: 50,
			boxMargin: 10,
			boxTextMargin: 5,
			noteMargin: 10,
			messageMargin: 35,
		},
		gantt: {
			useMaxWidth: true,
			barHeight: 20,
			barGap: 4,
			topPadding: 50,
			leftPadding: 75,
		},
		er: {
			useMaxWidth: true,
			layoutDirection: 'TB',
			minEntityWidth: 100,
			minEntityHeight: 75,
			entityPadding: 15,
		},
		pie: {
			useMaxWidth: true,
			textPosition: 0.75,
		},
		gitGraph: {
			useMaxWidth: true,
			mainBranchName: 'main',
		},
	});
};

export function MermaidRenderer({ chart, theme }: MermaidRendererProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [svgContent, setSvgContent] = useState<string | null>(null);

	// Use useLayoutEffect to ensure DOM is ready before we try to render
	useLayoutEffect(() => {
		let cancelled = false;

		const renderChart = async () => {
			if (!chart.trim()) {
				setIsLoading(false);
				return;
			}

			setIsLoading(true);
			setError(null);
			setSvgContent(null);

			// Initialize mermaid with the app's theme colors (only when theme changes)
			if (lastThemeId !== theme.name) {
				initMermaid(theme);
				lastThemeId = theme.name;
			}

			try {
				// Pre-validate chart syntax before render to prevent DOM pollution.
				// `normalizeMermaidSource` first repairs the `@`-in-a-label case
				// mermaid's edge-id lexer rule rejects (see that module); the
				// error branch below still shows the author's original source.
				const trimmed = normalizeMermaidSource(chart.trim());
				try {
					await mermaid.parse(trimmed);
				} catch (parseErr) {
					if (cancelled) return;
					const detail = parseErr instanceof Error ? parseErr.message : 'Invalid mermaid syntax';
					setError(detail);
					return;
				}

				// Generate a unique ID for this diagram
				const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;

				// Render the diagram - mermaid.render returns { svg: string }
				const result = await mermaid.render(id, trimmed);

				if (cancelled) return;

				if (result && result.svg) {
					// Sanitize the SVG before setting it
					const sanitizedSvg = DOMPurify.sanitize(result.svg, MERMAID_SANITIZE_CONFIG);
					setSvgContent(sanitizedSvg);
					setError(null);
				} else {
					setError('Mermaid returned empty result');
				}
			} catch (err) {
				if (cancelled) return;
				logger.error('Mermaid rendering error:', undefined, err);
				setError(err instanceof Error ? err.message : 'Failed to render diagram');

				// Clean up any orphaned mermaid error elements injected into the DOM
				document.querySelectorAll('[id^="dmermaid-"]').forEach((el) => el.remove());
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		};

		renderChart();

		return () => {
			cancelled = true;
		};
	}, [chart, theme]);

	// Update container with SVG when content changes
	// NOTE: This hook must be called before any conditional returns to satisfy rules-of-hooks
	// We depend on isLoading to ensure we re-run once the container div is actually rendered
	useLayoutEffect(() => {
		if (containerRef.current && svgContent) {
			// Parse the sanitized SVG as HTML rather than image/svg+xml. Mermaid's
			// output targets the browser's lenient HTML parser: some diagrams (e.g.
			// C4) emit <image xlink:href> without declaring the xmlns:xlink
			// namespace on the root <svg>, which a strict XML parse rejects,
			// leaving the diagram blank. The DOMPurify pass above is the security
			// boundary; parsing here only needs to reconstruct the DOM.
			const doc = new DOMParser().parseFromString(svgContent, 'text/html');
			const svgElement = doc.body.querySelector('svg');

			// Clear existing content
			while (containerRef.current.firstChild) {
				containerRef.current.removeChild(containerRef.current.firstChild);
			}

			// Append new SVG
			if (svgElement) {
				containerRef.current.appendChild(document.importNode(svgElement, true));
			}
		}
	}, [svgContent, isLoading]);

	if (error) {
		return (
			<div
				className="p-4 rounded-lg border"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.error,
					color: theme.colors.error,
				}}
			>
				<div className="text-sm font-medium mb-2">Failed to render Mermaid diagram</div>
				<pre className="text-xs whitespace-pre-wrap opacity-75">{error}</pre>
				<details className="mt-3">
					<summary className="text-xs cursor-pointer" style={{ color: theme.colors.textDim }}>
						View source
					</summary>
					<pre
						className="mt-2 p-2 text-xs rounded overflow-x-auto"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
						}}
					>
						{chart}
					</pre>
				</details>
			</div>
		);
	}

	// Show loading state
	if (isLoading) {
		return (
			<div
				className="mermaid-container p-4 rounded-lg overflow-x-auto"
				style={{
					backgroundColor: theme.colors.bgActivity,
					minHeight: '60px',
				}}
			>
				<div className="text-center text-sm" style={{ color: theme.colors.textDim }}>
					Rendering diagram...
				</div>
			</div>
		);
	}

	// Render container - SVG will be inserted via the effect above. The diagram is
	// appended imperatively and never passes through React's element tree, so it
	// carries no right-click handler of its own; the app-wide delegated listener
	// in ImageContextMenuHost resolves it from the click target instead.
	return (
		<div
			ref={containerRef}
			className="mermaid-container p-4 rounded-lg overflow-x-auto"
			style={{
				backgroundColor: theme.colors.bgActivity,
			}}
		/>
	);
}
