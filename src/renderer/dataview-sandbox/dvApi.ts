/**
 * The `dv` object a DataviewJS script gets (D5, M7): exactly the members D5 lists, over one run's index
 * snapshot. Ported from upstream `DataviewInlineApi` (`api/inline-api.ts`) and the `DataviewApi` methods
 * it delegates to (`api/plugin-api.ts`), with upstream's semantics and error text:
 *
 * - index reads (`pages`, `pagePaths`, `page`, `current`) run in the guest against the shared `PageIndex`,
 *   so a source matches the pages a `dataview` block matches;
 * - `query`, `tryQuery`, `queryMarkdown`, `tryQueryMarkdown`, and `execute` ask the host to run DQL
 *   (`query.dql`); `io.load`, `io.csv`, and `view` ask it to read a vault file (`io.load`);
 * - the render calls build DOM inside `dv.container` (`./renderDom`).
 *
 * Upstream members D5 leaves out are not provided (`literal`, `isDataArray`, `value`, `widget`, `index`,
 * `component`, `settings`, `currentFilePath`, `evaluationContext`, `executeJs`, `renderValue`, `api`,
 * `version`), and `query`'s third argument (`forceId`) is ignored, because the query runs in the host as
 * DQL text. `dv.app`, which is also `this.app` (a script's `this` is `dv`), throws
 * `Obsidian API not available in Maestro`.
 */

import * as Luxon from 'luxon';
import type { DateTime, Duration } from 'luxon';
import {
	Context,
	DATAVIEW_BLOCK_ERROR_PREFIX,
	DEFAULT_FUNCTIONS,
	DataArray,
	DataviewSettings,
	EXPRESSION,
	Functions,
	Link,
	Result,
	Sources,
	Values,
	defaultLinkHandler,
	markdownList,
	markdownTable,
	markdownTaskList,
	nestGroups,
	reviveDataviewResult,
	type BoundFunctionImpl,
	type DataObject,
	type DataviewIdMeaning,
	type DataviewResult,
	type ExportSettings,
	type Grouping,
	type Literal,
	type PageIndex,
	type RevivedDataviewResult,
	type SListItem,
	type SMarkdownPage,
	type Source,
} from '../../shared/dataview';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import type { CompiledScript, InlineScript } from './inlineScript';
import {
	renderErrorMessage,
	renderErrorPre,
	renderList,
	renderTable,
	renderTaskGroups,
	renderValue,
	type GuestRenderContext,
} from './renderDom';

/** The error every Obsidian-only API raises in the guest (D5). */
export const OBSIDIAN_API_UNAVAILABLE = 'Obsidian API not available in Maestro';

/** Throws {@link OBSIDIAN_API_UNAVAILABLE}. One function, so a global can be locked to it more than once. */
export function obsidianApiUnavailable(): never {
	throw new Error(OBSIDIAN_API_UNAVAILABLE);
}

/** What one run gives its `dv` object. */
export interface DvRunContext {
	index: PageIndex;
	/** The note the block sits in (vault-relative): `dv.current()`, and the origin of relative paths. */
	thisPath: string;
	/** Where the run's output goes: `dv.container`. */
	container: HTMLElement;
	render: GuestRenderContext;
	/** Run DQL in the host (`query.dql`). Rejects when the host refuses. */
	queryDql(source: string, originPath: string): Promise<DataviewResult>;
	/** Read a vault file in the host (`io.load`): its text, or null when it does not exist. */
	loadText(path: string): Promise<string | null>;
	/** Compile a view's script (DEV-6). */
	compile(script: InlineScript): CompiledScript;
	/** Keep the run open until `work` settles, so its output is part of the run. */
	track<T>(work: Promise<T>): Promise<T>;
}

/** Upstream's `QueryResult` for the query types Maestro runs (`CALENDAR` is refused). */
export type DvQueryResult =
	| { type: 'table'; headers: string[]; values: Literal[][]; idMeaning: DataviewIdMeaning }
	| { type: 'list'; values: Literal[]; primaryMeaning: DataviewIdMeaning }
	| { type: 'task'; values: Grouping<SListItem> };

/** Options a render call takes (Obsidian's `DomElementInfo`, as `dv.el` reads it). */
export interface DvElementOptions {
	cls?: string | string[];
	text?: string | Node;
	attr?: Record<string, string | number | boolean | null | undefined>;
	title?: string;
	href?: string;
	value?: string;
	type?: string;
	placeholder?: string;
	prepend?: boolean;
	/** Render here instead of `dv.container`. */
	container?: HTMLElement;
}

