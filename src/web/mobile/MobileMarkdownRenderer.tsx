/**
 * MobileMarkdownRenderer - Markdown rendering for mobile web interface
 *
 * A simplified version of the desktop MarkdownRenderer optimized for mobile.
 * Features:
 * - GitHub Flavored Markdown (tables, strikethrough, task lists)
 * - Syntax highlighted code blocks with copy buttons
 * - External link handling (opens in new tab)
 * - Theme-aware styling
 *
 * Does NOT include:
 * - Local image loading via IPC (not available in web context)
 * - File tree linking (maestro-file:// protocol)
 * - Frontmatter parsing (not needed for AI responses)
 */

import React, { memo, useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeColors, useTheme } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

/**
 * Props for MobileMarkdownRenderer
 */
export interface MobileMarkdownRendererProps {
	/** The markdown content to render */
	content: string;
	/** Optional custom font size (default: 13px) */
	fontSize?: number;
}

/**
 * CodeBlockWithCopy - Code block with copy button for mobile
 */
interface CodeBlockWithCopyProps {
	language: string;
	codeContent: string;
	syntaxStyle: { [key: string]: React.CSSProperties };
	bgColor: string;
	borderColor: string;
	textDimColor: string;
	successColor: string;
}

const CodeBlockWithCopy = memo(
	({
		language,
		codeContent,
		syntaxStyle,
		bgColor,
		borderColor,
		textDimColor,
		successColor,
	}: CodeBlockWithCopyProps) => {
		const [copied, setCopied] = useState(false);

		const handleCopy = useCallback(async () => {
			try {
				await navigator.clipboard.writeText(codeContent);
				setCopied(true);
				triggerHaptic(HAPTIC_PATTERNS.success);
				setTimeout(() => setCopied(false), 2000);
			} catch {
				triggerHaptic(HAPTIC_PATTERNS.error);
			}
		}, [codeContent]);

		// Normalize language display name
		const displayLanguage = language && language !== 'text' ? language : 'code';

		return (
			<div
				style={{
					borderRadius: '8px',
					overflow: 'hidden',
					border: `1px solid ${borderColor}`,
					margin: '8px 0',
				}}
			>
				{/* Code block header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '4px 8px 4px 12px',
						backgroundColor: bgColor,
						borderBottom: `1px solid ${borderColor}`,
						minHeight: '28px',
					}}
				>
					<span
						style={{
							fontSize: '11px',
							fontWeight: 500,
							color: textDimColor,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						{displayLanguage}
					</span>
					<button
						onClick={handleCopy}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '4px',
							padding: '4px 8px',
							borderRadius: '4px',
							border: 'none',
							backgroundColor: copied ? `${successColor}20` : 'transparent',
							color: copied ? successColor : textDimColor,
							fontSize: '11px',
							fontWeight: 500,
							cursor: 'pointer',
							transition: 'all 0.2s ease',
						}}
						aria-label={copied ? 'Copied!' : 'Copy code'}
					>
						{copied ? (
							<>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
								Copied
							</>
						) : (
							<>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
									<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
								</svg>
								Copy
							</>
						)}
					</button>
				</div>
				<SyntaxHighlighter
					language={language || 'text'}
					style={syntaxStyle}
					customStyle={{
						margin: 0,
						padding: '12px',
						fontSize: '12px',
						lineHeight: 1.5,
						backgroundColor: bgColor,
						borderRadius: 0,
					}}
					wrapLongLines={true}
					showLineNumbers={false}
				>
					{codeContent}
				</SyntaxHighlighter>
			</div>
		);
	}
);

CodeBlockWithCopy.displayName = 'CodeBlockWithCopy';

/**
 * MobileMarkdownRenderer component
 *
 * Renders markdown content with full GFM support for mobile displays.
 */
export const MobileMarkdownRenderer = memo(
	({ content, fontSize = 13 }: MobileMarkdownRendererProps) => {
		const colors = useThemeColors();
		const { isDark } = useTheme();
		const syntaxStyle = isDark ? vscDarkPlus : vs;

		return (
			<div
				style={{
					fontSize: `${fontSize}px`,
					lineHeight: 1.6,
					color: colors.textMain,
					wordBreak: 'break-word',
				}}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={{
						// Links open in new tab
						a: ({ href, children }) => (
							<a
								href={href}
								target="_blank"
								rel="noopener noreferrer"
								style={{
									color: colors.accent,
									textDecoration: 'underline',
								}}
							>
								{children}
							</a>
						),

						// Code blocks with syntax highlighting
						code: ({ inline, className, children, ...props }: any) => {
							const match = (className || '').match(/language-(\w+)/);
							const language = match ? match[1] : 'text';
							const codeContent = String(children).replace(/\n$/, '');

							if (!inline && match) {
								return (
									<CodeBlockWithCopy
										language={language}
										codeContent={codeContent}
										syntaxStyle={syntaxStyle}
										bgColor={colors.bgActivity}
										borderColor={colors.border}
										textDimColor={colors.textDim}
										successColor={colors.success}
									/>
								);
							}

							// Inline code
							return (
								<code
									{...props}
									style={{
										backgroundColor: colors.bgActivity,
										padding: '2px 6px',
										borderRadius: '4px',
										fontSize: '0.9em',
										fontFamily:
											'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
									}}
								>
									{children}
								</code>
							);
						},

						// Paragraphs
						p: ({ children }) => <p style={{ margin: '8px 0' }}>{children}</p>,

						// Headings
						h1: ({ children }) => (
							<h1
								style={{
									fontSize: '1.5em',
									fontWeight: 600,
									margin: '16px 0 8px',
									color: colors.textMain,
								}}
							>
								{children}
							</h1>
						),
						h2: ({ children }) => (
							<h2
								style={{
									fontSize: '1.3em',
									fontWeight: 600,
									margin: '14px 0 6px',
									color: colors.textMain,
								}}
							>
								{children}
							</h2>
						),
						h3: ({ children }) => (
							<h3
								style={{
									fontSize: '1.15em',
									fontWeight: 600,
									margin: '12px 0 4px',
									color: colors.textMain,
								}}
							>
								{children}
							</h3>
						),
						h4: ({ children }) => (
							<h4
								style={{
									fontSize: '1.05em',
									fontWeight: 600,
									margin: '10px 0 4px',
									color: colors.textMain,
								}}
							>
								{children}
							</h4>
						),
						h5: ({ children }) => (
							<h5
								style={{
									fontSize: '1em',
									fontWeight: 600,
									margin: '8px 0 4px',
									color: colors.textMain,
								}}
							>
								{children}
							</h5>
						),
						h6: ({ children }) => (
							<h6
								style={{
									fontSize: '0.95em',
									fontWeight: 600,
									margin: '8px 0 4px',
									color: colors.textDim,
								}}
							>
								{children}
							</h6>
						),

						// Lists
						ul: ({ children }) => (
							<ul style={{ margin: '8px 0', paddingLeft: '24px', listStyleType: 'disc' }}>
								{children}
							</ul>
						),
						ol: ({ children }) => (
							<ol style={{ margin: '8px 0', paddingLeft: '24px', listStyleType: 'decimal' }}>
								{children}
							</ol>
						),
						li: ({ children }) => <li style={{ margin: '4px 0' }}>{children}</li>,

						// Blockquotes
						blockquote: ({ children }) => (
							<blockquote
								style={{
									margin: '8px 0',
									paddingLeft: '16px',
									borderLeft: `3px solid ${colors.accent}`,
									color: colors.textDim,
									fontStyle: 'italic',
								}}
							>
								{children}
							</blockquote>
						),

						// Horizontal rules
						hr: () => (
							<hr
								style={{
									margin: '16px 0',
									border: 'none',
									borderTop: `1px solid ${colors.border}`,
								}}
							/>
						),

						// Tables
						table: ({ children }) => (
							<div style={{ overflowX: 'auto', margin: '8px 0' }}>
								<table
									style={{
										width: '100%',
										borderCollapse: 'collapse',
										fontSize: '0.9em',
									}}
								>
									{children}
								</table>
							</div>
						),
						thead: ({ children }) => (
							<thead style={{ backgroundColor: colors.bgActivity }}>{children}</thead>
						),
						th: ({ children }) => (
							<th
								style={{
									padding: '8px 12px',
									textAlign: 'left',
									borderBottom: `2px solid ${colors.border}`,
									fontWeight: 600,
								}}
							>
								{children}
							</th>
						),
						td: ({ children }) => (
							<td
								style={{
									padding: '8px 12px',
									borderBottom: `1px solid ${colors.border}`,
								}}
							>
								{children}
							</td>
						),

						// Strong and emphasis
						strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
						em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,

						// Strikethrough (GFM)
						del: ({ children }) => (
							<del style={{ textDecoration: 'line-through', color: colors.textDim }}>
								{children}
							</del>
						),

						// Task list items (GFM) - handled by li with checkbox
						input: ({ type, checked, ...props }: any) => {
							if (type === 'checkbox') {
								return (
									<input
										type="checkbox"
										checked={checked}
										disabled
										style={{
											marginRight: '8px',
											accentColor: colors.accent,
										}}
										{...props}
									/>
								);
							}
							return <input type={type} {...props} />;
						},

						// Images
						img: ({ src, alt }) => (
							<img
								src={src}
								alt={alt || ''}
								style={{
									maxWidth: '100%',
									height: 'auto',
									borderRadius: '4px',
									margin: '8px 0',
								}}
							/>
						),
					}}
				>
					{content}
				</ReactMarkdown>
			</div>
		);
	}
);

MobileMarkdownRenderer.displayName = 'MobileMarkdownRenderer';

export default MobileMarkdownRenderer;
