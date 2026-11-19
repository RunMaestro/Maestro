/**
 * PlaybookConfigureFlow: a guided playbook opens on the interview and lands
 * on the form (pre-filled, badged Detected, or You for what the user said in
 * the chat) when the agent is ready or the user skips; a form playbook offers "Help me fill this in" only under the
 * D5 rule.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
	loadPlaybookConciergePrompt: vi.fn(),
	sendPlaybookConciergeMessage: vi.fn(),
	endPlaybookConcierge: vi.fn(),
}));

vi.mock('../../../../renderer/services/playbookConcierge', async (importActual) => {
	const actual =
		await importActual<typeof import('../../../../renderer/services/playbookConcierge')>();
	return { ...actual, ...service };
});

import { PlaybookConfigureFlow } from '../../../../renderer/components/PlaybookLaunch/PlaybookConfigureFlow';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { resolveEncoreFeatures } from '../../../../shared/encoreFeatureDefaults';
import type { PlaybookFacts } from '../../../../shared/playbookFacts';
import type { Playbook } from '../../../../shared/types';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const FACTS: PlaybookFacts = {
	cwd: '/repo',
	isSshRemote: false,
	gitBranch: 'feat/login',
	gitRemoteUrl: 'git@github.com:acme/app.git',
	openPrUrlsForBranch: [],
	hasGh: true,
	hasPython3: true,
	unknownProbes: [],
	encoreFlags: resolveEncoreFeatures({}),
	cueSubscriptionCount: 0,
	cwdIsObsidianVault: false,
	obsidianVaults: [],
};

const PROPOSAL = { name: 'TEST_COMMAND', value: 'npm test', source: 'detected', confidence: 95 };

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'pb-1',
		name: 'Fix Tests',
		createdAt: 0,
		updatedAt: 0,
		documents: [{ filename: 'fix', resetOnCompletion: false }],
		loopEnabled: false,
		prompt: '<!-- CONFIGURE: How to run the tests -->\n**TEST_COMMAND:** `<UNSET>`',
		...overrides,
	};
}

const gatherFacts = () => window.maestro.playbooks.gatherFacts as ReturnType<typeof vi.fn>;

function renderFlow(playbook: Playbook) {
	return render(
		<PlaybookConfigureFlow
			theme={mockTheme}
			sessionId="agent-1"
			playbook={playbook}
			readme="Fixes the tests."
			onRun={vi.fn()}
		/>
	);
}

function provenance(name: string): string {
	return screen.getByTestId(`parameter-row-${name}-provenance`).textContent ?? '';
}

describe('PlaybookConfigureFlow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'agent-1',
					name: 'Backend',
					toolType: 'claude-code',
					cwd: '/repo',
				}),
			],
		});
		gatherFacts().mockResolvedValue({ success: true, facts: FACTS });
		service.loadPlaybookConciergePrompt.mockResolvedValue('TEMPLATE');
		service.endPlaybookConcierge.mockResolvedValue(undefined);
		service.sendPlaybookConciergeMessage.mockResolvedValue({
			success: true,
			response: { confidence: 40, ready: false, message: 'Which command?', parameters: [PROPOSAL] },
		});
	});

	afterEach(() => {
		useSessionStore.setState({ sessions: [] });
	});

	it('opens a guided playbook on the interview, and Skip to form keeps its proposals', async () => {
		renderFlow(makePlaybook({ interaction: 'guided' }));

		await waitFor(() => expect(screen.getByTestId('playbook-concierge-panel')).toBeTruthy());
		await waitFor(() => expect(screen.getByText('Which command?')).toBeTruthy());
		expect(screen.getByTestId('playbook-concierge-questions')).toHaveTextContent(
			'1 of 2 questions'
		);

		fireEvent.click(screen.getByTestId('playbook-concierge-skip'));
		expect(screen.getByTestId('parameter-sheet')).toBeTruthy();
		expect(provenance('TEST_COMMAND')).toBe('Detected');
		expect(screen.getByTestId('parameter-row-TEST_COMMAND-provenance')).toHaveAttribute(
			'title',
			'Found by the guided interview'
		);
		expect(service.endPlaybookConcierge).toHaveBeenCalled();
	});

	it('lands on the form by itself when the agent is ready', async () => {
		service.sendPlaybookConciergeMessage.mockResolvedValue({
			success: true,
			response: { confidence: 95, ready: true, message: 'Ready.', parameters: [PROPOSAL] },
		});
		renderFlow(makePlaybook({ interaction: 'guided' }));

		await waitFor(() => expect(screen.getByTestId('parameter-sheet')).toBeTruthy());
		expect(provenance('TEST_COMMAND')).toBe('Detected');
		expect(screen.getByTestId('parameter-sheet-run')).toHaveProperty('disabled', false);
	});

	it('lands what the user said in the chat on the form as their own answer', async () => {
		service.sendPlaybookConciergeMessage.mockResolvedValue({
			success: true,
			response: {
				confidence: 95,
				ready: true,
				message: 'Ready.',
				parameters: [{ ...PROPOSAL, value: 'npm run test:unit', source: 'asked' }],
			},
		});
		renderFlow(makePlaybook({ interaction: 'guided' }));

		await waitFor(() => expect(screen.getByTestId('parameter-sheet')).toBeTruthy());
		expect(provenance('TEST_COMMAND')).toBe('You');
		expect(screen.getByDisplayValue('npm run test:unit')).toBeTruthy();
	});

	it('lets a guided playbook skip to the form while the facts are still loading', async () => {
		gatherFacts().mockReturnValue(new Promise(() => {}));
		renderFlow(makePlaybook({ interaction: 'guided' }));

		fireEvent.click(screen.getByTestId('playbook-configure-skip'));
		expect(screen.getByTestId('parameter-sheet')).toBeTruthy();
		expect(service.sendPlaybookConciergeMessage).not.toHaveBeenCalled();
	});

	it('never interviews a guided playbook whose parameters are all answered', async () => {
		renderFlow(makePlaybook({ interaction: 'guided', parameterValues: { TEST_COMMAND: 'make' } }));

		await waitFor(() => expect(screen.getByTestId('parameter-sheet')).toBeTruthy());
		expect(service.loadPlaybookConciergePrompt).not.toHaveBeenCalled();
	});

	it('interviews a freshly installed guided playbook whose every parameter has a default', async () => {
		const prompt = '<!-- CONFIGURE: The trigger marker -->\n**TRIGGER_MARKER:** `@maestro`';
		renderFlow(makePlaybook({ interaction: 'guided', prompt }));

		await waitFor(() => expect(screen.getByTestId('playbook-concierge-panel')).toBeTruthy());
		expect(service.loadPlaybookConciergePrompt).toHaveBeenCalled();
	});

	it('takes the defaults of a guided playbook configured before', async () => {
		const prompt = '<!-- CONFIGURE: The trigger marker -->\n**TRIGGER_MARKER:** `@maestro`';
		renderFlow(makePlaybook({ interaction: 'guided', prompt, parameterValues: {} }));

		await waitFor(() => expect(screen.getByTestId('parameter-sheet')).toBeTruthy());
		expect(provenance('TRIGGER_MARKER')).toBe('Default');
		expect(service.loadPlaybookConciergePrompt).not.toHaveBeenCalled();
	});

	it('offers help on a form playbook when an unresolved parameter is discoverable', async () => {
		renderFlow(makePlaybook());

		const help = await screen.findByTestId('playbook-configure-help');
		expect(help).toHaveTextContent('Help me fill this in');
		await act(async () => {
			fireEvent.click(help);
		});
		await waitFor(() => expect(screen.getByTestId('playbook-concierge-panel')).toBeTruthy());
	});

	it('offers no help when nothing unresolved is discoverable', async () => {
		renderFlow(
			makePlaybook({ prompt: '<!-- CONFIGURE: The market -->\n**MARKET_TOPIC:** `<UNSET>`' })
		);

		await waitFor(() => expect(gatherFacts()).toHaveBeenCalledWith('agent-1'));
		await act(async () => {});
		expect(screen.queryByTestId('playbook-configure-help')).toBeNull();
	});

	it('offers no help without a configured agent', async () => {
		useSessionStore.setState({ sessions: [] });
		renderFlow(makePlaybook());

		await waitFor(() => expect(gatherFacts()).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByTestId('playbook-configure-help')).toBeNull();
	});
});
