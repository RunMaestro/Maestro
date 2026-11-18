/**
 * @fileoverview Tests for AgentPickerGrid component
 * Tests: agent display, selection, expansion, badges, debug info, loading/error states
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { Modal } from '../../../../renderer/components/ui/Modal';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import {
	AgentLogo,
	AGENT_LOGO_FALLBACK_TESTID,
} from '../../../../renderer/components/Wizard/screens/AgentSelectionScreen/components/AgentLogo';
import {
	PICKABLE_AGENT_IDS,
	AGENT_AUTOSELECT_ORDER,
	getAgentDisplayName,
	getAgentPickerMeta,
} from '../../../../shared/agentMetadata';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import { AgentPickerGrid } from '../../../../renderer/components/NewInstanceModal/AgentPickerGrid';
import type { Theme, AgentConfig } from '../../../../renderer/types';
import type {
	AgentPickerGridProps,
	AgentDebugInfo,
} from '../../../../renderer/components/NewInstanceModal/types';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

const createTheme = (): Theme =>
	({
		id: 'test-dark',
		name: 'Test Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a2e',
			bgSidebar: '#16213e',
			bgActivity: '#0f3460',
			textMain: '#e8e8e8',
			textDim: '#888888',
			accent: '#7b2cbf',
			accentDim: '#5a1f8f',
			accentForeground: '#ffffff',
			border: '#333355',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			bgAccentHover: '#9333ea',
		},
	}) as Theme;

const createAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	path: '/usr/local/bin/claude',
	binaryName: 'claude',
	hidden: false,
	...overrides,
});

const createDefaultProps = (
	overrides: Partial<AgentPickerGridProps> = {}
): AgentPickerGridProps => ({
	theme: createTheme(),
	loading: false,
	sshConnectionError: null,
	visibleAgents: [
		createAgent(),
		createAgent({ id: 'codex', name: 'OpenAI Codex', available: true, binaryName: 'codex' }),
	],
	availableProviderCount: 2,
	totalProviderCount: 11,
	providerLocationLabel: 'locally',
	showAllProviders: false,
	onShowAllProvidersChange: vi.fn(),
	selectedAgent: 'claude-code',
	expandedAgent: null,
	refreshingAgent: null,
	debugInfo: null,
	customAgentPaths: {},
	customAgentArgs: {},
	customAgentEnvVars: {},
	agentConfigs: {},
	availableModels: {},
	loadingModels: {},
	onAgentSelect: vi.fn(),
	onAgentExpand: vi.fn(),
	onRefreshAgent: vi.fn(),
	onDismissDebug: vi.fn(),
	onCustomPathChange: vi.fn(),
	onCustomArgsChange: vi.fn(),
	onEnvVarKeyChange: vi.fn(),
	onEnvVarValueChange: vi.fn(),
	onEnvVarRemove: vi.fn(),
	onEnvVarAdd: vi.fn(),
	onConfigChange: vi.fn(),
	onConfigBlur: vi.fn(),
	onRefreshModels: vi.fn(),
	onTransferPendingSshConfig: vi.fn(),
	onLoadModelsForAgent: vi.fn(),
	...overrides,
});

describe('AgentPickerGrid', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should render loading spinner when loading', () => {
		render(<AgentPickerGrid {...createDefaultProps({ loading: true })} />);
		expect(screen.getByText('Loading agents...')).toBeInTheDocument();
	});

	it('should render SSH connection error panel', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					sshConnectionError: 'Connection refused by remote host',
				})}
			/>
		);

		expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
		expect(screen.getByText('Connection refused by remote host')).toBeInTheDocument();
		expect(
			screen.getByText('Select a different remote host or switch to Local Execution.')
		).toBeInTheDocument();
	});

	it('should render agent cards with correct names', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
	});

	it('should show Available badge for available agents', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		const availableBadges = screen.getAllByText('Available');
		expect(availableBadges.length).toBeGreaterThanOrEqual(1);
	});

	it('should show Not Found badge for unavailable agents', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					visibleAgents: [createAgent({ available: false })],
				})}
			/>
		);

		expect(screen.getByText('Not Found')).toBeInTheDocument();
	});

	it('should show Coming Soon badge for unsupported agents', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					visibleAgents: [
						createAgent({ id: 'future-agent', name: 'Future Agent', available: false }),
					],
				})}
			/>
		);

		expect(screen.getByText('Coming Soon')).toBeInTheDocument();
	});

	it('should call onAgentSelect and onAgentExpand when clicking supported agent', () => {
		const onAgentSelect = vi.fn();
		const onAgentExpand = vi.fn();
		const onTransferPendingSshConfig = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					onAgentSelect,
					onAgentExpand,
					onTransferPendingSshConfig,
					selectedAgent: '',
				})}
			/>
		);

		// Click the first agent (Claude Code)
		fireEvent.click(screen.getByText('Claude Code'));

		expect(onAgentSelect).toHaveBeenCalledWith('claude-code');
		expect(onAgentExpand).toHaveBeenCalledWith('claude-code');
		expect(onTransferPendingSshConfig).toHaveBeenCalledWith('claude-code');
	});

	it('should not call callbacks when clicking unsupported agent', () => {
		const onAgentSelect = vi.fn();
		const onAgentExpand = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					visibleAgents: [
						createAgent({ id: 'future-agent', name: 'Future Agent', available: false }),
					],
					onAgentSelect,
					onAgentExpand,
				})}
			/>
		);

		fireEvent.click(screen.getByText('Future Agent'));
		expect(onAgentSelect).not.toHaveBeenCalled();
		expect(onAgentExpand).not.toHaveBeenCalled();
	});

	it('should call onAgentExpand with null to collapse expanded agent', () => {
		const onAgentExpand = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					expandedAgent: 'claude-code',
					onAgentExpand,
				})}
			/>
		);

		// Click the already-expanded agent
		fireEvent.click(screen.getByText('Claude Code'));
		expect(onAgentExpand).toHaveBeenCalledWith(null);
	});

	it('should activate agent on keyboard Enter', () => {
		const onAgentSelect = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					onAgentSelect,
					selectedAgent: '',
				})}
			/>
		);

		const option = screen.getAllByRole('option')[0];
		fireEvent.keyDown(option, { key: 'Enter' });
		expect(onAgentSelect).toHaveBeenCalledWith('claude-code');
	});

	it('should activate agent on keyboard Space', () => {
		const onAgentSelect = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					onAgentSelect,
					selectedAgent: '',
				})}
			/>
		);

		const option = screen.getAllByRole('option')[0];
		fireEvent.keyDown(option, { key: ' ' });
		expect(onAgentSelect).toHaveBeenCalledWith('claude-code');
	});

	it('should call onRefreshAgent when refresh button is clicked', () => {
		const onRefreshAgent = vi.fn();

		render(<AgentPickerGrid {...createDefaultProps({ onRefreshAgent })} />);

		const refreshButtons = screen.getAllByTitle('Refresh detection');
		fireEvent.click(refreshButtons[0]);
		expect(onRefreshAgent).toHaveBeenCalledWith('claude-code');
	});

	it('should render debug info when present', () => {
		const debugInfo: AgentDebugInfo = {
			agentId: 'claude-code',
			available: false,
			path: null,
			binaryName: 'claude',
			envPath: '/usr/local/bin:/usr/bin',
			homeDir: '/home/testuser',
			platform: 'linux',
			whichCommand: 'which',
			error: 'Binary not found in PATH',
		};

		render(<AgentPickerGrid {...createDefaultProps({ debugInfo })} />);

		expect(screen.getByText(/Debug Info: claude not found/)).toBeInTheDocument();
		expect(screen.getByText('Binary not found in PATH')).toBeInTheDocument();
		expect(screen.getByText(/Platform:/)).toBeInTheDocument();
		expect(screen.getByText('linux')).toBeInTheDocument();
	});

	it('should call onDismissDebug when dismiss button is clicked', () => {
		const onDismissDebug = vi.fn();
		const debugInfo: AgentDebugInfo = {
			agentId: 'claude-code',
			available: false,
			path: null,
			binaryName: 'claude',
			envPath: '/usr/local/bin',
			homeDir: '/home/testuser',
			platform: 'linux',
			whichCommand: 'which',
			error: null,
		};

		render(<AgentPickerGrid {...createDefaultProps({ debugInfo, onDismissDebug })} />);

		fireEvent.click(screen.getByText('Dismiss'));
		expect(onDismissDebug).toHaveBeenCalled();
	});

	it('should render Agent Provider label', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		expect(screen.getByText('Agent Provider')).toBeInTheDocument();
	});

	it('reports the provider counts beside the section heading', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);

		// Compact wording: the full sentence would wrap the heading onto a second
		// line in a modal that already scrolls.
		expect(screen.getByText('2 of 11 locally')).toBeInTheDocument();
		expect(screen.getByText('Show All')).toBeInTheDocument();
	});

	it('forwards the availability toggle', () => {
		const onShowAllProvidersChange = vi.fn();
		render(<AgentPickerGrid {...createDefaultProps({ onShowAllProvidersChange })} />);

		fireEvent.click(screen.getByRole('switch', { name: 'Show all supported providers' }));
		expect(onShowAllProvidersChange).toHaveBeenCalledWith(true);
	});

	it('hides the counts while detection is still running or unreachable', () => {
		// Both states make the numbers a lie: nothing has been counted yet, or the
		// host never answered.
		const { rerender } = render(<AgentPickerGrid {...createDefaultProps({ loading: true })} />);
		expect(screen.queryByRole('switch', { name: 'Show all supported providers' })).toBeNull();

		rerender(
			<AgentPickerGrid {...createDefaultProps({ sshConnectionError: 'Connection timed out' })} />
		);
		expect(screen.queryByRole('switch', { name: 'Show all supported providers' })).toBeNull();
	});

	it('should render hook behavior note', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		expect(screen.getByText(/Agent hooks run per-message/)).toBeInTheDocument();
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
	});

	it('should set tabIndex=0 for supported agents and tabIndex=-1 for unsupported', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					visibleAgents: [
						createAgent(),
						createAgent({ id: 'future-agent', name: 'Future', available: false }),
					],
				})}
			/>
		);

		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('tabindex', '0'); // claude-code (supported)
		expect(options[1]).toHaveAttribute('tabindex', '-1'); // future-agent (unsupported)
	});

	it('should treat grok as a supported agent (selectable, tabIndex=0)', () => {
		const onAgentSelect = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					visibleAgents: [
						createAgent({ id: 'grok', name: 'Grok CLI', available: true, binaryName: 'grok' }),
					],
					onAgentSelect,
					selectedAgent: '',
				})}
			/>
		);

		expect(screen.getByRole('option')).toHaveAttribute('tabindex', '0');
		fireEvent.click(screen.getByText('Grok CLI'));
		expect(onAgentSelect).toHaveBeenCalledWith('grok');
	});

	it('should set aria-selected on selected agent', () => {
		render(<AgentPickerGrid {...createDefaultProps({ selectedAgent: 'claude-code' })} />);

		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('aria-selected', 'true');
		expect(options[1]).toHaveAttribute('aria-selected', 'false');
	});

	describe('Grok provider picker contract', () => {
		it('keeps alphabetical rows, the preferred selection and the real Grok mark', () => {
			const props = createDefaultProps({
				visibleAgents: PICKABLE_AGENT_IDS.map((id) =>
					createAgent({ id, name: getAgentDisplayName(id) })
				),
				selectedAgent: AGENT_AUTOSELECT_ORDER[0],
			});
			render(<AgentPickerGrid {...props} />);
			const rows = within(
				screen.getByRole('listbox', { name: 'Agent provider selection' })
			).getAllByRole('option');
			const names = rows.map((row) => row.querySelector('.font-medium')?.textContent);
			expect(names).toEqual([
				'Antigravity CLI',
				'Claude Code',
				'Codex',
				'Copilot-CLI',
				'Factory Droid',
				'Grok CLI',
				'Hermes',
				'Oh My Pi',
				'OpenCode',
				'Pi',
				'Qwen3 Coder',
			]);
			expect(screen.getByRole('option', { name: /Claude Code/ })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			expect(screen.getByRole('option', { name: /Grok CLI\s*Beta Available/ })).toHaveAttribute(
				'aria-selected',
				'false'
			);
			expect(rows.every((row) => row.tabIndex === 0)).toBe(true);
			expect(props.onAgentSelect).not.toHaveBeenCalled();

			const { container } = render(
				<AgentLogo
					agentId="grok"
					supported
					detected
					brandColor={getAgentPickerMeta('grok')?.brandColor}
					theme={props.theme}
				/>
			);
			expect(container.querySelector('svg')).toBeInTheDocument();
			expect(container.querySelectorAll('path')).toHaveLength(3);
			expect(screen.queryByTestId(AGENT_LOGO_FALLBACK_TESTID)).not.toBeInTheDocument();
		});

		it.each([true, false])(
			'forwards custom binary and detection actions when installed=%s',
			(available) => {
				const props = createDefaultProps({
					visibleAgents: [
						createAgent({
							id: 'grok',
							name: 'Grok CLI',
							binaryName: 'grok',
							available,
							path: available ? '/synthetic/bin/grok' : undefined,
							capabilities: getAgentCapabilities('grok'),
						}),
					],
					selectedAgent: 'grok',
					expandedAgent: 'grok',
					customAgentPaths: { grok: '/synthetic/custom/grok' },
				});
				render(<AgentPickerGrid {...props} />);
				const row = screen.getByRole('option', { name: /Grok CLI/ });
				expect(within(row).getByText(available ? 'Available' : 'Not Found')).toBeInTheDocument();
				expect(within(row).getByText('Beta')).toBeInTheDocument();
				const path = screen.getByRole('textbox', { name: 'Path' });
				expect(path).toHaveValue('/synthetic/custom/grok');
				fireEvent.change(path, { target: { value: '/synthetic/alternate/grok' } });
				expect(props.onCustomPathChange).toHaveBeenCalledExactlyOnceWith(
					'grok',
					'/synthetic/alternate/grok'
				);
				fireEvent.click(within(row).getByRole('button', { name: 'Refresh detection' }));
				expect(props.onRefreshAgent).toHaveBeenCalledExactlyOnceWith('grok');
				expect(props.onAgentSelect).not.toHaveBeenCalled();
				expect(props.onAgentExpand).not.toHaveBeenCalled();
			}
		);

		it.each(['Enter', ' '])(
			'activates Grok with %j without enabling a disabled model capability',
			(key) => {
				const props = createDefaultProps({
					visibleAgents: [
						createAgent({
							id: 'grok',
							name: 'Grok CLI',
							capabilities: { ...getAgentCapabilities('grok'), supportsModelSelection: false },
						}),
					],
					onLoadDynamicOptionsForAgent: vi.fn(),
				});
				render(<AgentPickerGrid {...props} />);
				const row = screen.getByRole('option', { name: /Grok CLI/ });
				row.focus();
				expect(row).toHaveFocus();
				fireEvent.keyDown(row, { key });
				expect(props.onAgentSelect).toHaveBeenCalledExactlyOnceWith('grok');
				expect(props.onAgentExpand).toHaveBeenCalledExactlyOnceWith('grok');
				expect(props.onTransferPendingSshConfig).toHaveBeenCalledExactlyOnceWith('grok');
				expect(props.onLoadDynamicOptionsForAgent).toHaveBeenCalledExactlyOnceWith('grok');
				expect(props.onLoadModelsForAgent).not.toHaveBeenCalled();
				fireEvent.keyDown(within(row).getByRole('button', { name: 'Refresh detection' }), { key });
				expect(props.onAgentSelect).toHaveBeenCalledTimes(1);
			}
		);

		it('restores the opener focus when the Grok picker modal closes', async () => {
			const props = createDefaultProps({
				visibleAgents: [createAgent({ id: 'grok', name: 'Grok CLI' })],
			});
			const onClose = vi.fn();
			const { rerender } = render(
				<LayerStackProvider>
					<button>New agent</button>
				</LayerStackProvider>
			);
			const opener = screen.getByRole('button', { name: 'New agent' });
			opener.focus();
			rerender(
				<LayerStackProvider>
					<button>New agent</button>
					<Modal
						theme={props.theme}
						title="Create New Agent"
						priority={MODAL_PRIORITIES.NEW_INSTANCE}
						onClose={onClose}
					>
						<AgentPickerGrid {...props} />
					</Modal>
				</LayerStackProvider>
			);
			await waitFor(() =>
				expect(screen.getByRole('dialog', { name: 'Create New Agent' })).toHaveFocus()
			);
			const row = screen.getByRole('option', { name: /Grok CLI/ });
			row.focus();
			fireEvent.keyDown(row, { key: 'Escape' });
			expect(onClose).toHaveBeenCalledOnce();
			rerender(
				<LayerStackProvider>
					<button>New agent</button>
				</LayerStackProvider>
			);
			await waitFor(() => expect(opener).toHaveFocus());
		});
	});
});
