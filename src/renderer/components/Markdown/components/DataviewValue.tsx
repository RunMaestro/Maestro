/**
 * DataviewValue - one Dataview value as the preview shows it (DV-1, DV-8).
 *
 * Mirrors upstream's `renderValue` (Dataview 0.5.68, `ui/render.ts`): dates and
 * durations in Dataview's default formats, nulls as `renderNullAs`, strings as
 * compact markdown, lists inline (`a, b`) or expanded into a `<ul>`, objects as
 * `key: value` pairs, and the list-pair and external-link widgets.
 *
 * Links render through the document preset's own `MarkdownLink`, so they look
 * like a `[[link]]` in File Preview and open through the same `onFileClick` path.
 * A `Link` value is already resolved by main (its path is vault-relative); a raw
 * `[[target]]` inside a markdown string is resolved by Dataview's resolver in main
 * (`link("target")`) when it is clicked.
 *
 * A `DataviewValueScope` provider (one per block or inline span) supplies the
 * vault root and the link component, so a 25-row table builds one link renderer,
 * not one per cell.
 */

import React, { createContext, memo, useContext, useMemo } from 'react';
import type { Theme } from '../../../types';
import {
	DataviewSettings,
	Values,
	Widgets,
	currentLocale,
	dataviewLinkLabel,
	mayContainMarkdown,
	renderMinimalDate,
	renderMinimalDuration,
	reviveDataviewInlineResult,
	type Literal,
} from '../../../../shared/dataview';
import { isAbsolutePath, joinPath } from '../../../../shared/formatters';
import { openUrl } from '../../../utils/openUrl';
import { Markdown } from '../Markdown';
import { DATAVIEW_CELL_REMARK_PLUGINS } from '../remarkDataviewCell';
import { createMarkdownLink } from './MarkdownLink';
import { useDataviewDocument, type DataviewDocumentScope } from './DataviewDocumentContext';

type LinkOptions = { openInNewTab?: boolean };

interface DataviewValueScope {
	theme: Theme;
	/** The vault root the result came from; `Link` paths are relative to it. */
	root: string;
	/** The document preset's link leaf, bound to this scope's handlers. */
	LinkComponent: React.ComponentType<any>;
	/** Open a file reference found in a value: absolute paths as they are, others through the resolver. */
	openReference: (target: string, options?: LinkOptions) => void;
}

const DataviewValueContext = createContext<DataviewValueScope | null>(null);

function openExternal(href: string, options?: { ctrlKey?: boolean }): void {
	openUrl(href, { ctrlKey: options?.ctrlKey });
}

/** A DQL string literal for `value` (Dataview escapes `"` and `\` with a backslash). */
function dqlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Resolve a vault-relative reference (`Note`, `Folder/Note`, `Note#Heading`) the
 * way Dataview resolves a link, then open the file. Falls back to the path under
 * the root when the resolver has no answer, which fails as quietly as a stale
 * `[[link]]` does in the preview.
 */
