/**
 * createChatMarkdownComponents - the react-markdown component map for chat
 * surfaces (AI Terminal, Group Chat, History, Feedback, Director's Notes,
 * Document Graph). Moved out of MarkdownRenderer so the `<Markdown>` shell owns
 * a single implementation while MarkdownRenderer becomes a thin wrapper.
 *
 * Chat-specific element styling lives here (scroll-wrapped tables, accentText
 * links, Shiki code fences, IPC-loaded local images, bionify-aware prose). The
 * genuinely shared leaf pieces (links, inline code, code fences) come from the
 * Markdown/components/* modules, shared with the document factory.
 */

import React from 'react';
import type { Components } from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import type { Theme } from '../../types';
import { applyReadableTextTransforms } from '../../utils/markdownConfig';
import { LocalImage } from './components/LocalImage';
import { InlineCode } from './components/InlineCode';
import { createMarkdownLink } from './components/MarkdownLink';
import { createShikiCodeBlock } from './components/ShikiCodeBlock';
import { AlertCallout } from './components/AlertCallout';
import { FollowupChip } from './components/FollowupChip';
import { alertTypeFromClassName } from './remarkAlert';
import { readCodexDirectiveProps } from './remarkCodexDirectives';
import { requestCodexFollowup } from '../../services/codexFollowup';

export interface ChatMarkdownComponentsOptions {
	theme: Theme;
	/** Copy callback for code-fence copy buttons. */
	onCopy: (text: string) => void;
	/** Callback when an internal file link is clicked. */
	onFileClick?: (path: string) => void;
	/** Project root for resolving relative file paths (context menu). */
	projectRoot?: string;
	/** SSH remote ID for remote image loading. */
	sshRemoteId?: string;
	/** Bionify reading-mode emphasis (prose nodes only). */
	enableBionifyReadingMode?: boolean;
	bionifyIntensity?: number;
	bionifyAlgorithm?: string;
	/** Right-click handlers (owned by the shell so it can render the menus). */
	onLinkContextMenu: (e: React.MouseEvent, url: string) => void;
	onFileContextMenu: (e: React.MouseEvent, absPath: string, fileName: string) => void;
	/**
	 * Which conversation a clicked `:codex-followup` chip belongs to. Present
	 * only where a Codex agent's own message is being drawn, because that is the
	 * only place a directive is an OFFER rather than text somebody typed. Absent
	 * makes the chip inert: the directive renders as the plain span it already
	 * is, with no control to press.
	 */
	codexFollowup?: { sessionId: string; tabId: string };
}

