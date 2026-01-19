/**
 * Shared markdown configuration utilities for consistent rendering across components.
 *
 * This module provides:
 * - generateProseStyles: Creates theme-aware CSS for markdown prose content
 * - createMarkdownComponents: Factory for ReactMarkdown component overrides
 * - generateAutoRunProseStyles: Pre-configured styles for AutoRun panel
 * - generateTerminalProseStyles: Styles for terminal output and group chat messages
 * - generateDiffViewStyles: Styles for react-diff-view library theme overrides
 *
 * Used by:
 * - AutoRun.tsx: Document editing/preview with image attachments and mermaid diagrams
 * - TerminalOutput.tsx: AI terminal message rendering
 * - GroupChatMessages.tsx: Group chat message rendering
 * - GitDiffViewer.tsx: Git diff display
 * - GitLogViewer.tsx: Git log with commit diff display
 */

import type { Components } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import React from 'react';
import type { Theme } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface ProseStylesOptions {
	/** Theme object with color values */
	theme: Theme;
	/** Use colored headings (h1=accent, h2=success, h3=warning) - default false */
	coloredHeadings?: boolean;
	/** Use compact spacing for terminal output - default false */
	compactSpacing?: boolean;
	/** Include checkbox styling - default true */
	includeCheckboxStyles?: boolean;
	/** CSS selector to scope styles (e.g., '.autorun-panel') - prevents conflicts between components */
	scopeSelector?: string;
}

export interface MarkdownComponentsOptions {
	/** Theme object with color values */
	theme: Theme;
	/** Custom image renderer - if not provided, default img tag is used */
	imageRenderer?: React.ComponentType<{ src?: string; alt?: string }>;
	/** Custom code block renderer for specific languages (e.g., mermaid) */
	customLanguageRenderers?: Record<string, React.ComponentType<{ code: string; theme: Theme }>>;
	/** Callback when internal file link is clicked (maestro-file:// protocol) */
	onFileClick?: (filePath: string) => void;
	/** Callback when external link is clicked - if not provided, uses default browser behavior */
	onExternalLinkClick?: (href: string) => void;
	/** Callback when anchor link is clicked (same-page #section links) */
	onAnchorClick?: (anchorId: string) => void;
	/** Container ref for scrolling to anchors - if not provided, uses document.getElementById */
	containerRef?: React.RefObject<HTMLElement>;
	/** Search highlighting options */
	searchHighlight?: {
		query: string;
		currentMatchIndex: number;
		/** Callback to track match index for scrolling */
		onMatchRendered?: (index: number, element: HTMLElement) => void;
	};
}

// ============================================================================
// Prose Styles Generator
// ============================================================================

/**
 * Generates CSS styles for markdown prose content.
 *
 * @param options Configuration options for style generation
 * @returns CSS string to be injected via <style> tag
 *
 * @example
 * const styles = generateProseStyles({ theme });
 * // In component: <style>{styles}</style>
 */
