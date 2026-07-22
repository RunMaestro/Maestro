/**
 * MarkdownLink - the single anchor (`<a>`) renderer shared by every markdown
 * surface. It unifies the previously-divergent link handlers from the chat
 * renderer and the document factory, with per-surface differences expressed as
 * explicit behavior flags so no surface regresses.
 *
 * Supported targets (gated by config/behavior):
 *   - `maestro-file://` / `data-maestro-file`  -> onFileClick
 *   - `maestro://`                              -> openMaestroLink (always)
 *   - `#anchor`                                 -> onAnchorClick / scroll (behavior.anchors)
 *   - `http(s)://` / `file://` / `git@`         -> inline open (behavior.directExternal, chat)
 *   - `http(s)://` / `mailto:`                  -> onExternalLinkClick (doc)
 *   - relative path                             -> onFileClick (behavior.relativeAsFile, doc)
 *
 * Right-click context menus (chat) are opt-in via the onLinkContextMenu /
 * onFileContextMenu callbacks; when omitted, no context-menu handler is attached.
 */

import React from 'react';
import type { Theme } from '../../../types';
import { openUrl } from '../../../utils/openUrl';
import { openMaestroLink } from '../../../utils/openMaestroLink';
import { RenderedMentionChip } from './RenderedMentionChip';
import { parseConcertoHref, flashConcertoTarget } from '../../../utils/concertoLinks';
import { notifyToast } from '../../../stores/notificationStore';

export interface MarkdownLinkBehavior {
	/** Chat: handle http/file/git destinations inline via openUrl/openPath. */
	directExternal?: boolean;
	/** Doc: route `#anchor` links to onAnchorClick / in-container scroll. */
	anchors?: boolean;
	/** Doc: treat unmatched relative hrefs as file clicks. */
	relativeAsFile?: boolean;
	/**
	 * Pass `{ openInNewTab }` to onFileClick for `maestro-file://` links (doc).
	 * Chat omits options to preserve its historical single-argument call shape.
	 */
	fileClickOptions?: boolean;
}

export interface MarkdownLinkConfig {
	theme: Theme;
	/** Link text color slot. Chat uses accentText (legible on tinted bubbles); doc uses accent. */
	linkColor?: 'accent' | 'accentText';
	/** Project root for resolving relative file paths to absolute (context menu). */
	projectRoot?: string;
	onFileClick?: (filePath: string, options?: { openInNewTab?: boolean }) => void;
	onExternalLinkClick?: (href: string, options?: { ctrlKey?: boolean }) => void;
	onAnchorClick?: (anchorId: string) => void;
	/** Container for in-component anchor scrolling (falls back to document). */
	containerRef?: React.RefObject<HTMLElement>;
	/** Right-click on an external/maestro link. When set, attaches a context handler. */
	onLinkContextMenu?: (e: React.MouseEvent, url: string) => void;
	/** Right-click on a file link. Receives the resolved absolute path + file name. */
	onFileContextMenu?: (e: React.MouseEvent, absPath: string, fileName: string) => void;
	behavior?: MarkdownLinkBehavior;
}

/** Convert a `git@host:user/repo(.git)` SSH URL to an https URL, else return as-is. */
function gitToHttps(href: string): string {
	return href.startsWith('git@')
		? href
				.replace(/^git@/, 'https://')
				.replace(/:([^/])/, '/$1')
				.replace(/\.git$/, '')
		: href;
}

/**
 * Build the react-markdown `a` component for the given config. Returned as a
 * factory (not a component) because react-markdown calls components positionally
 * and we need the per-surface config closed over.
 */
