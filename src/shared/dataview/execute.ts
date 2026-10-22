/**
 * Run a DQL query or an inline expression against an index with upstream's own engine (D2, DV-1,
 * DV-2), and return the result in its wire form (`./types.ts`). Nothing here throws: a parse error,
 * an execution error, or an unexpected exception becomes an error result with Dataview's message
 * (DV-9). The main-process service calls these for the preview, the web-desktop build, and the CLI.
 */

import type { DataObject, Literal } from './vendor/data-model/value';
import type { SListItem } from './vendor/data-model/serialized/markdown';
import type { QueryOperation } from './vendor/query/query';
import {
	executeInline,
	executeList,
	executeTable,
	executeTask,
	type CoreExecution,
} from './vendor/query/engine';
import { parseQuery } from './vendor/query/parse';
import { parseField } from './vendor/expression/parse';
import { DataviewSettings } from './settings';
import { mapTaskGroups, toWireValue } from './wire';
import type {
	DataviewErrorResult,
	DataviewIndexReader,
	DataviewInlineResult,
	DataviewResult,
	DataviewWireValue,
} from './types';

/** Upstream's prefix for a block error (`Dataview: <error>`). */
export const DATAVIEW_BLOCK_ERROR_PREFIX = 'Dataview: ';

/**
 * Deprecated task aliases (`subtasks` is `children`, `header` is `section`, `real` is `task`).
 * Queries can still read them; they stay off the wire, where `subtasks` would double every level
 * of nesting.
 */
const DEPRECATED_TASK_KEYS = new Set(['subtasks', 'header', 'real']);

/**
 * The 1-based line of `source` that a parsimmon failure points at (`> 3 | ...`), or the last line
 * when the parser ran out of input.
 */
export function parseErrorLine(message: string, source: string): number | undefined {
	const marked = /^>\s*(\d+)\s*\|/m.exec(message);
	if (marked) return Number(marked[1]);
	if (/Got the end of the input/.test(message))
		return source.replace(/\s+$/, '').split('\n').length;
	return undefined;
}

