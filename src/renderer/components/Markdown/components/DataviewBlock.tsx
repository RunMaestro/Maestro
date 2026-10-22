/**
 * DataviewBlock - the `customLanguageRenderers` entry for `dataview` fences
 * (DV-1, DV-8, DV-9, D7).
 *
 * The block runs its query in main (`window.maestro.dataview.query`) with `this`
 * bound to the note on screen, and renders the result the way Dataview does: a
 * table, a list, grouped task lists, an inline callout for an error or an
 * unsupported query type, and a small result count.
 *
 * The note's path and agent come from `DataviewDocumentContext`. Outside a
 * provider, with the Encore Feature off, or in an untitled buffer, the fence
 * renders as ordinary highlighted code.
 *
 * Results live in the module-level resource cache (`useLiveDataviewResult`), keyed
 * by agent, note, and query source: a component map rebuild (theme, search, the
 * Auto Run lock) or a virtualized Fast-tier item remounts the block, and the cached
 * result repaints on the first frame instead of flashing the placeholder. A
 * `dataview:changed` event for the result's root re-runs the query (debounced) and
 * keeps the old result on screen until the new one arrives (DV-7).
 *
 * A task checkbox toggles the task's own source line (DV-8): through the surface's
 * own toggle for the note on screen, and `toggleDataviewTaskInFile()` for any
 * other file.
 *
 * Styling is the surface's own: plain `table`, `ul`, and `li` elements inherit the
 * GFM table and task-list CSS File Preview and Auto Run already apply. Nothing in
 * here renders `data-source-line` (rows come from other files and would break the
 * preview's ascending line walk) or a `language-*` code element (the Fast tier's
 * lazy highlighter would pick it up).
 */

import React, { useCallback, useMemo } from 'react';
import type { Theme } from '../../../types';
import {
	DataviewSettings,
	isTaskGroup,
	reviveDataviewResult,
	type DataviewQueryResponse,
	type Literal,
	type RevivedDataviewResult,
} from '../../../../shared/dataview';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useLiveDataviewResult } from '../../../hooks/file/useLiveDataviewResult';
import { toggleDataviewResultTask } from '../../../services/dataviewTaskToggle';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { AlertCallout } from './AlertCallout';
import { TaskCheckbox } from './TaskCheckbox';
import { PrismHighlightedCode } from './PrismCodeBlock';
import { useDataviewDocument, type DataviewDocumentScope } from './DataviewDocumentContext';
import { DataviewMarkdown, DataviewValue, DataviewValueProvider } from './DataviewValue';

export interface DataviewBlockProps {
	code: string;
	theme: Theme;
}

type DataviewBlockData = DataviewQueryResponse<RevivedDataviewResult>;

/** A task as the wire carries it: the task's own serialized fields. */
type TaskItem = Record<string, Literal>;

/** Height of the loading placeholder, so the document does not jump while a query runs. */
const PLACEHOLDER_HEIGHT = '2.5em';

export function DataviewBlock({ code, theme }: DataviewBlockProps) {
	const doc = useDataviewDocument();
	const enabled = useSettingsStore((s) => s.encoreFeatures?.dataview === true);
	if (!doc || !enabled || !doc.filePath) {
		return <PrismHighlightedCode code={code} language="dataview" theme={theme} />;
	}
	return <DataviewQueryView code={code} theme={theme} doc={doc} />;
}

/** The cache key of one block's result. */
export function dataviewBlockCacheKey(agentId: string, filePath: string, source: string): string {
	return JSON.stringify(['dataview:block', agentId, filePath, source]);
}

