// Run group lifecycle command - run a group's Onboarding or Offboarding prompt
// now, on one agent of the group, in the running desktop app.
//
// The CLI half of Group Settings > Lifecycle > "Run now on an agent...". It runs
// the STORED prompt (the dialog runs the one typed), through the same runner the
// dialog calls, by riding the `update_group_settings` message with a
// `runLifecycle` request that writes nothing. An Offboarding run here removes
// nothing: it only runs the prompt.

import { GROUP_LIFECYCLE_STAGES, type GroupLifecycleStage } from '../../shared/groupLifecycle';
import type { GroupSettingsUpdateResult } from '../../shared/groupSettingsUpdate';
import { formatGroupLifecycleRun } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { groupSettingsBlocker } from '../services/group-settings';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	sendSimpleCommand,
} from '../services/session-command';
import { getSessionById, readGroups, resolveAgentId, resolveGroupId } from '../services/storage';

interface RunGroupLifecycleOptions {
	agent: string;
	json?: boolean;
}

export async function runGroupLifecycle(
	groupId: string,
	stageArg: string,
	options: RunGroupLifecycleOptions
): Promise<void> {
	const stage = stageArg.trim().toLowerCase();
	if (!(GROUP_LIFECYCLE_STAGES as readonly string[]).includes(stage)) {
		return failCommand(
			`Unknown stage "${stageArg}". Use ${GROUP_LIFECYCLE_STAGES.join(' or ')}.`,
			options.json
		);
	}

	let resolvedGroupId: string;
	let agentId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
		agentId = resolveAgentId(options.agent);
	} catch (error) {
		return failFromError(error, options.json);
	}
	const group = readGroups().find((candidate) => candidate.id === resolvedGroupId);
	if (!group) return failCommand(`Group not found: ${groupId}`, options.json);
	const blocker = groupSettingsBlocker(group);
	if (blocker) return failCommand(blocker, options.json);

	let result: GroupSettingsUpdateResult;
	try {
		result = (await sendSimpleCommand(
			{
				type: 'update_group_settings',
				groupId: resolvedGroupId,
				runLifecycle: { stage: stage as GroupLifecycleStage, agentId },
			},
			'update_group_settings_result'
		)) as unknown as GroupSettingsUpdateResult;
	} catch (error) {
		return failFromError(error, options.json);
	}
	if (!result.success) {
		return failCommand(
			result.error || errorFrameMessage(result) || 'Failed to run the lifecycle prompt',
			options.json
		);
	}
	const run = result.lifecycleRun;
	if (!run) {
		return failCommand(
			'The running Maestro desktop app does not know Onboarding and Offboarding prompts. Update the app, then run this again.',
			options.json
		);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, groupId: resolvedGroupId, run }));
		return;
	}
	if (isQuiet()) return;
	console.log(
		formatGroupLifecycleRun(`${group.emoji} ${group.name}`, run, {
			subject: getSessionById(run.subjectAgentId)?.name ?? run.subjectAgentId,
			runAgent: getSessionById(run.runAgentId)?.name ?? run.runAgentId,
		})
	);
}
