/**
 * Tests for PlaybookLaunchModal: the dialog behind the Exchange's Launch button.
 *
 * The dialog is a form over `launchPlaybook()` (`services/playbookLaunch.ts`), so these tests pin
 * what a person sees and when Launch is allowed: the layout from the title down to "Save as a
 * reusable playbook", the three Run on choices (the current and existing agents are read-only,
 * a new agent is set up in the New Agent modal in capture mode and created only on Launch), the
 * maestro-cli row, and how a launch that starts, fails or is refused is shown.
 *
 * `launchPlaybook` is a spy that calls the real service, which asks main through the mocked
 * `window.maestro.marketplace.launch`. A test that needs a different outcome queues one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const newAgentModal = vi.hoisted(() => ({ props: null as Record<string, any> | null }));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

// The renderer behind the intro pulls in the whole remark stack; the dialog only has to reach it.
vi.mock('../../../../../renderer/components/Markdown', () => ({
	Markdown: ({ content }: { content: string }) => <div data-testid="intro-markdown">{content}</div>,
}));

// The New Agent modal has its own suite. This stand-in records how the dialog opened it and
// captures a fixed draft the way "Use these settings" does (the real modal then closes itself).
vi.mock('../../../../../renderer/components/NewInstanceModal', () => ({
	NewInstanceModal: (props: Record<string, any>) => {
		newAgentModal.props = props;
		return (
			<div data-testid="new-instance-modal-stub" data-mode={props.mode}>
				<button
					type="button"
					onClick={() => {
						props.onCapture(CAPTURED_DRAFT);
						props.onClose();
					}}
				>
					Use these settings
				</button>
				<button type="button" onClick={props.onClose}>
					Close new agent
				</button>
			</div>
		);
	},
}));

vi.mock('../../../../../renderer/services/playbookLaunch', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../../renderer/services/playbookLaunch')>();
	return { ...actual, launchPlaybook: vi.fn(actual.launchPlaybook) };
});

import { launchInputTestId } from '../../../../../renderer/components/MarketplaceModal/launch/LaunchInputField';
import { PlaybookLaunchModal } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookLaunchModal';
import type { PlaybookLaunchModalProps } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookLaunchModal';
import type { NewAgentDraft } from '../../../../../renderer/components/NewInstanceModal/types';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import * as playbookLaunchService from '../../../../../renderer/services/playbookLaunch';
import type { PlaybookLaunchOutcome } from '../../../../../renderer/services/playbookLaunch';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { captureException } from '../../../../../renderer/utils/sentry';
import type { MaestroCliStatus } from '../../../../../shared/maestro-cli';
import type { PlaybookLaunchSpec } from '../../../../../shared/marketplace-types';
import { createMockSession, resetStores } from '../../../../helpers';
import { mockTheme } from '../../../../helpers/mockTheme';
import { makePlaybook } from '../_fixtures';

const launchPlaybook = vi.mocked(playbookLaunchService.launchPlaybook);

const PR_URL = 'https://github.com/acme/app/pull/7';

const CURRENT = createMockSession({
	id: 'current',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/work/alpha',
	customModel: 'opus',
	autoRunFolderPath: '/work/alpha/.maestro/playbooks',
});
const OTHER = createMockSession({
	id: 'other',
	name: 'Beta',
	toolType: 'codex',
	cwd: '/work/beta',
	autoRunFolderPath: '/work/beta/Runner Docs',
});
const NO_FOLDER = createMockSession({
	id: 'bare',
	name: 'Gamma',
	cwd: '/work/gamma',
	autoRunFolderPath: undefined,
});
const REMOTE = createMockSession({
	id: 'remote',
	name: 'Delta',
	cwd: '/home/dev/app',
	autoRunFolderPath: '/home/dev/app/.maestro/playbooks',
	sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
});

const CAPTURED_DRAFT: NewAgentDraft = {
	agentId: 'codex',
	workingDir: '/work/market',
	name: 'Market Research',
	customModel: 'gpt-5',
};

const INSTALLED: MaestroCliStatus = {
	expectedVersion: '1.0.0',
	installed: true,
	inPath: true,
	inShellPath: false,
	commandPath: '/home/me/.local/bin/maestro-cli',
	installedVersion: '1.0.0',
	versionMatch: true,
	needsInstallOrUpdate: false,
	installDir: '/home/me/.local/bin',
	bundledCliPath: '/app/maestro-cli.js',
};
const NOT_INSTALLED: MaestroCliStatus = {
	...INSTALLED,
	installed: false,
	inPath: false,
	commandPath: null,
	installedVersion: null,
	needsInstallOrUpdate: true,
};

const REQUIRED_REMOTE_REASON =
	'This playbook drives Maestro through maestro-cli, which is not available on remote agents.';
const REQUIRED_MISSING_REASON =
	'This playbook drives Maestro through maestro-cli, which is not installed. Install maestro-cli to launch it.';
const OPTIONAL_MISSING_NOTE =
	'maestro-cli is not installed, so any step that calls it is skipped or uses a fallback.';

function launchSpec(overrides: Partial<PlaybookLaunchSpec> = {}): PlaybookLaunchSpec {
	return {
		intro: 'Reviews a pull request and cleans up bot threads.',
		inputs: [
			{ name: 'PR_URL', label: 'Pull request', type: 'url', required: true },
			{
				name: 'BOT_REVIEWERS',
				label: 'Bot reviewers',
				type: 'text',
				default: 'coderabbitai,greptile',
			},
			{ name: 'MAX_FILE_LOC', label: 'Max file LOC', type: 'number', default: 500, advanced: true },
		],
		outro: { summary: 'Done.', nextSteps: [] },
		...overrides,
	};
}

function installMaestroCli(status: MaestroCliStatus = INSTALLED) {
	const checkStatus = vi.fn().mockResolvedValue(status);
	const installOrUpdate = vi.fn().mockResolvedValue({
		success: true,
		status: INSTALLED,
		pathUpdated: true,
		restartRequired: true,
		shellFilesUpdated: [],
	});
	window.maestro.maestroCli = { checkStatus, installOrUpdate };
	return { checkStatus, installOrUpdate };
}

/** A `null` spec is a playbook without a launch block. */
function renderModal(
	spec: PlaybookLaunchSpec | null = launchSpec(),
	props: Partial<PlaybookLaunchModalProps> = {}
) {
	const onClose = vi.fn();
	const onLaunched = vi.fn();
	const playbook = makePlaybook({
		id: 'dev-pr-review',
		title: 'PR Review',
		author: 'Maestro Team',
		launch: spec ?? undefined,
	});
	const view = render(
		<LayerStackProvider>
			<PlaybookLaunchModal
				theme={mockTheme}
				playbook={playbook}
				onClose={onClose}
				onLaunched={onLaunched}
				{...props}
			/>
		</LayerStackProvider>
	);
	return { onClose, onLaunched, playbook, ...view };
}

