/**
 * The TUI's own preferences: `<userData>/maestro-tui.json` (requirement ST-5).
 *
 * Nothing here touches `maestro-settings.json` or any other desktop store. The
 * file is the TUI's alone, so this is the one place the read-only phase writes,
 * and it only ever writes this file.
 *
 * The document keeps every key it does not own (a later keymap section, a key
 * from a newer TUI build), so saving view state never discards them. A file
 * that is not a JSON object is left alone: view state then lives in memory for
 * the session rather than overwriting something the user may want to repair.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger, parseStoreJson } from '../../shared/maestro-lib';

export const TUI_STATE_FILE_NAME = 'maestro-tui.json';

/** Narrowest and widest the Agents pane may be, in columns. */
export const AGENTS_PANE_MIN_WIDTH = 20;
export const AGENTS_PANE_MAX_WIDTH = 50;
export const AGENTS_PANE_DEFAULT_WIDTH = 28;

/** What the TUI remembers between runs. Every field is optional on disk. */
export interface TuiViewState {
	selectedAgentId?: string;
	/** Group-section key to collapsed. Absent means "the desktop's saved default". */
	collapsedSections: Record<string, boolean>;
	agentsPaneWidth: number;
}

export const DEFAULT_VIEW_STATE: TuiViewState = {
	collapsedSections: {},
	agentsPaneWidth: AGENTS_PANE_DEFAULT_WIDTH,
};

export function tuiStateFilePath(userDataDir: string): string {
	return path.join(userDataDir, TUI_STATE_FILE_NAME);
}

export function clampAgentsPaneWidth(width: number): number {
	return Math.min(AGENTS_PANE_MAX_WIDTH, Math.max(AGENTS_PANE_MIN_WIDTH, Math.round(width)));
}

/** The whole file: `view` is ours, everything else is carried through. */
export interface TuiStateDocument {
	[key: string]: unknown;
	view?: unknown;
}

export type TuiStateLoad =
	| { status: 'ok' | 'missing'; document: TuiStateDocument; view: TuiViewState }
	/** Not a JSON object: view state is not persisted, so the file is never overwritten. */
	| { status: 'corrupt'; document: TuiStateDocument; view: TuiViewState; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pulls the fields it recognizes out of whatever `view` holds; the rest is ignored. */
export function normalizeViewState(raw: unknown): TuiViewState {
	if (!isPlainObject(raw)) return { ...DEFAULT_VIEW_STATE, collapsedSections: {} };

	const collapsedSections: Record<string, boolean> = {};
	if (isPlainObject(raw.collapsedSections)) {
		for (const [key, value] of Object.entries(raw.collapsedSections)) {
			if (typeof value === 'boolean') collapsedSections[key] = value;
		}
	}

	return {
		...(typeof raw.selectedAgentId === 'string' ? { selectedAgentId: raw.selectedAgentId } : {}),
		collapsedSections,
		agentsPaneWidth:
			typeof raw.agentsPaneWidth === 'number' && Number.isFinite(raw.agentsPaneWidth)
				? clampAgentsPaneWidth(raw.agentsPaneWidth)
				: AGENTS_PANE_DEFAULT_WIDTH,
	};
}

/** Reads the TUI state file. Never throws and never creates anything. */
export function loadTuiState(file: string): TuiStateLoad {
	const defaults = (): TuiViewState => ({ ...DEFAULT_VIEW_STATE, collapsedSections: {} });

	let content: string;
	try {
		content = fs.readFileSync(file, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return { status: 'missing', document: {}, view: defaults() };
		return {
			status: 'corrupt',
			document: {},
			view: defaults(),
			reason: (error as Error).message,
		};
	}

	const parsed = parseStoreJson<unknown>(content);
	if (!parsed.ok) {
		return { status: 'corrupt', document: {}, view: defaults(), reason: parsed.error.message };
	}
	if (!isPlainObject(parsed.value)) {
		return {
			status: 'corrupt',
			document: {},
			view: defaults(),
			reason: 'the document is not a JSON object',
		};
	}
	return {
		status: 'ok',
		document: parsed.value,
		view: normalizeViewState(parsed.value.view),
	};
}

/**
 * Writes `view` into the file, keeping every other key of `document`. Writes a
 * temp file beside it and renames, so a crash mid-write cannot leave a torn
 * state file. Returns false (and logs) when the write fails; a TUI that cannot
 * save its layout still works.
 */
export function saveTuiViewState(
	file: string,
	document: TuiStateDocument,
	view: TuiViewState
): boolean {
	const temp = `${file}.${process.pid}.tmp`;
	try {
		const next: TuiStateDocument = { ...document, view };
		fs.writeFileSync(temp, `${JSON.stringify(next, undefined, '\t')}\n`, 'utf-8');
		fs.renameSync(temp, file);
		return true;
	} catch (error) {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			// The temp file is ours; failing to remove it changes nothing the user sees.
		}
		logger.warn('could not save the TUI view state', 'tui', error);
		return false;
	}
}