export function generateProseStyles(options: ProseStylesOptions): string {
	const {
		theme,
		coloredHeadings = false,
		compactSpacing = false,
		includeCheckboxStyles = true,
		scopeSelector = '',
	} = options;
	const colors = theme.colors;

	// Build selector prefix - if scopeSelector provided, prefix .prose with it
	const s = scopeSelector ? `${scopeSelector} .prose` : '.prose';

	// Margin values based on spacing mode
	const headingMargin = compactSpacing ? '0.25em 0' : '0.67em 0';
	const headingMarginSmall = compactSpacing ? '0.2em 0' : '0.83em 0';
	const paragraphMargin = compactSpacing ? '0' : '0.5em 0';
	const listMargin = compactSpacing ? '0.25em 0' : '0.5em 0';
	const hrMargin = compactSpacing ? '0.5em 0' : '1em 0';

	// Heading colors based on mode
	const h1Color = coloredHeadings ? colors.accent : colors.textMain;
	const h2Color = coloredHeadings ? colors.success : colors.textMain;
	const h3Color = coloredHeadings ? colors.warning : colors.textMain;
	const h4Color = colors.textMain;
	const h5Color = colors.textMain;
	const h6Color = coloredHeadings ? colors.textDim : colors.textMain;

	let styles = `
    ${s} { line-height: 1.4; overflow: visible; }
    ${compactSpacing ? `${s} > *:first-child { margin-top: 0 !important; }` : ''}
    ${compactSpacing ? `${s} > *:last-child { margin-bottom: 0 !important; }` : ''}
    ${compactSpacing ? `${s} * { margin-top: 0; margin-bottom: 0; }` : ''}
    ${s} h1 { color: ${h1Color}; font-size: 2em; font-weight: bold; margin: ${headingMargin} !important; line-height: 1.4; }
    ${s} h2 { color: ${h2Color}; font-size: 1.5em; font-weight: bold; margin: ${headingMargin} !important; line-height: 1.4; }
    ${s} h3 { color: ${h3Color}; font-size: 1.17em; font-weight: bold; margin: ${headingMarginSmall} !important; line-height: 1.4; }
    ${s} h4 { color: ${h4Color}; font-size: 1em; font-weight: bold; margin: ${headingMarginSmall} !important; line-height: 1.4; }
    ${s} h5 { color: ${h5Color}; font-size: 0.83em; font-weight: bold; margin: ${headingMarginSmall} !important; line-height: 1.4; }
    ${s} h6 { color: ${h6Color}; font-size: 0.67em; font-weight: bold; margin: ${headingMarginSmall} !important; line-height: 1.4; }
    ${s} p { color: ${colors.textMain}; margin: ${paragraphMargin} !important; line-height: 1.4; }
    ${compactSpacing ? `${s} p + p { margin-top: 0.5em !important; }` : ''}
    ${compactSpacing ? `${s} p:empty { display: none; }` : ''}
    ${s} ul, ${s} ol { color: ${colors.textMain}; margin: ${listMargin} !important; padding-left: ${compactSpacing ? '2em' : '1.5em'}; ${compactSpacing ? 'list-style-position: outside;' : ''} }
    ${s} ul { list-style-type: disc; }
    ${s} ol { list-style-type: decimal; }
    ${compactSpacing ? `${s} li ul, ${s} li ol { margin: 0 !important; padding-left: 1.5em; list-style-position: outside; }` : ''}
    ${s} li { margin: ${compactSpacing ? '0' : '0.25em 0'} !important; ${compactSpacing ? 'padding: 0;' : ''} line-height: 1.4; display: list-item; }
    ${compactSpacing ? `${s} li > p { margin: 0 !important; display: inline; }` : ''}
    ${compactSpacing ? `${s} li > p + ul, ${s} li > p + ol { margin-top: 0 !important; }` : ''}
    ${s} li::marker { color: ${colors.textMain}; }
    ${s} li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
    ${s} code { background-color: ${colors.bgActivity}; color: ${colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    ${s} pre { background-color: ${colors.bgActivity}; color: ${colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; ${compactSpacing ? 'margin: 0.35em 0 !important;' : ''} }
    ${s} pre code { background: none; padding: 0; }
    ${s} blockquote { border-left: ${compactSpacing ? '3px' : '4px'} solid ${colors.border}; padding-left: ${compactSpacing ? '0.75em' : '1em'}; margin: ${compactSpacing ? '0.25em 0' : '0.5em 0'} !important; color: ${colors.textDim}; }
    ${s} a { color: ${colors.accent}; text-decoration: underline; }
    ${s} hr { border: none; border-top: ${compactSpacing ? '1px' : '2px'} solid ${colors.border}; margin: ${hrMargin} !important; }
    ${s} table { border-collapse: collapse; width: 100%; margin: ${compactSpacing ? '0.35em 0' : '0.5em 0'} !important; }
    ${s} th, ${s} td { border: 1px solid ${colors.border}; padding: ${compactSpacing ? '0.25em 0.5em' : '0.5em'}; text-align: left; }
    ${s} th { background-color: ${colors.bgActivity}; font-weight: bold; }
    ${s} strong { font-weight: bold; }
    ${s} em { font-style: italic; }
  `.trim();

	// Add checkbox styles if requested
	if (includeCheckboxStyles) {
		styles += `
    ${s} input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border: 2px solid ${colors.accent};
      border-radius: 3px;
      background-color: transparent;
      cursor: pointer;
      vertical-align: middle;
      margin-right: 8px;
      position: relative;
    }
    ${s} input[type="checkbox"]:checked {
      background-color: ${colors.accent};
      border-color: ${colors.accent};
    }
    ${s} input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 1px;
      width: 5px;
      height: 9px;
      border: solid ${colors.bgMain};
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    ${s} input[type="checkbox"]:hover {
      border-color: ${colors.accent};
      box-shadow: 0 0 4px ${colors.accent}40;
    }
    ${s} li:has(> input[type="checkbox"]) {
      list-style-type: none;
      margin-left: -1.5em;
    }
    `;
	}

	return styles;
}

