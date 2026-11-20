/**
 * Writing a group's Group Settings profile for a caller that is not the dialog:
 * `maestro-cli update-group-settings` and any bridge client.
 *
 * The same four steps the dialog's Save takes, with the form replaced by a
 * typed patch:
 *
 *   1. Fold the patch into the stored profile with the dialog's own builder
 *      (`applyGroupDefaultsPatch`), so a value a launch would refuse is refused.
 *   2. Diff the new profile against the stored one (`diffGroupDefaults`).
 *   3. Write the profile and the pill label in one pass, and flush the group
 *      list so the caller's readback is deterministic.
 *   4. When asked, publish exactly that diff into the group's direct members
 *      (`publishGroupDefaults`), through the service the dialog's publish
 *      button calls.
 *
 * Nothing is written when any step fails, so a refused flag leaves the group
 * as it was.
 *
 * The group's Onboarding and Offboarding prompts (`lifecyclePatch`) ride in the
 * same write, checked with the dialog's own validator. A `runLifecycle` request
 * writes nothing: it runs one stage's stored prompt now, through the runner the
 * dialog's "Run now" calls.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import { GROUP_SHORT_LABEL_MAX_LENGTH } from '../../shared/formatters';
import {
	diffGroupDefaults,
	summarizeGroupDefaultsDiff,
	withGroupDefaults,
	withGroupShortLabel,
} from '../../shared/groupAgentDefaults';
import {
	parseGroupSettingsUpdateRequest,
	type GroupSettingsPublishReport,
	type GroupSettingsUpdateResult,
} from '../../shared/groupSettingsUpdate';
import { isWorktreeGroup } from '../../shared/types';
import {
	applyGroupLifecyclePatch,
	groupLifecycleProblem,
	normalizeGroupLifecycle,
	withGroupLifecycle,
} from '../../shared/groupLifecycle';
import { applyGroupDefaultsPatch } from '../components/GroupSettingsModal/groupDefaultsPatch';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { getHomeDirAsync } from '../utils/homeDir';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { notifyGroupDefaultsPublished, publishGroupDefaults } from './groupDefaultsPublish';
import { flushGroupsToDisk } from './groupPersistence';
import { runGroupLifecycleNow } from './groupLifecycle';

function refuse(error: string): GroupSettingsUpdateResult {
	return { success: false, error };
}

/** The saved SSH remotes, or `undefined` when they cannot be read (then none is judged gone). */
async function readSshRemotes(): Promise<Array<{ id: string; name: string }> | undefined> {
	try {
		const result = await window.maestro.sshRemote.getConfigs();
		return result.success ? (result.configs ?? []) : undefined;
	} catch {
		return undefined;
	}
}

