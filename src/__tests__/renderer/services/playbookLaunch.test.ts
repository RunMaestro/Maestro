/**
 * Tests for Playbook Launch in the renderer: the agent a launch runs on (the selected agent, an
 * existing agent as it is, or a new agent created from its New Agent draft), and the submit path.
 * The order is the point: the answers are checked before a new agent is created, so an invalid
 * form never leaves an agent behind, and a launch that fails after it created its agent keeps the
 * agent and says so.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import type { NewAgentDraft } from '../../../renderer/components/NewInstanceModal/types';
import { registerNewAgentCreator } from '../../../renderer/services/newAgentCreation';
import {
	launchPlaybook,
	PlaybookLaunchTargetError,
	resolveLaunchTarget,
	type LaunchTarget,
	type PlaybookLaunchSubmission,
} from '../../../renderer/services/playbookLaunch';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import { buildNewAgentSession } from '../../../renderer/utils/newAgentSession';
import { captureException } from '../../../renderer/utils/sentry';
import { PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import type { PlaybookLaunchSpec } from '../../../shared/marketplace-types';
import { createMockSession, resetStores } from '../../helpers';

const launch = vi.mocked(window.maestro.marketplace.launch);

const spec: PlaybookLaunchSpec = {
	inputs: [
		{ name: 'PR_URL', label: 'Pull request', type: 'url', required: true },
		{ name: 'BASE_BRANCH', label: 'Base branch', type: 'text', default: 'main' },
	],
	outro: { summary: 'Reviewed {{PR_URL}}', nextSteps: [] },
};

/** What the form holds: an untrimmed URL and the base branch left blank. */
const validAnswers = { PR_URL: '  https://github.com/acme/app/pull/7  ', BASE_BRANCH: '' };
/** What main is sent for those answers: trimmed, the default filled in. */
const resolvedValues = { PR_URL: 'https://github.com/acme/app/pull/7', BASE_BRANCH: 'main' };

const CURRENT_FOLDER = '/work/current/.maestro/playbooks';
const OTHER_FOLDER = '/work/other/Runner Docs';

const draft: NewAgentDraft = {
	agentId: 'claude-code',
	workingDir: '/work/research',
	name: 'Market Research',
};
const NEW_AGENT_FOLDER = `${draft.workingDir}/${PLAYBOOKS_DIR}`;

function agent(overrides: Partial<Session>): Session {
	return createMockSession(overrides);
}

function storeIds(): string[] {
	return useSessionStore.getState().sessions.map((s) => s.id);
}

/**
 * Register a creator that behaves like `createNewSession`: it builds the agent with the New Agent
 * builder, stores and selects it, then resolves its id.
 */
function registerStoringCreator(
	build: (draft: NewAgentDraft) => Session = (d) =>
		buildNewAgentSession(d, { id: 'new-agent', git: { isGitRepo: false } })
) {
	const creator = vi.fn(async (d: NewAgentDraft) => {
		const session = build(d);
		useSessionStore.setState((state) => ({
			sessions: [...state.sessions, session],
			activeSessionId: session.id,
		}));
		return session.id;
	});
	registerNewAgentCreator(creator);
	return creator;
}

function submission(overrides: Partial<PlaybookLaunchSubmission> = {}): PlaybookLaunchSubmission {
	return {
		playbookId: 'development-code-review',
		spec,
		answers: validAnswers,
		target: { kind: 'current' },
		keepSavedPlaybook: false,
		...overrides,
	};
}

async function targetError(target: LaunchTarget): Promise<PlaybookLaunchTargetError> {
	const error = await resolveLaunchTarget(target).then(
		() => undefined,
		(thrown: unknown) => thrown
	);
	expect(error).toBeInstanceOf(PlaybookLaunchTargetError);
	return error as PlaybookLaunchTargetError;
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStores(useSessionStore);
	useSessionStore.setState({
		sessions: [
			agent({ id: 'current', name: 'Current', autoRunFolderPath: CURRENT_FOLDER }),
			agent({ id: 'other', name: 'Other', autoRunFolderPath: OTHER_FOLDER }),
		],
		activeSessionId: 'current',
	});
	launch.mockReset();
	launch.mockResolvedValue({
		success: true,
		launchId: 'launch-1',
		folderRelativePath: 'code-review-launch-2026-11-11-10-00-00',
	});
});