function errorResult(message: string, line?: number): DataviewErrorResult {
	return line === undefined ? { kind: 'error', message } : { kind: 'error', message, line };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One warning per query step that skipped rows because an expression failed on them. */
function rowWarnings(core: CoreExecution): string[] {
	const warnings: string[] = [];
	core.diagnostics.forEach((diagnostic, index) => {
		if (diagnostic.errors.length === 0) return;
		const op: QueryOperation | undefined = core.ops[index];
		const count = diagnostic.errors.length;
		warnings.push(
			`Skipped ${count} ${count === 1 ? 'row' : 'rows'} in '${op?.type ?? 'unknown'}': ${diagnostic.errors[0].message}`
		);
	});
	return warnings;
}

/**
 * A task as the engine returns it carries every field of its page too (copied on for `WHERE` and
 * `SORT`). Keep only the task's own keys, read from the page's own serialization, and drop the
 * deprecated aliases, recursively through `children`.
 */
function createTaskWireEncoder(index: DataviewIndexReader): (task: Literal) => DataviewWireValue {
	const ownTasks = new Map<string, Map<number, SListItem>>();
	const ownTask = (path: string, line: number): SListItem | undefined => {
		let byLine = ownTasks.get(path);
		if (!byLine) {
			byLine = new Map();
			const page = index.pages.get(path);
			for (const item of page?.serialize(index).file.tasks ?? []) byLine.set(item.line, item);
			ownTasks.set(path, byLine);
		}
		return byLine.get(line);
	};

	const encodeItem = (item: DataObject, own: DataObject | undefined): DataviewWireValue => {
		const result: { [key: string]: DataviewWireValue } = {};
		for (const [key, value] of Object.entries(item)) {
			if (DEPRECATED_TASK_KEYS.has(key) || value === undefined) continue;
			if (own && !(key in own)) continue;
			result[key] =
				key === 'children' && Array.isArray(value)
					? value.map((child) => encodeItem(child as DataObject, undefined))
					: toWireValue(value);
		}
		return result;
	};

	return (task) => {
		const item = task as DataObject;
		const own =
			typeof item.path === 'string' && typeof item.line === 'number'
				? ownTask(item.path, item.line)
				: undefined;
		return encodeItem(item, own as DataObject | undefined);
	};
}

/**
 * Run one `dataview` block. `thisPath` is the vault-relative path of the note that holds the
 * block: it binds `this` and anchors relative sources and links, as in Obsidian.
 */
export async function executeDql(
	source: string,
	thisPath: string,
	index: DataviewIndexReader
): Promise<DataviewResult> {
	const parsed = parseQuery(source);
	if (!parsed.successful) {
		return errorResult(
			DATAVIEW_BLOCK_ERROR_PREFIX + parsed.error,
			parseErrorLine(parsed.error, source)
		);
	}
	const query = parsed.value;
	try {
		switch (query.header.type) {
			case 'calendar':
				return { kind: 'unsupported', feature: 'CALENDAR' };
			case 'table': {
				const result = await executeTable(query, index, thisPath, DataviewSettings);
				if (!result.successful) return errorResult(DATAVIEW_BLOCK_ERROR_PREFIX + result.error);
				const { core, names, data, idMeaning } = result.value;
				return {
					kind: 'table',
					headers: names,
					rows: data.map((row) => row.map(toWireValue)),
					idMeaning,
					warnings: rowWarnings(core),
				};
			}
			case 'list': {
				const result = await executeList(query, index, thisPath, DataviewSettings);
				if (!result.successful) return errorResult(DATAVIEW_BLOCK_ERROR_PREFIX + result.error);
				const { core, data, primaryMeaning } = result.value;
				return {
					kind: 'list',
					items: data.map(toWireValue),
					idMeaning: primaryMeaning,
					warnings: rowWarnings(core),
				};
			}
			case 'task': {
				const result = await executeTask(query, thisPath, index, DataviewSettings);
				if (!result.successful) return errorResult(DATAVIEW_BLOCK_ERROR_PREFIX + result.error);
				const { core, tasks } = result.value;
				const encodeTask = createTaskWireEncoder(index);
				return {
					kind: 'task',
					groups: mapTaskGroups(tasks as Literal[], (value) =>
						// Group keys are plain values; tasks lose their copied page fields.
						isTaskItem(value) ? encodeTask(value) : toWireValue(value)
					),
					idMeaning: core.idMeaning,
					warnings: rowWarnings(core),
				};
			}
		}
	} catch (error) {
		return errorResult(DATAVIEW_BLOCK_ERROR_PREFIX + describeError(error));
	}
}

function isTaskItem(value: Literal): boolean {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && 'task' in value;
}

/**
 * Evaluate one inline `` `= expr` ``. A leading `=` is optional. Errors carry upstream's inline
 * messages: `Dataview (inline field '<expr>'): ...` for a parse error and
 * `Dataview (for inline query '<expr>'): ...` for an evaluation error.
 */
export function executeInlineDql(
	expression: string,
	thisPath: string,
	index: DataviewIndexReader
): DataviewInlineResult {
	const trimmed = expression.trim();
	const expr = (trimmed.startsWith('=') ? trimmed.slice(1) : trimmed).trim();
	const parsed = parseField(expr);
	if (!parsed.successful) {
		return errorResult(`Dataview (inline field '${expr}'): ${parsed.error}`);
	}
	try {
		const result = executeInline(parsed.value, thisPath, index, DataviewSettings);
		if (!result.successful) {
			return errorResult(`Dataview (for inline query '${expr}'): ${result.error}`);
		}
		return { kind: 'value', value: toWireValue(result.value) };
	} catch (error) {
		return errorResult(`Dataview (for inline query '${expr}'): ${describeError(error)}`);
	}
}
