/**
 * Screen-level cover for the one piece of provider-filter logic that lives in
 * the screen rather than in a hook or a util: what happens to the focus ring
 * when the strip renumbers.
 *
 * The strip hides uninstalled providers by default, so flipping "Show All
 * Supported" changes what every tile index means. Carrying the raw index across
 * that flip slides the ring onto whichever unrelated provider inherited the
 * slot, which is invisible until the user presses Enter and gets the wrong
 * agent. These tests press Enter.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { mockTheme } from '../../../../../helpers/mockTheme';
import type { AgentConfig } from '../../../../../../renderer/types';
import { AgentSelectionScreen } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/AgentSelectionScreen';
import { AGENT_TILES } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentTiles';

const announce = vi.fn();
const setSelectedAgent = vi.fn();
const nextStep = vi.fn();

/** Two installed providers, deliberately NOT adjacent in the full registry. */
const FIRST_AVAILABLE = 'codex';
const SECOND_AVAILABLE = 'opencode';

const detectedAgents: AgentConfig[] = [
	{ id: FIRST_AVAILABLE, name: 'Codex', available: true },
	{ id: SECOND_AVAILABLE, name: 'OpenCode', available: true },
] as AgentConfig[];

vi.mock('../../../../../../renderer/components/Wizard/WizardContext', () => ({
	useWizard: () => ({
		state: {
			selectedAgent: null,
			agentName: 'agent',
			customPath: '',
			customArgs: '',
			customEnvVars: {},
			enableMaestroP: false,
			maestroPMode: 'tui',
			maestroPPath: '',
			sessionSshRemoteConfig: undefined,
		},
		setSelectedAgent,
		setAvailableAgents: vi.fn(),
		setAgentName: vi.fn(),
		setCustomPath: vi.fn(),
		setCustomArgs: vi.fn(),
		setCustomEnvVars: vi.fn(),
		setEnableMaestroP: vi.fn(),
		setMaestroPMode: vi.fn(),
		setMaestroPPath: vi.fn(),
		setSessionSshRemoteConfig: vi.fn(),
		nextStep,
		canProceedToNext: () => false,
	}),
}));

// Detection, SSH, and the config panel are covered by their own hook tests and
// only get in the way here. The focus and keyboard hooks stay REAL: they are
// half of the behaviour under test.
vi.mock(
	'../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks')
			>();
		return {
			...actual,
			useAgentDetection: () => ({
				isDetecting: false,
				detectedAgents,
				sshConnectionError: null,
				announcement: '',
				announcementKey: 0,
				announce,
				refreshAgentDetection: vi.fn(),
			}),
			useSshRemotes: () => ({
				sshRemotes: [],
				sshRemoteConfig: undefined,
				handleSshRemoteChange: vi.fn(),
			}),
			useAgentConfigurationPanel: () => ({
				configuringTile: null,
				detectedConfigAgent: null,
				agentConfig: {},
				availableModels: [],
				loadingModels: false,
				refreshingAgent: null,
				detectedMaestroPPath: null,
				handleOpenConfig: vi.fn(),
				handleCloseConfig: vi.fn(),
				setCustomPath: vi.fn(),
				handleCustomPathBlur: vi.fn(),
				setCustomArgs: vi.fn(),
				handleEnvVarKeyChange: vi.fn(),
				handleEnvVarValueChange: vi.fn(),
				handleEnvVarRemove: vi.fn(),
				handleEnvVarAdd: vi.fn(),
				handleConfigChange: vi.fn(),
				handleConfigBlur: vi.fn(),
				handleRefreshModels: vi.fn(),
				handleRefreshAgent: vi.fn(),
			}),
		};
	}
);

function renderScreen() {
	const { container } = render(<AgentSelectionScreen theme={mockTheme} />);
	// The screen's keydown handler sits on the scroll container, the outermost node.
	return container.firstElementChild as HTMLElement;
}

describe('AgentSelectionScreen provider filter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders only the installed providers until asked for the rest', () => {
		renderScreen();

		expect(screen.getAllByRole('button', { name: /Codex|OpenCode/ })).toHaveLength(2);
		expect(screen.queryByRole('button', { name: /Claude Code/ })).toBeNull();

		fireEvent.click(screen.getByRole('switch', { name: 'Show all supported providers' }));

		expect(screen.getByRole('button', { name: /Claude Code \(not installed\)/ })).toBeTruthy();
	});

	it('carries the focus ring by provider when the strip renumbers', () => {
		const surface = renderScreen();

		// Focus starts on the first installed provider; step onto the second.
		fireEvent.keyDown(surface, { key: 'ArrowRight' });

		fireEvent.click(screen.getByRole('switch', { name: 'Show all supported providers' }));

		// Index 1 of the unfiltered strip is a DIFFERENT provider. Selecting by the
		// carried index would either pick that one or (being uninstalled) pick
		// nothing at all.
		fireEvent.keyDown(surface, { key: 'Enter' });

		expect(setSelectedAgent).toHaveBeenCalledWith(SECOND_AVAILABLE);
	});

	it('announces the new row count in the direction the filter moved', () => {
		const surface = renderScreen();
		const toggle = screen.getByRole('switch', { name: 'Show all supported providers' });

		fireEvent.click(toggle);
		expect(announce).toHaveBeenCalledWith(`Showing all ${AGENT_TILES.length} supported providers`);

		announce.mockClear();
		fireEvent.click(toggle);
		expect(announce).toHaveBeenCalledWith(`Showing ${detectedAgents.length} available providers`);

		// And the ring survived the round trip.
		fireEvent.keyDown(surface, { key: 'Enter' });
		expect(setSelectedAgent).toHaveBeenCalledWith(FIRST_AVAILABLE);
	});
});