async function resolveAndOpen(
	doc: DataviewDocumentScope,
	root: string,
	target: string,
	options?: LinkOptions
): Promise<void> {
	const filePart = target.replace(/#.*$/, '').trim();
	if (!filePart) return;
	let resolved = joinPath(root, filePart);
	try {
		const response = await window.maestro.dataview.queryInline({
			filePath: doc.filePath,
			agentId: doc.agentId,
			expression: `link(${dqlString(filePart)})`,
		});
		const result = reviveDataviewInlineResult(response.result);
		if (result.kind === 'value' && Values.isLink(result.value)) {
			resolved = joinPath(response.root, result.value.path);
		}
	} catch {
		// The fallback path above stands; the preview opens a stale link the same way.
	}
	doc.openLink(resolved, options);
}

/** Supplies the root and link handling every `DataviewValue` below it uses. */
export function DataviewValueProvider({
	root,
	theme,
	children,
}: {
	root: string;
	theme: Theme;
	children: React.ReactNode;
}) {
	const doc = useDataviewDocument();
	const scope = useMemo<DataviewValueScope>(() => {
		const openReference = (target: string, options?: LinkOptions) => {
			if (!doc) return;
			if (isAbsolutePath(target)) doc.openLink(target, options);
			else void resolveAndOpen(doc, root, target, options);
		};
		return {
			theme,
			root,
			openReference,
			LinkComponent: createMarkdownLink({
				theme,
				linkColor: 'accent',
				onFileClick: openReference,
				onExternalLinkClick: openExternal,
				behavior: { relativeAsFile: true, fileClickOptions: true },
			}),
		};
	}, [doc, root, theme]);
	return <DataviewValueContext.Provider value={scope}>{children}</DataviewValueContext.Provider>;
}

/** A markdown string rendered compact (inline when it is one paragraph), as Dataview does. */
export const DataviewMarkdown = memo(function DataviewMarkdown({ text }: { text: string }) {
	const scope = useContext(DataviewValueContext);
	if (!scope || !mayContainMarkdown(text)) return <>{text}</>;
	return (
		<Markdown
			preset="document"
			content={text}
			theme={scope.theme}
			frontmatter={false}
			onFileClick={scope.openReference}
			onExternalLinkClick={openExternal}
			extraRemarkPlugins={DATAVIEW_CELL_REMARK_PLUGINS}
		/>
	);
});

export interface DataviewValueProps {
	value: Literal;
	/** Render lists and objects as nested `<ul>`s (table cells, list items) instead of `a, b`. */
	expandList?: boolean;
	/** Recursion depth; past `maxRecursiveRenderDepth` the value renders as `...`. */
	depth?: number;
}

export const DataviewValue = memo(function DataviewValue({
	value,
	expandList = false,
	depth = 0,
}: DataviewValueProps) {
	const scope = useContext(DataviewValueContext);
	if (!scope) return <>{Values.toString(value, DataviewSettings)}</>;
	if (depth > DataviewSettings.maxRecursiveRenderDepth) return <>...</>;

	const child = (item: Literal) => (
		<DataviewValue value={item} expandList={expandList} depth={depth + 1} />
	);

	if (Values.isNull(value)) return <DataviewMarkdown text={DataviewSettings.renderNullAs} />;
	if (Values.isDate(value)) {
		return <>{renderMinimalDate(value, DataviewSettings, currentLocale())}</>;
	}
	if (Values.isDuration(value)) return <>{renderMinimalDuration(value)}</>;
	if (Values.isString(value)) return <DataviewMarkdown text={value} />;
	if (Values.isNumber(value) || Values.isBoolean(value)) return <>{String(value)}</>;
	if (Values.isLink(value)) {
		const { LinkComponent, root } = scope;
		const absolutePath = joinPath(root, value.path);
		return (
			<LinkComponent href={`maestro-file://${absolutePath}`} data-dataview-link="">
				{dataviewLinkLabel(value)}
			</LinkComponent>
		);
	}
	if (Values.isWidget(value)) {
		if (Widgets.isListPair(value)) {
			return (
				<>
					{child(value.key)}: {child(value.value)}
				</>
			);
		}
		if (Widgets.isExternalLink(value)) {
			const { LinkComponent } = scope;
			return <LinkComponent href={value.url}>{value.display ?? value.url}</LinkComponent>;
		}
		return <DataviewMarkdown text={value.markdown()} />;
	}
	if (Values.isFunction(value)) return <>{'<function>'}</>;
	if (Values.isArray(value)) {
		if (expandList) {
			return (
				<ul className="dataview dataview-ul">
					{value.map((item, index) => (
						<li key={index}>{child(item)}</li>
					))}
				</ul>
			);
		}
		if (value.length === 0) return <>{'<Empty List>'}</>;
		return (
			<span className="dataview">
				{value.map((item, index) => (
					<React.Fragment key={index}>
						{index > 0 && ', '}
						{child(item)}
					</React.Fragment>
				))}
			</span>
		);
	}
	if (Values.isObject(value)) {
		const entries = Object.entries(value);
		if (expandList) {
			return (
				<ul className="dataview dataview-ul">
					{entries.map(([key, item]) => (
						<li key={key}>
							{key}: {child(item)}
						</li>
					))}
				</ul>
			);
		}
		if (entries.length === 0) return <>{'<Empty Object>'}</>;
		return (
			<span className="dataview">
				{entries.map(([key, item], index) => (
					<React.Fragment key={key}>
						{index > 0 && ', '}
						{key}: {child(item)}
					</React.Fragment>
				))}
			</span>
		);
	}
	return null;
});