/** The footer's confirm button, whatever it says right now. */
function launchButton() {
	return screen.getByRole('button', { name: /^(Launch|Create agent and launch)/ });
}

function field(name: string) {
	return within(screen.getByTestId(launchInputTestId(name)));
}

function answerUrl(value: string = PR_URL) {
	fireEvent.change(field('PR_URL').getByRole('textbox'), { target: { value } });
}

function chooseRunOn(choice: 'current' | 'existing' | 'new') {
	fireEvent.click(screen.getByTestId(`launch-run-on-choice-${choice}`));
}

function pickExistingAgent(label: string) {
	fireEvent.click(screen.getByRole('button', { name: 'Existing agent' }));
	fireEvent.click(screen.getByRole('option', { name: label }));
}

function status() {
	return screen.getByTestId('launch-status');
}

beforeEach(async () => {
	vi.clearAllMocks();
	resetStores(useSessionStore);
	useSessionStore.setState({
		sessions: [CURRENT, OTHER, NO_FOLDER, REMOTE],
		activeSessionId: 'current',
	});
	newAgentModal.props = null;
	installMaestroCli();
	vi.mocked(window.maestro.marketplace.launch).mockReset();
	vi.mocked(window.maestro.marketplace.launch).mockResolvedValue({
		success: true,
		launchId: 'launch-1',
		folderRelativePath: 'dev-pr-review-launch-2026-11-11-10-00-00',
	});
	const actual = await vi.importActual<
		typeof import('../../../../../renderer/services/playbookLaunch')
	>('../../../../../renderer/services/playbookLaunch');
	launchPlaybook.mockReset();
	launchPlaybook.mockImplementation(actual.launchPlaybook);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('PlaybookLaunchModal', () => {
	describe('the dialog', () => {
		it('draws nothing for a playbook without a launch block', () => {
			renderModal(null);

			expect(screen.queryByTestId('playbook-launch-modal')).not.toBeInTheDocument();
		});

		it('is a dialog layered above the Exchange, in a portal, with a remembered size', () => {
			renderModal();

			const overlay = screen.getByTestId('playbook-launch-modal');
			expect(overlay).toHaveAttribute('role', 'dialog');
			expect(overlay).toHaveAttribute('aria-label', 'Launch playbook');
			expect(overlay.parentElement).toBe(document.body);
			expect(overlay).toHaveStyle({ zIndex: '10000' });
			expect(document.querySelector('[data-modal-resize-key="marketplace-launch"]')).not.toBeNull();
		});

		it('is click-driven, so its text is not selectable unless it opts back in', () => {
			renderModal();

			expect(screen.getByTestId('launch-playbook-title').closest('.select-none')).not.toBeNull();
			expect(screen.getByTestId('launch-intro')).toHaveClass('select-text');
		});

		it('has a visible way out and closes from it', () => {
			const { onClose } = renderModal();

			fireEvent.click(screen.getByLabelText('Close modal'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('closes on Cancel', () => {
			const { onClose } = renderModal();

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('closes on Escape', async () => {
			const { onClose } = renderModal();

			fireEvent.keyDown(window, { key: 'Escape' });

			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		});
	});

	describe('the layout', () => {
		it('shows the playbook title and author, and the intro as markdown', () => {
			renderModal();

			expect(screen.getByTestId('launch-playbook-title')).toHaveTextContent('PR Review');
			expect(screen.getByTestId('launch-playbook-author')).toHaveTextContent('by Maestro Team');
			expect(screen.getByTestId('intro-markdown')).toHaveTextContent(
				'Reviews a pull request and cleans up bot threads.'
			);
		});

		it('leaves the intro out when the playbook has none', () => {
			renderModal(launchSpec({ intro: undefined }));

			expect(screen.queryByTestId('launch-intro')).not.toBeInTheDocument();
		});

		it('runs top to bottom: title, intro, requirements, questions, Advanced, Run on, Save', () => {
			renderModal(launchSpec({ preconditions: { requires: ['gh logged in'] } }));

			const order = [
				'launch-playbook-title',
				'launch-intro',
				'launch-preconditions',
				'launch-inputs',
				'launch-advanced',
				'launch-run-on',
				'launch-keep-saved',
			].map((id) => screen.getByTestId(id));
			for (let i = 1; i < order.length; i++) {
				const follows = order[i - 1].compareDocumentPosition(order[i]);
				expect(Boolean(follows & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
			}
		});

		it('lists what the playbook requires', () => {
			renderModal(
				launchSpec({ preconditions: { requires: ['gh logged in', 'React web project'] } })
			);

			expect(
				within(screen.getByTestId('launch-requires'))
					.getAllByRole('listitem')
					.map((item) => item.textContent)
			).toEqual(['gh logged in', 'React web project']);
		});

		it('draws the required and optional questions, seeded with their defaults', () => {
			renderModal();

			expect(field('PR_URL').getByRole('textbox')).toHaveValue('');
			expect(field('BOT_REVIEWERS').getByRole('textbox')).toHaveValue('coderabbitai,greptile');
		});

		it('draws no questions area for a playbook with none', () => {
			renderModal(launchSpec({ inputs: [] }));

			expect(screen.queryByTestId('launch-inputs')).not.toBeInTheDocument();
			expect(screen.queryByTestId('launch-advanced')).not.toBeInTheDocument();
		});

		it('offers Save as a reusable playbook, off by default', () => {
			renderModal();

			expect(
				within(screen.getByTestId('launch-keep-saved')).getByRole('checkbox')
			).not.toBeChecked();
			expect(screen.getByText('Save as a reusable playbook')).toBeInTheDocument();
		});
	});

	describe('starting answers (Run again)', () => {
		it('starts the form on the answers of the earlier launch', () => {
			renderModal(launchSpec(), {
				initialValues: { PR_URL, BOT_REVIEWERS: 'greptile', MAX_FILE_LOC: 800 },
			});

			expect(field('PR_URL').getByRole('textbox')).toHaveValue(PR_URL);
			expect(field('BOT_REVIEWERS').getByRole('textbox')).toHaveValue('greptile');
			fireEvent.click(screen.getByTestId('launch-advanced-toggle'));
			expect(field('MAX_FILE_LOC').getByRole('spinbutton')).toHaveValue(800);
		});

		it('lets the person launch at once, because the required answers are already in', () => {
			renderModal(launchSpec(), { initialValues: { PR_URL } });

			expect(launchButton()).toBeEnabled();
			expect(status()).toBeEmptyDOMElement();
		});

		it('launches with the earlier answers, including the ones the person did not touch', async () => {
			const { onLaunched } = renderModal(launchSpec(), {
				initialValues: { PR_URL, BOT_REVIEWERS: 'greptile', MAX_FILE_LOC: 800 },
			});

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			expect(window.maestro.marketplace.launch).toHaveBeenCalledWith(
				expect.objectContaining({
					values: { PR_URL, BOT_REVIEWERS: 'greptile', MAX_FILE_LOC: 800 },
				})
			);
		});

		it('starts a question the earlier launch has no answer for at its default', () => {
			renderModal(launchSpec(), { initialValues: { PR_URL } });

			expect(field('BOT_REVIEWERS').getByRole('textbox')).toHaveValue('coderabbitai,greptile');
			expect(field('PR_URL').getByRole('textbox')).toHaveValue(PR_URL);
		});

		it('drops an earlier answer to a question the playbook no longer asks', async () => {
			const { onLaunched } = renderModal(launchSpec(), {
				initialValues: { PR_URL, REMOVED_INPUT: 'old' },
			});

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			const sent = vi.mocked(window.maestro.marketplace.launch).mock.calls[0][0];
			expect(sent.values).not.toHaveProperty('REMOVED_INPUT');
		});

		it('keeps Launch off for an earlier answer the playbook now refuses, without scolding it yet', () => {
			renderModal(launchSpec(), { initialValues: { PR_URL: 'not a url' } });

			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent('1 answer needs attention.');
			expect(
				field('PR_URL').queryByText('Enter a full http:// or https:// URL')
			).not.toBeInTheDocument();
		});

		it('reads the earlier answers once, when the dialog opens', () => {
			const view = renderModal(launchSpec(), { initialValues: { PR_URL } });
			fireEvent.change(field('PR_URL').getByRole('textbox'), {
				target: { value: 'https://github.com/acme/app/pull/9' },
			});

			view.rerender(
				<LayerStackProvider>
					<PlaybookLaunchModal
						theme={mockTheme}
						playbook={view.playbook}
						initialValues={{ PR_URL }}
						onClose={view.onClose}
						onLaunched={view.onLaunched}
					/>
				</LayerStackProvider>
			);

			expect(field('PR_URL').getByRole('textbox')).toHaveValue(
				'https://github.com/acme/app/pull/9'
			);
		});
	});

	describe('Advanced', () => {
		it('is collapsed by default: its questions are not drawn', () => {
			renderModal();

			const toggle = screen.getByTestId('launch-advanced-toggle');
			expect(toggle).toHaveAttribute('aria-expanded', 'false');
			expect(toggle).toHaveTextContent('Advanced');
			expect(toggle).toHaveTextContent('(1)');
			expect(screen.queryByTestId(launchInputTestId('MAX_FILE_LOC'))).not.toBeInTheDocument();
		});

		it('opens and closes on its heading', () => {
			renderModal();
			const toggle = screen.getByTestId('launch-advanced-toggle');

			fireEvent.click(toggle);
			expect(toggle).toHaveAttribute('aria-expanded', 'true');
			expect(field('MAX_FILE_LOC').getByRole('spinbutton')).toHaveValue(500);

			fireEvent.click(toggle);
			expect(toggle).toHaveAttribute('aria-expanded', 'false');
			expect(screen.queryByTestId(launchInputTestId('MAX_FILE_LOC'))).not.toBeInTheDocument();
		});

		it('keeps an answer through a collapse', () => {
			renderModal();
			const toggle = screen.getByTestId('launch-advanced-toggle');
			fireEvent.click(toggle);
			fireEvent.change(field('MAX_FILE_LOC').getByRole('spinbutton'), { target: { value: '800' } });

			fireEvent.click(toggle);
			fireEvent.click(toggle);

			expect(field('MAX_FILE_LOC').getByRole('spinbutton')).toHaveValue(800);
		});

		it('opens by itself, and stays open, while a hidden question blocks Launch', () => {
			renderModal(
				launchSpec({
					inputs: [
						{ name: 'PR_URL', label: 'Pull request', type: 'url', required: true },
						{
							name: 'TOKEN_FILE',
							label: 'Token file',
							type: 'text',
							required: true,
							advanced: true,
						},
					],
				})
			);

			const toggle = screen.getByTestId('launch-advanced-toggle');
			expect(toggle).toHaveAttribute('aria-expanded', 'true');
			expect(toggle).toBeDisabled();
			expect(screen.getByTestId(launchInputTestId('TOKEN_FILE'))).toBeInTheDocument();
		});

		it('draws no section when no question is advanced', () => {
			renderModal(launchSpec({ inputs: [{ name: 'PR_URL', label: 'Pull request', type: 'url' }] }));

			expect(screen.queryByTestId('launch-advanced')).not.toBeInTheDocument();
		});
	});

	describe('when Launch is allowed', () => {
		it('is off until the required answers are in, and says what is missing', () => {
			renderModal();

			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent('1 answer needs attention.');
		});

		it('turns on once the answers validate, and the line beside it empties', () => {
			renderModal();

			answerUrl();

			expect(launchButton()).toBeEnabled();
			expect(status()).toBeEmptyDOMElement();
		});

		it('shows what is wrong with an answer once the person has changed it', () => {
			renderModal();

			answerUrl('not a url');

			expect(field('PR_URL').getByText('Enter a full http:// or https:// URL')).toBeInTheDocument();
			expect(launchButton()).toBeDisabled();
		});

		it('does not scold a question nobody has touched', () => {
			renderModal();

			expect(field('PR_URL').queryByText('This field is required')).not.toBeInTheDocument();
		});

		it('turns off again when a valid answer is broken', () => {
			renderModal();
			answerUrl();
			expect(launchButton()).toBeEnabled();

			answerUrl('nope');

			expect(launchButton()).toBeDisabled();
		});

		it('waits for the confirmation a playbook asks for', () => {
			renderModal(
				launchSpec({ preconditions: { confirm: 'I understand this reads my Messages.' } })
			);
			answerUrl();

			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent('Tick the confirmation to continue.');

			fireEvent.click(
				screen.getByRole('checkbox', { name: /I understand this reads my Messages\./ })
			);

			expect(launchButton()).toBeEnabled();
			expect(status()).toBeEmptyDOMElement();
		});

		it('switches off again when the confirmation is untied', () => {
			renderModal(launchSpec({ preconditions: { confirm: 'Sure?' } }));
			answerUrl();
			const confirm = screen.getByRole('checkbox', { name: /Sure\?/ });

			fireEvent.click(confirm);
			fireEvent.click(confirm);

			expect(launchButton()).toBeDisabled();
		});

		it('refuses a playbook that runs on another platform, with the reason', () => {
			renderModal(launchSpec({ preconditions: { platforms: ['linux'] } }));
			answerUrl();

			expect(screen.getByTestId('launch-blocked-reason')).toHaveTextContent(
				'This playbook runs on Linux only.'
			);
			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent('This playbook runs on Linux only.');
		});

		it('allows a playbook that runs on this platform', () => {
			renderModal(launchSpec({ preconditions: { platforms: ['darwin', 'linux'] } }));
			answerUrl();

			expect(screen.queryByTestId('launch-blocked-reason')).not.toBeInTheDocument();
			expect(launchButton()).toBeEnabled();
		});
	});

	describe('Run on', () => {
		describe('Current agent', () => {
			it('is the default and shows the selected agent as a read-only card', () => {
				renderModal();

				expect(screen.getByTestId('launch-run-on-choice-current')).toHaveAttribute(
					'aria-checked',
					'true'
				);
				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Alpha');
				const card = within(screen.getByTestId('launch-agent-card'));
				expect(card.getByText('Provider').nextElementSibling).toHaveTextContent('Claude Code');
				expect(card.getByText('Model').nextElementSibling).toHaveTextContent('opus');
				expect(card.getByText('Folder').nextElementSibling).toHaveTextContent('/work/alpha');
			});

			it('offers nothing to edit', () => {
				renderModal();

				expect(screen.queryByTestId('launch-edit-new-agent')).not.toBeInTheDocument();
				expect(screen.queryByTestId('launch-setup-new-agent')).not.toBeInTheDocument();
				expect(screen.queryByTestId('launch-existing-agent')).not.toBeInTheDocument();
			});

			it('follows the agent that is selected', () => {
				useSessionStore.setState({ activeSessionId: 'other' });
				renderModal();

				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Beta');
			});

			it('cannot launch on an agent with no Auto Run folder, and says why', () => {
				useSessionStore.setState({ activeSessionId: 'bare' });
				renderModal();
				answerUrl();

				expect(screen.getByTestId('launch-agent-card-problem')).toHaveTextContent(
					'This agent has no Auto Run folder.'
				);
				expect(launchButton()).toBeDisabled();
				expect(status()).toHaveTextContent('This agent has no Auto Run folder.');
			});

			it('names the agent on the Launch button', () => {
				renderModal();

				expect(launchButton()).toHaveTextContent('Launch on Alpha');
			});
		});

		describe('Existing agent', () => {
			it('offers the agents that have an Auto Run folder, and nothing is chosen yet', () => {
				renderModal();
				answerUrl();

				chooseRunOn('existing');
				fireEvent.click(screen.getByRole('button', { name: 'Existing agent' }));

				expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
					'Choose an agent...',
					'Alpha (Claude Code)',
					'Beta (Codex)',
					'Delta (Claude Code)',
				]);
				expect(screen.queryByTestId('launch-agent-card')).not.toBeInTheDocument();
				expect(launchButton()).toBeDisabled();
				expect(launchButton()).toHaveTextContent(/^Launch$/);
				expect(status()).toHaveTextContent('Choose the agent to launch on.');
			});

			it('shows the pick as the same read-only card and names it on Launch', () => {
				renderModal();
				answerUrl();
				chooseRunOn('existing');

				pickExistingAgent('Beta (Codex)');

				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Beta');
				const card = within(screen.getByTestId('launch-agent-card'));
				expect(card.getByText('Provider').nextElementSibling).toHaveTextContent('Codex');
				expect(card.getByText('Model').nextElementSibling).toHaveTextContent('Provider default');
				expect(card.getByText('Folder').nextElementSibling).toHaveTextContent('/work/beta');
				expect(screen.queryByTestId('launch-edit-new-agent')).not.toBeInTheDocument();
				expect(launchButton()).toBeEnabled();
				expect(launchButton()).toHaveTextContent('Launch on Beta');
			});

			it('marks an agent on an SSH remote', () => {
				renderModal();
				chooseRunOn('existing');

				pickExistingAgent('Delta (Claude Code)');

				expect(
					within(screen.getByTestId('launch-agent-card')).getByText('SSH')
				).toBeInTheDocument();
			});
		});

		describe('New agent', () => {
			it('asks for the agent to be set up first, and creates nothing', () => {
				renderModal();
				answerUrl();

				chooseRunOn('new');

				expect(screen.getByTestId('launch-setup-new-agent')).toHaveTextContent(
					'Set up new agent...'
				);
				expect(screen.queryByTestId('launch-agent-card')).not.toBeInTheDocument();
				expect(launchButton()).toHaveTextContent('Create agent and launch');
				expect(launchButton()).toBeDisabled();
				expect(status()).toHaveTextContent('Set up the new agent to launch on.');
			});

			it('opens the New Agent modal in capture mode, named for the playbook, in the current folder', () => {
				renderModal();
				chooseRunOn('new');

				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));

				expect(screen.getByTestId('new-instance-modal-stub')).toHaveAttribute(
					'data-mode',
					'capture'
				);
				expect(newAgentModal.props?.isOpen).toBe(true);
				expect(newAgentModal.props?.initialDraft).toEqual({
					name: 'PR Review',
					workingDir: '/work/alpha',
				});
				expect(newAgentModal.props?.existingSessions).toEqual([CURRENT, OTHER, NO_FOLDER, REMOTE]);
				expect(newAgentModal.props?.onCreate).toBeUndefined();
			});

			it('opens the New Agent modal on a layer above the dialog and the Exchange', () => {
				renderModal();
				chooseRunOn('new');

				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));

				const layer = screen.getByTestId('launch-new-agent-layer');
				expect(layer.parentElement).toBe(document.body);
				expect(layer).toHaveStyle({ zIndex: '10001' });
			});

			it('takes the remote of an SSH agent along with its folder', () => {
				useSessionStore.setState({ activeSessionId: 'remote' });
				renderModal();
				chooseRunOn('new');

				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));

				expect(newAgentModal.props?.initialDraft).toEqual({
					name: 'PR Review',
					workingDir: '/home/dev/app',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				});
			});

			it('shows what was captured as a summary card, with Edit, and still creates nothing', () => {
				renderModal();
				answerUrl();
				chooseRunOn('new');
				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));

				fireEvent.click(screen.getByRole('button', { name: 'Use these settings' }));

				expect(screen.queryByTestId('new-instance-modal-stub')).not.toBeInTheDocument();
				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Market Research');
				const card = within(screen.getByTestId('launch-agent-card'));
				expect(card.getByText('Provider').nextElementSibling).toHaveTextContent('Codex');
				expect(card.getByText('Model').nextElementSibling).toHaveTextContent('gpt-5');
				expect(card.getByText('Folder').nextElementSibling).toHaveTextContent('/work/market');
				expect(screen.getByTestId('launch-edit-new-agent')).toBeInTheDocument();
				expect(screen.queryByTestId('launch-setup-new-agent')).not.toBeInTheDocument();
				expect(launchButton()).toBeEnabled();
				expect(launchButton()).toHaveTextContent('Create agent and launch');
				expect(useSessionStore.getState().sessions).toHaveLength(4);
				expect(launchPlaybook).not.toHaveBeenCalled();
				expect(window.maestro.marketplace.launch).not.toHaveBeenCalled();
			});

			it('reopens the New Agent modal on the captured draft when Edit is pressed', () => {
				renderModal();
				chooseRunOn('new');
				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));
				fireEvent.click(screen.getByRole('button', { name: 'Use these settings' }));

				fireEvent.click(screen.getByTestId('launch-edit-new-agent'));

				expect(screen.getByTestId('new-instance-modal-stub')).toHaveAttribute(
					'data-mode',
					'capture'
				);
				expect(newAgentModal.props?.initialDraft).toEqual(CAPTURED_DRAFT);
			});

			it('keeps the card when the New Agent modal is closed without capturing', () => {
				renderModal();
				chooseRunOn('new');
				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));

				fireEvent.click(screen.getByRole('button', { name: 'Close new agent' }));

				expect(screen.queryByTestId('new-instance-modal-stub')).not.toBeInTheDocument();
				expect(screen.getByTestId('launch-setup-new-agent')).toBeInTheDocument();
				expect(launchButton()).toBeDisabled();
			});

			it('keeps the captured agent through a switch to another choice and back', () => {
				renderModal();
				chooseRunOn('new');
				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));
				fireEvent.click(screen.getByRole('button', { name: 'Use these settings' }));

				chooseRunOn('current');
				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Alpha');
				chooseRunOn('new');

				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Market Research');
			});
		});
	});

	describe('maestro-cli', () => {
		it('does not look at maestro-cli for a playbook that does not mention it', () => {
			const { checkStatus } = installMaestroCli();
			renderModal();

			expect(checkStatus).not.toHaveBeenCalled();
			expect(screen.queryByTestId('launch-maestro-cli-row')).not.toBeInTheDocument();
		});

		it('keeps Launch off, with Install on offer, while a required maestro-cli is missing', async () => {
			installMaestroCli(NOT_INSTALLED);
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();

			const install = await screen.findByTestId('launch-install-maestro-cli');

			expect(install).toHaveTextContent('Install maestro-cli');
			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				REQUIRED_MISSING_REASON
			);
			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent(REQUIRED_MISSING_REASON);
		});

		it('says it is checking, and keeps Launch off, until the install state is read', async () => {
			const { checkStatus } = installMaestroCli(INSTALLED);
			let finishCheck!: (status: MaestroCliStatus) => void;
			checkStatus.mockReturnValue(
				new Promise<MaestroCliStatus>((resolve) => {
					finishCheck = resolve;
				})
			);
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				'Checking whether maestro-cli is installed...'
			);
			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent('Checking whether maestro-cli is installed...');

			await act(async () => {
				finishCheck(INSTALLED);
			});

			await waitFor(() => expect(launchButton()).toBeEnabled());
		});

		it('turns Launch on once the install succeeds, and says who sees the changed PATH', async () => {
			const { installOrUpdate } = installMaestroCli(NOT_INSTALLED);
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();
			fireEvent.click(await screen.findByTestId('launch-install-maestro-cli'));

			await waitFor(() => expect(launchButton()).toBeEnabled());

			expect(installOrUpdate).toHaveBeenCalledTimes(1);
			const row = screen.getByTestId('launch-maestro-cli-row');
			expect(row).toHaveTextContent('maestro-cli is installed.');
			expect(row).toHaveTextContent('Agents Maestro starts already get the updated PATH.');
			expect(screen.queryByTestId('launch-install-maestro-cli')).not.toBeInTheDocument();
		});

		it('leaves Launch off when the install fails', async () => {
			const { installOrUpdate } = installMaestroCli(NOT_INSTALLED);
			installOrUpdate.mockRejectedValue(new Error('install failed'));
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();
			fireEvent.click(await screen.findByTestId('launch-install-maestro-cli'));

			await waitFor(() =>
				expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
					'Failed to install/update Maestro CLI'
				)
			);

			expect(launchButton()).toBeDisabled();
			expect(screen.getByTestId('launch-install-maestro-cli')).toBeEnabled();
		});

		it('only adds a note, and leaves Launch on, when an optional maestro-cli is missing', async () => {
			installMaestroCli(NOT_INSTALLED);
			renderModal(launchSpec({ preconditions: { maestroCli: 'optional' } }));
			answerUrl();

			await screen.findByTestId('launch-install-maestro-cli');

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(OPTIONAL_MISSING_NOTE);
			expect(launchButton()).toBeEnabled();
			expect(status()).toBeEmptyDOMElement();
		});

		it('is satisfied by an installed maestro-cli', async () => {
			installMaestroCli(INSTALLED);
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();

			await waitFor(() =>
				expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
					'maestro-cli is installed.'
				)
			);

			expect(launchButton()).toBeEnabled();
			expect(screen.queryByTestId('launch-install-maestro-cli')).not.toBeInTheDocument();
		});

		it('refuses a required maestro-cli for an agent on an SSH remote, with the reason and no Install', () => {
			const { checkStatus } = installMaestroCli(INSTALLED);
			useSessionStore.setState({ activeSessionId: 'remote' });
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				REQUIRED_REMOTE_REASON
			);
			expect(screen.queryByTestId('launch-install-maestro-cli')).not.toBeInTheDocument();
			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent(REQUIRED_REMOTE_REASON);
			expect(checkStatus).not.toHaveBeenCalled();
		});

		it('only notes the skipped steps for an optional maestro-cli on an SSH remote', () => {
			useSessionStore.setState({ activeSessionId: 'remote' });
			renderModal(launchSpec({ preconditions: { maestroCli: 'optional' } }));
			answerUrl();

			expect(screen.getByTestId('launch-maestro-cli-row')).toHaveTextContent(
				'maestro-cli is not available on remote agents'
			);
			expect(screen.queryByTestId('launch-install-maestro-cli')).not.toBeInTheDocument();
			expect(launchButton()).toBeEnabled();
		});

		it('is read again when the Run on choice moves between a local and a remote agent', async () => {
			const { checkStatus } = installMaestroCli(INSTALLED);
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();
			await waitFor(() => expect(launchButton()).toBeEnabled());
			expect(checkStatus).toHaveBeenCalledTimes(1);

			chooseRunOn('existing');
			pickExistingAgent('Delta (Claude Code)');

			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent(REQUIRED_REMOTE_REASON);

			pickExistingAgent('Beta (Codex)');

			await waitFor(() => expect(launchButton()).toBeEnabled());
			expect(checkStatus).toHaveBeenCalledTimes(2);
		});

		it('follows a new agent set up on an SSH remote', async () => {
			installMaestroCli(INSTALLED);
			renderModal(launchSpec({ preconditions: { maestroCli: 'required' } }));
			answerUrl();
			await waitFor(() => expect(launchButton()).toBeEnabled());
			chooseRunOn('new');
			fireEvent.click(screen.getByTestId('launch-setup-new-agent'));
			// Capture a remote draft instead of the stand-in's fixed local one.
			act(() => {
				newAgentModal.props?.onCapture({
					...CAPTURED_DRAFT,
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				});
				newAgentModal.props?.onClose();
			});

			expect(launchButton()).toBeDisabled();
			expect(status()).toHaveTextContent(REQUIRED_REMOTE_REASON);
		});
	});

	describe('Launch', () => {
		it('hands the form to the launch service and reports the started launch', async () => {
			const { onLaunched } = renderModal();
			answerUrl();

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			expect(launchPlaybook).toHaveBeenCalledTimes(1);
			expect(launchPlaybook).toHaveBeenCalledWith({
				playbookId: 'dev-pr-review',
				spec: expect.objectContaining({ inputs: expect.any(Array) }),
				answers: {
					PR_URL,
					BOT_REVIEWERS: 'coderabbitai,greptile',
					MAX_FILE_LOC: 500,
				},
				target: { kind: 'current' },
				keepSavedPlaybook: false,
			});
			expect(window.maestro.marketplace.launch).toHaveBeenCalledWith({
				playbookId: 'dev-pr-review',
				values: { PR_URL, BOT_REVIEWERS: 'coderabbitai,greptile', MAX_FILE_LOC: 500 },
				keepSavedPlaybook: false,
				sessionId: 'current',
				autoRunFolderPath: '/work/alpha/.maestro/playbooks',
			});
			expect(onLaunched).toHaveBeenCalledWith({
				status: 'started',
				target: { sessionId: 'current', autoRunFolderPath: '/work/alpha/.maestro/playbooks' },
			});
		});

		it('sends the changed answers, including an advanced one', async () => {
			const { onLaunched } = renderModal();
			answerUrl();
			fireEvent.change(field('BOT_REVIEWERS').getByRole('textbox'), {
				target: { value: 'coderabbitai' },
			});
			fireEvent.click(screen.getByTestId('launch-advanced-toggle'));
			fireEvent.change(field('MAX_FILE_LOC').getByRole('spinbutton'), { target: { value: '800' } });

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			expect(window.maestro.marketplace.launch).toHaveBeenCalledWith(
				expect.objectContaining({
					values: { PR_URL, BOT_REVIEWERS: 'coderabbitai', MAX_FILE_LOC: 800 },
				})
			);
		});

		it('runs on an existing agent', async () => {
			const { onLaunched } = renderModal();
			answerUrl();
			chooseRunOn('existing');
			pickExistingAgent('Beta (Codex)');

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			expect(launchPlaybook).toHaveBeenCalledWith(
				expect.objectContaining({ target: { kind: 'existing', sessionId: 'other' } })
			);
			expect(window.maestro.marketplace.launch).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'other', autoRunFolderPath: '/work/beta/Runner Docs' })
			);
		});

		it('creates a new agent only now: it hands the captured draft to the service', async () => {
			const { onLaunched } = renderModal();
			answerUrl();
			chooseRunOn('new');
			fireEvent.click(screen.getByTestId('launch-setup-new-agent'));
			fireEvent.click(screen.getByRole('button', { name: 'Use these settings' }));
			launchPlaybook.mockResolvedValueOnce({
				status: 'started',
				target: { sessionId: 'new-agent', autoRunFolderPath: '/work/market/.maestro/playbooks' },
				createdSessionId: 'new-agent',
			});

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			expect(launchPlaybook).toHaveBeenCalledWith(
				expect.objectContaining({ target: { kind: 'new', draft: CAPTURED_DRAFT } })
			);
			expect(onLaunched).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'started', createdSessionId: 'new-agent' })
			);
		});

		it('passes Save as a reusable playbook through', async () => {
			const { onLaunched } = renderModal();
			answerUrl();
			fireEvent.click(within(screen.getByTestId('launch-keep-saved')).getByRole('checkbox'));

			fireEvent.click(launchButton());

			await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
			expect(launchPlaybook).toHaveBeenCalledWith(
				expect.objectContaining({ keepSavedPlaybook: true })
			);
			expect(window.maestro.marketplace.launch).toHaveBeenCalledWith(
				expect.objectContaining({ keepSavedPlaybook: true })
			);
		});

		it('does nothing while Launch is off', () => {
			renderModal();

			fireEvent.click(launchButton());

			expect(launchPlaybook).not.toHaveBeenCalled();
		});

		describe('while it starts', () => {
			function holdLaunch() {
				let release!: () => void;
				vi.mocked(window.maestro.marketplace.launch).mockImplementation(
					() =>
						new Promise((resolve) => {
							release = () =>
								resolve({ success: true, launchId: 'launch-1', folderRelativePath: 'folder' });
						})
				);
				return () => release();
			}

			it('shows it is launching and blocks a second launch, a cancel and every control', async () => {
				const release = holdLaunch();
				renderModal();
				answerUrl();
				fireEvent.click(launchButton());

				await waitFor(() => expect(launchButton()).toHaveTextContent('Launching...'));

				expect(launchButton()).toBeDisabled();
				expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
				expect(field('PR_URL').getByRole('textbox')).toBeDisabled();
				expect(screen.getByTestId('launch-run-on-choice-new')).toBeDisabled();
				expect(
					within(screen.getByTestId('launch-keep-saved')).getByRole('checkbox')
				).toBeDisabled();
				fireEvent.click(launchButton());
				expect(launchPlaybook).toHaveBeenCalledTimes(1);

				await act(async () => {
					release();
				});
			});

			it('ignores Escape and the close button until the launch has answered', async () => {
				const release = holdLaunch();
				const { onClose } = renderModal();
				answerUrl();
				fireEvent.click(launchButton());
				await waitFor(() => expect(launchButton()).toHaveTextContent('Launching...'));

				fireEvent.keyDown(window, { key: 'Escape' });
				fireEvent.click(screen.getByLabelText('Close modal'));

				expect(onClose).not.toHaveBeenCalled();

				await act(async () => {
					release();
				});
			});

			it('stays locked after the run has started, for the host to close', async () => {
				const release = holdLaunch();
				const { onLaunched } = renderModal();
				answerUrl();
				fireEvent.click(launchButton());
				await waitFor(() => expect(launchButton()).toHaveTextContent('Launching...'));

				await act(async () => {
					release();
				});

				await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
				expect(launchButton()).toHaveTextContent('Launching...');
				expect(launchButton()).toBeDisabled();
			});
		});

		describe('when it does not start', () => {
			it('shows the refusal beside Launch and lets the person try again', async () => {
				vi.mocked(window.maestro.marketplace.launch).mockResolvedValue({
					success: false,
					error: 'MarketplaceImportError: The launch folder already exists.',
				});
				const { onLaunched } = renderModal();
				answerUrl();

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(status()).toHaveTextContent('The launch folder already exists.')
				);
				expect(status()).toHaveAttribute('role', 'alert');
				expect(onLaunched).not.toHaveBeenCalled();
				expect(launchButton()).toBeEnabled();
				expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
			});

			it('clears the failure when an answer is changed', async () => {
				launchPlaybook.mockResolvedValueOnce({ status: 'failed', error: 'Main refused.' });
				renderModal();
				answerUrl();
				fireEvent.click(launchButton());
				await waitFor(() => expect(status()).toHaveTextContent('Main refused.'));

				answerUrl('https://github.com/acme/app/pull/8');

				expect(status()).toBeEmptyDOMElement();
			});

			it('clears the failure when the next launch starts', async () => {
				launchPlaybook.mockResolvedValueOnce({ status: 'failed', error: 'Main refused.' });
				const { onLaunched } = renderModal();
				answerUrl();
				fireEvent.click(launchButton());
				await waitFor(() => expect(status()).toHaveTextContent('Main refused.'));

				fireEvent.click(launchButton());

				await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
				expect(status()).toBeEmptyDOMElement();
			});

			it('puts the refusal of an answer on its field', async () => {
				launchPlaybook.mockResolvedValueOnce({
					status: 'invalid',
					fieldErrors: { PR_URL: 'Enter a full http:// or https:// URL' },
				});
				const { onLaunched } = renderModal();
				answerUrl();

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(
						field('PR_URL').getByText('Enter a full http:// or https:// URL')
					).toBeInTheDocument()
				);
				expect(status()).toHaveTextContent(
					'Some answers are not valid. Fix them and launch again.'
				);
				expect(onLaunched).not.toHaveBeenCalled();
			});

			it('removes the refusal from a field when that answer is changed', async () => {
				launchPlaybook.mockResolvedValueOnce({
					status: 'invalid',
					fieldErrors: { PR_URL: 'Main did not like this one.' },
				});
				renderModal();
				answerUrl();
				fireEvent.click(launchButton());
				await waitFor(() =>
					expect(field('PR_URL').getByText('Main did not like this one.')).toBeInTheDocument()
				);

				answerUrl('https://github.com/acme/app/pull/9');

				expect(field('PR_URL').queryByText('Main did not like this one.')).not.toBeInTheDocument();
			});

			it('opens Advanced for a refused hidden answer, so the refusal is not out of sight', async () => {
				launchPlaybook.mockResolvedValueOnce({
					status: 'invalid',
					fieldErrors: { MAX_FILE_LOC: 'Must be at most 100' },
				});
				renderModal();
				answerUrl();
				expect(screen.getByTestId('launch-advanced-toggle')).toHaveAttribute(
					'aria-expanded',
					'false'
				);

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(screen.getByTestId('launch-advanced-toggle')).toHaveAttribute(
						'aria-expanded',
						'true'
					)
				);
				expect(field('MAX_FILE_LOC').getByText('Must be at most 100')).toBeInTheDocument();
			});

			it('keeps a new agent the launch created, and moves the choice onto it for the retry', async () => {
				renderModal();
				answerUrl();
				chooseRunOn('new');
				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));
				fireEvent.click(screen.getByRole('button', { name: 'Use these settings' }));
				launchPlaybook.mockImplementationOnce(async (): Promise<PlaybookLaunchOutcome> => {
					// The service has created the agent by the time main refuses.
					useSessionStore.setState((state) => ({
						sessions: [
							...state.sessions,
							createMockSession({
								id: 'new-agent',
								name: 'Market Research',
								toolType: 'codex',
								cwd: '/work/market',
								customModel: 'gpt-5',
								autoRunFolderPath: '/work/market/.maestro/playbooks',
							}),
						],
					}));
					return { status: 'failed', error: 'Main refused.', createdSessionId: 'new-agent' };
				});

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(status()).toHaveTextContent(
						'Main refused. The new agent was kept, so you can launch on it again.'
					)
				);
				expect(screen.getByTestId('launch-run-on-choice-existing')).toHaveAttribute(
					'aria-checked',
					'true'
				);
				expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Market Research');
				expect(screen.queryByTestId('launch-edit-new-agent')).not.toBeInTheDocument();
				expect(launchButton()).toHaveTextContent('Launch on Market Research');
				expect(launchButton()).toBeEnabled();

				// The retry runs on that agent; it does not create a second one.
				fireEvent.click(launchButton());

				await waitFor(() => expect(launchPlaybook).toHaveBeenCalledTimes(2));
				expect(launchPlaybook).toHaveBeenLastCalledWith(
					expect.objectContaining({ target: { kind: 'existing', sessionId: 'new-agent' } })
				);
			});

			it('puts the refusal of the answers by main on the fields, from the text main sends', async () => {
				// The renderer's own check passes; main checks again against its own copy of the playbook.
				vi.mocked(window.maestro.marketplace.launch).mockResolvedValue({
					success: false,
					error:
						'MarketplaceLaunchValuesError: Launch values are not valid: PR_URL: Enter a full http:// or https:// URL; MAX_FILE_LOC: Must be at most 100',
				});
				const { onLaunched } = renderModal();
				answerUrl();

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(
						field('PR_URL').getByText('Enter a full http:// or https:// URL')
					).toBeInTheDocument()
				);
				expect(field('MAX_FILE_LOC').getByText('Must be at most 100')).toBeInTheDocument();
				expect(status()).toHaveTextContent(
					'Some answers are not valid. Fix them and launch again.'
				);
				expect(screen.getByTestId('launch-advanced-toggle')).toHaveAttribute(
					'aria-expanded',
					'true'
				);
				expect(onLaunched).not.toHaveBeenCalled();
				expect(launchButton()).toBeEnabled();
			});

			it('keeps a new agent when main refuses the answers after it was created', async () => {
				renderModal();
				answerUrl();
				chooseRunOn('new');
				fireEvent.click(screen.getByTestId('launch-setup-new-agent'));
				fireEvent.click(screen.getByRole('button', { name: 'Use these settings' }));
				launchPlaybook.mockImplementationOnce(async (): Promise<PlaybookLaunchOutcome> => {
					useSessionStore.setState((state) => ({
						sessions: [
							...state.sessions,
							createMockSession({
								id: 'new-agent',
								name: 'Market Research',
								toolType: 'codex',
								cwd: '/work/market',
								autoRunFolderPath: '/work/market/.maestro/playbooks',
							}),
						],
					}));
					return {
						status: 'invalid',
						fieldErrors: { PR_URL: 'Main did not like this one.' },
						createdSessionId: 'new-agent',
					};
				});

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(field('PR_URL').getByText('Main did not like this one.')).toBeInTheDocument()
				);
				expect(status()).toHaveTextContent(
					'Some answers are not valid. Fix them and launch again. The new agent was kept, so you can launch on it again.'
				);
				// The fix is a new answer; the retry runs on the agent that exists, not on a second one.
				expect(screen.getByTestId('launch-run-on-choice-existing')).toHaveAttribute(
					'aria-checked',
					'true'
				);
				expect(launchButton()).toHaveTextContent('Launch on Market Research');

				answerUrl('https://github.com/acme/app/pull/8');
				fireEvent.click(launchButton());

				await waitFor(() => expect(launchPlaybook).toHaveBeenCalledTimes(2));
				expect(launchPlaybook).toHaveBeenLastCalledWith(
					expect.objectContaining({ target: { kind: 'existing', sessionId: 'new-agent' } })
				);
			});

			it('reports a fault, and tells the person to try again', async () => {
				const fault = new Error('boom');
				launchPlaybook.mockRejectedValueOnce(fault);
				const { onLaunched } = renderModal();
				answerUrl();

				fireEvent.click(launchButton());

				await waitFor(() =>
					expect(status()).toHaveTextContent('The launch failed unexpectedly. Try again.')
				);
				expect(captureException).toHaveBeenCalledWith(fault, {
					extra: { operation: 'playbookLaunch:submit', playbookId: 'dev-pr-review' },
				});
				expect(onLaunched).not.toHaveBeenCalled();
				expect(launchButton()).toBeEnabled();
			});
		});
	});
});