afterEach(() => {
	registerNewAgentCreator(null);
});

describe('resolveLaunchTarget', () => {
	describe('current', () => {
		it('is the agent this window has selected, as it is', async () => {
			await expect(resolveLaunchTarget({ kind: 'current' })).resolves.toStrictEqual({
				sessionId: 'current',
				autoRunFolderPath: CURRENT_FOLDER,
			});
		});

		it('follows the selection at the moment it is asked', async () => {
			useSessionStore.setState({ activeSessionId: 'other' });

			await expect(resolveLaunchTarget({ kind: 'current' })).resolves.toStrictEqual({
				sessionId: 'other',
				autoRunFolderPath: OTHER_FOLDER,
			});
		});

		it('is refused when there is no agent', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const error = await targetError({ kind: 'current' });
			expect(error.message).toBe('No agent is selected. Select one, then launch again.');
			expect(error.createdSessionId).toBeUndefined();
		});
	});

	describe('existing', () => {
		it('is that agent, not the selected one', async () => {
			await expect(
				resolveLaunchTarget({ kind: 'existing', sessionId: 'other' })
			).resolves.toStrictEqual({ sessionId: 'other', autoRunFolderPath: OTHER_FOLDER });
		});

		it('is refused when the agent is gone', async () => {
			const error = await targetError({ kind: 'existing', sessionId: 'deleted' });
			expect(error.message).toBe('The agent to launch on no longer exists. Choose another agent.');
		});

		it('is refused by name when the agent has no Auto Run folder', async () => {
			useSessionStore.setState((state) => ({
				sessions: [...state.sessions, agent({ id: 'bare', name: 'No Folder' })],
			}));

			const error = await targetError({ kind: 'existing', sessionId: 'bare' });
			expect(error.message).toBe(
				'"No Folder" has no Auto Run folder. Set one in its Auto Run panel, then launch again.'
			);
			expect(error.createdSessionId).toBeUndefined();
		});
	});

	describe('SSH remote', () => {
		it.each<[string, Partial<Session>, string | undefined]>([
			[
				'the remote its settings choose',
				{ sessionSshRemoteConfig: { enabled: true, remoteId: 'build-box' } },
				'build-box',
			],
			[
				'the remote its agent spawned on, over its settings',
				{
					sshRemoteId: 'spawned-box',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'build-box' },
				},
				'spawned-box',
			],
			[
				'the remote its agent spawned on, with no settings',
				{ sshRemoteId: 'spawned-box' },
				'spawned-box',
			],
			[
				'no remote when its settings turned SSH off',
				{ sessionSshRemoteConfig: { enabled: false, remoteId: 'old-box' } },
				undefined,
			],
		])('names %s', async (_case, ssh, sshRemoteId) => {
			useSessionStore.setState((state) => ({
				sessions: [
					...state.sessions,
					agent({
						id: 'remote',
						name: 'Remote',
						autoRunFolderPath: '~/app/.maestro/playbooks',
						...ssh,
					}),
				],
			}));

			const target = await resolveLaunchTarget({ kind: 'existing', sessionId: 'remote' });

			expect(target).toStrictEqual(
				sshRemoteId === undefined
					? { sessionId: 'remote', autoRunFolderPath: '~/app/.maestro/playbooks' }
					: { sessionId: 'remote', autoRunFolderPath: '~/app/.maestro/playbooks', sshRemoteId }
			);
		});

		it('refuses an agent set to SSH with no remote chosen, never running it here', async () => {
			useSessionStore.setState((state) => ({
				sessions: [
					...state.sessions,
					agent({
						id: 'remote',
						name: 'Remote',
						autoRunFolderPath: '~/app/.maestro/playbooks',
						sessionSshRemoteConfig: { enabled: true, remoteId: null },
					}),
				],
			}));

			const error = await targetError({ kind: 'existing', sessionId: 'remote' });
			expect(error.message).toBe(
				'"Remote" is set to run on an SSH remote, but no remote is chosen. Choose one in its settings, then launch again.'
			);
		});
	});

	describe('new', () => {
		it('creates the agent from its draft and resolves it once the store holds it', async () => {
			const creator = registerStoringCreator();

			const target = await resolveLaunchTarget({ kind: 'new', draft });

			expect(creator).toHaveBeenCalledTimes(1);
			expect(creator).toHaveBeenCalledWith(draft);
			expect(target).toStrictEqual({ sessionId: 'new-agent', autoRunFolderPath: NEW_AGENT_FOLDER });
			expect(storeIds()).toEqual(['current', 'other', 'new-agent']);
		});

		it('runs a new SSH agent on its remote', async () => {
			registerStoringCreator();
			const remoteDraft: NewAgentDraft = {
				...draft,
				workingDir: '~/research',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'build-box',
					workingDirOverride: '~/research',
				},
			};

			await expect(resolveLaunchTarget({ kind: 'new', draft: remoteDraft })).resolves.toStrictEqual(
				{
					sessionId: 'new-agent',
					autoRunFolderPath: `~/research/${PLAYBOOKS_DIR}`,
					sshRemoteId: 'build-box',
				}
			);
		});

		it('waits for a creator that stores the agent after it answers', async () => {
			registerNewAgentCreator(async (d) => {
				setTimeout(() => {
					useSessionStore.setState((state) => ({
						sessions: [
							...state.sessions,
							buildNewAgentSession(d, { id: 'late-agent', git: { isGitRepo: false } }),
						],
					}));
				}, 0);
				return 'late-agent';
			});

			await expect(resolveLaunchTarget({ kind: 'new', draft })).resolves.toStrictEqual({
				sessionId: 'late-agent',
				autoRunFolderPath: NEW_AGENT_FOLDER,
			});
		});

		it('is refused when the creator creates no agent', async () => {
			registerNewAgentCreator(async () => null);

			const error = await targetError({ kind: 'new', draft });
			expect(error.message).toBe('The new agent was not created.');
			expect(error.createdSessionId).toBeUndefined();
			expect(storeIds()).toEqual(['current', 'other']);
		});

		it('names and keeps a created agent that cannot be launched on', async () => {
			registerStoringCreator((d) =>
				buildNewAgentSession(
					{ ...d, sessionSshRemoteConfig: { enabled: true, remoteId: null } },
					{ id: 'new-agent', git: { isGitRepo: false } }
				)
			);

			const error = await targetError({ kind: 'new', draft });
			expect(error.message).toBe(
				'"Market Research" is set to run on an SSH remote, but no remote is chosen. Choose one in its settings, then launch again.'
			);
			expect(error.createdSessionId).toBe('new-agent');
			expect(storeIds()).toEqual(['current', 'other', 'new-agent']);
		});
	});
});

