import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Theme } from '../../../types';
import { useCachedResource } from '../../../hooks/utils/useCachedResource';
import { useElementWidth } from '../../../hooks/ui/useElementWidth';
import { resolveConcertoHtmlSrc } from '../../../utils/concertoHtmlSrc';
import { openUrl } from '../../../utils/openUrl';
import { requestCodexFollowup } from '../../../services/codexFollowup';
import {
	CODEX_VISUALIZATION_WIDE_MAX_WIDTH,
	MAX_CODEX_VISUALIZATION_HEIGHT,
	type CodexVisualizationLoadResult,
} from '../../../../shared/codexVisualization';
import { CodexFileCitation } from './CodexFileCitation';

/** Height before the frame reports its own, so the transcript does not jump twice. */
const INITIAL_HEIGHT = 240;
/** A normal-width visual stays at reading width; only `mode: "wide"` spreads out. */
const NORMAL_MAX_WIDTH = 768;

export interface CodexVisualizationFrameProps {
	/** Absolute path of the HTML fragment the agent wrote. */
	path: string;
	title?: string;
	/** `wide` for a full app mockup or side-by-side panels, per the skill. */
	mode?: string;
	theme: Theme;
	LinkComponent: (props: Record<string, unknown>) => ReactNode;
	/** The conversation this message belongs to; absent on surfaces with none. */
	conversation?: { sessionId: string; tabId: string };
}

interface BridgeMessage {
	type?: unknown;
	height?: unknown;
	href?: unknown;
	prompt?: unknown;
	id?: unknown;
}

/** Bridge actions that act outside the frame need a real click behind them. */
function userIsActing(): boolean {
	return navigator.userActivation?.isActive === true;
}

/**
 * A Codex `visualize` reference, drawn the way the Codex app draws it: the
 * agent's HTML fragment wrapped in Codex's own visualize kit (built in main
 * from the user's Codex install) and run in an isolated, sandboxed frame.
 *
 * This component is the host SHELL the kit's bridge expects. On load it hands
 * the frame one end of a MessageChannel, and from then on the frame can only
 * ask for four things: a height, a state write (refused - nothing persists),
 * an https link opened, and a follow-up prompt. The last two run only on a
 * real user click, and a follow-up only PREFILLS the composer: the prompt is
 * written by the agent's own HTML and must never send itself.
 *
 * The file chip stays above the frame, and stands in for it whenever the frame
 * cannot be built (an SSH agent, no visualize plugin, a missing file).
 */
export function CodexVisualizationFrame({
	path,
	title,
	mode,
	theme,
	LinkComponent,
	conversation,
}: CodexVisualizationFrameProps) {
	const sessionId = conversation?.sessionId;
	const { data } = useCachedResource<CodexVisualizationLoadResult>(
		`codex-visualization:${sessionId ?? ''}:${path}:${title ?? ''}`,
		() => window.maestro.codexVisualization.load({ sessionId, path, title })
	);
	const loaded = data?.ok ? data : null;

	const frameRef = useRef<HTMLIFrameElement>(null);
	const portRef = useRef<MessagePort | null>(null);
	const [height, setHeight] = useState(INITIAL_HEIGHT);
	const width = useElementWidth(frameRef, !!loaded);

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message = event.data as BridgeMessage | null;
			if (!message || typeof message !== 'object') return;
			if (message.type === 'height') {
				const next = message.height;
				if (typeof next === 'number' && Number.isFinite(next) && next >= 0) {
					setHeight(Math.ceil(Math.min(next, MAX_CODEX_VISUALIZATION_HEIGHT)));
				}
				return;
			}
			if (message.type === 'widget-state-write') {
				if (Number.isSafeInteger(message.id)) {
					portRef.current?.postMessage({ type: 'widget-state-result', id: message.id, ok: false });
				}
				return;
			}
			if (message.type === 'open-external') {
				if (typeof message.href !== 'string' || !userIsActing()) return;
				try {
					const url = new URL(message.href);
					if (url.protocol === 'https:') openUrl(url.href);
				} catch {
					// Not a URL; nothing to open.
				}
				return;
			}
			if (message.type === 'follow-up') {
				if (typeof message.prompt !== 'string' || !conversation || !userIsActing()) return;
				requestCodexFollowup({ ...conversation, prompt: message.prompt, mode: 'prefill' });
			}
		},
		[conversation]
	);

	const closePort = useCallback(() => {
		portRef.current?.close();
		portRef.current = null;
	}, []);

	const handleLoad = useCallback(() => {
		const target = frameRef.current?.contentWindow;
		if (!target) return;
		closePort();
		const channel = new MessageChannel();
		channel.port1.onmessage = handleMessage;
		portRef.current = channel.port1;
		// The frame's origin is opaque (sandboxed), so `*` is the only target
		// that reaches it. The port, not the origin, is what scopes the channel.
		target.postMessage({ type: 'codex-visualization-initialize' }, '*', [channel.port2]);
	}, [closePort, handleMessage]);

	// Keep the live port answering with the newest handler.
	useEffect(() => {
		if (portRef.current) portRef.current.onmessage = handleMessage;
	}, [handleMessage]);

	useEffect(() => closePort, [closePort]);

	// A narrower column rewraps the content; ask the frame to report again.
	useEffect(() => {
		if (width > 0) portRef.current?.postMessage({ type: 'measure' });
	}, [width]);

	const chip = (
		<CodexFileCitation
			path={path}
			purpose="output"
			artifactKind="visualization"
			theme={theme}
			LinkComponent={LinkComponent}
		/>
	);

	if (!loaded) {
		return (
			<span
				data-testid="codex-visualization"
				data-visualization-state={data ? 'unavailable' : 'loading'}
				title={data && !data.ok ? data.message : undefined}
			>
				{chip}
			</span>
		);
	}

	return (
		<span
			data-testid="codex-visualization"
			data-visualization-state="ready"
			style={{
				display: 'block',
				width: '100%',
				maxWidth: mode === 'wide' ? CODEX_VISUALIZATION_WIDE_MAX_WIDTH : NORMAL_MAX_WIDTH,
				margin: '0.5em 0',
			}}
		>
			{chip}
			<iframe
				ref={frameRef}
				src={resolveConcertoHtmlSrc('visualization', loaded.id, loaded.revision)}
				// The served CSP carries `sandbox allow-scripts` too; the attribute
				// keeps the frame sandboxed even if a header is ever lost in transit.
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				title={title || 'Codex visualization'}
				onLoad={handleLoad}
				style={{
					display: 'block',
					width: '100%',
					height,
					marginTop: '0.4em',
					border: `1px solid ${theme.colors.border}`,
					borderRadius: 8,
					// The kit picks light or dark from prefers-color-scheme, which a
					// frame reads off its embedder's color-scheme.
					colorScheme: theme.mode === 'light' ? 'light' : 'dark',
				}}
			/>
		</span>
	);
}
