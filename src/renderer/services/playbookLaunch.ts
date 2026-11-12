/**
 * Playbook Launch in the renderer: the agent a launch runs on, and the submit
 * path that checks the answers, settles that agent and asks main to launch.
 *
 * The launch modal never edits an agent. The current agent and an existing
 * agent are used as they are. A new agent is set up in the New Agent modal in
 * capture mode, which hands back a `NewAgentDraft`, and is created only on
 * submit, after the answers pass validation, so an invalid form never leaves an
 * agent behind. A launch that fails after it created its agent keeps the agent
 * and says so. Main does the rest (`launchMarketplacePlaybook()` in
 * `src/main/services/marketplace-service.ts`): it imports the playbook into a
 * launch folder, records the launch and starts the Auto Run.
 */

import type { NewAgentDraft } from '../components/NewInstanceModal/types';
import {
	launchFieldErrorsFromMessage,
	type PlaybookLaunchRequest,
	type PlaybookLaunchSpec,
} from '../../shared/marketplace-types';
import {
	resolveLaunchValues,
	validateLaunchValues,
	type PlaybookLaunchAnswers,
} from '../../shared/playbookLaunch';
import { definedOnly } from '../../shared/objectUtils';
import { notifyToast } from '../stores/notificationStore';
import { selectActiveSession, selectSessionById, useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { ipcErrorMessage, ipcResultErrorMessage } from '../utils/ipcErrorMessage';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getSessionSshRemoteId, isSessionRemote } from '../utils/sessionHelpers';
import { createAgentFromDraft } from './newAgentCreation';

const LOG_CONTEXT = '[PlaybookLaunch]';

/**
 * The agent a launch runs on, as the launch modal's Run on choice holds it:
 * the agent this window has selected, another agent as it is, or a new agent
 * that does not exist until the launch is submitted.
 */
export type LaunchTarget =
	| { kind: 'current' }
	| { kind: 'existing'; sessionId: string }
	| { kind: 'new'; draft: NewAgentDraft };

/** A launch target settled to one agent: what a launch request says about the agent. */
export type ResolvedLaunchTarget = Pick<
	PlaybookLaunchRequest,
	'sessionId' | 'autoRunFolderPath' | 'sshRemoteId'
>;

/**
 * A launch target that cannot be launched on: the agent is gone, has no Auto
 * Run folder, or is set to an SSH remote it does not name, or the new agent was
 * not created. The message is written for the person. `createdSessionId` names
 * the new agent when it was created all the same; it is kept.
 */
export class PlaybookLaunchTargetError extends Error {
	constructor(
		message: string,
		readonly createdSessionId?: string
	) {
		super(message);
		this.name = 'PlaybookLaunchTargetError';
	}
}

/**
 * Read a stored agent as a launch target. The SSH remote is read the way main
 * reads a stored agent for `maestro-cli` (`resolveAgentImportTarget()` in
 * `src/main/web-server/callbacks/marketplaceCallbacks.ts`), so a launch from a
 * window and one from the CLI run on the same machine. An agent set to an SSH
 * remote it does not name is refused, never launched on this computer.
 */
function launchTargetOf(session: Session, createdSessionId?: string): ResolvedLaunchTarget {
	const { autoRunFolderPath } = session;
	if (!autoRunFolderPath) {
		throw new PlaybookLaunchTargetError(
			`"${session.name}" has no Auto Run folder. Set one in its Auto Run panel, then launch again.`,
			createdSessionId
		);
	}
	if (!isSessionRemote(session)) return { sessionId: session.id, autoRunFolderPath };
	const sshRemoteId = getSessionSshRemoteId(session);
	if (!sshRemoteId) {
		throw new PlaybookLaunchTargetError(
			`"${session.name}" is set to run on an SSH remote, but no remote is chosen. Choose one in its settings, then launch again.`,
			createdSessionId
		);
	}
	return { sessionId: session.id, autoRunFolderPath, sshRemoteId };
}