/** The text `dv.query` fails with: a host error without the `Dataview: ` prefix blocks add. */
function queryError(message: string): string {
	return message.startsWith(DATAVIEW_BLOCK_ERROR_PREFIX)
		? message.slice(DATAVIEW_BLOCK_ERROR_PREFIX.length)
		: message;
}

function toQueryResult(result: RevivedDataviewResult): Result<DvQueryResult, string> {
	switch (result.kind) {
		case 'table':
			return Result.success({
				type: 'table',
				headers: result.headers,
				values: result.rows,
				idMeaning: result.idMeaning,
			});
		case 'list':
			return Result.success({
				type: 'list',
				values: result.items,
				primaryMeaning: result.idMeaning,
			});
		case 'task':
			return Result.success({ type: 'task', values: result.groups as Grouping<SListItem> });
		case 'unsupported':
			return Result.failure(`${result.feature} queries are not supported in Maestro.`);
		case 'error':
			return Result.failure(queryError(result.message));
	}
}

/** Create an element the way Obsidian's `createEl` does, inside `parent`. */
function createElement(parent: HTMLElement, tag: string, options: DvElementOptions): HTMLElement {
	const created = parent.ownerDocument.createElement(tag);
	if (options.cls) {
		const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(' ');
		for (const name of classes) if (name) created.classList.add(name);
	}
	if (options.text !== undefined) {
		if (typeof options.text === 'string') created.textContent = options.text;
		else created.append(options.text);
	}
	for (const [name, value] of Object.entries(options.attr ?? {})) {
		if (value === null || value === undefined) created.removeAttribute(name);
		else created.setAttribute(name, String(value));
	}
	if (options.title !== undefined) created.title = options.title;
	for (const name of ['href', 'value', 'type', 'placeholder'] as const) {
		const value = options[name];
		if (value !== undefined) created.setAttribute(name, value);
	}
	parent.insertBefore(created, options.prepend ? parent.firstChild : null);
	return created;
}

/** Upstream `_addDataArrays`: the array fields of `file` become data arrays. */
function withDataArrays(page: SMarkdownPage): SMarkdownPage {
	const file = page.file as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(file)) {
		if (Array.isArray(value)) file[key] = DataArray.wrap<unknown>(value, DataviewSettings);
	}
	return page;
}

/** The rows of a table, each one an array (upstream calls `row.map` on it). */
function tableRows(values: unknown): unknown[][] {
	return Array.from(values as Iterable<unknown>, (row) => {
		if (Array.isArray(row)) return row;
		if (DataArray.isDataArray(row)) return row.array();
		throw new TypeError(`dv.table expects every row to be an array; got ${typeof row}.`);
	});
}

