/**
 * DataviewJsInlineQuery - an inline `` `$= expr` `` code span evaluated by DataviewJS (DV-11, DV-12, DV-14, DEV-5).
 *
 * The surface opts in through `dataviewInlineCodeRenderer()` (`dataviewSurface.ts`), next to inline `= expr`.
 * Outside a `DataviewDocumentContext`, with the Encore Feature off, or in an untitled buffer the span stays the
 * plain code it was. Inside, it follows the note's `useDataviewJsRunPolicy()`, as a `dataviewjs` block does:
 * - `disabled`: plain code;
 * - `desktop-only` (the browser build): the code plus the "DataviewJS runs in the desktop app" pill;
 * - `ask` (an untrusted vault): the code plus a Run button, which asks main for this session's grant
 *   (`dataview:jsRunOnce`) and then evaluates this span until its expression changes;
 * - `run`: the expression registers with the note's inline host (`DataviewJsInlineHost`), which evaluates it in
 *   the note's hidden guest with `dv` in scope; the value renders through `DataviewValue`.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { Theme } from '../../../types';
import { DataviewSettings } from '../../../../shared/dataview';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useDataviewJsRunPolicy } from '../../../hooks/file/useDataviewJsRunPolicy';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { useDataviewDocument, type DataviewDocumentScope } from './DataviewDocumentContext';
import { DataviewInlineError } from './DataviewInlineQuery';
import { useDataviewJsInlineStore, type DataviewJsInlineStore } from './DataviewJsInlineHost';
import { DataviewJsDesktopOnlyPill } from './DataviewJsBlock';
import { DataviewValue, DataviewValueProvider } from './DataviewValue';

/**
 * The expression of an inline DataviewJS span (`$= dv.pages().length` gives `dv.pages().length`), or null when
 * the span is not one: no `$=` prefix, or nothing after it.
 */
export function parseDataviewJsInlineQuery(code: string): string | null {
	const prefix = DataviewSettings.inlineJsQueryPrefix;
	if (!code.startsWith(prefix)) return null;
	const expression = code.slice(prefix.length).trim();
	return expression || null;
}

/** The `renderInlineCode` option for `` `$= expr` `` spans; returns null for every other span. */
export function createDataviewJsInlineCodeRenderer(
	theme: Theme
): (code: string, fallback: React.ReactElement) => React.ReactNode | null {
	return (code, fallback) => {
		const expression = parseDataviewJsInlineQuery(code);
		return expression === null ? null : (
			<DataviewJsInlineQuery expression={expression} theme={theme} fallback={fallback} />
		);
	};
}

export interface DataviewJsInlineQueryProps {
	/** The expression, without its `$=` prefix. */
	expression: string;
	theme: Theme;
	/** The span as plain code, shown wherever DataviewJS does not apply. */
	fallback: React.ReactElement;
}

export function DataviewJsInlineQuery(props: DataviewJsInlineQueryProps) {
	const doc = useDataviewDocument();
	const enabled = useSettingsStore((s) => s.encoreFeatures?.dataview === true);
	if (!doc || !enabled || !doc.filePath) return props.fallback;
	// A new note is a new span: a Run in one note never evaluates a span of another.
	return <PolicySpan key={`${doc.agentId}\0${doc.filePath}`} {...props} doc={doc} />;
}

function PolicySpan({
	expression,
	theme,
	fallback,
	doc,
}: DataviewJsInlineQueryProps & { doc: DataviewDocumentScope }) {
	const run = useDataviewJsRunPolicy(doc);
	const store = useDataviewJsInlineStore();
	// "Run" covers the expression as it was when the user chose it; an edit asks again.
	const [ranOnceFor, setRanOnceFor] = useState<string | null>(null);

	if (run.policy === 'disabled' || !store) return fallback;
	if (run.policy === 'desktop-only') {
		return (
			<span data-dataview-js-inline="" data-dataview-js-desktop-only="">
				{fallback} <DataviewJsDesktopOnlyPill theme={theme} />
			</span>
		);
	}
	if (run.policy === 'run' || (run.policy === 'ask' && ranOnceFor === expression)) {
		return <InlineValue expression={expression} theme={theme} fallback={fallback} store={store} />;
	}
	if (run.resolving) return <Placeholder fallback={fallback} />;
	return (
		<RunPrompt
			theme={theme}
			fallback={fallback}
			doc={doc}
			problem={run.error}
			onRan={() => setRanOnceFor(expression)}
		/>
	);
}

/** While the first answer is on its way, the span keeps its source in place, dimmed. */
function Placeholder({ fallback }: { fallback: React.ReactElement }) {
	return (
		<span data-dataview-inline-placeholder="" aria-busy="true" style={{ opacity: 0.5 }}>
			{fallback}
		</span>
	);
}

function RunPrompt({
	theme,
	fallback,
	doc,
	problem,
	onRan,
}: {
	theme: Theme;
	fallback: React.ReactElement;
	doc: DataviewDocumentScope;
	problem: string | null;
	onRan: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const runOnce = async () => {
		setBusy(true);
		setError(null);
		try {
			await window.maestro.dataview.jsRunOnce({ agentId: doc.agentId, filePath: doc.filePath });
			onRan();
		} catch (failure) {
			setError(ipcErrorMessage(failure));
		} finally {
			setBusy(false);
		}
	};
	const message = error ?? problem;
	return (
		<span data-dataview-js-inline="" data-dataview-js-trust="">
			{fallback}{' '}
			<button
				type="button"
				onClick={runOnce}
				disabled={busy}
				title="This inline DataviewJS query would read your vault when it runs, in an isolated sandbox. Run it this once, or trust the vault from a dataviewjs block or Settings."
				className="px-1 rounded disabled:opacity-50"
				style={{
					border: `1px solid ${theme.colors.border}`,
					color: theme.colors.textMain,
					fontSize: '0.8em',
				}}
			>
				Run
			</button>
			{message && (
				<>
					{' '}
					<DataviewInlineError theme={theme} title={message}>
						{message}
					</DataviewInlineError>
				</>
			)}
		</span>
	);
}

function InlineValue({
	expression,
	theme,
	fallback,
	store,
}: {
	expression: string;
	theme: Theme;
	fallback: React.ReactElement;
	store: DataviewJsInlineStore;
}) {
	useEffect(() => store.register(expression), [store, expression]);
	const outcome = useSyncExternalStore(store.subscribe, () => store.outcome(expression));

	if (outcome === null) return <Placeholder fallback={fallback} />;
	switch (outcome.kind) {
		case 'empty':
			return <span className="dataview dataview-inline-query" data-dataview-js-inline="" />;
		case 'value':
			return (
				<span className="dataview dataview-inline-query" data-dataview-js-inline="">
					<DataviewValueProvider root={outcome.root} theme={theme}>
						<DataviewValue value={outcome.value} />
					</DataviewValueProvider>
				</span>
			);
		case 'error': {
			// Upstream's wording (`DataviewInlineJSRenderer`).
			return (
				<DataviewInlineError theme={theme} title={outcome.message}>
					Dataview (for inline JS query &apos;{expression}&apos;): {outcome.message}
				</DataviewInlineError>
			);
		}
		case 'problem':
			return (
				<DataviewInlineError theme={theme} title={outcome.message}>
					{outcome.message}
				</DataviewInlineError>
			);
	}
}