export function createMarkdownLink(config: MarkdownLinkConfig) {
	const {
		theme,
		linkColor = 'accent',
		projectRoot,
		onFileClick,
		onExternalLinkClick,
		onAnchorClick,
		containerRef,
		onLinkContextMenu,
		onFileContextMenu,
		behavior = {},
	} = config;

	const color = linkColor === 'accentText' ? theme.colors.accentText : theme.colors.accent;
	const hasContextMenu = Boolean(onLinkContextMenu || onFileContextMenu);

	return function MarkdownLink({ node: _node, href, children, ...props }: any) {
		// Mention chips (remarkMentionChips) ride in as link nodes tagged with
		// data-mention-kind. Detect them first and hand off to the chip renderer
		// so they render as chips, not anchors. File chips still carry
		// data-maestro-file, so this branch MUST run before the file-link check.
		const mentionKind = props['data-mention-kind'] as 'file' | 'agent' | undefined;
		if (mentionKind === 'file' || mentionKind === 'agent') {
			return React.createElement(RenderedMentionChip, {
				kind: mentionKind,
				theme,
				filePath: props['data-maestro-file'] as string | undefined,
				extension: props['data-mention-ext'] as string | undefined,
				agentName: props['data-mention-name'] as string | undefined,
				onFileClick,
			});
		}

		// Concerto "point" links: `maestro://concerto/<movement|cadenza>/<id>`.
		// Render as an inline chip that flashes/focuses the referenced view, so an
		// agent's chat can point at a Movement/Cadenza instead of re-typing it.
		const concertoTarget = parseConcertoHref(href);
		if (concertoTarget) {
			const notifyUnavailable = () =>
				notifyToast({
					color: 'orange',
					title: 'Concerto unavailable',
					message: `The ${concertoTarget.surface} "${concertoTarget.id}" is no longer available. Ask the agent to recreate it.`,
				});
			return React.createElement(
				'button',
				{
					type: 'button',
					onClick: (e: React.MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						void flashConcertoTarget(href).then((opened) => {
							if (!opened) notifyUnavailable();
						}, notifyUnavailable);
					},
					title: `Show the ${concertoTarget.surface} "${concertoTarget.id}"`,
					className:
						'inline-flex items-center gap-1 px-1.5 py-px rounded align-baseline text-[0.92em] font-medium',
					style: {
						color: theme.colors.accentText ?? theme.colors.accent,
						backgroundColor: `${theme.colors.accent}22`,
						border: `1px solid ${theme.colors.accent}55`,
						cursor: 'pointer',
					},
				},
				'◉ ',
				children
			);
		}

		// Check for maestro-file:// protocol OR data-maestro-file attribute
		// (data attribute is the fallback when rehype strips custom protocols).
		const dataFilePath = props['data-maestro-file'] as string | undefined;
		const isMaestroFile = href?.startsWith('maestro-file://') || !!dataFilePath;
		const filePath =
			dataFilePath ??
			(href?.startsWith('maestro-file://') ? href.replace('maestro-file://', '') : null);
		const isAnchorLink = Boolean(href && href.startsWith('#'));

		const handleClick = (e: React.MouseEvent) => {
			e.preventDefault();
			const openInNewTab = e.metaKey || e.ctrlKey;

			if (isMaestroFile && filePath && onFileClick) {
				if (behavior.fileClickOptions) onFileClick(filePath, { openInNewTab });
				else onFileClick(filePath);
				return;
			}
			if (!href) return;

			if (href.startsWith('maestro://')) {
				openMaestroLink(href);
				return;
			}

			if (behavior.anchors && isAnchorLink) {
				const anchorId = href.slice(1);
				if (onAnchorClick) {
					onAnchorClick(anchorId);
				} else {
					const target = containerRef?.current
						? containerRef.current.querySelector(`#${CSS.escape(anchorId)}`)
						: document.getElementById(anchorId);
					if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}
				return;
			}

			if (behavior.directExternal) {
				// Chat: open http/https via openUrl; file:// via openPath; attempt
				// git@host:user/repo -> https conversion for anything else.
				// `metaKey || ctrlKey`: on macOS Cmd-click sets metaKey, so translate
				// it to the same ctrlKey inversion openUrl expects (#1060).
				if (/^file:\/\//.test(href)) {
					window.maestro.shell.openPath(href.replace(/^file:\/\//, ''));
				} else if (/^https?:\/\//.test(href)) {
					openUrl(href, { ctrlKey: e.metaKey || e.ctrlKey });
				} else {
					// gitToHttps is a pure string transform (no throw); convert and open
					// only if it produced an http(s) URL.
					const converted = gitToHttps(href);
					if (/^https?:\/\//.test(converted)) {
						openUrl(converted, { ctrlKey: e.metaKey || e.ctrlKey });
					}
				}
				return;
			}

			// Doc: route external links through the caller's callback.
			if (onExternalLinkClick && /^https?:\/\/|^mailto:/.test(href)) {
				onExternalLinkClick(href, { ctrlKey: e.metaKey || e.ctrlKey });
				return;
			}

			// Doc: treat remaining relative paths (e.g. LICENSE, ./README.md) as file links.
			if (
				behavior.relativeAsFile &&
				onFileClick &&
				!href.startsWith('mailto:') &&
				!/^https?:\/\//.test(href)
			) {
				onFileClick(href, { openInNewTab });
			}
		};

		const handleContextMenu = hasContextMenu
			? (e: React.MouseEvent) => {
					if (isMaestroFile && filePath && onFileContextMenu) {
						e.preventDefault();
						e.stopPropagation();
						// Resolve to absolute path for file operations.
						const absPath = filePath.startsWith('/')
							? filePath
							: projectRoot
								? `${projectRoot}/${filePath}`
								: filePath;
						const fileName = filePath.split('/').pop() || filePath;
						onFileContextMenu(e, absPath, fileName);
					} else if (href && onLinkContextMenu) {
						e.preventDefault();
						e.stopPropagation();
						onLinkContextMenu(e, href);
					}
				}
			: undefined;

		return React.createElement(
			'a',
			{
				href,
				...props,
				onClick: handleClick,
				onContextMenu: handleContextMenu,
				style: { color, textDecoration: 'underline', cursor: 'pointer' },
			},
			children
		);
	};
}
