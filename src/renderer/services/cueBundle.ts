/**
 * Cue bundle service: export a pipeline or an agent, inspect a bundle, plan
 * and run an import, all in the running app.
 *
 * Every call returns the main process's outcome object (`ok` plus the result,
 * or a `code` and `message`), so callers show a refusal without parsing it.
 *
 * Also applies the agents an import brings. Main writes the files, then asks
 * the renderer to add the agents, because the renderer owns them and would
 * overwrite a direct write to the sessions file.
 */

import type { Session } from '../types';
import type { SessionInfo, ToolType } from '../../shared/types';
import { CUE_BUNDLE_AGENT_FIELDS } from '../../shared/cue-bundle-types';
import type {
	CueBundleExportOutcome,
	CueBundleExportRequest,
	CueBundleImportOutcome,
	CueBundleImportRequest,
	CueBundleInspectOutcome,
} from '../../main/cue-bundle-service';
import { useSessionStore } from '../stores/sessionStore';
import {
	isSameDirectory,
	withWorkingDirectory,
	workingDirectoryChangeBlocker,
} from '../utils/agentWorkingDirectory';
import { switchTabProvider } from '../utils/providerTabSessions';
import { gitService } from './git';

export const cueBundleService = {
	export(request: CueBundleExportRequest): Promise<CueBundleExportOutcome> {
		return window.maestro.cueBundle.export(request);
	},

	/** Open dialog for a bundle zip. Null when cancelled. */
	chooseFile(): Promise<string | null> {
		return window.maestro.cueBundle.chooseFile();
	},

	inspect(bundlePath: string): Promise<CueBundleInspectOutcome> {
		return window.maestro.cueBundle.inspect(bundlePath);
	},

	/** Plan only: what an import would do, including conflicts. */
	plan(request: Omit<CueBundleImportRequest, 'dryRun'>): Promise<CueBundleImportOutcome> {
		return window.maestro.cueBundle.import({ ...request, dryRun: true });
	},

	import(request: Omit<CueBundleImportRequest, 'dryRun'>): Promise<CueBundleImportOutcome> {
		return window.maestro.cueBundle.import({ ...request, dryRun: false });
	},
};

/**
 * Copy only the fields an import sets onto an existing agent. Every one of
 * them, present or not: the importer sets them all, and one it cleared (a
 * bundle that declares no secrets, say) is `undefined`. Electron IPC keeps
 * such a key, but a JSON transport drops it, and a missing key must still
 * clear the field rather than leave the stale value behind.
 */
function bundleFieldsOf(record: SessionInfo): Partial<Session> {
	const source = record as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const field of CUE_BUNDLE_AGENT_FIELDS) out[field] = source[field];
	return out as Partial<Session>;
}

/** Whether an update moves the agent to another folder. */
function moves(session: Session, fields: Partial<Session>): boolean {
	const dir = fields.projectRoot ?? fields.cwd;
	return typeof dir === 'string' && !isSameDirectory(session.projectRoot || session.cwd, dir);
}

/**
 * An existing agent with the bundle's settings, moved and switched the way
 * the app moves and switches agents: `withWorkingDirectory` clears what
 * described the old folder, and `switchTabProvider` parks each tab's resume
 * token for the old provider instead of handing it to the new one.
 */
function applyBundleUpdate(session: Session, fields: Partial<Session>): Session {
	let next = session;
	if (moves(session, fields)) {
		next = withWorkingDirectory(next, (fields.projectRoot ?? fields.cwd) as string);
	}
	const toolType = fields.toolType as ToolType | undefined;
	if (toolType && toolType !== session.toolType) {
		// As the app's own provider switch does: the old provider's overrides go,
		// and the bundle's fields below set the new provider's.
		next = {
			...next,
			aiTabs: next.aiTabs.map((tab) => switchTabProvider(tab, session.toolType, toolType)),
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
			customEnvVarsDisabled: undefined,
			customModel: undefined,
			customEffort: undefined,
			customContextWindow: undefined,
			contextWindowSource: undefined,
			enableMaestroP: undefined,
			maestroPPath: undefined,
			maestroPMode: undefined,
		};
	}
	return { ...next, ...fields };
}

/** A new agent, with the git state the Left Bar shows, as a created agent gets it. */
async function withGitState(record: SessionInfo): Promise<Session> {
	const session = record as unknown as Session;
	const isGitRepo = await gitService.isRepo(session.cwd);
	if (!isGitRepo) return { ...session, isGitRepo };
	const [gitBranches, gitTags] = await Promise.all([
		gitService.getBranches(session.cwd),
		gitService.getTags(session.cwd),
	]);
	return { ...session, isGitRepo, gitBranches, gitTags, gitRefsCacheTime: Date.now() };
}

/**
 * Add the agents an import created and update the ones it replaced, then
 * write them to disk before answering, so a CLI import followed by
 * `list agents` sees them.
 *
 * Throws when an agent that would move is working, or when the save fails.
 * Either way the agents are left as they were, and main rolls the import's
 * files back.
 */
export async function applyImportedAgents(change: {
	created: SessionInfo[];
	updated: SessionInfo[];
}): Promise<void> {
	const updates = new Map(change.updated.map((record) => [record.id, bundleFieldsOf(record)]));
	const current = new Map(useSessionStore.getState().sessions.map((s) => [s.id, s]));
	for (const [id, fields] of updates) {
		const session = current.get(id);
		if (!session || !moves(session, fields)) continue;
		const blocker = workingDirectoryChangeBlocker(session);
		if (blocker) throw new Error(`Agent "${session.name}" is working. ${blocker}`);
	}

	const created = await Promise.all(change.created.map(withGitState));
	const originals = new Map<string, Session>();
	const createdIds = new Set<string>();
	const touched: Session[] = [];

	useSessionStore.getState().setSessions((prev) => {
		const existingIds = new Set(prev.map((s) => s.id));
		const next = prev.map((s) => {
			const fields = updates.get(s.id);
			if (!fields) return s;
			originals.set(s.id, s);
			const updated = applyBundleUpdate(s, fields);
			touched.push(updated);
			return updated;
		});
		const added = created.filter((s) => !existingIds.has(s.id));
		for (const s of added) createdIds.add(s.id);
		touched.push(...added);
		return [...next, ...added];
	});

	try {
		const saved = await window.maestro.sessions.setMany(touched, []);
		if (saved === false) throw new Error('The imported agents could not be saved.');
	} catch (error) {
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.filter((s) => !createdIds.has(s.id)).map((s) => originals.get(s.id) ?? s)
			);
		throw error;
	}
}
