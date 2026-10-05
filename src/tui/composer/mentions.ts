/**
 * The `@` picker over the composer's draft (XM-1), as pure state.
 *
 * The picker is not stored: it is derived from the draft and the caret each
 * time, so a paste, a held key, and an edit from anywhere cannot leave it
 * describing text that is gone. The only state it keeps (`MentionUi`) is the
 * highlighted row, which filter that row belongs to, and the `@` the person
 * dismissed with Esc. The rules for where a mention starts, how rows rank, and
 * what accepting one inserts are the library's, shared with the desktop.
 */

import {
	buildAgentMentionSuggestions,
	filterAgentMentionSuggestions,
	getAtMentionTrigger,
	mentionableAgentsOf,
	mentionableGroupsOf,
	spliceMentionLiteral,
	stripMentionQuotes,
	type AgentMentionSuggestion,
	type AgentRecord,
	type AgentTreeSection,
	type GroupRecord,
} from '../../shared/maestro-lib';
import type { ComposerState } from './draft';

/** The picker shows this many rows at once and scrolls past them. */
export const MENTION_PICKER_ROWS = 5;

/** Lines the picker takes: its header and its rows. */
export function mentionPickerHeight(picker: MentionPicker): number {
	return 1 + Math.min(MENTION_PICKER_ROWS, picker.rows.length);
}

export interface MentionUi {
	/** The composer the state belongs to, so switching tabs starts fresh. */
	key: string;
	/** The raw filter the highlighted row was chosen for. */
	filter: string | undefined;
	cursor: number;
	/** The `@` Esc closed. The picker stays shut for that `@` until it is gone. */
	dismissedAt: number | undefined;
}

export const initialMentionUi = (key: string): MentionUi => ({
	key,
	filter: undefined,
	cursor: 0,
	dismissedAt: undefined,
});

export interface MentionPicker {
	/** Index of the `@` in the draft. */
	startIndex: number;
	/** The raw text after the `@`, as typed. */
	filter: string;
	rows: AgentMentionSuggestion[];
	/** The highlighted row, within `rows`. */
	cursor: number;
}

/** The groups the agent tree knows, as the mention helpers read them. */
export function groupsOfSections(sections: readonly AgentTreeSection[]): GroupRecord[] {
	return sections
		.filter((section) => section.kind === 'group' && section.groupId !== undefined)
		.map((section) => ({ id: section.groupId!, name: section.title }));
}

/** Every row the picker can offer from `sourceAgentId`: other agents, and groups that expand into them. */
export function mentionItemsFor(
	agents: readonly AgentRecord[],
	sections: readonly AgentTreeSection[],
	sourceAgentId: string
): AgentMentionSuggestion[] {
	return buildAgentMentionSuggestions(
		mentionableAgentsOf(agents),
		mentionableGroupsOf(groupsOfSections(sections)),
		sourceAgentId
	);
}

/** The open picker for this draft, or undefined when the caret is not in an `@name` or nothing matches. */
export function resolveMentionPicker(
	draft: ComposerState,
	items: readonly AgentMentionSuggestion[],
	ui: MentionUi
): MentionPicker | undefined {
	const trigger = getAtMentionTrigger(draft.text, draft.cursor);
	if (!trigger || trigger.startIndex === ui.dismissedAt) return undefined;
	const rows = filterAgentMentionSuggestions(items, stripMentionQuotes(trigger.filter));
	if (rows.length === 0) return undefined;
	const cursor = ui.filter === trigger.filter ? Math.min(ui.cursor, rows.length - 1) : 0;
	return { startIndex: trigger.startIndex, filter: trigger.filter, rows, cursor };
}

/** The highlighted row moves by `delta` and stops at the ends. */
export function stepMentionCursor(ui: MentionUi, picker: MentionPicker, delta: number): MentionUi {
	const cursor = Math.max(0, Math.min(picker.rows.length - 1, picker.cursor + delta));
	return { ...ui, filter: picker.filter, cursor };
}

/** Esc: shut the picker for this `@`, leaving the text as typed. */
export function dismissMentionPicker(ui: MentionUi, picker: MentionPicker): MentionUi {
	return { ...ui, filter: picker.filter, cursor: picker.cursor, dismissedAt: picker.startIndex };
}

/**
 * The draft after accepting the highlighted row. An agent inserts its own
 * `@name `; a group inserts every member's `@name ` instead, because a group is
 * shorthand and never a target (XM-1).
 */
export function acceptMention(draft: ComposerState, picker: MentionPicker): ComposerState {
	const row = picker.rows[picker.cursor];
	if (!row) return draft;
	const literal =
		row.kind === 'group' && row.memberMentionValue ? row.memberMentionValue : row.value;
	const { value, caretPos } = spliceMentionLiteral(
		draft.text,
		picker.startIndex,
		picker.filter,
		literal
	);
	return { text: value, cursor: caretPos };
}

/** The rows on screen: a window of `MENTION_PICKER_ROWS` that keeps the highlighted row in view. */
export function visibleMentionRows(picker: MentionPicker): {
	start: number;
	rows: AgentMentionSuggestion[];
} {
	const start = Math.max(
		0,
		Math.min(picker.cursor - MENTION_PICKER_ROWS + 1, picker.rows.length - MENTION_PICKER_ROWS)
	);
	const from = Math.max(0, start);
	return { start: from, rows: picker.rows.slice(from, from + MENTION_PICKER_ROWS) };
}
