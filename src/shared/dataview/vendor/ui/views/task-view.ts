// Vendored from blacksmithgu/obsidian-dataview@0.5.68 (29b1ad87e1f2b964b4fa0c209f11d0622469bdb0).
// Upstream path: src/ui/views/task-view.tsx. License: MIT, see ../../LICENSE.
// Modified for Maestro: E1, E2, E-proto, Split (kept the task de-duplication and task manipulation helpers, upstream
// lines 258-406, verbatim; the preact views are dropped); indentation converted to tabs. Search for "MAESTRO" for the
// non-mechanical ones.
import { setEmojiShorthandCompletionField, setInlineField } from "../../data-import/inline-field";
import { LIST_ITEM_REGEX } from "../../data-import/markdown-file";
import { SListItem, STask } from "../../data-model/serialized/markdown";
import { Grouping, Groupings } from "../../data-model/value";
import { DateTime } from "luxon";
import { Vault } from "../../obsidian-shim";

/////////////////////////
// Task De-Duplication //
/////////////////////////

function listId(item: SListItem): string {
	return item.path + ":" + item.line;
}

function parentListId(item: SListItem): string {
	return item.path + ":" + item.parent;
}

/** Compute a map of all task IDs -> tasks. */
function enumerateChildren(item: SListItem, output: Map<string, SListItem>): Map<string, SListItem> {
	if (!output.has(listId(item))) output.set(listId(item), item);
	for (let child of item.children) enumerateChildren(child, output);

	return output;
}

/** Replace basic tasks with tasks from a lookup map. Retains the original order of the list. */
function replaceChildren(elements: SListItem[], lookup: Map<string, SListItem>): SListItem[] {
	return elements.map(element => {
		element.children = replaceChildren(element.children, lookup);

		const id = listId(element);
		const map = lookup.get(id);

		if (map) return map;
		else return element;
	});
}

/**
 * Removes tasks from a list if they are already present by being a child of another task. Fixes child pointers.
 * Retains original order of input list.
 */
export function nestItems(raw: SListItem[]): [SListItem[], Set<string>] {
	let elements: Map<string, SListItem> = new Map();
	let mask: Set<string> = new Set();

	for (let elem of raw) {
		let id = listId(elem);
		elements.set(id, elem);
		mask.add(id);
	}

	// List all elements & their children in the lookup map.
	for (let elem of raw) enumerateChildren(elem, elements);

	let roots = raw.filter(
		elem => elem.parent == undefined || elem.parent == null || !elements.has(parentListId(elem))
	);
	return [replaceChildren(roots, elements), mask];
}

/**
 * Recursively removes tasks from each subgroup if they are already present by being a child of another task.
 * Fixes child pointers. Retains original order of input list.
 */
export function nestGroups(raw: Grouping<SListItem>): Grouping<SListItem> {
	if (Groupings.isGrouping(raw)) {
		return raw.map(g => {
			return { key: g.key, rows: nestGroups(g.rows) };
		});
	} else {
		return nestItems(raw)[0];
	}
}

///////////////////////
// Task Manipulation //
///////////////////////

/** Trim empty ending lines. */
function trimEndingLines(text: string): string {
	let parts = text.split(/\r?\n/u);
	let trim = parts.length - 1;
	while (trim > 0 && parts[trim].trim() == "") trim--;

	return parts.join("\n");
}

/** Set the task completion key on check. */
export function setTaskCompletion(
	originalText: string,
	useEmojiShorthand: boolean,
	completionKey: string,
	completionDateFormat: string,
	complete: boolean
): string {
	const blockIdRegex = /\^[a-z0-9\-]+/i;

	if (!complete && !useEmojiShorthand)
		return trimEndingLines(setInlineField(originalText.trimEnd(), completionKey)).trimEnd();

	let parts = originalText.split(/\r?\n/u);
	const matches = blockIdRegex.exec(parts[parts.length - 1]);
	console.debug("matchreg", matches);

	let processedPart = parts[parts.length - 1].split(blockIdRegex).join(""); // last part without block id
	if (useEmojiShorthand) {
		processedPart = setEmojiShorthandCompletionField(
			processedPart,
			complete ? DateTime.now().toFormat("yyyy-MM-dd") : ""
		);
	} else {
		processedPart = setInlineField(processedPart, completionKey, DateTime.now().toFormat(completionDateFormat));
	}
	processedPart = `${processedPart.trimEnd()}${matches?.length ? " " + matches[0].trim() : ""}`.trimEnd(); // add back block id
	parts[parts.length - 1] = processedPart;

	return parts.join("\n");
}

/** Rewrite a task with the given completion status and new text. */
export async function rewriteTask(vault: Vault, task: STask, desiredStatus: string, desiredText?: string) {
	if (desiredStatus == task.status && (desiredText == undefined || desiredText == task.text)) return;
	desiredStatus = desiredStatus == "" ? " " : desiredStatus;

	let rawFiletext = await vault.adapter.read(task.path);
	let hasRN = rawFiletext.includes("\r"); // MAESTRO: E-proto (upstream `.contains`, an Obsidian-only String method)
	let filetext = rawFiletext.split(/\r?\n/u);

	if (filetext.length < task.line) return;
	let match = LIST_ITEM_REGEX.exec(filetext[task.line]);
	if (!match || match[2].length == 0) return;

	let taskTextParts = task.text.split("\n");
	if (taskTextParts[0].trim() != match[3].trim()) return;

	// We have a positive match here at this point, so go ahead and do the rewrite of the status.
	let initialSpacing = /^[\s>]*/u.exec(filetext[task.line])!![0];
	if (desiredText) {
		let desiredParts = desiredText.split("\n");

		let newTextLines: string[] = [`${initialSpacing}${task.symbol} [${desiredStatus}] ${desiredParts[0]}`].concat(
			desiredParts.slice(1).map(l => initialSpacing + "\t" + l)
		);

		filetext.splice(task.line, task.lineCount, ...newTextLines);
	} else {
		filetext[task.line] = `${initialSpacing}${task.symbol} [${desiredStatus}] ${taskTextParts[0].trim()}`;
	}

	let newText = filetext.join(hasRN ? "\r\n" : "\n");
	await vault.adapter.write(task.path, newText);
}