// ============================================================================
// Markdown Components Factory
// ============================================================================

/**
 * Creates ReactMarkdown component overrides for consistent rendering.
 *
 * @param options Configuration options for component creation
 * @returns Components object for ReactMarkdown's `components` prop
 *
 * @example
 * const components = createMarkdownComponents({
 *   theme,
 *   imageRenderer: MyImageComponent,
 *   customLanguageRenderers: { mermaid: MermaidRenderer },
 * });
 * // In component: <ReactMarkdown components={components}>...</ReactMarkdown>
 */
// Global match counter for tracking which match is current during render
let globalMatchCounter = 0;

/**
 * Helper to highlight search matches in text content.
 * Recursively processes children to find and highlight text matches.
 */
function highlightSearchMatches(
	children: React.ReactNode,
	searchHighlight: NonNullable<MarkdownComponentsOptions['searchHighlight']>,
	theme: Theme
): React.ReactNode {
	const { query, currentMatchIndex, onMatchRendered } = searchHighlight;

	// Process each child
	const processChild = (child: React.ReactNode, childIndex: number): React.ReactNode => {
		// Handle string children - this is where we do the actual highlighting
		if (typeof child === 'string') {
			const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`(${escapedQuery})`, 'gi');
			const parts = child.split(regex);

			// If no matches, return original string
			if (parts.length === 1) {
				return child;
			}

			// Build highlighted elements
			const elements: React.ReactNode[] = [];
			parts.forEach((part, i) => {
				if (part.toLowerCase() === query.toLowerCase()) {
					const matchIndex = globalMatchCounter++;
					const isCurrent = matchIndex === currentMatchIndex;
					elements.push(
						React.createElement(
							'mark',
							{
								key: `match-${childIndex}-${i}`,
								className: 'search-match',
								'data-match-index': matchIndex,
								'data-current': isCurrent ? 'true' : undefined,
								style: {
									padding: '0 2px',
									borderRadius: '2px',
									backgroundColor: isCurrent ? theme.colors.accent : '#ffd700',
									color: isCurrent ? '#fff' : '#000',
								},
								ref:
									isCurrent && onMatchRendered
										? (el: HTMLElement | null) => el && onMatchRendered(matchIndex, el)
										: undefined,
							},
							part
						)
					);
				} else if (part) {
					elements.push(part);
				}
			});

			return React.createElement(React.Fragment, { key: `text-${childIndex}` }, ...elements);
		}

		// Handle React elements - recursively process their children
		if (React.isValidElement(child)) {
			const element = child as React.ReactElement<any>;
			const elementChildren = element.props.children;

			// If element has children, recursively process them
			if (elementChildren !== undefined) {
				const processedChildren = highlightSearchMatches(elementChildren, searchHighlight, theme);
				// Clone the element with processed children
				return React.cloneElement(
					element,
					{ key: element.key || `elem-${childIndex}` },
					processedChildren
				);
			}

			return child;
		}

		// Handle arrays of children
		if (Array.isArray(child)) {
			return child.map((c, i) => processChild(c, i));
		}

		// Return other types as-is (numbers, null, undefined, etc.)
		return child;
	};

	// Handle array of children
	if (Array.isArray(children)) {
		return children.map((child, i) => processChild(child, i));
	}

	// Handle single child
	return processChild(children, 0);
}