export async function applyRemoteGroupSettings(
	groupId: string,
	rawRequest: unknown
): Promise<GroupSettingsUpdateResult> {
	const parsed = parseGroupSettingsUpdateRequest(rawRequest);
	if (!parsed.ok) return refuse(parsed.error);
	const request = parsed.request;

	const store = useSessionStore.getState();
	const group = store.groups.find((candidate) => candidate.id === groupId);
	if (!group) return refuse('Group not found');
	if (isWorktreeGroup(group)) {
		return refuse(
			`"${group.name}" is a worktree group. Its agents are created by the worktree flow and take no defaults, so there is nothing to set here.`
		);
	}

	if (request.runLifecycle) {
		const { stage, agentId } = request.runLifecycle;
		const outcome = await runGroupLifecycleNow(groupId, stage, agentId);
		if (!outcome.ok) return refuse(outcome.error);
		return {
			success: true,
			defaults: group.defaults ?? null,
			shortLabel: group.shortLabel ?? null,
			lifecycle: normalizeGroupLifecycle(group.lifecycle) ?? null,
			changed: [],
			lifecycleRun: outcome.report,
		};
	}

	let lifecycle = normalizeGroupLifecycle(group.lifecycle);
	if (request.lifecyclePatch) {
		lifecycle = applyGroupLifecyclePatch(group.lifecycle, request.lifecyclePatch);
		const problem = groupLifecycleProblem(lifecycle, {
			liveAgentIds: store.sessions.map((session) => session.id),
		});
		if (problem) return refuse(problem.error);
	}

	const shortLabel = request.shortLabel?.trim();
	if (shortLabel !== undefined && shortLabel.length > GROUP_SHORT_LABEL_MAX_LENGTH) {
		return refuse(
			`--short-label is ${shortLabel.length} characters. The pill holds ${GROUP_SHORT_LABEL_MAX_LENGTH}.`
		);
	}

	let defaults = group.defaults;
	if (request.clearDefaults) {
		defaults = undefined;
	} else if (request.configPatch || request.sshPatch) {
		let homeDir = '';
		try {
			homeDir = (await getHomeDirAsync()) ?? '';
		} catch (error) {
			return refuse(`Could not read the home directory: ${ipcErrorMessage(error)}`);
		}
		const settings = useSettingsStore.getState();
		const applied = applyGroupDefaultsPatch(
			group.defaults,
			{ configPatch: request.configPatch, sshPatch: request.sshPatch },
			{
				homeDir,
				endpoints: settings.localModelEndpoints ?? [],
				harnessTierDefaults: settings.harnessTierDefaults,
				sshRemotes: await readSshRemotes(),
				liveAgentIds: store.sessions.map((session) => session.id),
			}
		);
		if (!applied.ok) return refuse(applied.error);
		defaults = applied.defaults;
	}

	const diff = diffGroupDefaults(group.defaults, defaults);
	const nextShortLabel = shortLabel === undefined ? group.shortLabel : shortLabel || undefined;

	store.setGroups((prev) =>
		prev.map((candidate) =>
			candidate.id === groupId
				? withGroupLifecycle(
						withGroupShortLabel(withGroupDefaults(candidate, defaults), nextShortLabel),
						lifecycle
					)
				: candidate
		)
	);
	if (!(await flushGroupsToDisk())) return refuse('Failed to persist group defaults');

	const summary = summarizeGroupDefaultsDiff(diff);
	const result: GroupSettingsUpdateResult = {
		success: true,
		defaults: defaults ?? null,
		shortLabel: nextShortLabel ?? null,
		lifecycle: lifecycle ?? null,
		changed: [
			...summary.changed,
			...summary.unpublished,
			...(request.lifecyclePatch ? lifecycleChangeNames(group.lifecycle, lifecycle) : []),
		],
	};

	if (request.publish) {
		const published = { id: group.id, name: group.name, emoji: group.emoji };
		const outcome =
			diff.changes.length > 0
				? await publishGroupDefaults(published, diff)
				: { publishId: null, agentCount: 0, agents: [], skipped: [] };
		// The Undo toast is the dialog's only undo, and a publish from a script
		// is the one most likely to need it. It is raised the same way.
		if (diff.changes.length > 0) notifyGroupDefaultsPublished(published, diff, outcome);
		const report: GroupSettingsPublishReport = {
			agents: outcome.agents,
			skipped: outcome.skipped,
			changed: summary.changed,
			unpublished: summary.unpublished,
			replaced: summary.replaced,
			providerBound: summary.providerBound,
		};
		result.publish = report;
	}

	return result;
}

/** The lifecycle stages a write changed, named as the dialog names them. */
function lifecycleChangeNames(
	before: unknown,
	after: ReturnType<typeof normalizeGroupLifecycle>
): string[] {
	const previous = normalizeGroupLifecycle(before);
	const names: string[] = [];
	if (canonicalJson(previous?.onboarding ?? null) !== canonicalJson(after?.onboarding ?? null)) {
		names.push('Onboarding');
	}
	if (canonicalJson(previous?.offboarding ?? null) !== canonicalJson(after?.offboarding ?? null)) {
		names.push('Offboarding');
	}
	return names;
}