export function createChatMarkdownComponents(
	options: ChatMarkdownComponentsOptions
): Partial<Components> {
	const {
		theme,
		onCopy,
		onFileClick,
		projectRoot,
		sshRemoteId,
		enableBionifyReadingMode = false,
		bionifyIntensity,
		bionifyAlgorithm,
		onLinkContextMenu,
		onFileContextMenu,
		codexFollowup,
	} = options;

	const withReadableTransforms = (children: React.ReactNode) =>
		applyReadableTextTransforms(children, {
			theme,
			enableBionifyReadingMode,
			bionifyIntensity,
			bionifyAlgorithm,
		});

	// Chat link + code-fence renderers share the same leaf modules as the
	// document path; chat behavior (accentText links, inline external handling,
	// Shiki code fences, right-click context menus) is selected via config.
	const ChatLink = createMarkdownLink({
		theme,
		linkColor: 'accentText',
		projectRoot,
		onFileClick,
		onLinkContextMenu,
		onFileContextMenu,
		behavior: { directExternal: true },
	});
	const ChatCodeBlock = createShikiCodeBlock(theme, onCopy);

	return {
		a: ChatLink,
		pre: ChatCodeBlock,
		code: ({
			node: _node,
			className,
			children,
			style,
			...props
		}: JSX.IntrinsicElements['code'] & ExtraProps) => (
			// Inline code only - block code is handled by the pre component above
			<InlineCode className={className} style={style} passthrough={props}>
				{children}
			</InlineCode>
		),
		p: ({ node: _node, children, ...props }: JSX.IntrinsicElements['p'] & ExtraProps) => (
			<p {...props}>{withReadableTransforms(children)}</p>
		),
		li: ({ node: _node, children, ...props }: JSX.IntrinsicElements['li'] & ExtraProps) => (
			<li {...props}>{withReadableTransforms(children)}</li>
		),
		blockquote: ({
			node: _node,
			children,
			className,
			...props
		}: JSX.IntrinsicElements['blockquote'] & ExtraProps) => {
			// remarkAlert tags GitHub `[!NOTE]`-style blockquotes with a
			// markdown-alert-<type> class; render those as styled callouts.
			const alertType = alertTypeFromClassName(className);
			if (alertType) {
				return (
					<AlertCallout type={alertType} theme={theme}>
						{withReadableTransforms(children)}
					</AlertCallout>
				);
			}
			return (
				<blockquote className={className} {...props}>
					{withReadableTransforms(children)}
				</blockquote>
			);
		},
		h1: ({ node: _node, children, ...props }: JSX.IntrinsicElements['h1'] & ExtraProps) => (
			<h1 {...props}>{withReadableTransforms(children)}</h1>
		),
		h2: ({ node: _node, children, ...props }: JSX.IntrinsicElements['h2'] & ExtraProps) => (
			<h2 {...props}>{withReadableTransforms(children)}</h2>
		),
		h3: ({ node: _node, children, ...props }: JSX.IntrinsicElements['h3'] & ExtraProps) => (
			<h3 {...props}>{withReadableTransforms(children)}</h3>
		),
		h4: ({ node: _node, children, ...props }: JSX.IntrinsicElements['h4'] & ExtraProps) => (
			<h4 {...props}>{withReadableTransforms(children)}</h4>
		),
		h5: ({ node: _node, children, ...props }: JSX.IntrinsicElements['h5'] & ExtraProps) => (
			<h5 {...props}>{withReadableTransforms(children)}</h5>
		),
		h6: ({ node: _node, children, ...props }: JSX.IntrinsicElements['h6'] & ExtraProps) => (
			<h6 {...props}>{withReadableTransforms(children)}</h6>
		),
		img: ({ node: _node, src, alt, ...props }: JSX.IntrinsicElements['img'] & ExtraProps) => {
			// Use LocalImage component to handle file:// URLs via IPC.
			// Extract width from data-maestro-width attribute if present.
			const widthStr = (props as Record<string, unknown>)['data-maestro-width'] as
				| string
				| undefined;
			const width = widthStr ? parseInt(widthStr, 10) : undefined;

			return (
				<LocalImage src={src} alt={alt} theme={theme} width={width} sshRemoteId={sshRemoteId} />
			);
		},
		table: ({ node: _node, style, ...props }: JSX.IntrinsicElements['table'] & ExtraProps) => (
			<div className="overflow-x-auto scrollbar-thin" style={{ maxWidth: '100%' }}>
				<table
					{...props}
					style={{
						minWidth: '100%',
						borderCollapse: 'collapse',
						...(style || {}),
					}}
				/>
			</div>
		),
		th: ({ node: _node, style, children, ...props }: JSX.IntrinsicElements['th'] & ExtraProps) => (
			<th
				{...props}
				style={{
					padding: '8px 12px',
					textAlign: 'left',
					borderBottom: `1px solid ${theme.colors.border}`,
					whiteSpace: 'nowrap',
					...(style || {}),
				}}
			>
				{withReadableTransforms(children)}
			</th>
		),
		td: ({ node: _node, style, children, ...props }: JSX.IntrinsicElements['td'] & ExtraProps) => (
			<td
				{...props}
				style={{
					padding: '8px 12px',
					borderBottom: `1px solid ${theme.colors.border}`,
					wordWrap: 'break-word',
					overflowWrap: 'break-word',
					whiteSpace: 'normal',
					verticalAlign: 'top',
					...(style || {}),
				}}
			>
				{withReadableTransforms(children)}
			</td>
		),
		// Inline SVG diagrams (rehype-raw + sanitize let agents draw). The
		// right-click Copy/Save menu comes from the app-wide delegated listener in
		// ImageContextMenuHost, so nothing is wired here.
		svg: ({ node: _node, children, ...props }: JSX.IntrinsicElements['svg'] & ExtraProps) => (
			<svg {...props}>{children}</svg>
		),
		// Strip event handler attributes (e.g. onToggle) that rehype-raw may
		// pass through as strings from AI-generated HTML, which React rejects.
		// Fixes MAESTRO-8Q
		details: ({
			node: _node,
			onToggle: _onToggle,
			...props
		}: JSX.IntrinsicElements['details'] & ExtraProps) => <details {...props} />,
		/*
		 * Codex assistant directives, tagged as spans by `remarkCodexDirectives`.
		 *
		 * Every branch that is not a wired-up followup falls through to the plain
		 * span with its children, which keeps the override inert in the two places
		 * it has to be: a surface with no `codexFollowup` context (a non-Codex
		 * agent, a user message, a tool result), and any other span in the
		 * message - chat renders sanitized raw HTML, so an agent drawing its own
		 * `<span>` must still get one.
		 *
		 * Only `codex-followup` draws a chip today. The rest of the allowlist is
		 * recognized by the parser but has no click behavior to offer yet, and a
		 * directive with no renderer is better left as the text it arrived as than
		 * turned into a chip that does nothing.
		 */
		span: ({ node: _node, children, ...props }: JSX.IntrinsicElements['span'] & ExtraProps) => {
			const plain = <span {...props}>{children}</span>;
			if (!codexFollowup) return plain;

			const directive = readCodexDirectiveProps(props as Record<string, unknown>);
			if (!directive || directive.name !== 'codex-followup') return plain;

			const { sessionId, tabId } = codexFollowup;
			const prompt = directive.attributes.prompt ?? '';
			return (
				<FollowupChip
					// The `[Label]` is optional in the grammar even though the bundled
					// skills always emit one. Showing the prompt is the honest fallback:
					// the alternative is a chip with nothing but an arrow on it, which
					// says less about what a click does than the wire text did.
					label={directive.label || prompt}
					prompt={prompt}
					sessionId={sessionId}
					tabId={tabId}
					theme={theme}
					onActivate={(mode) => requestCodexFollowup({ prompt, sessionId, tabId, mode })}
				/>
			);
		},
	};
}