describe('launchPlaybook', () => {
	describe('checks the answers before anything else', () => {
		it.each<[string, LaunchTarget]>([
			['the selected agent', { kind: 'current' }],
			['an existing agent', { kind: 'existing', sessionId: 'other' }],
			['a new agent', { kind: 'new', draft }],
		])('an invalid form on %s creates no agent and launches nothing', async (_case, target) => {
			const creator = registerStoringCreator();

			const outcome = await launchPlaybook(
				submission({ target, answers: { PR_URL: 'not a url', BASE_BRANCH: 'feature`x' } })
			);

			expect(outcome).toStrictEqual({
				status: 'invalid',
				fieldErrors: {
					PR_URL: 'Enter a full http:// or https:// URL',
					BASE_BRANCH: 'Cannot contain a backtick',
				},
			});
			expect(creator).not.toHaveBeenCalled();
			expect(launch).not.toHaveBeenCalled();
			expect(storeIds()).toEqual(['current', 'other']);
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('counts a required input left blank as invalid', async () => {
			const creator = registerStoringCreator();

			const outcome = await launchPlaybook(
				submission({ target: { kind: 'new', draft }, answers: { PR_URL: '   ' } })
			);

			expect(outcome).toStrictEqual({
				status: 'invalid',
				fieldErrors: { PR_URL: 'This field is required' },
			});
			expect(creator).not.toHaveBeenCalled();
			expect(launch).not.toHaveBeenCalled();
		});
	});

	describe('a launch that starts', () => {
		it('launches on the selected agent with the resolved answers', async () => {
			const outcome = await launchPlaybook(submission());

			expect(launch).toHaveBeenCalledTimes(1);
			expect(launch.mock.calls[0][0]).toStrictEqual({
				playbookId: 'development-code-review',
				values: resolvedValues,
				keepSavedPlaybook: false,
				sessionId: 'current',
				autoRunFolderPath: CURRENT_FOLDER,
			});
			expect(outcome).toStrictEqual({
				status: 'started',
				target: { sessionId: 'current', autoRunFolderPath: CURRENT_FOLDER },
			});
			expect(notifyToast).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		});

		it('passes the reusable-playbook choice and the SSH remote through', async () => {
			useSessionStore.setState((state) => ({
				sessions: [
					...state.sessions,
					agent({
						id: 'remote',
						name: 'Remote',
						autoRunFolderPath: '~/app/.maestro/playbooks',
						sessionSshRemoteConfig: { enabled: true, remoteId: 'build-box' },
					}),
				],
			}));

			await launchPlaybook(
				submission({ target: { kind: 'existing', sessionId: 'remote' }, keepSavedPlaybook: true })
			);

			expect(launch.mock.calls[0][0]).toStrictEqual({
				playbookId: 'development-code-review',
				values: resolvedValues,
				keepSavedPlaybook: true,
				sessionId: 'remote',
				autoRunFolderPath: '~/app/.maestro/playbooks',
				sshRemoteId: 'build-box',
			});
		});

		it('creates a new agent only after the answers pass, then launches on it', async () => {
			const creator = registerStoringCreator();

			const outcome = await launchPlaybook(submission({ target: { kind: 'new', draft } }));

			expect(creator).toHaveBeenCalledTimes(1);
			expect(creator).toHaveBeenCalledBefore(launch);
			expect(launch.mock.calls[0][0]).toStrictEqual({
				playbookId: 'development-code-review',
				values: resolvedValues,
				keepSavedPlaybook: false,
				sessionId: 'new-agent',
				autoRunFolderPath: NEW_AGENT_FOLDER,
			});
			expect(outcome).toStrictEqual({
				status: 'started',
				target: { sessionId: 'new-agent', autoRunFolderPath: NEW_AGENT_FOLDER },
				createdSessionId: 'new-agent',
			});
			expect(notifyToast).not.toHaveBeenCalled();
		});
	});

	describe('a launch that fails after it created its agent', () => {
		it('keeps the agent, names it in the outcome and raises a toast when main refuses', async () => {
			registerStoringCreator();
			launch.mockResolvedValue({
				success: false,
				error: 'MarketplaceImportError: Failed to fetch document: 1_ANALYZE_CHANGES.md',
			});

			const outcome = await launchPlaybook(submission({ target: { kind: 'new', draft } }));

			expect(outcome).toStrictEqual({
				status: 'failed',
				error: 'Failed to fetch document: 1_ANALYZE_CHANGES.md',
				createdSessionId: 'new-agent',
			});
			expect(storeIds()).toEqual(['current', 'other', 'new-agent']);
			expect(notifyToast).toHaveBeenCalledTimes(1);
			expect(notifyToast).toHaveBeenCalledWith({
				color: 'red',
				title: 'Launch did not start',
				message:
					'Failed to fetch document: 1_ANALYZE_CHANGES.md Maestro kept the new agent "Market Research", so you can launch on it again.',
				project: 'Market Research',
				sessionId: 'new-agent',
			});
			// A refusal is the person's to read, not a fault.
			expect(captureException).not.toHaveBeenCalled();
		});

		it('keeps the agent and reports the fault when the call to main rejects', async () => {
			registerStoringCreator();
			const fault = new Error(
				"Error invoking remote method 'marketplace:launch': Error: No handler registered for 'marketplace:launch'"
			);
			launch.mockRejectedValue(fault);

			const outcome = await launchPlaybook(submission({ target: { kind: 'new', draft } }));

			expect(outcome).toStrictEqual({
				status: 'failed',
				error: "No handler registered for 'marketplace:launch'",
				createdSessionId: 'new-agent',
			});
			expect(captureException).toHaveBeenCalledWith(fault, {
				extra: {
					operation: 'playbookLaunch:launch',
					playbookId: 'development-code-review',
					sessionId: 'new-agent',
				},
			});
			expect(storeIds()).toEqual(['current', 'other', 'new-agent']);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'red', sessionId: 'new-agent' })
			);
		});

		it('keeps a created agent that cannot be launched on, and asks main nothing', async () => {
			registerStoringCreator((d) =>
				buildNewAgentSession(
					{ ...d, sessionSshRemoteConfig: { enabled: true, remoteId: null } },
					{ id: 'new-agent', git: { isGitRepo: false } }
				)
			);

			const outcome = await launchPlaybook(submission({ target: { kind: 'new', draft } }));

			expect(outcome).toStrictEqual({
				status: 'failed',
				error:
					'"Market Research" is set to run on an SSH remote, but no remote is chosen. Choose one in its settings, then launch again.',
				createdSessionId: 'new-agent',
			});
			expect(launch).not.toHaveBeenCalled();
			expect(storeIds()).toEqual(['current', 'other', 'new-agent']);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Launch did not start', sessionId: 'new-agent' })
			);
		});
	});

	describe('a launch that fails with no agent created', () => {
		it("leaves main's refusal to the caller: no toast, no fault report", async () => {
			launch.mockResolvedValue({
				success: false,
				error:
					'MarketplaceLaunchBusyError: This agent is already running the "Code Review" launch (launch-0). Wait for it to finish, or stop it, then launch again.',
			});

			const outcome = await launchPlaybook(
				submission({ target: { kind: 'existing', sessionId: 'other' } })
			);

			expect(outcome).toStrictEqual({
				status: 'failed',
				error:
					'This agent is already running the "Code Review" launch (launch-0). Wait for it to finish, or stop it, then launch again.',
			});
			expect(notifyToast).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		});

		it('says the launch did not start when main gives no reason', async () => {
			launch.mockResolvedValue({ success: false });

			await expect(launchPlaybook(submission())).resolves.toStrictEqual({
				status: 'failed',
				error: 'The launch did not start.',
			});
		});

		it('stops before main is asked when the agent to run on is gone', async () => {
			const outcome = await launchPlaybook(
				submission({ target: { kind: 'existing', sessionId: 'deleted' } })
			);

			expect(outcome).toStrictEqual({
				status: 'failed',
				error: 'The agent to launch on no longer exists. Choose another agent.',
			});
			expect(launch).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('launches nothing when the creator creates no agent', async () => {
			registerNewAgentCreator(async () => null);

			const outcome = await launchPlaybook(submission({ target: { kind: 'new', draft } }));

			expect(outcome).toStrictEqual({ status: 'failed', error: 'The new agent was not created.' });
			expect(launch).not.toHaveBeenCalled();
			expect(storeIds()).toEqual(['current', 'other']);
			// The creator tells the person why; this path adds no second toast.
			expect(notifyToast).not.toHaveBeenCalled();
		});
	});

	it('lets a fault reach the caller instead of reporting it as a failed launch', async () => {
		// No creator registered: App has not wired agent creation.
		await expect(launchPlaybook(submission({ target: { kind: 'new', draft } }))).rejects.toThrow(
			'No agent creator is registered'
		);
		expect(launch).not.toHaveBeenCalled();
	});
});
