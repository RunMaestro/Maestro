/**
 * StreamingDocumentPreview.tsx
 *
 * Component that shows document content as it streams in.
 * Features:
 * - Monospace font for raw content display
 * - Cursor blink at end of content
 * - Incremental markdown parsing and rendering
 * - Document filename displayed at top
 * - Progress indicator showing "Generating Phase X of Y..." when multiple documents
 *
 * Used by DocumentGenerationView during document generation phase.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { FileText, Code2, AlignLeft } from 'lucide-react';
import type { Theme } from '../../types';
import {
	REMARK_GFM_PLUGINS,
	createMarkdownComponents,
	generateInlineWizardPreviewProseStyles,
} from '../../utils/markdownConfig';

/**
 * Props for StreamingDocumentPreview
 */
export interface StreamingDocumentPreviewProps {
	/** Theme for styling */
	theme: Theme;
	/** Streaming content being generated */
	content: string;
	/** Filename of the document being generated */
	filename?: string;
	/** Current phase/document being generated (1-indexed) */
	currentPhase?: number;
	/** Total number of phases/documents to generate */
	totalPhases?: number;
}

/**
 * View mode for the streaming preview
 */
type ViewMode = 'raw' | 'markdown';

/**
 * Check if markdown content seems complete enough for preview
 * (has no unclosed code blocks or other obvious incomplete structures)
 */
function isMarkdownPreviewable(content: string): boolean {
	// Count backtick blocks - if odd number of triple backticks, we're in a code block
	const codeBlockMatches = content.match(/```/g);
	if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
		return false;
	}
	return true;
}

/**
 * Clean incomplete markdown for safer rendering
 * Closes any unclosed structures at the end
 */
function cleanIncompleteMarkdown(content: string): string {
	let cleaned = content;

	// If we end in the middle of a code block, close it
	const codeBlockMatches = cleaned.match(/```/g);
	if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
		cleaned += '\n```';
	}

	// If we end in the middle of a link, close it
	// Match unclosed [text]( patterns
	if (/\[[^\]]*\]\([^)]*$/.test(cleaned)) {
		cleaned += ')';
	}

	return cleaned;
}

/**
 * StreamingDocumentPreview - Shows document content as it streams in
 *
 * Supports two view modes:
 * - Raw: Shows content as-is with monospace font and blinking cursor
 * - Markdown: Incrementally parses and renders markdown (with some cleaning for incomplete content)
 */