/**
 * The agent a launch runs on: its id, its own Auto Run folder (the renderer
 * runs the launched documents from that folder, so main must import into it)
 * and its SSH remote when it works on one.
 *
 * `current` is the agent this window has selected and `existing` is read from
 * the session store as it is. `new` CREATES the agent from its draft, through
 * the New Agent modal's own create path (`createAgentFromDraft()`), and waits
 * for the session store to hold it. So validate the launch values before
 * calling this for a new agent, as {@link launchPlaybook} does, or an invalid
 * form leaves an agent behind.
 *
 * Rejects with {@link PlaybookLaunchTargetError} when the agent cannot be
 * launched on. Any other rejection is a fault and is not caught here.
 */
export async function resolveLaunchTarget(target: LaunchTarget): Promise<ResolvedLaunchTarget> {
	switch (target.kind) {
		case 'current': {
			const session = selectActiveSession(useSessionStore.getState());
			if (!session) {
				throw new PlaybookLaunchTargetError('No agent is selected. Select one, then launch again.');
			}
			return launchTargetOf(session);
		}
		case 'existing': {
			const session = selectSessionById(target.sessionId)(useSessionStore.getState());
			if (!session) {
				throw new PlaybookLaunchTargetError(
					'The agent to launch on no longer exists. Choose another agent.'
				);
			}
			return launchTargetOf(session);
		}
		case 'new': {
			const session = await createAgentFromDraft(target.draft);
			if (!session) throw new PlaybookLaunchTargetError('The new agent was not created.');
			return launchTargetOf(session, session.id);
		}
	}
}

/** What the launch modal submits. */
export interface PlaybookLaunchSubmission {
	/** Id of the Exchange playbook. */
	playbookId: string;
	/** Its launch block, as the modal shows it. */
	spec: PlaybookLaunchSpec;
	/** The form's answers, keyed by input name. A blank answer takes the input's default. */
	answers: PlaybookLaunchAnswers;
	/** The Run on choice. */
	target: LaunchTarget;
	/** "Save as a reusable playbook" is ticked. */
	keepSavedPlaybook: boolean;
}

/**
 * How a submitted launch ended.
 *
 * - `invalid`: the answers failed validation, one message per input name.
 *   Normally this is the renderer's own check, before any agent is created and
 *   before main is asked. Main checks the answers again against its own copy of
 *   the playbook, which can have changed since the form opened; then the same
 *   outcome carries main's messages, and `createdSessionId` may be set.
 * - `failed`: there was no agent to run on, or main did not start the launch.
 *   `error` is written for the person.
 * - `started`: the Auto Run started on `target`.
 *
 * `createdSessionId` names the agent this launch created, when it created one.
 * That agent is kept whatever happened next, so retry a failed or refused
 * launch on it (`{ kind: 'existing', sessionId: createdSessionId }`) instead of
 * creating another.
 */
export type PlaybookLaunchOutcome =
	| { status: 'invalid'; fieldErrors: Record<string, string>; createdSessionId?: string }
	| { status: 'failed'; error: string; createdSessionId?: string }
	| { status: 'started'; target: ResolvedLaunchTarget; createdSessionId?: string };

/**
 * Tell the person about the agent a launch created and kept although the launch
 * did not start. A toast as well as the outcome, because the agent outlives the
 * launch modal: it is in the Left Bar even when the modal closed before main
 * answered. A click on the toast goes to the agent.
 */
function reportKeptAgent(sessionId: string, error: string): void {
	const name = selectSessionById(sessionId)(useSessionStore.getState())?.name;
	notifyToast({
		color: 'red',
		title: 'Launch did not start',
		message: `${error} Maestro kept the new agent${name ? ` "${name}"` : ''}, so you can launch on it again.`,
		project: name,
		sessionId,
	});
}

/**
 * Submit a launch, in the order that keeps a new agent from being created for
 * nothing: check the answers (`resolveLaunchValues()` then
 * `validateLaunchValues()`, the checks main runs again), settle the agent with
 * {@link resolveLaunchTarget} (which creates a new agent only now), then ask
 * main to launch (`window.maestro.marketplace.launch`).
 *
 * Never deletes an agent. A launch that fails after it created its agent keeps
 * the agent, raises a red toast naming it, and names it in the outcome. A call
 * to main that rejects is reported to Sentry and comes back as `failed`; a
 * refusal from main is the person's to read and is only logged. When main
 * refuses the answers themselves (its copy of the playbook can differ from the
 * one the form was built from) and every field it names is one of the spec's
 * inputs, the refusal comes back as `invalid`, so the form can mark those
 * fields; otherwise it is a `failed` with main's text. Faults other than these
 * reject.
 */
