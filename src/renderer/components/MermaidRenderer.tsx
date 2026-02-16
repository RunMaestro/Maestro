import { useLayoutEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import type { Theme } from '../types';

// Track theme for mermaid initialization
let lastThemeId: string | null = null;

interface MermaidRendererProps {
	chart: string;
	theme: Theme;
}

/**
 * Convert hex color to RGB components
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result
		? {
				r: parseInt(result[1], 16),
				g: parseInt(result[2], 16),
				b: parseInt(result[3], 16),
			}
		: null;
}

/**
 * Create a slightly lighter/darker version of a color
 */
function adjustBrightness(hex: string, percent: number): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;

	const adjust = (value: number) =>
		Math.min(255, Math.max(0, Math.round(value + (255 * percent) / 100)));
	const r = adjust(rgb.r);
	const g = adjust(rgb.g);
	const b = adjust(rgb.b);

	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Blend two hex colors together
 */
function blendColors(color1: string, color2: string, ratio: number): string {
	const rgb1 = hexToRgb(color1);
	const rgb2 = hexToRgb(color2);
	if (!rgb1 || !rgb2) return color1;

	const r = Math.round(rgb1.r * (1 - ratio) + rgb2.r * ratio);
	const g = Math.round(rgb1.g * (1 - ratio) + rgb2.g * ratio);
	const b = Math.round(rgb1.b * (1 - ratio) + rgb2.b * ratio);

	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Create a semi-transparent version of a color as a solid color blended with background
 */
function transparentize(color: string, bgColor: string, alpha: number): string {
	return blendColors(bgColor, color, alpha);
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

	// Create theme variables from the app's color scheme
	const themeVariables = {
		// Base colors - primary nodes get accent color treatment
		primaryColor: primaryNodeBg,
		primaryTextColor: colors.textMain,
		primaryBorderColor: primaryBorder,

		// Secondary colors - use success color for variety
		secondaryColor: secondaryNodeBg,
		secondaryTextColor: colors.textMain,
		secondaryBorderColor: secondaryBorder,

		// Tertiary colors - use warning for additional variety
		tertiaryColor: tertiaryNodeBg,
		tertiaryTextColor: colors.textMain,
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
		nodeTextColor: colors.textMain,
		nodeBorder: primaryBorder,

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
		actorTextColor: colors.textMain,
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
		sequenceNumberColor: colors.bgMain,

		// Class diagram colors
		classText: colors.textMain,

		// Git graph colors - use vibrant colors
		git0: colors.accent,
		git1: colors.success,
		git2: colors.warning,
		git3: colors.error,
		git4: adjustBrightness(colors.accent, isDark ? 20 : -20),
		git5: adjustBrightness(colors.success, isDark ? 20 : -20),
		git6: adjustBrightness(colors.warning, isDark ? 20 : -20),
		git7: adjustBrightness(colors.error, isDark ? 20 : -20),
		gitBranchLabel0: colors.textMain,
		gitBranchLabel1: colors.textMain,
		gitBranchLabel2: colors.textMain,
		gitBranchLabel3: colors.textMain,
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
		taskTextColor: colors.bgMain,
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
		pieSectionTextColor: colors.textMain,
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
		requirementTextColor: colors.textMain,

		// Mindmap - colorful nodes
		mindmapBkg: primaryNodeBg,

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

		// Timeline
		cScale0: colors.accent,
		cScale1: colors.success,
		cScale2: colors.warning,
		cScale3: colors.error,
		cScale4: adjustBrightness(colors.accent, isDark ? 20 : -20),
		cScale5: adjustBrightness(colors.success, isDark ? 20 : -20),

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
				const trimmed = chart.trim();
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
					const sanitizedSvg = DOMPurify.sanitize(result.svg, {
						USE_PROFILES: { svg: true, svgFilters: true },
						ADD_TAGS: ['foreignObject'],
						ADD_ATTR: ['xmlns', 'xmlns:xlink', 'xlink:href', 'dominant-baseline', 'text-anchor'],
					});
					setSvgContent(sanitizedSvg);
					setError(null);
				} else {
					setError('Mermaid returned empty result');
				}
			} catch (err) {
				if (cancelled) return;
				console.error('Mermaid rendering error:', err);
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
			// Parse sanitized SVG and append to container
			const parser = new DOMParser();
			const doc = parser.parseFromString(svgContent, 'image/svg+xml');
			const svgElement = doc.documentElement;

			// Clear existing content
			while (containerRef.current.firstChild) {
				containerRef.current.removeChild(containerRef.current.firstChild);
			}

			// Append new SVG
			if (svgElement && svgElement.tagName === 'svg') {
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

	// Render container - SVG will be inserted via the effect above
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
