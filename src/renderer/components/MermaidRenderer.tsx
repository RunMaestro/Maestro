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
 * Initialize mermaid with theme-aware settings using the app's color scheme
 */
const initMermaid = (theme: Theme) => {
	const colors = theme.colors;

	// Determine if this is a dark theme by checking background luminance
	const bgRgb = hexToRgb(colors.bgMain);
	const isDark = bgRgb ? bgRgb.r * 0.299 + bgRgb.g * 0.587 + bgRgb.b * 0.114 < 128 : true;

	// Create theme variables from the app's color scheme
	const themeVariables = {
		// Base colors
		primaryColor: colors.accent,
		primaryTextColor: colors.textMain,
		primaryBorderColor: colors.border,

		// Secondary colors (derived from accent)
		secondaryColor: adjustBrightness(colors.accent, isDark ? -20 : 20),
		secondaryTextColor: colors.textMain,
		secondaryBorderColor: colors.border,

		// Tertiary colors
		tertiaryColor: colors.bgActivity,
		tertiaryTextColor: colors.textMain,
		tertiaryBorderColor: colors.border,

		// Background and text
		background: colors.bgMain,
		mainBkg: colors.bgActivity,
		textColor: colors.textMain,
		titleColor: colors.textMain,

		// Line colors
		lineColor: colors.textDim,

		// Node colors for flowcharts
		nodeBkg: colors.bgActivity,
		nodeTextColor: colors.textMain,
		nodeBorder: colors.border,

		// Cluster (subgraph) colors
		clusterBkg: colors.bgSidebar,
		clusterBorder: colors.border,

		// Edge labels
		edgeLabelBackground: colors.bgMain,

		// State diagram colors
		labelColor: colors.textMain,
		altBackground: colors.bgSidebar,

		// Sequence diagram colors
		actorBkg: colors.bgActivity,
		actorBorder: colors.border,
		actorTextColor: colors.textMain,
		actorLineColor: colors.textDim,
		signalColor: colors.textMain,
		signalTextColor: colors.textMain,
		labelBoxBkgColor: colors.bgActivity,
		labelBoxBorderColor: colors.border,
		labelTextColor: colors.textMain,
		loopTextColor: colors.textMain,
		noteBkgColor: colors.bgActivity,
		noteBorderColor: colors.border,
		noteTextColor: colors.textMain,
		activationBkgColor: colors.bgActivity,
		activationBorderColor: colors.accent,
		sequenceNumberColor: colors.textMain,

		// Class diagram colors
		classText: colors.textMain,

		// Git graph colors
		git0: colors.accent,
		git1: colors.success,
		git2: colors.warning,
		git3: colors.error,
		gitBranchLabel0: colors.textMain,
		gitBranchLabel1: colors.textMain,
		gitBranchLabel2: colors.textMain,
		gitBranchLabel3: colors.textMain,

		// Gantt colors
		sectionBkgColor: colors.bgActivity,
		altSectionBkgColor: colors.bgSidebar,
		sectionBkgColor2: colors.bgActivity,
		taskBkgColor: colors.accent,
		taskTextColor: colors.textMain,
		taskTextLightColor: colors.textMain,
		taskTextOutsideColor: colors.textMain,
		activeTaskBkgColor: colors.accent,
		activeTaskBorderColor: colors.border,
		doneTaskBkgColor: colors.success,
		doneTaskBorderColor: colors.border,
		critBkgColor: colors.error,
		critBorderColor: colors.error,
		gridColor: colors.border,
		todayLineColor: colors.warning,

		// Pie chart colors
		pie1: colors.accent,
		pie2: colors.success,
		pie3: colors.warning,
		pie4: colors.error,
		pie5: adjustBrightness(colors.accent, 30),
		pie6: adjustBrightness(colors.success, 30),
		pie7: adjustBrightness(colors.warning, 30),
		pieTitleTextColor: colors.textMain,
		pieSectionTextColor: colors.textMain,
		pieLegendTextColor: colors.textMain,

		// Relationship colors for ER diagrams
		relationColor: colors.textDim,
		relationLabelColor: colors.textMain,
		relationLabelBackground: colors.bgMain,

		// Requirement diagram
		requirementBkgColor: colors.bgActivity,
		requirementBorderColor: colors.border,
		requirementTextColor: colors.textMain,

		// Mindmap
		mindmapBkg: colors.bgActivity,
	};

	mermaid.initialize({
		startOnLoad: false,
		theme: 'base', // Use 'base' theme to fully customize with themeVariables
		themeVariables,
		securityLevel: 'strict',
		fontFamily:
			'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
		flowchart: {
			useMaxWidth: true,
			htmlLabels: true,
			curve: 'basis',
		},
		sequence: {
			useMaxWidth: true,
			diagramMarginX: 8,
			diagramMarginY: 8,
		},
		gantt: {
			useMaxWidth: true,
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
				// Generate a unique ID for this diagram
				const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;

				// Render the diagram - mermaid.render returns { svg: string }
				const result = await mermaid.render(id, chart.trim());

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