function DataviewQueryView({
	code,
	theme,
	doc,
}: {
	code: string;
	theme: Theme;
	doc: DataviewDocumentScope;
}) {
	const { agentId, filePath } = doc;
	const key = dataviewBlockCacheKey(agentId, filePath, code);
	const fetchResult = useCallback(async (): Promise<DataviewBlockData> => {
		try {
			const response = await window.maestro.dataview.query({ filePath, source: code, agentId });
			return { ...response, result: reviveDataviewResult(response.result) };
		} catch (error) {
			throw new Error(ipcErrorMessage(error));
		}
	}, [agentId, filePath, code]);
	const { data, error, loading } = useLiveDataviewResult(key, fetchResult);

	// The Fast tier routes clicks on anchors from its container; result links are
	// handled here already, so a second handler must not open them again.
	const stopLinkClick = useCallback((event: React.MouseEvent) => {
		if ((event.target as HTMLElement).closest?.('a')) event.stopPropagation();
	}, []);

	let body: React.ReactNode;
	if (data) {
		body = (
			<DataviewValueProvider root={data.root} theme={theme}>
				<DataviewResultView data={data} theme={theme} doc={doc} />
			</DataviewValueProvider>
		);
	} else if (error && !loading) {
		body = <DataviewErrorCallout theme={theme} message={error} />;
	} else {
		body = (
			<div
				data-dataview-placeholder=""
				aria-busy="true"
				aria-label="Running Dataview query"
				style={{
					height: PLACEHOLDER_HEIGHT,
					borderRadius: '6px',
					background: theme.colors.bgActivity,
					opacity: 0.5,
				}}
			/>
		);
	}

	return (
		<div
			className="dataview"
			data-dataview-block=""
			style={{ margin: '0.5em 0' }}
			onClick={stopLinkClick}
		>
			{body}
		</div>
	);
}

function DataviewErrorCallout({ theme, message }: { theme: Theme; message: string }) {
	return (
		<AlertCallout type="caution" theme={theme}>
			<div
				data-dataview-error=""
				style={{
					whiteSpace: 'pre-wrap',
					fontFamily: 'var(--maestro-font-mono, ui-monospace, SFMono-Regular, monospace)',
					fontSize: '0.85em',
				}}
			>
				{message}
			</div>
		</AlertCallout>
	);
}

/** Leaf rows of a task grouping (tasks, not groups). */
function countTasks(groups: unknown[]): number {
	return groups.reduce<number>(
		(total, entry) =>
			total + (isTaskGroup<Literal>(entry) ? countTasks(entry.rows as unknown[]) : 1),
		0
	);
}