export function createMarkdownComponents(options: MarkdownComponentsOptions): Partial<Components> {
	const {
		theme,
		imageRenderer,
		customLanguageRenderers = {},
		onFileClick,
		onExternalLinkClick,
		onAnchorClick,
		containerRef,
		searchHighlight,
	} = options;

	// Reset match counter at start of each render
	globalMatchCounter = 0;

	// Helper to wrap children with search highlighting
	const withHighlight = (children: React.ReactNode): React.ReactNode => {
		if (!searchHighlight || !searchHighlight.query.trim()) {
			return children;
		}
		return highlightSearchMatches(children, searchHighlight, theme);
	};

	const components: Partial<Components> = {
		// Override paragraph to apply search highlighting
		p: ({ children }: any) => React.createElement('p', null, withHighlight(children)),

		// Override headings to apply search highlighting
		h1: ({ children }: any) => React.createElement('h1', null, withHighlight(children)),
		h2: ({ children }: any) => React.createElement('h2', null, withHighlight(children)),
		h3: ({ children }: any) => React.createElement('h3', null, withHighlight(children)),
		h4: ({ children }: any) => React.createElement('h4', null, withHighlight(children)),
		h5: ({ children }: any) => React.createElement('h5', null, withHighlight(children)),
		h6: ({ children }: any) => React.createElement('h6', null, withHighlight(children)),

		// Override list items to apply search highlighting
		li: ({ children }: any) => React.createElement('li', null, withHighlight(children)),

		// Override table cells to apply search highlighting
		td: ({ children }: any) => React.createElement('td', null, withHighlight(children)),
		th: ({ children }: any) => React.createElement('th', null, withHighlight(children)),

		// Override blockquote to apply search highlighting
		blockquote: ({ children }: any) =>
			React.createElement('blockquote', null, withHighlight(children)),

		// Override strong/em to apply search highlighting
		strong: ({ children }: any) => React.createElement('strong', null, withHighlight(children)),
		em: ({ children }: any) => React.createElement('em', null, withHighlight(children)),
		// Code block with syntax highlighting and custom language support
		code: ({ node: _node, inline, className, children, ...props }: any) => {
			const match = (className || '').match(/language-(\w+)/);
			const language = match ? match[1] : 'text';
			const codeContent = String(children).replace(/\n$/, '');

			// Check for custom language renderer (e.g., mermaid)
			if (!inline && customLanguageRenderers[language]) {
				const CustomRenderer = customLanguageRenderers[language];
				return React.createElement(CustomRenderer, { code: codeContent, theme });
			}

			// Standard syntax-highlighted code block
			if (!inline && match) {
				return React.createElement(SyntaxHighlighter, {
					language,
					style: vscDarkPlus,
					customStyle: {
						margin: '0.5em 0',
						padding: '1em',
						background: theme.colors.bgActivity,
						fontSize: '0.9em',
						borderRadius: '6px',
					},
					PreTag: 'div',
					children: codeContent,
				});
			}

			// Inline code
			return React.createElement('code', { className, ...props }, children);
		},
	};

	// Custom image renderer if provided
	if (imageRenderer) {
		components.img = ({ node: _node, src, alt, ...props }: any) => {
			return React.createElement(imageRenderer, { src, alt, ...props });
		};
	}

	// Link handler - supports internal file links, anchor links, and external links
	if (onFileClick || onExternalLinkClick || onAnchorClick) {
		components.a = ({ node: _node, href, children, ...props }: any) => {
			// Check for maestro-file:// protocol OR data-maestro-file attribute
			// (data attribute is fallback when rehype strips custom protocols)
			const dataFilePath = props['data-maestro-file'];
			const isMaestroFile = href?.startsWith('maestro-file://') || !!dataFilePath;
			const filePath =
				dataFilePath ||
				(href?.startsWith('maestro-file://') ? href.replace('maestro-file://', '') : null);

			// Check for anchor links (same-page navigation)
			const isAnchorLink = href?.startsWith('#');
			const anchorId = isAnchorLink ? href.slice(1) : null;

			return React.createElement(
				'a',
				{
					href,
					...props,
					onClick: (e: React.MouseEvent) => {
						e.preventDefault();
						if (isMaestroFile && filePath && onFileClick) {
							onFileClick(filePath);
						} else if (isAnchorLink && anchorId) {
							// Handle anchor links - scroll to the target element
							if (onAnchorClick) {
								onAnchorClick(anchorId);
							} else {
								// Default behavior: find element by ID and scroll to it
								const targetElement = containerRef?.current
									? containerRef.current.querySelector(`#${CSS.escape(anchorId)}`)
									: document.getElementById(anchorId);
								if (targetElement) {
									targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
								}
							}
						} else if (href && onExternalLinkClick) {
							onExternalLinkClick(href);
						}
					},
					style: { color: theme.colors.accent, textDecoration: 'underline', cursor: 'pointer' },
				},
				children
			);
		};
	}

	return components;
}