/** Build the `dv` object for one run. */
export function createDvApi(run: DvRunContext) {
	const { index, thisPath, render } = run;
	const settings = DataviewSettings;

	// Upstream keeps two contexts: the plugin API's, whose link handler has no origin (`dv.date`,
	// `dv.duration`), and the script's own, which binds `this` to the current page (`dv.func`, `dv.evaluate`).
	const apiFunctions = Functions.bindAll(
		DEFAULT_FUNCTIONS,
		new Context(defaultLinkHandler(index, ''), settings)
	);
	const fileMeta = (index.pages.get(thisPath)?.serialize(index) ?? {}) as unknown as Literal;
	const evaluationContext = new Context(defaultLinkHandler(index, thisPath), settings, {
		this: fileMeta,
	});
	const func: Record<string, BoundFunctionImpl> = Functions.bindAll(
		DEFAULT_FUNCTIONS,
		evaluationContext
	);

	const normalize = (path: Link | string, originFile?: string): string => {
		const realPath = Values.isLink(path) ? path.path : path;
		return index.prefix.resolveRelative(realPath, originFile || thisPath);
	};

	const pagePaths = (query?: string): DataArray<string> => {
		let source: Source;
		try {
			if (!query || query.trim() === '') source = Sources.folder('');
			else source = EXPRESSION.source.tryParse(query);
		} catch (error) {
			throw new Error(`Failed to parse query in 'pagePaths': ${error}`);
		}
		return index
			.pagesForSource(source, thisPath)
			.map((paths) => DataArray.from(paths, settings))
			.orElseThrow();
	};

	const page = (path: string | Link, originFile = thisPath): SMarkdownPage | undefined => {
		if (!(typeof path === 'string') && !Values.isLink(path)) {
			throw Error(
				"dv.page only handles string and link paths; was provided type '" + typeof path + "'"
			);
		}
		const rawPath = Values.isLink(path) ? path.path : path;
		const normPath = index.metadataCache.getFirstLinkpathDest(rawPath, originFile ?? '');
		if (!normPath) return undefined;
		const pageObject = index.pages.get(normPath.path);
		if (!pageObject) return undefined;
		return withDataArrays(pageObject.serialize(index));
	};

	const query = async (
		source: string,
		originFile?: string
	): Promise<Result<DvQueryResult, string>> => {
		if (typeof source !== 'string') {
			return Result.failure('dv.query in Maestro takes DQL text.');
		}
		const origin = normalizeRootRelativePath(originFile ?? thisPath);
		if (!origin) return Result.failure(`Not a path inside the vault: '${originFile}'.`);
		try {
			return toQueryResult(reviveDataviewResult(await run.queryDql(source, origin)));
		} catch (error) {
			return Result.failure(error instanceof Error ? error.message : String(error));
		}
	};

	const exportSettings = (overrides?: Partial<ExportSettings>) =>
		Object.assign({}, settings, overrides);

	const dvMarkdownTable = (
		headers: string[] | undefined,
		values?: unknown,
		overrides?: Partial<ExportSettings>
	): string =>
		markdownTable(
			headers ?? [],
			(values ? tableRows(values) : []) as Literal[][],
			exportSettings(overrides)
		);

	const dvMarkdownList = (values?: unknown, overrides?: Partial<ExportSettings>): string =>
		markdownList(
			(values ? Array.from(values as Iterable<Literal>) : []) as Literal[],
			exportSettings(overrides)
		);

	const dvMarkdownTaskList = (
		values: Grouping<SListItem>,
		overrides?: Partial<ExportSettings>
	): string => markdownTaskList(nestGroups(values ?? []), exportSettings(overrides));

	const queryMarkdown = async (
		source: string,
		originFile?: string,
		overrides?: Partial<ExportSettings>
	): Promise<Result<string, string>> => {
		const result = await query(source, originFile);
		if (!result.successful) return result.cast();
		switch (result.value.type) {
			case 'list':
				return Result.success(dvMarkdownList(result.value.values, overrides));
			case 'table':
				return Result.success(
					dvMarkdownTable(result.value.headers, result.value.values, overrides)
				);
			case 'task':
				return Result.success(dvMarkdownTaskList(result.value.values, overrides));
		}
	};

	const el = (tag: string, text: unknown, options: DvElementOptions = {}): HTMLElement => {
		const { container = run.container, ...info } = options ?? {};
		const wrapped = Values.wrapValue(text as Literal);
		if (wrapped === null || wrapped === undefined) {
			return createElement(container, tag, { text: String(text), ...info });
		}
		const created = createElement(container, tag, info);
		renderValue(render, wrapped.value, created, true);
		return created;
	};

	/** Render a DQL query's result into `target`, with the text upstream's views show. */
	const renderQuery = async (target: HTMLElement, source: string): Promise<void> => {
		let result: RevivedDataviewResult;
		try {
			result = reviveDataviewResult(await run.queryDql(source, thisPath));
		} catch (error) {
			renderErrorPre(
				target,
				DATAVIEW_BLOCK_ERROR_PREFIX + (error instanceof Error ? error.message : String(error))
			);
			return;
		}
		switch (result.kind) {
			case 'error':
				renderErrorPre(target, result.message);
				return;
			case 'unsupported':
				renderErrorPre(target, `${result.feature} queries are not supported in Maestro.`);
				return;
			case 'table':
				renderTable(render, target, result.headers, result.rows);
				break;
			case 'list':
				if (result.items.length === 0 && settings.warnOnEmptyResult) {
					renderErrorMessage(target, 'Dataview: No results to show for list query.');
				} else {
					renderList(render, target, result.items);
				}
				break;
			case 'task': {
				const view = target.ownerDocument.createElement('div');
				view.className = 'dataview dataview-container';
				renderTaskGroups(render, view, result.groups as Grouping<SListItem>);
				target.append(view);
				break;
			}
		}
		// Rows the engine skipped because an expression failed on them, as the preview lists them.
		for (const warning of result.warnings) {
			const line = target.ownerDocument.createElement('div');
			line.className = 'dataview dataview-warning';
			line.textContent = warning;
			target.append(line);
		}
	};

	/** A new element at the end of the output, so later work renders where it was called. */
	const placeholder = (): HTMLElement => {
		const created = run.container.ownerDocument.createElement('div');
		run.container.append(created);
		return created;
	};

	const readFile = async (path: string): Promise<string> => {
		const text = await run.loadText(path);
		if (text === null) throw new Error(`No such file: '${path}'.`);
		return text;
	};

	const io = {
		/** Load a CSV inside the vault as a data array of rows. */
		async csv(
			path: Link | string,
			originFile?: string
		): Promise<DataArray<DataObject> | undefined> {
			if (!Values.isLink(path) && !Values.isString(path)) {
				throw Error(
					`dv.io.csv only handles string or link paths; was provided type '${typeof path}'.`
				);
			}
			const origin = originFile || thisPath;
			const data = await index.csv.get(normalize(path, origin));
			if (data.successful) return DataArray.from(data.value, settings);
			throw Error(`Could not find CSV for path '${path}' (relative to origin '${origin ?? '/'}')`);
		},

		/** Load the text of a vault file, or undefined when no such file exists. */
		async load(path: Link | string, originFile?: string): Promise<string | undefined> {
			if (!Values.isLink(path) && !Values.isString(path)) {
				throw Error(
					`dv.io.load only handles string or link paths; was provided type '${typeof path}'.`
				);
			}
			// Only a file the vault lists, as upstream reads through Obsidian's vault (no dot folders).
			const normalized = normalizeRootRelativePath(normalize(path, originFile));
			if (!normalized || !index.prefix.hasFile(normalized)) return undefined;
			return (await run.loadText(normalized)) ?? undefined;
		},

		/** A link or path resolved against an origin file (the current note by default). */
		normalize(path: Link | string, originFile?: string): string {
			return normalize(path, originFile);
		},
	};

	const dv = {
		// Index and data collection.
		current: (): SMarkdownPage | undefined => page(thisPath),
		page: (path: string | Link): SMarkdownPage | undefined => page(path, thisPath),
		pages: (query?: string): DataArray<SMarkdownPage> =>
			pagePaths(query).flatMap((path) => {
				const found = page(path, thisPath);
				return found ? [found] : [];
			}),
		pagePaths,

		// Utilities.
		array: (raw: unknown): DataArray<unknown> => {
			if (DataArray.isDataArray(raw)) return raw;
			if (Array.isArray(raw)) return DataArray.wrap(raw, settings);
			return DataArray.wrap([raw], settings);
		},
		isArray: (raw: unknown): raw is DataArray<unknown> | unknown[] =>
			DataArray.isDataArray(raw) || Array.isArray(raw),
		fileLink: (path: string, embed = false, display?: string): Link =>
			Link.file(path, embed, display),
		sectionLink: (path: string, section: string, embed = false, display?: string): Link =>
			Link.header(path, section, embed, display),
		blockLink: (path: string, blockId: string, embed = false, display?: string): Link =>
			Link.block(path, blockId, embed, display),
		date: (pathlike: string | Link | DateTime): DateTime | null =>
			apiFunctions.date(pathlike) as DateTime | null,
		duration: (str: string | Duration): Duration | null => apiFunctions.dur(str) as Duration | null,
		compare: (a: unknown, b: unknown): number => Values.compareValue(a as Literal, b as Literal),
		equal: (a: unknown, b: unknown): boolean =>
			Values.compareValue(a as Literal, b as Literal) == 0,
		clone: (value: Literal): Literal => Values.deepCopy(value),
		parse: (value: string): Literal => {
			const raw = EXPRESSION.inlineField.parse(value);
			return raw.status ? raw.value : value;
		},
		luxon: Luxon,
		func,

		// Rendering.
		el,
		header: (level: number, text: unknown, options?: DvElementOptions): HTMLElement => {
			const tag = (
				{ 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as Record<number, string>
			)[level];
			if (!tag) throw Error(`Unrecognized level '${level}' (expected 1, 2, 3, 4, 5, or 6)`);
			return el(tag, text, options);
		},
		paragraph: (text: unknown, options?: DvElementOptions): HTMLElement => el('p', text, options),
		span: (text: unknown, options?: DvElementOptions): HTMLElement => el('span', text, options),
		// Upstream's render calls return promises. These draw at once and throw at once, so a script that
		// does not await them still fails with its error instead of leaving an unhandled rejection.
		list: (values?: unknown): Promise<void> => {
			if (values) {
				const items = Array.from(values as Iterable<unknown>);
				renderList(render, placeholder(), items);
			}
			return Promise.resolve();
		},
		taskList: (
			tasks: Grouping<SListItem> | DataArray<SListItem>,
			groupByFile = true
		): Promise<void> => {
			const items = (DataArray.isDataArray(tasks) ? tasks.array() : tasks) as SListItem[];
			let grouped: Grouping<SListItem> = items;
			if (groupByFile) {
				const byFile = new Map<string, SListItem[]>();
				for (const task of items) {
					if (!byFile.has(task.path)) byFile.set(task.path, []);
					byFile.get(task.path)?.push(task);
				}
				grouped = Array.from(byFile.entries(), ([path, rows]) => ({ key: Link.file(path), rows }));
			}
			renderTaskGroups(render, placeholder(), grouped);
			return Promise.resolve();
		},
		table: (headers: string[] | Iterable<string> | undefined, values?: unknown): Promise<void> => {
			const headerList = Array.from(headers ?? []);
			const rows = values ? tableRows(values) : [];
			renderTable(render, placeholder(), headerList, rows);
			return Promise.resolve();
		},
		markdownTable: dvMarkdownTable,
		markdownList: dvMarkdownList,
		markdownTaskList: dvMarkdownTaskList,

		// Query evaluation.
		query,
		tryQuery: async (source: string, originFile?: string): Promise<DvQueryResult> =>
			(await query(source, originFile)).orElseThrow(),
		queryMarkdown,
		tryQueryMarkdown: async (
			source: string,
			originFile?: string,
			overrides?: Partial<ExportSettings>
		): Promise<string> => (await queryMarkdown(source, originFile, overrides)).orElseThrow(),
		evaluate: (expression: string, context?: DataObject): Result<Literal, string> => {
			const field = EXPRESSION.field.parse(expression);
			if (!field.status) return Result.failure(`Failed to parse expression "${expression}"`);
			return evaluationContext.evaluate(field.value, context);
		},
		tryEvaluate: (expression: string, context?: DataObject): Literal =>
			dv.evaluate(expression, context).orElseThrow(),
		execute: (source: string): Promise<void> => run.track(renderQuery(placeholder(), source)),

		io,

		/** Run `<name>.js`, or `<name>/view.js` with an optional `<name>/view.css`, from the vault. */
		view: (viewName: string, input?: unknown): Promise<void> =>
			run.track(
				(async () => {
					const container = run.container;
					const simpleViewPath = `${viewName}.js`;
					const complexViewPath = `${viewName}/view.js`;
					let checkForCss = false;
					let cssElement: HTMLElement | undefined;
					let viewFile = index.metadataCache.getFirstLinkpathDest(simpleViewPath, thisPath);
					if (!viewFile) {
						viewFile = index.metadataCache.getFirstLinkpathDest(complexViewPath, thisPath);
						checkForCss = true;
					}
					if (!viewFile) {
						renderErrorPre(
							container,
							`Dataview: custom view not found for '${simpleViewPath}' or '${complexViewPath}'.`
						);
						return;
					}

					if (checkForCss) {
						const cssFile = index.metadataCache.getFirstLinkpathDest(
							`${viewName}/view.css`,
							thisPath
						);
						if (cssFile) {
							cssElement = createElement(container, 'style', {
								text: await readFile(cssFile.path),
								attr: { scope: ' ' },
							});
						}
					}

					let contents = await readFile(viewFile.path);
					// Upstream wraps a view that awaits in an async arrow; returning it lets the run wait for it.
					if (contents.includes('await')) contents = `return (async () => { ${contents}\n})();`;
					const view = run.compile({
						params: ['dv', 'input'],
						body: contents,
						strict: false,
						sourceUrl: viewFile.path,
					});
					try {
						// This may directly render, in which case it will likely return undefined or null.
						const result = await Promise.resolve(view(dv, input));
						if (result) renderValue(render, result, container, true);
					} catch (error) {
						if (cssElement) container.removeChild(cssElement);
						renderErrorPre(
							container,
							`Dataview: Failed to execute view '${viewFile.path}'.\n\n${error}`
						);
					}
				})()
			),

		container: run.container,
	};

	// Not part of D5: the Obsidian app. Non-enumerable, so the object's keys are exactly the D5 surface.
	Object.defineProperty(dv, 'app', { get: obsidianApiUnavailable, enumerable: false });
	return dv;
}

export type DvApi = ReturnType<typeof createDvApi>;
