/**
 * The Agents pane as a flat list of rows, plus the small pure helpers its view
 * needs. The tree itself comes from the library (`buildAgentTree`); what is
 * TUI-specific is which sections the user has folded, how a row is drawn, and
 * which slice of a long list fits on screen.
 */

import {
	getAgentDisplayName,
	type AgentRecord,
	type AgentRecordState,
	type AgentTreeSection,
} from '../../shared/maestro-lib';

export interface SectionRow {
	kind: 'section';
	key: string;
	section: AgentTreeSection;
	collapsed: boolean;
	/** Agents in the section, worktree children included. */
	agentCount: number;
}

export interface AgentRow {
	kind: 'agent';
	/** `<section key>/<agent id>`: a bookmarked agent appears in two sections. */
	key: string;
	agent: AgentRecord;
	/** 0 for a top-level agent, 1 for a worktree child. */
	depth: 0 | 1;
}

export type PaneRow = SectionRow | AgentRow;

/** A section is folded when the user said so, else when the desktop saved it folded. */
export function isSectionCollapsed(
	section: AgentTreeSection,
	overrides: Readonly<Record<string, boolean>>
): boolean {
	return overrides[section.key] ?? section.collapsedByDefault;
}

/**
 * Flattens the tree into drawable rows. Every section gets a header row, so a
 * group the user folded (or left empty) is still there to unfold. The
 * Bookmarks and Ungrouped sections are headed too, which keeps the cursor
 * model uniform: a row is either a section or an agent.
 */
export function buildPaneRows(
	sections: readonly AgentTreeSection[],
	collapsedOverrides: Readonly<Record<string, boolean>>
): PaneRow[] {
	const rows: PaneRow[] = [];
	for (const section of sections) {
		const collapsed = isSectionCollapsed(section, collapsedOverrides);
		rows.push({
			kind: 'section',
			key: section.key,
			section,
			collapsed,
			agentCount: section.nodes.reduce((total, node) => total + 1 + node.children.length, 0),
		});
		if (collapsed) continue;
		for (const node of section.nodes) {
			rows.push({
				kind: 'agent',
				key: `${section.key}/${node.agent.id}`,
				agent: node.agent,
				depth: 0,
			});
			for (const child of node.children) {
				rows.push({
					kind: 'agent',
					key: `${section.key}/${child.id}`,
					agent: child,
					depth: 1,
				});
			}
		}
	}
	return rows;
}

/** Where the cursor starts: the remembered agent when it is still listed, else the first row. */
export function initialCursorKey(
	rows: readonly PaneRow[],
	selectedAgentId: string | undefined
): string | undefined {
	if (selectedAgentId) {
		const remembered = rows.find((row) => row.kind === 'agent' && row.agent.id === selectedAgentId);
		if (remembered) return remembered.key;
	}
	return rows[0]?.key;
}

/**
 * Where the cursor goes to land on an agent from outside the list (the palette).
 * An agent already drawn gets its row; one inside a folded section gets that
 * section's key too, so the caller can unfold it. A bookmarked agent sits in two
 * sections, and the one drawn wins. Undefined when no section lists the agent.
 */
export function locateAgent(
	sections: readonly AgentTreeSection[],
	rows: readonly PaneRow[],
	agentId: string
): { cursorKey: string; unfoldSectionKey?: string } | undefined {
	const drawn = rows.find((row) => row.kind === 'agent' && row.agent.id === agentId);
	if (drawn) return { cursorKey: drawn.key };
	const section = sections.find((candidate) =>
		candidate.nodes.some(
			(node) => node.agent.id === agentId || node.children.some((child) => child.id === agentId)
		)
	);
	return section
		? { cursorKey: `${section.key}/${agentId}`, unfoldSectionKey: section.key }
		: undefined;
}

/** Moves the cursor by `delta` rows, stopping at either end. */
export function moveCursor(
	rows: readonly PaneRow[],
	cursorKey: string | undefined,
	delta: number
): string | undefined {
	if (rows.length === 0) return undefined;
	const index = rows.findIndex((row) => row.key === cursorKey);
	const next = Math.min(rows.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta));
	return rows[next].key;
}

/**
 * The slice of `rows` to draw in `height` lines, keeping the cursor on screen.
 * Scrolls only as far as it has to, so moving down a long list does not recenter
 * it on every key.
 */
export function windowRows<T extends { key: string }>(
	rows: readonly T[],
	cursorKey: string | undefined,
	height: number,
	previousStart = 0
): { start: number; rows: T[] } {
	if (height <= 0) return { start: 0, rows: [] };
	if (rows.length <= height) return { start: 0, rows: [...rows] };
	const cursor = Math.max(
		0,
		rows.findIndex((row) => row.key === cursorKey)
	);
	let start = Math.min(previousStart, rows.length - height);
	if (cursor < start) start = cursor;
	else if (cursor >= start + height) start = cursor - height + 1;
	return { start, rows: rows.slice(start, start + height) };
}

/** Ink color for an agent's state dot, following the desktop's color coding. */
export function stateColor(state: AgentRecordState | undefined): string {
	switch (state) {
		case 'busy':
			return 'yellow';
		case 'error':
			return 'red';
		case 'connecting':
			return '#ff9900';
		case 'waiting_input':
			return 'cyan';
		default:
			return 'green';
	}
}

/**
 * A short provider tag for a row: initials for a multi-word name (Claude Code
 * is CC, Oh My Pi is OMP), else the first three letters. A provider this build
 * has never heard of falls back to its raw id, so it is still labelled.
 */
export function providerBadge(toolType: string): string {
	const words = getAgentDisplayName(toolType)
		.split(/[\s_-]+/)
		.filter(Boolean);
	if (words.length === 0) return '?';
	if (words.length > 1)
		return words
			.map((word) => word[0])
			.join('')
			.toUpperCase()
			.slice(0, 3);
	return words[0].slice(0, 3).toUpperCase();
}
