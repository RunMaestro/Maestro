/**
 * The DataviewJS guest's DOM renderer (M6 and M7 on the guest side): Dataview values, and the table, list,
 * and task views that `dv.table`, `dv.list`, `dv.taskList`, and `dv.execute` draw. It ports upstream's
 * `renderValue` (`ui/render.ts`) and its preact views (`ui/markdown.tsx`, `ui/views/*-view.tsx`) to plain DOM
 * with upstream's class names and messages, so a vault's `view.css` still applies. Values read as they do in
 * the preview's `DataviewValue` (the empty-list text, link labels), so a `dataview` block and a `dataviewjs`
 * block show a value the same way.
 *
 * Text goes in with `textContent`, `append(string)`, or the D6 markdown step (`./markdownDom`); nothing here
 * parses HTML. Links carry their target in data attributes and never navigate: the guest's click handler
 * sends `open.link`. A task checkbox calls `toggleTask`.
 */

import {
	DataArray,
	DataviewSettings,
	Groupings,
	Link,
	Values,
	Widgets,
	currentLocale,
	dataviewLinkLabel,
	nestItems,
	renderMinimalDate,
	renderMinimalDuration,
	type Grouping,
	type SListItem,
} from '../../shared/dataview';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import { renderCompactMarkdown, type MarkdownLinks } from './markdownDom';

/** The vault path a link opens, on its anchor. */
export const LINK_PATH_ATTRIBUTE = 'data-dataview-path';
/** The http or https URL a link opens, on its anchor. */
export const LINK_URL_ATTRIBUTE = 'data-dataview-url';

export interface GuestRenderContext {
	document: Document;
	/** The note the run belongs to. Links in values resolve from it. */
	originPath: string;
	/** Obsidian link resolution (M3): the vault path `linkpath` names from `sourcePath`, or null. */
	resolveLink(linkpath: string, sourcePath: string): string | null;
	/** Toggle a task the user clicked, in the task's own file. `line` is 1-based. */
	toggleTask(task: { path: string; line: number; text: string }): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className?: string
): HTMLElementTagNameMap[K] {
	const created = doc.createElement(tag);
	if (className) created.className = className;
	return created;
}

/**
 * An anchor that opens a vault file. `path` is a link path without its `#section`; it resolves from
 * `sourcePath` as Obsidian resolves it, and an unresolved link keeps the path as written (as a stale
 * `[[link]]` in the preview does).
 */
function vaultAnchor(
	ctx: GuestRenderContext,
	path: string,
	sourcePath: string,
	embed: boolean
): HTMLAnchorElement {
	const anchor = element(
		ctx.document,
		'a',
		embed ? 'internal-link internal-embed' : 'internal-link'
	);
	anchor.setAttribute('href', '#');
	const resolved = ctx.resolveLink(path, sourcePath);
	if (resolved === null) anchor.classList.add('is-unresolved');
	// Only a path inside the vault root becomes a target; the host would refuse any other.
	const target = normalizeRootRelativePath(resolved ?? path);
	if (target) anchor.setAttribute(LINK_PATH_ATTRIBUTE, target);
	return anchor;
}

/** An anchor that opens an http or https page outside Maestro. */
function urlAnchor(ctx: GuestRenderContext, url: string): HTMLAnchorElement {
	const anchor = element(ctx.document, 'a', 'external-link');
	anchor.setAttribute('href', url);
	anchor.setAttribute('rel', 'noopener');
	anchor.setAttribute('target', '_blank');
	anchor.setAttribute(LINK_URL_ATTRIBUTE, url);
	return anchor;
}

/** Link handling for the markdown step, for markdown that came from `sourcePath`. */
function markdownLinks(ctx: GuestRenderContext, sourcePath: string): MarkdownLinks {
	return {
		vaultLink: (linkpath, embed) => vaultAnchor(ctx, Link.infer(linkpath).path, sourcePath, embed),
		urlLink: (url) => urlAnchor(ctx, url),
	};
}

/** Markdown rendered compact (a lone paragraph unwrapped), with links resolved from `sourcePath`. */
export function renderMarkdownText(
	ctx: GuestRenderContext,
	container: HTMLElement,
	markdown: string,
	sourcePath = ctx.originPath
): HTMLSpanElement {
	return renderCompactMarkdown(container, markdown, markdownLinks(ctx, sourcePath));
}

/** A `Link` value: an anchor to its file, labeled as Dataview labels it. */
function linkElement(ctx: GuestRenderContext, link: Link): HTMLAnchorElement {
	const anchor = vaultAnchor(ctx, link.path, ctx.originPath, link.embed);
	anchor.append(dataviewLinkLabel(link));
	return anchor;
}

