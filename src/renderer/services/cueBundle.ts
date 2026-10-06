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
import type { SessionInfo } from '../../shared/types';
import { CUE_BUNDLE_AGENT_FIELDS } from '../../shared/cue-bundle-types';
import type {
	CueBundleExportOutcome,
	CueBundleExportRequest,
	CueBundleImportOutcome,
	CueBundleImportRequest,
	CueBundleInspectOutcome,
} from '../../main/cue-bundle-service';
import { useSessionStore } from '../stores/sessionStore';
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

/** Copy only the fields an import sets onto an existing agent. */
function bundleFieldsOf(record: SessionInfo): Partial<Session> {
	const source = record as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const field of CUE_BUNDLE_AGENT_FIELDS) {
		if (field in source) out[field] = source[field];
	}
	return out as Partial<Session>;
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
 */
export async function applyImportedAgents(change: {
	created: SessionInfo[];
	updated: SessionInfo[];
}): Promise<void> {
	const created = await Promise.all(change.created.map(withGitState));
	const updates = new Map(change.updated.map((record) => [record.id, bundleFieldsOf(record)]));
	const touched: Session[] = [];

	useSessionStore.getState().setSessions((prev) => {
		const existingIds = new Set(prev.map((s) => s.id));
		const next = prev.map((s) => {
			const fields = updates.get(s.id);
			if (!fields) return s;
			const merged = { ...s, ...fields };
			touched.push(merged);
			return merged;
		});
		const added = created.filter((s) => !existingIds.has(s.id));
		touched.push(...added);
		return [...next, ...added];
	});

	await window.maestro.sessions.setMany(touched, []);
}
