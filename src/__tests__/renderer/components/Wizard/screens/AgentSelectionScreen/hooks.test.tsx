import React from 'react';
import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDiscoveryResult } from '../../../../../../shared/types';
import { getAgentCapabilities } from '../../../../../../shared/maestro-lib/providers/capabilities';
import { PICKABLE_AGENT_IDS } from '../../../../../../shared/agentMetadata';
import { mockTheme } from '../../../../../helpers/mockTheme';
import { AgentSelectionScreen } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/AgentSelectionScreen';
import {
	useWizard,
	type WizardState,
} from '../../../../../../renderer/components/Wizard/WizardContext';
import { initialState } from '../../../../../../renderer/components/Wizard/WizardContext/reducer';
import type { AgentConfig } from '../../../../../../renderer/types';
import { useAgentConfigurationPanel } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentConfigurationPanel';
import { useAgentDetection } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentDetection';
import { useAgentSelectionFocus } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentSelectionFocus';
import { useAgentSelectionKeyboard } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentSelectionKeyboard';
import { useSshRemotes } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useSshRemotes';
import { AGENT_TILES } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/utils/agentTiles';
import { captureException } from '../../../../../../renderer/utils/sentry';

vi.mock('../../../../../../renderer/components/Wizard/WizardContext', () => ({
	useWizard: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

function agent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		hidden: false,
		...overrides,
	};
}

function createRefs() {
	const nameInput = document.createElement('input');
	const firstTile = document.createElement('button');
	const secondTile = document.createElement('button');
	vi.spyOn(nameInput, 'focus');
	vi.spyOn(firstTile, 'focus');
	vi.spyOn(secondTile, 'focus');

	return {
		nameInput,
		firstTile,
		secondTile,
		refs: {
			nameInputRef: { current: nameInput } as React.RefObject<HTMLInputElement>,
			tileRefs: { current: [firstTile, secondTile] } as React.RefObject<
				(HTMLButtonElement | null)[]
			>,
			containerRef: { current: null } as React.RefObject<HTMLDivElement>,
		},
	};
}

const FIRST_TILE_ID = AGENT_TILES[0].id;
const SECOND_TILE_ID = AGENT_TILES[1].id;

describe('AgentSelectionScreen hooks', () => {
	let wizardState: WizardState;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		wizardState = { ...initialState, isOpen: true, directoryPath: '/project' };
		vi.mocked(useWizard).mockImplementation(
			() => ({ state: wizardState }) as ReturnType<typeof useWizard>
		);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'terminal', hidden: true }),
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.getModels).mockReset().mockResolvedValue([]);
		vi.mocked(window.maestro.agents.getConfigOptions).mockReset().mockResolvedValue([]);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('detects local agents, filters hidden entries, auto-selects Claude, and announces', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(window.maestro.agents.detect).toHaveBeenCalledWith(undefined);
		expect(result.current.detectedAgents).toHaveLength(1);
		expect(setAvailableAgents).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'claude-code' }),
		]);
		expect(setSelectedAgent).toHaveBeenCalledWith('claude-code');
		expect(result.current.announcement).toContain('Claude Code automatically selected');
	});

	it('does not auto-select when a restored agent is already selected', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: 'codex',
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(setSelectedAgent).not.toHaveBeenCalled();
	});

	it('detects with SSH remote ID and exposes all-agent connection errors', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			agent({ id: 'claude-code', available: false, error: 'Connection timed out' } as any),
			agent({ id: 'codex', available: false, error: 'Connection timed out' } as any),
		]);

		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
		expect(result.current.sshConnectionError).toBe('Connection timed out');
		expect(result.current.announcement).toContain('Unable to connect to remote host');

		vi.mocked(window.maestro.agents.detect).mockClear();
		await act(async () => result.current.refreshAgentDetection());
		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
	});

	it('handles thrown detection errors and ignores stale completion after unmount', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('boom'));

		const { result, unmount } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));
		expect(result.current.sshConnectionError).toBe('boom');

		let resolveDetect: (agents: AgentConfig[]) => void = () => {};
		vi.mocked(window.maestro.agents.detect).mockReturnValue(
			new Promise((resolve) => {
				resolveDetect = resolve;
			})
		);
		const stale = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);
		stale.unmount();
		await act(async () => resolveDetect([agent({ id: 'codex' })]));
		expect(setAvailableAgents).not.toHaveBeenCalledWith([expect.objectContaining({ id: 'codex' })]);
		unmount();
	});

	it.each([false, true])(
		'keeps detection ownership across refreshes and host round trips (stale rejection=%s)',
		async (rejectStale) => {
			const pending: { resolve: (value: AgentConfig[]) => void; reject: (error: Error) => void }[] =
				[];
			vi.mocked(window.maestro.agents.detect).mockImplementation(
				() => new Promise((resolve, reject) => pending.push({ resolve, reject }))
			);
			const setAvailableAgents = vi.fn();
			const setSelectedAgent = vi.fn();
			const grok = agent({ id: 'grok', name: 'Grok CLI', path: '/selected/grok' });
			const { result, rerender } = renderHook(
				({ sshRemoteConfig, selectedAgent }) =>
					useAgentDetection({
						sshRemoteConfig,
						selectedAgent,
						setAvailableAgents,
						setSelectedAgent,
					}),
				{
					initialProps: {
						sshRemoteConfig: undefined as Parameters<
							typeof useAgentDetection
						>[0]['sshRemoteConfig'],
						selectedAgent: null as string | null,
					},
				}
			);
			rerender({ sshRemoteConfig: undefined, selectedAgent: 'grok' });
			await act(async () => pending[0].resolve([grok, agent({ id: 'claude-code' })]));
			expect(setSelectedAgent).not.toHaveBeenCalled();
			const oldLocalRefresh = result.current.refreshAgentDetection;
			let first!: Promise<void>;
			let second!: Promise<void>;
			act(() => {
				first = result.current.refreshAgentDetection();
			});
			expect(setAvailableAgents).toHaveBeenLastCalledWith([]);
			expect(result.current.detectedAgents).toContainEqual(grok);
			act(() => {
				second = result.current.refreshAgentDetection();
			});
			const missing = { ...grok, available: false };
			await act(async () => {
				pending[2].resolve([missing]);
				await second;
			});
			setAvailableAgents.mockClear();
			await act(async () => {
				if (rejectStale) pending[1].reject(new Error('obsolete detection'));
				else pending[1].resolve([grok]);
				await first;
			});
			expect(setAvailableAgents).not.toHaveBeenCalled();
			expect(result.current.detectedAgents).toEqual([missing]);
			expect(captureException).not.toHaveBeenCalled();

			rerender({ sshRemoteConfig: { enabled: true, remoteId: 'remote-1' }, selectedAgent: 'grok' });
			expect(result.current.detectedAgents).toEqual([]);
			expect(setAvailableAgents).toHaveBeenLastCalledWith([]);
			expect(result.current.isDetecting).toBe(true);
			expect(window.maestro.agents.detect).toHaveBeenLastCalledWith('remote-1');
			const oldRemoteRefresh = result.current.refreshAgentDetection;
			rerender({ sshRemoteConfig: undefined, selectedAgent: 'grok' });
			expect(window.maestro.agents.detect).toHaveBeenLastCalledWith(undefined);
			await act(async () => {
				await oldLocalRefresh();
				await oldRemoteRefresh();
			});
			expect(window.maestro.agents.detect).toHaveBeenCalledTimes(5);
			await act(async () => pending[4].resolve([grok]));
			setAvailableAgents.mockClear();
			await act(async () => pending[3].resolve([agent({ id: 'claude-code' })]));
			expect(result.current.detectedAgents).toEqual([grok]);
			expect(result.current.isDetecting).toBe(false);
			expect(result.current.sshConnectionError).toBeNull();
			expect(setAvailableAgents).not.toHaveBeenCalled();
			expect(setSelectedAgent).not.toHaveBeenCalled();
		}
	);

	it('lets a manual detection replace pending initial detection without late default selection', async () => {
		let finishInitial!: (value: AgentConfig[]) => void;
		const grok = agent({ id: 'grok' });
		vi.mocked(window.maestro.agents.detect)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					finishInitial = resolve;
				})
			)
			.mockResolvedValue([grok]);
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);
		await act(async () => result.current.refreshAgentDetection());
		expect(result.current.detectedAgents).toEqual([grok]);
		expect(result.current.isDetecting).toBe(false);
		setAvailableAgents.mockClear();
		await act(async () => finishInitial([agent({ id: 'claude-code' })]));
		expect(result.current.detectedAgents).toEqual([grok]);
		expect(setAvailableAgents).not.toHaveBeenCalled();
		expect(setSelectedAgent).not.toHaveBeenCalled();
	});

	it('restores current detection ownership after StrictMode cleanup', async () => {
		const pending: ((value: AgentConfig[]) => void)[] = [];
		vi.mocked(window.maestro.agents.detect).mockImplementation(
			() => new Promise((resolve) => pending.push(resolve))
		);
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(
			() =>
				useAgentDetection({
					sshRemoteConfig: undefined,
					selectedAgent: 'grok',
					setAvailableAgents,
					setSelectedAgent,
				}),
			{
				wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
			}
		);
		expect(pending).toHaveLength(2);
		setAvailableAgents.mockClear();
		await act(async () => pending[0]([agent({ id: 'claude-code' })]));
		expect(result.current.isDetecting).toBe(true);
		expect(setAvailableAgents).not.toHaveBeenCalled();
		const grok = agent({ id: 'grok' });
		await act(async () => pending[1]([grok]));
		expect(result.current.isDetecting).toBe(false);
		expect(result.current.detectedAgents).toEqual([grok]);
		expect(setAvailableAgents).toHaveBeenCalledExactlyOnceWith([grok]);
		expect(setSelectedAgent).not.toHaveBeenCalled();
	});

	it.each(['local failure', 'remote failure', 'unresolved SSH'] as const)(
		'clears detection readiness on %s without a local fallback',
		async (failure) => {
			const setAvailableAgents = vi.fn();
			const setSelectedAgent = vi.fn();
			vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('detection refused'));
			const { result } = renderHook(() =>
				useAgentDetection({
					sshRemoteConfig:
						failure === 'local failure'
							? undefined
							: { enabled: true, remoteId: failure === 'unresolved SSH' ? '' : 'remote-1' },
					selectedAgent: 'grok',
					setAvailableAgents,
					setSelectedAgent,
				})
			);
			await waitFor(() => expect(result.current.isDetecting).toBe(false));
			expect(result.current.detectedAgents).toEqual([]);
			expect(setAvailableAgents).toHaveBeenLastCalledWith([]);
			expect(setSelectedAgent).not.toHaveBeenCalled();
			if (failure === 'unresolved SSH') {
				expect(window.maestro.agents.detect).not.toHaveBeenCalled();
				expect(result.current.sshConnectionError).toBe(
					'Select an SSH remote before detecting agents.'
				);
			} else {
				expect(window.maestro.agents.detect).toHaveBeenCalledExactlyOnceWith(
					failure === 'local failure' ? undefined : 'remote-1'
				);
			}
		}
	);

	it('loads SSH remotes, syncs restored context, and forwards local or remote selections', async () => {
		const setWizardSessionSshRemoteConfig = vi.fn();
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Server', host: 'host' } as any],
		});

		const { result, rerender } = renderHook(
			({ sessionSshRemoteConfig }) =>
				useSshRemotes({
					sessionSshRemoteConfig,
					setWizardSessionSshRemoteConfig,
				}),
			{ initialProps: { sessionSshRemoteConfig: undefined as any } }
		);

		await waitFor(() => expect(result.current.sshRemotes).toHaveLength(1));
		expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(1);

		act(() => result.current.handleSshRemoteChange('remote-1'));
		expect(result.current.sshRemoteConfig).toEqual({ enabled: true, remoteId: 'remote-1' });
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});

		act(() => result.current.handleSshRemoteChange(''));
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: false,
			remoteId: null,
		});

		rerender({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-2',
				workingDirOverride: '/work',
			},
		});

		expect(result.current.sshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
			workingDirOverride: '/work',
		});
		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2));

		rerender({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-2',
				workingDirOverride: '/other-work',
			},
		});

		expect(result.current.sshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
			workingDirOverride: '/other-work',
		});
		expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2);
	});

	it('swallows SSH remote load failures and reports telemetry', async () => {
		const error = new Error('no ssh');
		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValue(error);

		const { result } = renderHook(() =>
			useSshRemotes({
				sessionSshRemoteConfig: undefined,
				setWizardSessionSshRemoteConfig: vi.fn(),
			})
		);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(result.current.sshRemotes).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(error, {
			extra: {
				operation: 'agentSelection:loadSshRemotes',
				sessionRemoteEnabled: false,
				sessionRemoteId: null,
			},
		});
	});

	it('handles unsuccessful SSH remote config responses', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: false,
			error: 'Failed to load',
		});

		const { result } = renderHook(() =>
			useSshRemotes({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				setWizardSessionSshRemoteConfig: vi.fn(),
			})
		);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(result.current.sshRemotes).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: {
				operation: 'agentSelection:loadSshRemotes',
				sessionRemoteEnabled: true,
				sessionRemoteId: 'remote-1',
				error: 'Failed to load',
			},
		});
		expect((vi.mocked(captureException).mock.calls[0][0] as Error).message).toBe('Failed to load');
	});

	it('focuses name field for one selectable agent and tile for multiple selectable agents', () => {
		const { refs, nameInput, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const { rerender } = renderHook(
			({ detectedAgents, selectedAgent }) =>
				useAgentSelectionFocus({
					tiles: AGENT_TILES,
					isDetecting: false,
					selectedAgent,
					detectedAgents,
					refs,
					setFocusedTileIndex,
					setIsNameFieldFocused,
				}),
			{
				initialProps: {
					detectedAgents: [agent({ id: FIRST_TILE_ID, available: true })],
					selectedAgent: null as string | null,
				},
			}
		);

		expect(nameInput.focus).toHaveBeenCalled();
		expect(setIsNameFieldFocused).toHaveBeenCalledWith(true);

		// Tile order is alphabetical and grows with every new provider, so drive
		// the assertion off the strip rather than off two hard-coded ids.
		rerender({
			detectedAgents: [
				agent({ id: FIRST_TILE_ID, available: true }),
				agent({ id: SECOND_TILE_ID, available: true }),
			],
			selectedAgent: SECOND_TILE_ID,
		});

		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
		expect(secondTile.focus).toHaveBeenCalled();
	});

	it('handles keyboard navigation, field focus, selection, and continue', () => {
		const { refs, nameInput, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const setSelectedAgent = vi.fn();
		const nextStep = vi.fn();
		const preventDefault = vi.fn();

		const { result, rerender } = renderHook(
			({ isNameFieldFocused, focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					tiles: AGENT_TILES,
					tileColumns: AGENT_TILES.length,
					isNameFieldFocused,
					focusedTileIndex,
					detectedAgents: [
						agent({ id: FIRST_TILE_ID, available: true }),
						agent({ id: SECOND_TILE_ID, available: true }),
					],
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused,
					setFocusedTileIndex,
					setSelectedAgent,
					canProceedToNext: () => true,
					nextStep,
				}),
			{ initialProps: { isNameFieldFocused: false, focusedTileIndex: 0 } }
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
		expect(secondTile.focus).toHaveBeenCalled();

		act(() => result.current({ key: 'Tab', shiftKey: false, preventDefault } as any));
		expect(setIsNameFieldFocused).toHaveBeenCalledWith(true);
		expect(nameInput.focus).toHaveBeenCalled();

		act(() => result.current({ key: ' ', preventDefault } as any));
		expect(setSelectedAgent).toHaveBeenCalledWith(FIRST_TILE_ID);

		act(() => result.current({ key: 'Enter', preventDefault } as any));
		expect(nextStep).toHaveBeenCalledTimes(1);

		rerender({ isNameFieldFocused: true, focusedTileIndex: 0 });
		act(() => result.current({ key: 'Tab', shiftKey: true, preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
	});

	it('traverses Grok and unavailable neighbors, preserves the default, and restores focus after configuration', async () => {
		const detectedAgents = AGENT_TILES.map((tile) =>
			agent({
				id: tile.id,
				name: tile.name,
				available: tile.id === 'claude-code' || tile.id === 'grok',
				capabilities: getAgentCapabilities(tile.id),
			})
		);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(detectedAgents);
		const setSelectedAgent = vi.fn((selectedAgent: WizardState['selectedAgent']) => {
			wizardState = { ...wizardState, selectedAgent };
		});
		const context = {
			setSelectedAgent,
			setAvailableAgents: vi.fn(),
			setAgentName: vi.fn(),
			setCustomPath: vi.fn(),
			setCustomArgs: vi.fn(),
			setCustomEnvVars: vi.fn(),
			setEnableMaestroP: vi.fn(),
			setMaestroPMode: vi.fn(),
			setMaestroPPath: vi.fn(),
			setCodexTransport: vi.fn(),
			setSessionSshRemoteConfig: vi.fn(),
			nextStep: vi.fn(),
			canProceedToNext: () => false,
		};
		vi.mocked(useWizard).mockImplementation(
			() => ({ ...context, state: wizardState }) as ReturnType<typeof useWizard>
		);
		const view = render(<AgentSelectionScreen theme={mockTheme} />);
		const claude = await screen.findByRole('button', { name: 'Claude Code' });
		expect(setSelectedAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
		expect(claude).toHaveFocus();
		const tiles = screen
			.getAllByRole('button')
			.filter((button) =>
				AGENT_TILES.some((tile) => button.getAttribute('aria-label')?.startsWith(tile.name))
			);
		expect(tiles.map((button) => button.getAttribute('aria-label'))).toEqual(
			PICKABLE_AGENT_IDS.map((id) => {
				const detected = detectedAgents.find((entry) => entry.id === id)!;
				return `${detected.name}${detected.available ? '' : ' (not installed)'}`;
			})
		);
		const grokIndex = AGENT_TILES.findIndex((tile) => tile.id === 'grok');
		const claudeIndex = AGENT_TILES.findIndex((tile) => tile.id === 'claude-code');
		setSelectedAgent.mockClear();
		for (let index = claudeIndex + 1; index <= grokIndex; index++) {
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
			if (index < grokIndex) {
				expect(tiles[index]).toBeDisabled();
				fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
				expect(setSelectedAgent).not.toHaveBeenCalled();
			}
		}
		const grok = screen.getByRole('button', { name: 'Grok CLI' });
		expect(grok).toHaveFocus();
		fireEvent.keyDown(grok, { key: ' ' });
		expect(setSelectedAgent).toHaveBeenCalledExactlyOnceWith('grok');
		view.rerender(<AgentSelectionScreen theme={mockTheme} />);
		expect(grok).toHaveAttribute('aria-pressed', 'true');
		setSelectedAgent.mockClear();
		fireEvent.keyDown(grok, { key: 'ArrowRight' });
		expect(tiles[grokIndex + 1]).toBeDisabled();
		fireEvent.keyDown(document.activeElement!, { key: ' ' });
		expect(setSelectedAgent).not.toHaveBeenCalled();
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
		expect(grok).toHaveFocus();
		fireEvent.keyDown(grok, { key: 'Tab' });
		expect(document.activeElement?.tagName).toBe('INPUT');
		fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
		expect(grok).toHaveFocus();
		expect(context.nextStep).not.toHaveBeenCalled();

		vi.useFakeTimers();
		await act(async () => {
			fireEvent.keyDown(within(grok).getByRole('button', { name: 'Customize agent settings' }), {
				key: 'Enter',
			});
		});
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(screen.getByRole('heading', { name: 'Configure Grok CLI' })).toBeInTheDocument();
		expect(grok).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		await act(async () => vi.advanceTimersByTimeAsync(150));
		const restoredGrok = screen.getByRole('button', { name: 'Grok CLI' });
		expect(restoredGrok).toHaveFocus();
		setSelectedAgent.mockClear();
		fireEvent.keyDown(document.activeElement!, { key: ' ' });
		expect(setSelectedAgent).toHaveBeenCalledExactlyOnceWith('grok');
	});

	it('navigates the filtered strip, not the full provider registry', () => {
		// With unavailable providers hidden, the strip is two tiles long. Clamping
		// on the registry would let the focus ring walk past what is drawn.
		const { refs, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const preventDefault = vi.fn();
		const visibleTiles = AGENT_TILES.slice(0, 2);

		const { result } = renderHook(
			({ focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					tiles: visibleTiles,
					tileColumns: visibleTiles.length,
					isNameFieldFocused: false,
					focusedTileIndex,
					detectedAgents: [
						agent({ id: FIRST_TILE_ID, available: true }),
						agent({ id: SECOND_TILE_ID, available: true }),
					],
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused: vi.fn(),
					setFocusedTileIndex,
					setSelectedAgent: vi.fn(),
					canProceedToNext: () => true,
					nextStep: vi.fn(),
				}),
			{ initialProps: { focusedTileIndex: 1 } }
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(setFocusedTileIndex).not.toHaveBeenCalled();

		act(() => result.current({ key: 'ArrowLeft', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(0);

		// The strip scrolls the focused tile into view itself, so the browser's own
		// scroll must be suppressed or it parks the tile under an edge fade first.
		expect(secondTile.focus).not.toHaveBeenCalled();
	});

	it('steps a whole row on up/down once the tiles wrap', () => {
		// A filtered list short enough to wrap is drawn as rows, so up/down have
		// somewhere to go. The row width comes from the grid's own measurement -
		// assuming one here would jump the ring to a tile that is not below the
		// current one.
		const { refs } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const preventDefault = vi.fn();
		const visibleTiles = AGENT_TILES.slice(0, 5);

		const { result } = renderHook(
			({ focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					tiles: visibleTiles,
					tileColumns: 3,
					isNameFieldFocused: false,
					focusedTileIndex,
					detectedAgents: visibleTiles.map((tile) => agent({ id: tile.id, available: true })),
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused: vi.fn(),
					setFocusedTileIndex,
					setSelectedAgent: vi.fn(),
					canProceedToNext: () => true,
					nextStep: vi.fn(),
				}),
			{ initialProps: { focusedTileIndex: 0 } }
		);

		act(() => result.current({ key: 'ArrowDown', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenLastCalledWith(3);

		act(() => result.current({ key: 'ArrowUp', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledTimes(1);
	});

	it('suppresses the browser scroll when moving focus onto a tile', () => {
		const { refs, secondTile } = createRefs();
		const preventDefault = vi.fn();

		const { result } = renderHook(() =>
			useAgentSelectionKeyboard({
				tiles: AGENT_TILES,
				tileColumns: AGENT_TILES.length,
				isNameFieldFocused: false,
				focusedTileIndex: 0,
				detectedAgents: [
					agent({ id: FIRST_TILE_ID, available: true }),
					agent({ id: SECOND_TILE_ID, available: true }),
				],
				nameInputRef: refs.nameInputRef,
				tileRefs: refs.tileRefs,
				setIsNameFieldFocused: vi.fn(),
				setFocusedTileIndex: vi.fn(),
				setSelectedAgent: vi.fn(),
				canProceedToNext: () => true,
				nextStep: vi.fn(),
			})
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(secondTile.focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it('leaves keys alone for a control that opts out of strip navigation', () => {
		// The keydown handler covers the whole screen, so the availability bar's
		// toggle would otherwise lose its own Tab and arrow keys to tile movement.
		const { refs } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const preventDefault = vi.fn();

		const exempt = document.createElement('label');
		exempt.setAttribute('data-provider-bar-nav-exempt', 'true');
		const toggle = document.createElement('button');
		exempt.appendChild(toggle);

		const { result } = renderHook(() =>
			useAgentSelectionKeyboard({
				tiles: AGENT_TILES,
				tileColumns: AGENT_TILES.length,
				isNameFieldFocused: false,
				focusedTileIndex: 0,
				detectedAgents: [agent({ id: FIRST_TILE_ID, available: true })],
				nameInputRef: refs.nameInputRef,
				tileRefs: refs.tileRefs,
				setIsNameFieldFocused,
				setFocusedTileIndex,
				setSelectedAgent: vi.fn(),
				canProceedToNext: () => true,
				nextStep: vi.fn(),
			})
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault, target: toggle } as any));
		act(() =>
			result.current({ key: 'Tab', shiftKey: false, preventDefault, target: toggle } as any)
		);

		expect(setFocusedTileIndex).not.toHaveBeenCalled();
		expect(setIsNameFieldFocused).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});

	it('opens and closes config panel, loading config and models with SSH ID', async () => {
		vi.useFakeTimers();
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'old' });
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['gpt-5']);
		const showConfigView = vi.fn();
		const showGridView = vi.fn();
		const announce = vi.fn();
		const setWizardSessionSshRemoteConfig = vi.fn();
		// Match useSshRemotes state: the host stays stable during config/model reads.
		const sshRemoteConfig = { enabled: true, remoteId: 'remote-1' };

		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: [
					agent({
						id: 'codex',
						available: true,
						capabilities: { supportsModelSelection: true } as any,
					}),
				],
				sshRemoteConfig,
				configuringAgentId: 'codex',
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath: vi.fn(),
				setWizardCustomArgs: vi.fn(),
				setWizardCustomEnvVars: vi.fn(),
				setWizardSessionSshRemoteConfig,
				customPath: '/bin/codex',
				customEnvVars: {},
				refreshAgentDetection: vi.fn(),
				showConfigView,
				showGridView,
				announce,
			})
		);

		await act(async () => {
			await result.current.handleOpenConfig('codex');
		});

		expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false, 'remote-1');
		expect(result.current.agentConfig).toEqual({ model: 'old' });
		expect(result.current.availableModels).toEqual(['gpt-5']);
		expect(showConfigView).toHaveBeenCalledTimes(1);
		expect(announce).toHaveBeenCalledWith('Configuring Codex');

		const loadError = new Error('load failed');
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(loadError);
		await act(async () => {
			await result.current.handleOpenConfig('codex');
		});
		expect(captureException).toHaveBeenCalledWith(loadError, {
			extra: {
				operation: 'agentSelection:loadModels',
				agentId: 'codex',
				remoteMode: true,
			},
		});

		act(() => result.current.handleCloseConfig());
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});
		expect(showGridView).toHaveBeenCalledWith('codex');
	});

	it('handles custom config, env vars, model refresh, agent refresh, and config persistence', async () => {
		const setWizardCustomPath = vi.fn();
		const setWizardCustomArgs = vi.fn();
		const setWizardCustomEnvVars = vi.fn();
		const refreshAgentDetection = vi.fn();
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model-a']);

		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: [agent({ id: 'codex' })],
				sshRemoteConfig: undefined,
				configuringAgentId: 'codex',
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath,
				setWizardCustomArgs,
				setWizardCustomEnvVars,
				setWizardSessionSshRemoteConfig: vi.fn(),
				customPath: '/bin/codex',
				customEnvVars: { OLD: '1' },
				refreshAgentDetection,
				showConfigView: vi.fn(),
				showGridView: vi.fn(),
				announce: vi.fn(),
			})
		);

		act(() => result.current.setCustomPath(''));
		act(() => result.current.setCustomArgs('--flag'));
		act(() => result.current.handleEnvVarKeyChange('OLD', 'NEW', '2'));
		act(() => result.current.handleEnvVarValueChange('OLD', '3'));
		act(() => result.current.handleEnvVarRemove('OLD'));
		act(() => result.current.handleEnvVarAdd());
		act(() => result.current.handleConfigChange('model', 'gpt-5'));

		await act(async () => result.current.handleConfigBlur('model', 'gpt-5'));
		await act(async () => result.current.handleCustomPathBlur());
		await act(async () => result.current.handleRefreshModels());
		const refreshError = new Error('refresh failed');
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(refreshError);
		await act(async () => result.current.handleRefreshModels());
		await act(async () => result.current.handleRefreshAgent());

		expect(setWizardCustomPath).toHaveBeenCalledWith(undefined);
		expect(setWizardCustomArgs).toHaveBeenCalledWith('--flag');
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ NEW: '2' });
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ OLD: '3' });
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({});
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ OLD: '1', '': '' });
		expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('codex', { model: 'gpt-5' });
		expect(window.maestro.agents.setCustomPath).toHaveBeenCalledWith('codex', '/bin/codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', true, undefined);
		expect(captureException).toHaveBeenCalledWith(refreshError, {
			extra: {
				operation: 'agentSelection:refreshModels',
				agentId: 'codex',
				remoteMode: false,
			},
		});
		expect(refreshAgentDetection).toHaveBeenCalledTimes(2);
	});
	describe('Grok configuration discovery', () => {
		let args: Parameters<typeof useAgentConfigurationPanel>[0];
		beforeEach(() => {
			vi.useFakeTimers();
			wizardState = { ...wizardState, selectedAgent: 'grok' };
			args = {
				detectedAgents: [
					agent({
						id: 'grok',
						configOptions: [
							{ key: 'model', type: 'text', label: 'Model', description: 'Model', default: '' },
							{
								key: 'reasoningEffort',
								type: 'text',
								label: 'Effort',
								description: 'Effort',
								default: '',
							},
						],
					}),
				],
				configuringAgentId: 'grok',
				sshRemoteConfig: undefined,
				customPath: '/bin/grok',
				customEnvVars: {},
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath: vi.fn(),
				setWizardCustomArgs: vi.fn(),
				setWizardCustomEnvVars: vi.fn(),
				setWizardSessionSshRemoteConfig: vi.fn(),
				refreshAgentDetection: vi.fn(),
				showConfigView: vi.fn(),
				showGridView: vi.fn(),
				announce: vi.fn(),
			};
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'manual-model',
				reasoningEffort: 'manual-effort',
			});
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
				status: 'discovered',
				options: ['catalog-model'],
			} as never);
			vi.mocked(window.maestro.agents.getConfigOptions).mockResolvedValue({
				status: 'discovered',
				options: ['high'],
			} as never);
		});

		it.each([undefined, {}, { GROK_HOME: '/accounts/one' }, { GROK_HOME: '/accounts/two' }] as (
			| Record<string, string>
			| undefined
		)[])(
			'preserves untouched environment %j and forwards explicit account/path/args edits',
			async (customEnvVars) => {
				const original = customEnvVars && { ...customEnvVars };
				wizardState = { ...wizardState, customEnvVars };
				args = {
					...args,
					customEnvVars: customEnvVars ?? {},
					sshRemoteConfig: { enabled: true, remoteId: '' },
				};
				const { result, rerender } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				act(() => result.current.handleCloseConfig());
				expect(args.setWizardCustomEnvVars).not.toHaveBeenCalled();
				expect(args.setWizardSessionSshRemoteConfig).toHaveBeenCalledExactlyOnceWith({
					enabled: true,
					remoteId: null,
				});
				expect(args.showGridView).toHaveBeenCalledWith('grok');
				act(() => {
					result.current.setCustomPath('/selected/grok');
					result.current.setCustomArgs('--profile selected');
					result.current.handleEnvVarValueChange('GROK_HOME', '/accounts/next');
				});
				expect(args.setWizardCustomPath).toHaveBeenCalledExactlyOnceWith('/selected/grok');
				expect(args.setWizardCustomArgs).toHaveBeenCalledExactlyOnceWith('--profile selected');
				expect(args.setWizardCustomEnvVars).toHaveBeenLastCalledWith({
					GROK_HOME: '/accounts/next',
				});
				args = { ...args, customEnvVars: { GROK_HOME: '/accounts/next' } };
				rerender();
				act(() => result.current.handleEnvVarRemove('GROK_HOME'));
				expect(args.setWizardCustomEnvVars).toHaveBeenLastCalledWith({});
				expect(wizardState.customEnvVars).toEqual(original);
			}
		);

		it.each([undefined, {}, { GROK_HOME: '' }] as (Record<string, string> | undefined)[])(
			'preserves raw environment %j and provider-setting clears',
			async (customEnvVars) => {
				wizardState = { ...wizardState, customEnvVars };
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: {
						kind: 'provider-settings',
						cwd: '/project',
						customPath: '/bin/grok',
						customEnvVars,
						model: 'manual-model',
						effort: 'manual-effort',
						sessionSshRemoteConfig: undefined,
					},
				});
				act(() => {
					result.current.handleConfigChange('model', '');
					result.current.handleConfigChange('reasoningEffort', '');
				});
				expect(result.current.availableModels).toEqual([]);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({ model: '', effort: '', customEnvVars }),
				});
				expect(result.current.agentConfig).toEqual({ model: '', reasoningEffort: '' });
			}
		);

		it.each(['unavailable', 'configured-fallback', 'discovered'] as const)(
			'keeps manual values with %s metadata and counts only discovered options',
			async (status) => {
				vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
					status,
					options: status === 'unavailable' ? [] : ['catalog-model'],
				} as never);
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				act(() => result.current.handleConfigChange('model', 'typed-model'));
				act(() => result.current.handleConfigChange('reasoningEffort', 'typed-effort'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.modelDiscoveryStatus).toBe(status);
				expect(result.current.availableModels).toEqual(
					status === 'discovered' ? ['catalog-model'] : []
				);
				expect(result.current.agentConfig).toEqual({
					model: 'typed-model',
					reasoningEffort: 'typed-effort',
				});
				if (status !== 'discovered')
					expect(result.current.detectedConfigAgent?.configOptions?.[0].description).toContain(
						'Discovery is unavailable'
					);
			}
		);

		it.each(['missing cwd', 'unresolved SSH'])(
			'forwards %s for host refusal without inventing a local target',
			async (missing) => {
				if (missing === 'missing cwd') wizardState = { ...wizardState, directoryPath: '' };
				else args = { ...args, sshRemoteConfig: { enabled: true, remoteId: '' } };
				vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
					status: 'unavailable',
					options: [],
				} as never);
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({
						cwd: wizardState.directoryPath,
						sessionSshRemoteConfig: args.sshRemoteConfig,
					}),
				});
				expect(result.current.availableModels).toEqual([]);
				expect(result.current.modelDiscoveryStatus).toBe('unavailable');
				expect(result.current.agentConfig.model).toBe('manual-model');
				expect(result.current.detectedConfigAgent?.configOptions?.[0].description).toContain(
					missing === 'missing cwd'
						? 'until a project directory is selected'
						: 'Manual values are preserved'
				);
			}
		);

		it.each(['account', 'executable', 'remote', 'cwd'] as const)(
			'rejects late options after a changed %s selection',
			async (change) => {
				let resolveModels!: (value: AgentDiscoveryResult) => void;
				vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
					new Promise<AgentDiscoveryResult>((resolve) => {
						resolveModels = resolve;
					}) as never
				);
				const { result, rerender } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				if (change === 'account')
					wizardState = { ...wizardState, customEnvVars: { GROK_HOME: '/accounts/second' } };
				if (change === 'cwd') wizardState = { ...wizardState, directoryPath: '/other-project' };
				if (change === 'executable') args = { ...args, customPath: '/other/grok' };
				if (change === 'remote')
					args = { ...args, sshRemoteConfig: { enabled: true, remoteId: 'remote-2' } };
				rerender();
				await act(async () => resolveModels({ status: 'discovered', options: ['stale-model'] }));
				expect(result.current.availableModels).toEqual([]);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.availableModels).toEqual(['catalog-model']);
				expect(result.current.agentConfig).toEqual({
					model: 'manual-model',
					reasoningEffort: 'manual-effort',
				});
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({
						cwd: wizardState.directoryPath,
						customEnvVars: wizardState.customEnvVars,
						customPath: args.customPath,
						sessionSshRemoteConfig: args.sshRemoteConfig,
					}),
				});
			}
		);

		it('keeps executable clear ownership with the provider that was edited', async () => {
			args = {
				...args,
				customPath: '',
				detectedAgents: [
					...args.detectedAgents,
					agent({ id: 'codex', capabilities: { supportsModelSelection: true } as any }),
				],
			};
			const { result, rerender } = renderHook(() => useAgentConfigurationPanel(args));
			await act(async () => result.current.handleOpenConfig('grok'));
			await act(async () => vi.advanceTimersByTimeAsync(300));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				context: expect.objectContaining({ customPath: undefined }),
			});
			act(() => result.current.setCustomPath(''));
			expect(args.setWizardCustomPath).toHaveBeenLastCalledWith(undefined);
			expect(result.current.availableModels).toEqual([]);
			await act(async () => vi.advanceTimersByTimeAsync(300));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				context: expect.objectContaining({ customPath: '' }),
			});

			wizardState = { ...wizardState, selectedAgent: 'codex' };
			args = { ...args, configuringAgentId: 'codex' };
			rerender();
			vi.mocked(window.maestro.agents.getModels).mockResolvedValueOnce(['codex-model']);
			await act(async () => result.current.handleOpenConfig('codex'));
			act(() => result.current.setCustomPath(''));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith('codex', false, undefined);
			expect(result.current.availableModels).toEqual(['codex-model']);

			wizardState = { ...wizardState, selectedAgent: 'grok' };
			args = { ...args, configuringAgentId: 'grok' };
			rerender();
			await act(async () => result.current.handleOpenConfig('grok'));
			await act(async () => vi.advanceTimersByTimeAsync(300));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				context: expect.objectContaining({ customPath: undefined }),
			});
		});

		it.each(['/selected/grok', ''])(
			'invalidates the catalog after saving executable %j even when the text is unchanged',
			async (customPath) => {
				const { result, rerender } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				act(() => result.current.setCustomPath(customPath));
				args = { ...args, customPath };
				rerender();
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.availableModels).toEqual(['catalog-model']);
				let finishSave!: () => void;
				vi.mocked(window.maestro.agents.setCustomPath).mockReturnValueOnce(
					new Promise<void>((resolve) => {
						finishSave = resolve;
					})
				);
				let saving!: Promise<void>;
				act(() => {
					saving = result.current.handleCustomPathBlur();
				});
				expect(window.maestro.agents.setCustomPath).toHaveBeenLastCalledWith(
					'grok',
					customPath || null
				);
				expect(args.refreshAgentDetection).not.toHaveBeenCalled();
				await act(async () => {
					finishSave();
					await saving;
				});
				expect(args.refreshAgentDetection).toHaveBeenCalledTimes(1);
				expect(result.current.availableModels).toEqual([]);
				vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
					status: 'discovered',
					options: ['saved-executable-model'],
				} as never);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					context: expect.objectContaining({ customPath }),
				});
				expect(result.current.availableModels).toEqual(['saved-executable-model']);
				expect(result.current.agentConfig).toEqual({
					model: 'manual-model',
					reasoningEffort: 'manual-effort',
				});
			}
		);

		it.each([
			'account',
			'account reopen',
			'remote',
			'cwd',
			'provider',
			'close',
			'reopen',
			'wizard reopen',
			'unmount',
		] as const)(
			'discards a pending config load after %s without selecting or overwriting a new owner',
			async (change) => {
				let finishConfig!: (value: Record<string, string>) => void;
				vi.mocked(window.maestro.agents.getConfig).mockReturnValueOnce(
					new Promise((resolve) => {
						finishConfig = resolve;
					})
				);
				const { result, rerender, unmount } = renderHook(() => useAgentConfigurationPanel(args));
				let opening!: Promise<void>;
				act(() => {
					opening = result.current.handleOpenConfig('grok');
				});
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
				expect(window.maestro.agents.getConfigOptions).not.toHaveBeenCalled();
				if (change === 'account' || change === 'account reopen') {
					wizardState = { ...wizardState, customEnvVars: { GROK_HOME: '/accounts/next' } };
					rerender();
				} else if (change === 'remote') {
					args = { ...args, sshRemoteConfig: { enabled: true, remoteId: 'remote-2' } };
					rerender();
				} else if (change === 'cwd') {
					wizardState = { ...wizardState, directoryPath: '/new-project' };
					rerender();
				} else if (change === 'provider') {
					wizardState = { ...wizardState, selectedAgent: 'codex' };
					args = { ...args, configuringAgentId: 'codex' };
					rerender();
				} else if (change === 'wizard reopen') {
					wizardState = { ...wizardState, isOpen: false };
					rerender();
					wizardState = { ...wizardState, isOpen: true };
					rerender();
				} else if (change === 'unmount') unmount();
				else act(() => result.current.handleCloseConfig());
				if (change === 'provider' || change === 'reopen' || change === 'account reopen') {
					await act(async () => result.current.handleOpenConfig(args.configuringAgentId!));
					act(() => {
						result.current.handleConfigChange('model', 'new-owner-model');
						result.current.handleConfigChange('reasoningEffort', 'new-owner-effort');
					});
					await act(async () => vi.advanceTimersByTimeAsync(300));
				}
				const expected =
					change === 'provider' || change === 'reopen' || change === 'account reopen'
						? { model: 'new-owner-model', reasoningEffort: 'new-owner-effort' }
						: {};
				expect(result.current.agentConfig).toEqual(expected);
				vi.mocked(args.setSelectedAgent).mockClear();
				vi.mocked(args.setConfiguringAgentId).mockClear();
				vi.mocked(args.showConfigView).mockClear();
				vi.mocked(args.announce).mockClear();
				const modelCalls = vi.mocked(window.maestro.agents.getModels).mock.calls.length;
				await act(async () => {
					finishConfig({ model: 'stale-model', reasoningEffort: 'stale-effort' });
					await opening;
				});
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.agentConfig).toEqual(expected);
				expect(args.setSelectedAgent).not.toHaveBeenCalled();
				expect(args.setConfiguringAgentId).not.toHaveBeenCalled();
				expect(args.showConfigView).not.toHaveBeenCalled();
				expect(args.announce).not.toHaveBeenCalled();
				expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(modelCalls);
			}
		);

		it.each(['account', 'provider', 'close', 'reopen', 'unmount'] as const)(
			'ignores pending model and both effort catalogs after %s',
			async (change) => {
				let finishModels!: (value: AgentDiscoveryResult) => void;
				let finishEfforts!: (value: AgentDiscoveryResult) => void;
				vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
					new Promise<AgentDiscoveryResult>((resolve) => {
						finishModels = resolve;
					}) as never
				);
				const pendingEfforts = new Promise<AgentDiscoveryResult>((resolve) => {
					finishEfforts = resolve;
				});
				vi.mocked(window.maestro.agents.getConfigOptions)
					.mockReturnValueOnce(pendingEfforts as never)
					.mockReturnValueOnce(pendingEfforts as never)
					.mockResolvedValue({ status: 'unavailable', options: [] } as never);
				const { result, rerender, unmount } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(1);
				expect(window.maestro.agents.getConfigOptions).toHaveBeenCalledTimes(2);
				if (change === 'account') {
					wizardState = { ...wizardState, customEnvVars: { GROK_HOME: '/accounts/next' } };
					rerender();
				} else if (change === 'provider') {
					wizardState = { ...wizardState, selectedAgent: 'codex' };
					args = { ...args, configuringAgentId: 'codex' };
					rerender();
					await act(async () => result.current.handleOpenConfig('codex'));
				} else if (change === 'unmount') unmount();
				else {
					act(() => result.current.handleCloseConfig());
					if (change === 'reopen') await act(async () => result.current.handleOpenConfig('grok'));
				}
				if (change !== 'unmount') {
					expect(result.current.availableModels).toEqual([]);
					act(() => {
						result.current.handleConfigChange('model', 'typed-model');
						result.current.handleConfigChange('reasoningEffort', 'typed-effort');
					});
				}
				await act(async () => vi.advanceTimersByTimeAsync(300));
				const activeGrok = change === 'account' || change === 'reopen';
				expect(result.current.availableModels).toEqual(activeGrok ? ['catalog-model'] : []);
				expect(result.current.effortDiscoveryStatus).toBe('unavailable');
				const config = result.current.agentConfig;
				await act(async () => {
					finishModels({ status: 'discovered', options: ['stale-model'] });
					finishEfforts({ status: 'discovered', options: ['stale-effort'] });
				});
				expect(result.current.availableModels).toEqual(activeGrok ? ['catalog-model'] : []);
				expect(result.current.effortDiscoveryStatus).toBe('unavailable');
				expect(result.current.agentConfig).toEqual(config);
				if (activeGrok)
					expect(result.current.agentConfig).toEqual({
						model: 'typed-model',
						reasoningEffort: 'typed-effort',
					});
			}
		);

		it.each([
			'account',
			'provider',
			'close',
			'reopen',
			'wizard reopen',
			'unmount',
			'manual edit',
		] as const)(
			'prevents an old forced refresh from publishing or reloading after %s',
			async (change) => {
				const { result, rerender, unmount } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				act(() => {
					result.current.handleConfigChange('model', 'typed-model');
					result.current.handleConfigChange('reasoningEffort', 'typed-effort');
				});
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.availableModels).toEqual(['catalog-model']);
				let finishRefresh!: (value: AgentDiscoveryResult) => void;
				vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
					new Promise<AgentDiscoveryResult>((resolve) => {
						finishRefresh = resolve;
					}) as never
				);
				let refreshing!: Promise<void>;
				act(() => {
					refreshing = result.current.handleRefreshModels();
				});
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
					providerId: 'grok',
					forceRefresh: true,
					context: expect.objectContaining({ model: 'typed-model', effort: 'typed-effort' }),
				});
				if (change === 'account') {
					wizardState = { ...wizardState, customEnvVars: { GROK_HOME: '/accounts/next' } };
					rerender();
				} else if (change === 'provider') {
					wizardState = { ...wizardState, selectedAgent: 'codex' };
					args = { ...args, configuringAgentId: 'codex' };
					rerender();
					await act(async () => result.current.handleOpenConfig('codex'));
				} else if (change === 'wizard reopen') {
					wizardState = { ...wizardState, isOpen: false };
					rerender();
					expect(result.current.availableModels).toEqual([]);
					wizardState = { ...wizardState, isOpen: true };
					rerender();
				} else if (change === 'unmount') unmount();
				else if (change === 'close' || change === 'reopen') {
					act(() => result.current.handleCloseConfig());
					if (change === 'reopen') await act(async () => result.current.handleOpenConfig('grok'));
				}
				if (change === 'provider' || change === 'reopen' || change === 'manual edit')
					act(() => {
						result.current.handleConfigChange(
							'model',
							change === 'manual edit' ? 'latest-model' : 'typed-model'
						);
						result.current.handleConfigChange(
							'reasoningEffort',
							change === 'manual edit' ? 'latest-effort' : 'typed-effort'
						);
					});
				await act(async () => vi.advanceTimersByTimeAsync(300));
				const modelCalls = vi.mocked(window.maestro.agents.getModels).mock.calls.length;
				const effortCalls = vi.mocked(window.maestro.agents.getConfigOptions).mock.calls.length;
				const models = result.current.availableModels;
				const config = result.current.agentConfig;
				expect(models).toEqual(
					change === 'provider' || change === 'close' ? [] : ['catalog-model']
				);
				expect(config).toEqual({
					model: change === 'manual edit' ? 'latest-model' : 'typed-model',
					reasoningEffort: change === 'manual edit' ? 'latest-effort' : 'typed-effort',
				});
				await act(async () => {
					finishRefresh({ status: 'discovered', options: ['stale-forced-model'] });
					await refreshing;
				});
				expect(result.current.availableModels).toEqual(models);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(modelCalls);
				expect(window.maestro.agents.getConfigOptions).toHaveBeenCalledTimes(effortCalls);
				expect(result.current.availableModels).toEqual(models);
				expect(result.current.agentConfig).toEqual(config);
			}
		);

		it.each([false, true])(
			'reports forced refresh errors with remoteMode=%s and retains manual text',
			async (remoteMode) => {
				if (remoteMode)
					args = { ...args, sshRemoteConfig: { enabled: true, remoteId: 'remote-1' } };
				const { result } = renderHook(() => useAgentConfigurationPanel(args));
				await act(async () => result.current.handleOpenConfig('grok'));
				await act(async () => vi.advanceTimersByTimeAsync(300));
				const error = new Error('synthetic discovery failure');
				vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(error);
				await act(async () => result.current.handleRefreshModels());
				expect(captureException).toHaveBeenCalledWith(error, {
					extra: { operation: 'agentSelection:refreshModels', agentId: 'grok', remoteMode },
				});
				expect(result.current.availableModels).toEqual([]);
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.availableModels).toEqual(['catalog-model']);
				expect(result.current.agentConfig).toEqual({
					model: 'manual-model',
					reasoningEffort: 'manual-effort',
				});
			}
		);

		it('reloads the current catalog after a successful forced refresh without adopting its payload', async () => {
			const { result } = renderHook(() => useAgentConfigurationPanel(args));
			await act(async () => result.current.handleOpenConfig('grok'));
			await act(async () => vi.advanceTimersByTimeAsync(300));
			vi.mocked(window.maestro.agents.getModels)
				.mockResolvedValueOnce({ status: 'discovered', options: ['force-payload'] } as never)
				.mockResolvedValue({ status: 'discovered', options: ['fresh-catalog'] } as never);
			await act(async () => result.current.handleRefreshModels());
			expect(result.current.availableModels).toEqual([]);
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				forceRefresh: true,
				context: expect.objectContaining({ customPath: '/bin/grok' }),
			});
			await act(async () => vi.advanceTimersByTimeAsync(300));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				context: expect.objectContaining({ customPath: '/bin/grok' }),
			});
			expect(result.current.availableModels).toEqual(['fresh-catalog']);
			expect(result.current.agentConfig).toEqual({
				model: 'manual-model',
				reasoningEffort: 'manual-effort',
			});
		});

		it.each(['open', 'refresh'] as const)(
			'keeps the Codex %s signature and rejects its late catalog after switching to Grok',
			async (operation) => {
				wizardState = { ...wizardState, selectedAgent: 'codex' };
				args = {
					...args,
					configuringAgentId: 'codex',
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					detectedAgents: [
						...args.detectedAgents,
						agent({
							id: 'codex',
							capabilities: { supportsModelSelection: true } as any,
						}),
					],
				};
				const { result, rerender } = renderHook(() => useAgentConfigurationPanel(args));
				if (operation === 'refresh') {
					vi.mocked(window.maestro.agents.getModels).mockResolvedValueOnce(['codex-model']);
					await act(async () => result.current.handleOpenConfig('codex'));
				}
				let finishModels!: (value: string[]) => void;
				vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
					new Promise<string[]>((resolve) => {
						finishModels = resolve;
					})
				);
				let pending!: Promise<void>;
				await act(async () => {
					pending =
						operation === 'open'
							? result.current.handleOpenConfig('codex')
							: result.current.handleRefreshModels();
				});
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
					'codex',
					operation === 'refresh',
					'remote-1'
				);
				wizardState = { ...wizardState, selectedAgent: 'grok' };
				args = { ...args, configuringAgentId: 'grok' };
				rerender();
				await act(async () => result.current.handleOpenConfig('grok'));
				act(() => {
					result.current.handleConfigChange('model', 'typed-model');
					result.current.handleConfigChange('reasoningEffort', 'typed-effort');
				});
				await act(async () => vi.advanceTimersByTimeAsync(300));
				vi.mocked(args.showConfigView).mockClear();
				vi.mocked(args.setSelectedAgent).mockClear();
				vi.mocked(args.announce).mockClear();
				await act(async () => {
					finishModels(['stale-codex-model']);
					await pending;
				});
				expect(result.current.availableModels).toEqual(['catalog-model']);
				expect(result.current.agentConfig).toEqual({
					model: 'typed-model',
					reasoningEffort: 'typed-effort',
				});
				expect(args.showConfigView).not.toHaveBeenCalled();
				expect(args.setSelectedAgent).not.toHaveBeenCalled();
				expect(args.announce).not.toHaveBeenCalled();
			}
		);
	});
});