/**
 * Render any value into `container`, as upstream `renderValue` does: nulls as `renderNullAs`, strings as
 * compact markdown, dates and durations in Dataview's formats, links as anchors, lists and objects inline
 * (`a, b`) or, with `expandList`, as nested lists.
 */
export function renderValue(
	ctx: GuestRenderContext,
	field: unknown,
	container: HTMLElement,
	expandList = false,
	depth = 0
): void {
	const doc = ctx.document;
	if (depth > DataviewSettings.maxRecursiveRenderDepth) {
		container.append('...');
		return;
	}

	if (Values.isNull(field)) {
		renderMarkdownText(ctx, container, DataviewSettings.renderNullAs);
	} else if (Values.isDate(field)) {
		container.append(renderMinimalDate(field, DataviewSettings, currentLocale()));
	} else if (Values.isDuration(field)) {
		container.append(renderMinimalDuration(field));
	} else if (Values.isString(field)) {
		renderMarkdownText(ctx, container, field);
	} else if (Values.isNumber(field) || Values.isBoolean(field)) {
		container.append(String(field));
	} else if (Values.isLink(field)) {
		container.append(linkElement(ctx, field));
	} else if (Values.isHtml(field)) {
		container.append(field as unknown as Node);
	} else if (Values.isWidget(field)) {
		if (Widgets.isListPair(field)) {
			renderValue(ctx, field.key, container, expandList, depth);
			container.append(': ');
			renderValue(ctx, field.value, container, expandList, depth);
		} else if (Widgets.isExternalLink(field)) {
			const anchor = urlAnchor(ctx, field.url);
			anchor.append(field.display ?? field.url);
			container.append(anchor);
		} else {
			renderMarkdownText(ctx, container, field.markdown());
		}
	} else if (Values.isFunction(field)) {
		container.append('<function>');
	} else if (Values.isArray(field) || DataArray.isDataArray(field)) {
		const items = Array.from(field as Iterable<unknown>);
		if (expandList) {
			const list = element(doc, 'ul', 'dataview dataview-ul dataview-result-list-ul');
			for (const item of items) {
				const entry = element(doc, 'li', 'dataview-result-list-li');
				renderValue(ctx, item, entry, expandList, depth + 1);
				list.append(entry);
			}
			container.append(list);
		} else if (items.length === 0) {
			container.append('<Empty List>');
		} else {
			const span = element(doc, 'span', 'dataview dataview-result-list-span');
			items.forEach((item, index) => {
				if (index > 0) span.append(', ');
				renderValue(ctx, item, span, expandList, depth + 1);
			});
			container.append(span);
		}
	} else if (Values.isObject(field)) {
		// Upstream does not render class instances, which may hold recursive references.
		const className = (field as { constructor?: { name?: string } }).constructor?.name;
		if (className && className !== 'Object') {
			container.append(`<${className}>`);
			return;
		}
		const entries = Object.entries(field);
		if (expandList) {
			const list = element(doc, 'ul', 'dataview dataview-ul dataview-result-object-ul');
			for (const [key, value] of entries) {
				const entry = element(doc, 'li', 'dataview dataview-li dataview-result-object-li');
				entry.append(`${key}: `);
				renderValue(ctx, value, entry, expandList, depth + 1);
				list.append(entry);
			}
			container.append(list);
		} else if (entries.length === 0) {
			container.append('<Empty Object>');
		} else {
			const span = element(doc, 'span', 'dataview dataview-result-object-span');
			entries.forEach(([key, value], index) => {
				if (index > 0) span.append(', ');
				span.append(`${key}: `);
				renderValue(ctx, value, span, expandList, depth + 1);
			});
			container.append(span);
		}
	} else {
		container.append(`Unrecognized: ${JSON.stringify(field)}`);
	}
}

/** Upstream `renderErrorPre`: an error in a code-styled box. */
export function renderErrorPre(container: HTMLElement, message: string): HTMLPreElement {
	const pre = element(container.ownerDocument, 'pre', 'dataview dataview-error');
	pre.textContent = message;
	container.append(pre);
	return pre;
}

/** Upstream `ErrorMessage`: a notice such as Dataview's empty-result message. */
export function renderErrorMessage(container: HTMLElement, message: string): void {
	const doc = container.ownerDocument;
	const box = element(doc, 'div', 'dataview dataview-error-box');
	const text = element(doc, 'p', 'dataview dataview-error-message');
	text.textContent = message;
	box.append(text);
	container.append(box);
}