function DataviewResultView({
	data,
	theme,
	doc,
}: {
	data: DataviewBlockData;
	theme: Theme;
	doc: DataviewDocumentScope;
}) {
	const { result } = data;
	switch (result.kind) {
		case 'error':
			return <DataviewErrorCallout theme={theme} message={result.message} />;
		case 'unsupported':
			return (
				<AlertCallout type="warning" theme={theme}>
					{result.feature} queries are not supported in Maestro.
				</AlertCallout>
			);
		case 'table':
			return (
				<ResultFrame
					theme={theme}
					count={result.rows.length}
					type="table"
					warnings={result.warnings}
				>
					<table>
						<thead>
							<tr>
								{result.headers.map((header, index) => (
									<th key={index}>{header}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{result.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex}>
											<DataviewValue value={cell} expandList />
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</ResultFrame>
			);
		case 'list':
			return (
				<ResultFrame
					theme={theme}
					count={result.items.length}
					type="list"
					warnings={result.warnings}
				>
					<ul className="dataview dataview-ul">
						{result.items.map((item, index) => (
							<li key={index}>
								<DataviewValue value={item} expandList />
							</li>
						))}
					</ul>
				</ResultFrame>
			);
		case 'task':
			return (
				<ResultFrame
					theme={theme}
					count={countTasks(result.groups as unknown[])}
					type="task"
					warnings={result.warnings}
				>
					<TaskGroups groups={result.groups as unknown[]} theme={theme} data={data} doc={doc} />
				</ResultFrame>
			);
	}
}

/** Results with Dataview's empty-result notice, the result count, and any skipped-row warnings. */
function ResultFrame({
	theme,
	count,
	type,
	warnings,
	children,
}: {
	theme: Theme;
	count: number;
	type: 'table' | 'list' | 'task';
	warnings: string[];
	children: React.ReactNode;
}) {
	const dim: React.CSSProperties = { color: theme.colors.textDim, fontSize: '0.8em' };
	return (
		<>
			{count === 0 ? (
				DataviewSettings.warnOnEmptyResult && (
					<div data-dataview-empty="" style={dim}>
						Dataview: No results to show for {type} query.
					</div>
				)
			) : (
				<>
					{children}
					{DataviewSettings.showResultCount && (
						<div data-dataview-count="" style={dim}>
							{count} {count === 1 ? 'result' : 'results'}
						</div>
					)}
				</>
			)}
			{warnings.length > 0 && (
				<AlertCallout type="warning" theme={theme}>
					{warnings.map((warning, index) => (
						<div key={index}>{warning}</div>
					))}
				</AlertCallout>
			)}
		</>
	);
}

function TaskGroups({
	groups,
	theme,
	data,
	doc,
}: {
	groups: unknown[];
	theme: Theme;
	data: DataviewBlockData;
	doc: DataviewDocumentScope;
}) {
	if (groups.length > 0 && isTaskGroup<Literal>(groups[0])) {
		return (
			<>
				{groups.map((entry, index) => {
					if (!isTaskGroup<Literal>(entry)) return null;
					const rows = entry.rows as unknown[];
					return (
						<div key={index} data-dataview-group="">
							<div style={{ fontWeight: 600, marginTop: '0.5em' }}>
								<DataviewValue value={entry.key} />{' '}
								<span style={{ color: theme.colors.textDim, fontSize: '0.8em', fontWeight: 400 }}>
									{countTasks(rows)}
								</span>
							</div>
							<TaskGroups groups={rows} theme={theme} data={data} doc={doc} />
						</div>
					);
				})}
			</>
		);
	}
	return <TaskList items={groups as TaskItem[]} theme={theme} data={data} doc={doc} />;
}

function taskKey(item: TaskItem, fallback: number): string {
	return typeof item.path === 'string' && typeof item.line === 'number'
		? `${item.path}:${item.line}`
		: String(fallback);
}

/**
 * One task list. A task whose parent is also in the list renders under that
 * parent (through its `children`) rather than a second time at the top, as
 * upstream nests them.
 */
function TaskList({
	items,
	theme,
	data,
	doc,
}: {
	items: TaskItem[];
	theme: Theme;
	data: DataviewBlockData;
	doc: DataviewDocumentScope;
}) {
	const roots = useMemo(() => {
		const present = new Set(items.map((item, index) => taskKey(item, index)));
		return items.filter(
			(item) =>
				typeof item.parent !== 'number' ||
				typeof item.path !== 'string' ||
				!present.has(`${item.path}:${item.parent}`)
		);
	}, [items]);
	return (
		<ul className="dataview contains-task-list">
			{roots.map((item, index) => (
				<TaskListItem key={taskKey(item, index)} item={item} theme={theme} data={data} doc={doc} />
			))}
		</ul>
	);
}

function TaskListItem({
	item,
	theme,
	data,
	doc,
}: {
	item: TaskItem;
	theme: Theme;
	data: DataviewBlockData;
	doc: DataviewDocumentScope;
}) {
	const isTask = item.task === true;
	const children = Array.isArray(item.children) ? (item.children as TaskItem[]) : [];
	const line = typeof item.line === 'number' ? item.line + 1 : null;
	const path = typeof item.path === 'string' ? item.path : null;
	const text = typeof item.text === 'string' ? item.text : '';
	const toggle = useCallback(
		(sourceLine: number): Promise<boolean> => {
			if (path === null) return Promise.resolve(false);
			return toggleDataviewResultTask(doc.toggleOwnTask, data, { path, line: sourceLine, text });
		},
		[path, text, data, doc]
	);
	return (
		<li
			className={isTask ? 'task-list-item' : undefined}
			data-dataview-task={isTask ? '' : undefined}
		>
			{isTask && line !== null && (
				<>
					<TaskCheckbox
						line={line}
						checked={item.checked === true}
						theme={theme}
						onToggle={toggle}
					/>{' '}
				</>
			)}
			<DataviewMarkdown text={text} />
			{children.length > 0 && <TaskList items={children} theme={theme} data={data} doc={doc} />}
		</li>
	);
}
