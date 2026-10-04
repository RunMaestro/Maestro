/**
 * The Auto Run overlay as pure state (AR-1, AR-2): the folder's documents with
 * done / total counts, the problems found in the highlighted document, and the
 * box a new document is named in. The overlay that draws it (`AutoRunView.tsx`)
 * and the App's key handling read this file. Listing, counting, validating, and
 * creating all come from the library, so the figures here are the ones a run
 * works from.
 */

import {
	checkAutoRunDocument,
	createAutoRunDocument,
	findLastAutoRun,
	listAutoRunDocuments,
	resolveAutoRunFolder,
	summarizeAutoRunIssues,
	type AgentRecord,
	type AutoRunDocument,
	type AutoRunIssue,
	type LastAutoRun,
	type MaestroPaths,
} from '../../shared/maestro-lib';
import { agentSshRemoteId } from '../agents/form';
import type { EditorResult } from './editor';

export interface AutoRunViewState {
	agentId: string;
	/** Where the documents are. Absent for an agent whose folder cannot be listed here. */
	folder?: string;
	documents: readonly AutoRunDocument[];
	cursor: number;
	lastRun?: LastAutoRun;
	/** Why there is nothing to list (remote agent, unreadable folder), in a line or two. */
	problem?: string;
	/** A softer fact about the folder: it does not exist yet. */
	note?: string;
	/** A new document can be written here. */
	canCreate: boolean;
	/** The document `issues` describes. */
	checked?: string;
	issues: readonly AutoRunIssue[];
	/** The result of the last edit, or why the editor did not run. */
	message?: string;
	/** The name box for a new document, while it is open. */
	naming?: { text: string; error?: string };
}

type HistoryPaths = Pick<MaestroPaths, 'historyDir'>;

export function highlightedDocument(view: AutoRunViewState): AutoRunDocument | undefined {
	return view.documents[view.cursor];
}

/** Reads the highlighted document and records what is wrong with it. */
function checkHighlighted(view: AutoRunViewState): AutoRunViewState {
	const document = highlightedDocument(view);
	if (!document) return { ...view, checked: undefined, issues: [] };
	const result = checkAutoRunDocument(document.file);
	if (result.status === 'ok') return { ...view, checked: document.name, issues: result.issues };
	return {
		...view,
		checked: document.name,
		issues: [{ severity: 'error', line: 0, message: `Could not read it: ${result.reason}` }],
	};
}

/** Lists the folder again, keeping the cursor on the same document when it is still there. */
function load(view: AutoRunViewState, keep?: string): AutoRunViewState {
	if (!view.folder) return view;
	const listing = listAutoRunDocuments(view.folder);
	const stay = keep ?? highlightedDocument(view)?.name;
	if (listing.status === 'unreadable') {
		return {
			...view,
			documents: [],
			cursor: 0,
			canCreate: false,
			problem: `The folder could not be read: ${listing.reason}`,
			note: undefined,
			checked: undefined,
			issues: [],
		};
	}
	const documents = listing.status === 'ok' ? listing.documents : [];
	const found = stay ? documents.findIndex((document) => document.name === stay) : -1;
	return checkHighlighted({
		...view,
		documents,
		cursor: found >= 0 ? found : Math.min(view.cursor, Math.max(0, documents.length - 1)),
		canCreate: true,
		problem: undefined,
		note:
			listing.status === 'missing'
				? 'The folder does not exist yet. A new document creates it.'
				: undefined,
	});
}

export function openAutoRunView(
	paths: HistoryPaths,
	agent: AgentRecord,
	options: { naming?: boolean } = {}
): AutoRunViewState {
	const base: AutoRunViewState = {
		agentId: agent.id,
		documents: [],
		cursor: 0,
		canCreate: false,
		issues: [],
		lastRun: findLastAutoRun(paths, agent.id),
	};
	if (agentSshRemoteId(agent)) {
		return {
			...base,
			problem: `${agent.name} runs on an SSH remote, so its Auto Run folder is on that host. The TUI lists local folders only.`,
		};
	}
	const folder = resolveAutoRunFolder(agent);
	if (!folder) {
		return {
			...base,
			problem: `${agent.name} has no working directory, so it has no Auto Run folder.`,
		};
	}
	const loaded = load({ ...base, folder });
	return options.naming && loaded.canCreate ? beginNaming(loaded) : loaded;
}

export function reloadAutoRunView(view: AutoRunViewState): AutoRunViewState {
	return load({ ...view, message: undefined });
}

export function moveAutoRunCursor(view: AutoRunViewState, delta: number): AutoRunViewState {
	const cursor = Math.min(Math.max(0, view.cursor + delta), Math.max(0, view.documents.length - 1));
	if (cursor === view.cursor) return view;
	return checkHighlighted({ ...view, cursor, message: undefined });
}

export function beginNaming(view: AutoRunViewState): AutoRunViewState {
	return view.canCreate ? { ...view, message: undefined, naming: { text: '' } } : view;
}

export function cancelNaming(view: AutoRunViewState): AutoRunViewState {
	return { ...view, naming: undefined };
}

export function typeIntoName(view: AutoRunViewState, text: string): AutoRunViewState {
	return view.naming ? { ...view, naming: { text: view.naming.text + text } } : view;
}

export function backspaceName(view: AutoRunViewState): AutoRunViewState {
	return view.naming ? { ...view, naming: { text: view.naming.text.slice(0, -1) } } : view;
}

export interface NewDocumentOutcome {
	view: AutoRunViewState;
	/** The file to open in the editor, when the document was created. */
	edit?: string;
}

/** Writes the template named in the box. A refusal stays in the box with its reason. */
export function submitNewDocument(view: AutoRunViewState): NewDocumentOutcome {
	if (!view.naming || !view.folder) return { view };
	const created = createAutoRunDocument(view.folder, view.naming.text);
	if (!created.ok) return { view: { ...view, naming: { ...view.naming, error: created.reason } } };
	return {
		view: load({ ...view, naming: undefined, message: `Created ${created.name}.` }, created.name),
		edit: created.file,
	};
}

/** What the list says after the editor closes: the document is re-read and re-checked. */
export function finishAutoRunEdit(
	view: AutoRunViewState,
	file: string,
	result: EditorResult
): AutoRunViewState {
	const name = view.documents.find((document) => document.file === file)?.name;
	const reloaded = load(view, name);
	if (!result.ok) return { ...reloaded, message: result.message };
	const edited = reloaded.checked ?? name ?? 'the document';
	return {
		...reloaded,
		message: `Edited ${edited}: ${summarizeAutoRunIssues(reloaded.issues)}.`,
	};
}