function resultCount(doc: Document, count: number): HTMLSpanElement | null {
	if (!DataviewSettings.showResultCount) return null;
	const span = element(doc, 'span', 'dataview small-text');
	span.textContent = String(count);
	return span;
}

/** Upstream `TableGrouping`: headers as markdown with the row count on the first, cells with lists expanded. */
export function renderTable(
	ctx: GuestRenderContext,
	container: HTMLElement,
	headers: unknown[],
	rows: unknown[][]
): void {
	const doc = ctx.document;
	const table = element(doc, 'table', 'dataview table-view-table');
	const head = element(doc, 'thead', 'table-view-thead');
	const headerRow = element(doc, 'tr', 'table-view-tr-header');
	headers.forEach((heading, index) => {
		const cell = element(doc, 'th', 'table-view-th');
		renderMarkdownText(ctx, cell, typeof heading === 'string' ? heading : Values.toString(heading));
		const count = index === 0 ? resultCount(doc, rows.length) : null;
		if (count) cell.append(count);
		headerRow.append(cell);
	});
	head.append(headerRow);

	const body = element(doc, 'tbody', 'table-view-tbody');
	for (const row of rows) {
		const tableRow = element(doc, 'tr');
		for (const value of row) {
			const cell = element(doc, 'td');
			renderValue(ctx, value, cell, true);
			tableRow.append(cell);
		}
		body.append(tableRow);
	}
	table.append(head, body);
	container.append(table);

	if (DataviewSettings.warnOnEmptyResult && rows.length === 0) {
		renderErrorMessage(container, 'Dataview: No results to show for table query.');
	}
}

/** Upstream `ListGrouping`: one item per value, lists inside an item expanded. */
export function renderList(
	ctx: GuestRenderContext,
	container: HTMLElement,
	items: unknown[]
): void {
	const list = element(ctx.document, 'ul', 'dataview list-view-ul');
	for (const item of items) {
		const entry = element(ctx.document, 'li');
		renderValue(ctx, item, entry, true);
		list.append(entry);
	}
	container.append(list);
}

/** One task or list item, with its children nested (upstream `TaskItem` and `ListItem`). */
function renderTaskItem(ctx: GuestRenderContext, item: SListItem): HTMLLIElement {
	const doc = ctx.document;
	const entry = element(doc, 'li');
	if (item.task) {
		const checked = item.status !== ' ';
		entry.className = checked ? 'dataview task-list-item is-checked' : 'dataview task-list-item';
		entry.setAttribute('data-task', item.status);
		const checkbox = element(doc, 'input', 'dataview task-list-item-checkbox');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.addEventListener('click', () => {
			const status = checkbox.checked ? 'x' : ' ';
			entry.setAttribute('data-task', status);
			entry.classList.toggle('is-checked', checkbox.checked);
			ctx.toggleTask({ path: item.path, line: item.line + 1, text: item.text });
		});
		entry.append(checkbox);
	} else {
		entry.className = 'dataview task-list-basic-item';
	}
	// A task's text is markdown from its own file, so its links resolve from there.
	renderMarkdownText(ctx, entry, item.visual ?? item.text, item.path);
	if (item.children.length > 0) renderTaskList(ctx, entry, item.children);
	return entry;
}

/** Upstream `TaskList`: items whose parent is also in the list render under it, once. */
function renderTaskList(ctx: GuestRenderContext, container: HTMLElement, items: SListItem[]): void {
	if (items.length === 0 && DataviewSettings.warnOnEmptyResult) {
		renderErrorMessage(container, 'Dataview: No results to show for task query.');
		return;
	}
	const [nested] = nestItems(items);
	const list = element(ctx.document, 'ul', 'contains-task-list');
	for (const item of nested) list.append(renderTaskItem(ctx, item));
	container.append(list);
}

/** Upstream `TaskGrouping`: each group as a heading with its count, then its rows. */
export function renderTaskGroups(
	ctx: GuestRenderContext,
	container: HTMLElement,
	items: Grouping<SListItem>
): void {
	if (items.length > 0 && Groupings.isGrouping(items)) {
		const doc = ctx.document;
		for (const group of items) {
			const heading = element(doc, 'h4');
			renderValue(ctx, group.key, heading);
			const count = resultCount(doc, Groupings.count(group.rows));
			if (count) heading.append(count);
			const rows = element(doc, 'div', 'dataview result-group');
			renderTaskGroups(ctx, rows, group.rows);
			container.append(heading, rows);
		}
		return;
	}
	renderTaskList(ctx, container, items as SListItem[]);
}