// ============================================================================
// Pre-configured Style Generators (convenience exports)
// ============================================================================

/**
 * Generates prose styles for AutoRun document editing/preview.
 * Includes checkbox styling and standard heading colors.
 * Scoped to .autorun-panel to avoid CSS conflicts with other prose containers.
 */
export function generateAutoRunProseStyles(theme: Theme): string {
	return generateProseStyles({
		theme,
		coloredHeadings: true,
		compactSpacing: false,
		includeCheckboxStyles: true,
		scopeSelector: '.autorun-panel',
	});
}

/**
 * Generates prose styles for terminal output and group chat messages.
 * Features: colored headings (accent/success/warning), compact spacing,
 * bgSidebar for code backgrounds, and extra list item styling.
 *
 * @param scopeSelector CSS selector to scope styles (e.g., '.terminal-output' or '.group-chat-messages')
 */
export function generateTerminalProseStyles(theme: Theme, scopeSelector: string): string {
	const c = theme.colors;
	const s = `${scopeSelector} .prose`;

	return `
    ${s} { line-height: 1.4; overflow: visible; }
    ${s} > *:first-child { margin-top: 0 !important; }
    ${s} > *:last-child { margin-bottom: 0 !important; }
    ${s} * { margin-top: 0; margin-bottom: 0; }
    ${s} h1 { color: ${c.accent}; font-size: 2em; font-weight: bold; margin: 0.25em 0 !important; line-height: 1.4; }
    ${s} h2 { color: ${c.success}; font-size: 1.75em; font-weight: bold; margin: 0.25em 0 !important; line-height: 1.4; }
    ${s} h3 { color: ${c.warning}; font-size: 1.5em; font-weight: bold; margin: 0.25em 0 !important; line-height: 1.4; }
    ${s} h4 { color: ${c.textMain}; font-size: 1.35em; font-weight: bold; margin: 0.2em 0 !important; line-height: 1.4; }
    ${s} h5 { color: ${c.textMain}; font-size: 1.2em; font-weight: bold; margin: 0.2em 0 !important; line-height: 1.4; }
    ${s} h6 { color: ${c.textDim}; font-size: 1.1em; font-weight: bold; margin: 0.2em 0 !important; line-height: 1.4; }
    ${s} p { color: ${c.textMain}; margin: 0 !important; line-height: 1.4; }
    ${s} p + p { margin-top: 0.5em !important; }
    ${s} p:empty { display: none; }
    ${s} > ul, ${s} > ol { color: ${c.textMain}; margin: 0.25em 0 !important; padding-left: 2em; list-style-position: outside; }
    ${s} li ul, ${s} li ol { margin: 0 !important; padding-left: 1.5em; list-style-position: outside; }
    ${s} li { margin: 0 !important; padding: 0; line-height: 1.4; display: list-item; }
    ${s} li > p { margin: 0 !important; display: inline; }
    ${s} li > p + ul, ${s} li > p + ol { margin-top: 0 !important; }
    ${s} li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
    ${s} code { background-color: ${c.bgSidebar}; color: ${c.textMain}; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
    ${s} pre { background-color: ${c.bgSidebar}; color: ${c.textMain}; padding: 0.5em; border-radius: 6px; overflow-x: auto; margin: 0.35em 0 !important; }
    ${s} pre code { background: none; padding: 0; }
    ${s} blockquote { border-left: 3px solid ${c.border}; padding-left: 0.75em; margin: 0.25em 0 !important; color: ${c.textDim}; }
    ${s} a { color: ${c.accent}; text-decoration: underline; }
    ${s} hr { border: none; border-top: 1px solid ${c.border}; margin: 0.5em 0 !important; }
    ${s} table { border-collapse: collapse; width: 100%; margin: 0.35em 0 !important; }
    ${s} th, ${s} td { border: 1px solid ${c.border}; padding: 0.25em 0.5em; text-align: left; }
    ${s} th { background-color: ${c.bgSidebar}; font-weight: bold; }
    ${s} strong { font-weight: bold; }
    ${s} em { font-style: italic; }
    ${s} li > strong:first-child, ${s} li > b:first-child, ${s} li > em:first-child, ${s} li > code:first-child, ${s} li > a:first-child { vertical-align: baseline; line-height: inherit; }
    ${s} li::marker { font-weight: normal; }
  `;
}

