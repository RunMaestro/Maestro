import { memo, useEffect, useRef, useState } from 'react';
import { Clipboard } from 'lucide-react';
import type { Theme } from '../../types';
import { captureException } from '../../utils/sentry';
import {
	ensureLanguage,
	getHighlighter,
	resolveLanguage,
	resolveLanguageSync,
	themeNameForMode,
} from '../../utils/shiki/highlighterManager';
import { detectLanguage } from '../../utils/shiki/languageDetect';
import { useDebouncedValue } from '../../hooks/utils/useThrottle';
import { LanguagePicker } from './LanguagePicker';

interface CodeFenceProps {
	/** Raw fence tag from the markdown (e.g. `'ts'`, `''`, `'TypeScript'`). */
	language: string;
	/** Code content (already stripped of trailing newline). */
	code: string;
	theme: Theme;
	onCopy: (text: string) => void;
}

const FALLBACK_LANG = 'text';

// Auto-detection only needs to run once a fence has settled, not on every
// streamed character. Debouncing the `code` value that feeds detection keeps
// `detectLanguage` from churning (and flickering the picker) while tokens
// stream in, while still resolving untagged fences shortly after they stop
// growing. Highlighting itself is NOT debounced - it tracks `code` live.
export const DETECTION_DEBOUNCE_MS = 150;

function isExplicitLang(lang: string): boolean {
	return Boolean(lang) && lang !== FALLBACK_LANG;
}

/**
 * Renders a code fence with Shiki syntax highlighting. Falls back to a plain
 * `<pre>` while Shiki loads, while detection runs, or when the resolved
 * language has no Shiki grammar. The language picker lets the user override
 * the (auto-detected or fence-tagged) language at any time.
 */
export const CodeFence = memo(function CodeFence({
	language,
	code,
	theme,
	onCopy,
}: CodeFenceProps) {
	// What the picker shows / what Shiki renders. Starts from the fence tag
	// (resolved against our local alias table so common short tags like `js`
	// surface as `javascript` on first paint), overridden by detection on
	// no-language fences, overridden again by user picker choice.
	const [resolvedLang, setResolvedLang] = useState<string>(
		() => resolveLanguageSync(language) ?? language ?? FALLBACK_LANG
	);
	const [html, setHtml] = useState<string | null>(null);
	const userOverrodeRef = useRef(false);

	// Debounced code feeds auto-detection only. Without this, the effect below
	// re-runs (and re-detects) on every streamed character, which flickers the
	// resolved language and, by extension, the highlight effect.
	const debouncedCode = useDebouncedValue(code, DETECTION_DEBOUNCE_MS);

	// Resolve the fence tag to a canonical Shiki id (handles aliases). Once
	// the user picks a language via the dropdown (`userOverrodeRef`), this
	// effect stays out of the way for the lifetime of the component instance -
	// including re-checking the ref after every `await`, since a streaming
	// `code` update could land mid-detection and try to overwrite the choice.
	useEffect(() => {
		if (userOverrodeRef.current) return;
		let cancelled = false;
		const stale = () => cancelled || userOverrodeRef.current;
		// Skip a redundant state update (and the highlight re-run it triggers)
		// when detection lands on the value we're already showing.
		const applyLang = (next: string) => {
			setResolvedLang((prev) => (prev === next ? prev : next));
		};
		void (async () => {
			// An explicit, resolvable fence tag (e.g. `ts`, `python`) is trusted
			// as-is. We only consult the alias table for explicit tags - a bare
			// fence resolves to `text`, which would otherwise short-circuit the
			// auto-detection below and leave untagged code blocks unhighlighted.
			const resolved = isExplicitLang(language) ? await resolveLanguage(language) : null;
			if (stale()) return;
			if (resolved) {
				applyLang(resolved);
				return;
			}
			// No explicit language (or an unknown tag) - guess from the body.
			// Uses the debounced snapshot so streaming doesn't re-detect per char.
			const detected = await detectLanguage(debouncedCode);
			if (stale()) return;
			applyLang(detected?.language ?? FALLBACK_LANG);
		})();
		return () => {
			cancelled = true;
		};
	}, [language, debouncedCode]);

	// Highlight whenever the resolved language, code, or theme changes.
	useEffect(() => {
		if (resolvedLang === FALLBACK_LANG) {
			setHtml(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const highlighter = await getHighlighter();
				const lang = await ensureLanguage(highlighter, resolvedLang);
				if (cancelled || !lang) {
					if (!cancelled) setHtml(null);
					return;
				}
				const themeName = themeNameForMode(theme.mode);
				const rendered = highlighter.codeToHtml(code, { lang, theme: themeName });
				if (!cancelled) setHtml(rendered);
			} catch (err) {
				// Shiki failed (WASM load, missing grammar, malformed theme, …).
				// Reset to the plain fallback so the user still sees the code, and
				// report so we hear about real regressions in production.
				if (!cancelled) setHtml(null);
				captureException(err, {
					extra: { component: 'CodeFence', lang: resolvedLang, themeMode: theme.mode },
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [resolvedLang, code, theme.mode]);

	const handlePickerChange = (lang: string) => {
		userOverrodeRef.current = true;
		setResolvedLang(lang);
	};

	const containerStyle = {
		margin: '0.5em 0',
		borderRadius: '6px',
		background: html ? undefined : theme.colors.bgSidebar,
		border: `1px solid ${theme.colors.border}`,
		overflow: 'hidden' as const,
		fontSize: '0.9em',
		// Contain the fence's internal z-index (picker/copy buttons sit at z-10)
		// to its own stacking context. Without this, those positioned children
		// are hoisted into the ancestor context and paint over the terminal
		// overlay (z-index: 1) when the terminal tab is active. The language
		// picker popover is portaled to document.body, so it's unaffected.
		isolation: 'isolate' as const,
	};

	const fallbackPreStyle = {
		margin: 0,
		// Extra top padding reserves room for the language picker (top-left) and
		// copy button (top-right) overlaid by CodeFence so the first line never
		// renders underneath them. Kept in sync with the Shiki path in index.css
		// (.code-fence .shiki-host pre.shiki).
		padding: '2.75em 1em 1em',
		background: 'transparent',
		color: theme.colors.textMain,
		overflowX: 'auto' as const,
		whiteSpace: 'pre' as const,
	};

	return (
		<div
			className="relative code-fence"
			translate="no"
			style={containerStyle}
			data-testid="code-fence"
			data-language={resolvedLang}
		>
			<div className="absolute top-2 left-2 z-10 flex items-center gap-1">
				<LanguagePicker theme={theme} language={resolvedLang} onChange={handlePickerChange} />
			</div>
			{html ? (
				// Shiki emits `<pre class="shiki" style="background:...">` with its own
				// theme background and inline token styles. dangerouslySetInnerHTML is
				// safe: the HTML comes from Shiki (HTML-escaped) - not user-supplied.
				<div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<pre style={fallbackPreStyle}>
					<code>{code}</code>
				</pre>
			)}
			<button
				onClick={() => onCopy(code)}
				className="absolute top-2 right-2 p-1.5 rounded opacity-70 hover:opacity-100 transition-opacity z-10"
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textDim,
					border: `1px solid ${theme.colors.border}`,
				}}
				title="Copy code"
			>
				<Clipboard className="w-3.5 h-3.5" />
			</button>
		</div>
	);
});