export async function launchPlaybook(
	submission: PlaybookLaunchSubmission
): Promise<PlaybookLaunchOutcome> {
	const { playbookId, spec, target, keepSavedPlaybook } = submission;
	const values = resolveLaunchValues(spec, submission.answers);
	const fieldErrors = validateLaunchValues(spec, values);
	if (Object.keys(fieldErrors).length > 0) return { status: 'invalid', fieldErrors };

	let resolved: ResolvedLaunchTarget;
	try {
		resolved = await resolveLaunchTarget(target);
	} catch (thrown) {
		if (!(thrown instanceof PlaybookLaunchTargetError)) throw thrown;
		logger.warn(`Launch of ${playbookId} has no agent to run on: ${thrown.message}`, LOG_CONTEXT);
		if (thrown.createdSessionId) reportKeptAgent(thrown.createdSessionId, thrown.message);
		return definedOnly({
			status: 'failed' as const,
			error: thrown.message,
			createdSessionId: thrown.createdSessionId,
		});
	}
	const createdSessionId = target.kind === 'new' ? resolved.sessionId : undefined;

	let error: string;
	let refusedFields: Record<string, string> | null = null;
	try {
		const result = await window.maestro.marketplace.launch({
			playbookId,
			values,
			keepSavedPlaybook,
			...resolved,
		});
		if (result.success) {
			return definedOnly({ status: 'started' as const, target: resolved, createdSessionId });
		}
		error = ipcResultErrorMessage(result.error, 'The launch did not start.');
		refusedFields = refusedInputsOf(spec, error);
	} catch (thrown) {
		captureException(thrown, {
			extra: { operation: 'playbookLaunch:launch', playbookId, sessionId: resolved.sessionId },
		});
		error = ipcErrorMessage(thrown);
	}
	logger.warn(
		`Launch of ${playbookId} did not start on ${resolved.sessionId}: ${error}`,
		LOG_CONTEXT
	);
	if (createdSessionId) reportKeptAgent(createdSessionId, error);
	if (refusedFields) {
		return definedOnly({
			status: 'invalid' as const,
			fieldErrors: refusedFields,
			createdSessionId,
		});
	}
	return definedOnly({ status: 'failed' as const, error, createdSessionId });
}

/**
 * The field errors in main's refusal of the answers, when main refused them and every field it
 * names is an input of `spec`; `null` otherwise. A refusal that names a field the form does not
 * have cannot be shown on the form, so it stays a plain failure with main's text.
 */
function refusedInputsOf(spec: PlaybookLaunchSpec, error: string): Record<string, string> | null {
	const fieldErrors = launchFieldErrorsFromMessage(error);
	if (!fieldErrors) return null;
	const known = new Set(spec.inputs.map((input) => input.name));
	return Object.keys(fieldErrors).every((name) => known.has(name)) ? fieldErrors : null;
}

/**
 * Tell the person a launch started and where it runs: a green toast naming the playbook and the
 * agent, and a click on it goes to that agent. For the host that closes the launch dialog and the
 * Exchange once {@link launchPlaybook} answers `started`. The agent's name is read from the session
 * store, so it is the name now, not the one in the draft; a new agent is said to have been created.
 */
export function notifyLaunchStarted(
	playbookTitle: string,
	started: Pick<
		Extract<PlaybookLaunchOutcome, { status: 'started' }>,
		'target' | 'createdSessionId'
	>
): void {
	const { sessionId } = started.target;
	const name = selectSessionById(sessionId)(useSessionStore.getState())?.name;
	const agent = name ? `"${name}"` : 'the agent';
	notifyToast({
		color: 'green',
		title: 'Playbook launched',
		message: started.createdSessionId
			? `Created ${agent} and started "${playbookTitle}" on it.`
			: `"${playbookTitle}" is running on ${agent}.`,
		project: name,
		sessionId,
	});
}