/**
 * Generates CSS styles for react-diff-view library theme overrides.
 * Used by GitDiffViewer and GitLogViewer to apply consistent diff styling.
 *
 * @param theme Theme object with color values
 * @returns CSS string to be injected via <style> tag
 */
export function generateDiffViewStyles(theme: Theme): string {
	const c = theme.colors;

	return `
    .diff-gutter {
      background-color: ${c.bgSidebar} !important;
      color: ${c.textDim} !important;
      border-right: 1px solid ${c.border} !important;
    }
    .diff-code {
      background-color: ${c.bgMain} !important;
      color: ${c.textMain} !important;
    }
    .diff-gutter-insert {
      background-color: rgba(34, 197, 94, 0.1) !important;
    }
    .diff-code-insert {
      background-color: rgba(34, 197, 94, 0.15) !important;
      color: ${c.textMain} !important;
    }
    .diff-gutter-delete {
      background-color: rgba(239, 68, 68, 0.1) !important;
    }
    .diff-code-delete {
      background-color: rgba(239, 68, 68, 0.15) !important;
      color: ${c.textMain} !important;
    }
    .diff-code-insert .diff-code-edit {
      background-color: rgba(34, 197, 94, 0.3) !important;
    }
    .diff-code-delete .diff-code-edit {
      background-color: rgba(239, 68, 68, 0.3) !important;
    }
    .diff-hunk-header {
      background-color: ${c.bgActivity} !important;
      color: ${c.accent} !important;
      border-bottom: 1px solid ${c.border} !important;
    }
    .diff-line {
      color: ${c.textMain} !important;
    }
  `;
}