export function StreamingDocumentPreview({
	theme,
	content,
	filename,
	currentPhase,
	totalPhases,
}: StreamingDocumentPreviewProps): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const [viewMode, setViewMode] = useState<ViewMode>('raw');
	const [userScrolled, setUserScrolled] = useState(false);

	// Auto-scroll to bottom as content streams (unless user has scrolled up)
	useEffect(() => {
		if (containerRef.current && !userScrolled) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [content, userScrolled]);

	// Reset user scroll when content resets (new document)
	useEffect(() => {
		setUserScrolled(false);
	}, [filename]);

	// Handle scroll to detect if user has manually scrolled
	const handleScroll = () => {
		if (!containerRef.current) return;

		const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
		const isNearBottom = scrollHeight - scrollTop - clientHeight < 50;

		// If user scrolls up, stop auto-scroll. If they scroll back to bottom, resume.
		setUserScrolled(!isNearBottom);
	};

	// Clean content for markdown preview
	const cleanedContent = useMemo(() => cleanIncompleteMarkdown(content), [content]);

	// Determine if markdown preview is safe
	const canPreviewMarkdown = useMemo(() => isMarkdownPreviewable(content), [content]);

	// Prose styles for markdown preview - scoped to .streaming-preview
	const proseStyles = useMemo(
		() => generateInlineWizardPreviewProseStyles(theme, '.streaming-preview', 'streaming'),
		[theme]
	);

	// Markdown components for rendering
	const markdownComponents = useMemo(
		() =>
			createMarkdownComponents({
				theme,
				onExternalLinkClick: (href) => window.maestro.shell.openExternal(href),
				codeBlockStyle: {
					padding: '0.75em',
					fontSize: '0.85em',
				},
			}),
		[theme]
	);

	return (
		<div className="flex flex-col h-full streaming-preview">
			{/* Header with filename, progress, and view toggle */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgActivity,
				}}
			>
				<div className="flex items-center gap-2">
					<FileText className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{filename || 'Generating...'}
					</span>
				</div>

				<div className="flex items-center gap-3">
					{/* Progress indicator */}
					{currentPhase !== undefined && totalPhases !== undefined && totalPhases > 1 && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Generating Phase {currentPhase} of {totalPhases}...
						</span>
					)}

					{/* View mode toggle */}
					<div
						className="flex items-center rounded overflow-hidden"
						style={{ border: `1px solid ${theme.colors.border}` }}
					>
						<button
							onClick={() => setViewMode('raw')}
							className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${
								viewMode === 'raw' ? 'font-medium' : ''
							}`}
							style={{
								backgroundColor: viewMode === 'raw' ? theme.colors.bgSidebar : 'transparent',
								color: viewMode === 'raw' ? theme.colors.textMain : theme.colors.textDim,
							}}
							title="Raw view (monospace)"
						>
							<Code2 className="w-3 h-3" />
							Raw
						</button>
						<button
							onClick={() => setViewMode('markdown')}
							disabled={!canPreviewMarkdown}
							className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${
								viewMode === 'markdown' ? 'font-medium' : ''
							} ${!canPreviewMarkdown ? 'opacity-50 cursor-not-allowed' : ''}`}
							style={{
								backgroundColor: viewMode === 'markdown' ? theme.colors.bgSidebar : 'transparent',
								color: viewMode === 'markdown' ? theme.colors.textMain : theme.colors.textDim,
								borderLeft: `1px solid ${theme.colors.border}`,
							}}
							title={
								canPreviewMarkdown
									? 'Markdown preview'
									: 'Markdown preview unavailable (code block in progress)'
							}
						>
							<AlignLeft className="w-3 h-3" />
							Preview
						</button>
					</div>
				</div>
			</div>

			{/* Streaming content */}
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto p-4"
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
				}}
			>
				{viewMode === 'raw' ? (
					/* Raw view with monospace font and cursor */
					<pre
						className="whitespace-pre-wrap break-words font-mono text-sm"
						style={{ color: theme.colors.textMain }}
					>
						{content}
						<span
							className="inline-block w-2 h-4 ml-0.5 align-text-bottom animate-pulse"
							style={{ backgroundColor: theme.colors.accent }}
						>
							▊
						</span>
					</pre>
				) : (
					/* Markdown preview */
					<div className="prose prose-sm max-w-none text-sm">
						<style>{proseStyles}</style>
						<ReactMarkdown remarkPlugins={REMARK_GFM_PLUGINS} components={markdownComponents}>
							{cleanedContent}
						</ReactMarkdown>
						{/* Blinking cursor at end */}
						<span
							className="inline-block w-2 h-4 ml-0.5 align-text-bottom animate-pulse"
							style={{ backgroundColor: theme.colors.accent }}
						>
							▊
						</span>
					</div>
				)}
			</div>

			{/* User scroll indicator */}
			{userScrolled && (
				<div className="absolute bottom-4 left-1/2 transform -translate-x-1/2">
					<button
						onClick={() => {
							setUserScrolled(false);
							if (containerRef.current) {
								containerRef.current.scrollTop = containerRef.current.scrollHeight;
							}
						}}
						className="px-3 py-1.5 rounded-full text-xs shadow-lg transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						↓ Resume auto-scroll
					</button>
				</div>
			)}
		</div>
	);
}

export default StreamingDocumentPreview;
