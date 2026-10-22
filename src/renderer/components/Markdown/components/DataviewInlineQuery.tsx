/**
 * DataviewInlineQuery - an inline `` `= expr` `` code span evaluated by Dataview
 * (DV-1, DV-7, DV-9, DV-10, D7).
 *
 * The surface opts in by passing `createDataviewInlineCodeRenderer(theme)` as the
 * `renderInlineCode` option of `createMarkdownComponents()`; no other surface
 * does, so chat and every other markdown keeps the span as code. Inside, the
 * same guards as `DataviewBlock` apply: outside a `DataviewDocumentContext`, with
 * the Encore Feature off, or in an untitled buffer the span renders as the plain
 * code it was.
 *
 * The expression runs in main (`window.maestro.dataview.queryInline`) with `this`
 * bound to the note on screen, and the value renders through `DataviewValue`, so
 * links, dates, and lists look the way they do in a block's table. The answer is
 * cached and refreshed on `dataview:changed` like a block's.
 */

import React, { useCallback } from 'react';
import type { Theme } from '../../../types';
import {
	DataviewSettings,
	reviveDataviewInlineResult,
	type DataviewQueryResponse,
	type RevivedDataviewInlineResult,
} from '../../../../shared/dataview';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useLiveDataviewResult } from '../../../hooks/file/useLiveDataviewResult';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { useDataviewDocument, type DataviewDocumentScope } from './DataviewDocumentContext';
import { DataviewValue, DataviewValueProvider } from './DataviewValue';

type DataviewInlineData = DataviewQueryResponse<RevivedDataviewInlineResult>;

/**
 * The expression of an inline query span (`= this.file.name` gives
 * `this.file.name`), or null when the span is not one: no `=` prefix, or
 * nothing after it.
 */
export function parseDataviewInlineQuery(code: string): string | null {
	const prefix = DataviewSettings.inlineQueryPrefix;
	if (!code.startsWith(prefix)) return null;
	const expression = code.slice(prefix.length).trim();
	return expression || null;
}

/** The cache key of one inline span's value. */
export function dataviewInlineCacheKey(
	agentId: string,
	filePath: string,
	expression: string
): string {
	return JSON.stringify(['dataview:inline', agentId, filePath, expression]);
}

/** The `renderInlineCode` option of `createMarkdownComponents()` for a Dataview surface. */
export function createDataviewInlineCodeRenderer(
	theme: Theme
): (code: string, fallback: React.ReactElement) => React.ReactNode | null {
	return (code, fallback) => {
		const expression = parseDataviewInlineQuery(code);
		return expression === null ? null : (
			<DataviewInlineQuery expression={expression} theme={theme} fallback={fallback} />
		);
	};
}

export interface DataviewInlineQueryProps {
	/** The expression, without its `=` prefix. */
	expression: string;
	theme: Theme;
	/** The span as plain code, shown wherever Dataview does not apply. */
	fallback: React.ReactElement;
}

export function DataviewInlineQuery({ expression, theme, fallback }: DataviewInlineQueryProps) {
	const doc = useDataviewDocument();
	const enabled = useSettingsStore((s) => s.encoreFeatures?.dataview === true);
	if (!doc || !enabled || !doc.filePath) return fallback;
	return <InlineQueryView expression={expression} theme={theme} fallback={fallback} doc={doc} />;
}

function InlineQueryView({
	expression,
	theme,
	fallback,
	doc,
}: DataviewInlineQueryProps & { doc: DataviewDocumentScope }) {
	const { agentId, filePath } = doc;
	const key = dataviewInlineCacheKey(agentId, filePath, expression);
	const fetchValue = useCallback(async (): Promise<DataviewInlineData> => {
		try {
			const response = await window.maestro.dataview.queryInline({
				filePath,
				expression,
				agentId,
			});
			return { ...response, result: reviveDataviewInlineResult(response.result) };
		} catch (error) {
			throw new Error(ipcErrorMessage(error));
		}
	}, [agentId, filePath, expression]);
	const { data, error, loading } = useLiveDataviewResult(key, fetchValue);

	if (data?.result.kind === 'value') {
		return (
			<span className="dataview dataview-inline-query" data-dataview-inline="">
				<DataviewValueProvider root={data.root} theme={theme}>
					<DataviewValue value={data.result.value} />
				</DataviewValueProvider>
			</span>
		);
	}
	const message = data?.result.kind === 'error' ? data.result.message : !loading ? error : null;
	if (message) {
		// Upstream's wording.
		return (
			<DataviewInlineError theme={theme} title={message}>
				Dataview (for inline query &apos;{expression}&apos;): {message}
			</DataviewInlineError>
		);
	}
	// While the first answer is on its way, the span keeps its source in place, dimmed.
	return (
		<span data-dataview-inline-placeholder="" aria-busy="true" style={{ opacity: 0.5 }}>
			{fallback}
		</span>
	);
}

/** An inline span's error text: a themed chip, since a block callout would break the line. */
export function DataviewInlineError({
	theme,
	title,
	children,
}: {
	theme: Theme;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<span
			data-dataview-inline-error=""
			title={title}
			style={{
				color: theme.colors.error,
				fontFamily: 'var(--maestro-font-mono, ui-monospace, SFMono-Regular, monospace)',
				fontSize: '0.85em',
			}}
		>
			{children}
		</span>
	);
}
