/**
 * Tests for LocalModelsGatewaySection - the table of agents and the gateway
 * each one's provider traffic goes through. Also the Maestro token proxy on
 * the same surface: the per-agent mode control, the totals, and the list of
 * recent compressions with its diff.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session, Theme } from '../../../../../renderer/types';
import { LocalModelsGatewaySection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsGatewaySection';
import { tokenProxyModeBlocker } from '../../../../../renderer/components/shared/TokenProxyModeField';
import { describeProxyListener } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsProxyUsage';
import {
	describeAddedLatency,
	describeTokensSaved,
	type StoredTokenProxyMode,
	type TokenProxyReport,
} from '../../../../../shared/local-models/token-proxy';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

const theme = {
	colors: {
		accent: '#a78bfa',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		error: '#ff0000',
		warning: '#ffaa00',
	},
} as unknown as Theme;

function agent(overrides: Partial<Session>): Session {
	return { id: 'a', name: 'Agent', toolType: 'claude-code', aiTabs: [], ...overrides } as Session;
}

function seed(...sessions: Session[]) {
	useSessionStore.setState({ sessions });
}

function row(agentId: string): HTMLElement {
	const found = screen
		.getAllByTestId('local-models-gateway-row')
		.find((el) => el.getAttribute('data-agent-id') === agentId);
	if (!found) throw new Error(`no row for ${agentId}`);
	return found;
}

const PROXY_PORT = 48123;
const proxyUrl = (path: string) => `http://127.0.0.1:${PROXY_PORT}${path}`;
const blockHash = 'a'.repeat(64);

function proxyReport(overrides: Partial<TokenProxyReport> = {}): TokenProxyReport {
	return {
		status: { port: null, running: false, agentIds: [], lastError: null, gatewayUrls: null },
		agents: [],
		usage: null,
		recentCompressions: [],
		...overrides,
	};
}

/** A proxy that has a port and is listening for these agents. */
function runningProxy(agentIds: string[], extra: Partial<TokenProxyReport> = {}): TokenProxyReport {
	return proxyReport({
		status: { port: PROXY_PORT, running: true, agentIds, lastError: null, gatewayUrls: null },
		...extra,
	});
}

function modeSelect(agentId: string): HTMLSelectElement {
	return screen.getByTestId(`gateway-proxy-mode-${agentId}`) as HTMLSelectElement;
}

beforeEach(() => {
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	const proxy = window.maestro.localModels.proxy;
	vi.mocked(proxy.report).mockReset();
	vi.mocked(proxy.report).mockResolvedValue(proxyReport());
	vi.mocked(proxy.ensurePort).mockReset();
	vi.mocked(proxy.ensurePort).mockResolvedValue(PROXY_PORT);
	vi.mocked(proxy.block).mockReset();
	vi.mocked(proxy.block).mockResolvedValue(null);
	useSettingsStore.setState({ shellEnvVars: {} });
});

describe('LocalModelsGatewaySection', () => {
	it.each<StoredTokenProxyMode>(['passthrough', 'compress', 'compress-early'])(
		'applies %s to all eligible agents, skipping SSH, unsupported providers, and terminals',
		async (mode) => {
			seed(
				agent({ id: 'a', name: 'Alpha' }),
				agent({ id: 'b', name: 'Beta', gatewayUrl: 'https://old.example.com' }),
				agent({
					id: 'r',
					name: 'Remote',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
				}),
				agent({ id: 'c', name: 'Copilot', toolType: 'copilot-cli' }),
				agent({ id: 't', name: 'Shell', toolType: 'terminal' })
			);
			render(<LocalModelsGatewaySection theme={theme} />);
			await waitFor(() => expect(window.maestro.localModels.proxy.report).toHaveBeenCalled());
			vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(
				runningProxy(['a', 'b'])
			);

			fireEvent.click(screen.getByTestId(`gateway-proxy-all-${mode}`));

			await waitFor(() =>
				expect(screen.getByRole('status')).toHaveTextContent('to 2 agents. Skipped 2')
			);
			const sessions = useSessionStore.getState().sessions;
			for (const id of ['a', 'b']) {
				expect(sessions.find((s) => s.id === id)).toMatchObject({
					gatewayUrl: proxyUrl('/anthropic'),
					tokenProxyMode: mode,
				});
				await waitFor(() => expect(modeSelect(id)).toHaveValue(mode));
			}
			for (const id of ['r', 'c', 't']) {
				expect(sessions.find((s) => s.id === id)?.gatewayUrl).toBeUndefined();
			}
			expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(2);
			expect(window.maestro.localModels.proxy.report).toHaveBeenCalledTimes(2);
		}
	);

	it('turns all proxy agents off while preserving external gateways', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(runningProxy(['a', 'b']));
		seed(
			agent({ id: 'a', gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' }),
			agent({ id: 'b', gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress-early' }),
			agent({ id: 'e', gatewayUrl: 'https://external.example.com' })
		);
		render(<LocalModelsGatewaySection theme={theme} />);

		fireEvent.click(screen.getByTestId('gateway-proxy-all-off'));

		await waitFor(() =>
			expect(screen.getByRole('status')).toHaveTextContent('Applied Off to 3 agents.')
		);
		const sessions = useSessionStore.getState().sessions;
		for (const id of ['a', 'b']) {
			expect(sessions.find((s) => s.id === id)?.gatewayUrl).toBeUndefined();
			expect(sessions.find((s) => s.id === id)?.tokenProxyMode).toBeUndefined();
		}
		expect(sessions.find((s) => s.id === 'e')?.gatewayUrl).toBe('https://external.example.com');
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(2);
	});

	it('reports a failed agent, continues with the rest, and unlocks the controls', async () => {
		vi.mocked(window.maestro.localModels.proxy.ensurePort).mockRejectedValueOnce(
			new Error('Port unavailable')
		);
		seed(agent({ id: 'a', name: 'Alpha' }), agent({ id: 'b', name: 'Beta' }));
		render(<LocalModelsGatewaySection theme={theme} />);

		fireEvent.click(screen.getByTestId('gateway-proxy-all-compress'));
		expect(screen.getByTestId('gateway-proxy-all-off')).toBeDisabled();
		expect(modeSelect('a')).toBeDisabled();
		expect(within(row('a')).getByRole('textbox')).toBeDisabled();

		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Alpha: Port unavailable')
		);
		expect(screen.getByRole('status')).toHaveTextContent('to 1 agent.');
		expect(
			useSessionStore.getState().sessions.find((s) => s.id === 'a')?.gatewayUrl
		).toBeUndefined();
		expect(useSessionStore.getState().sessions.find((s) => s.id === 'b')?.tokenProxyMode).toBe(
			'compress'
		);
		expect(screen.getByTestId('gateway-proxy-all-off')).toBeEnabled();
		expect(modeSelect('a')).toBeEnabled();
	});

	it('disables bulk enabling when no agents can use the local proxy', () => {
		seed(agent({ id: 'c', toolType: 'copilot-cli' }));
		render(<LocalModelsGatewaySection theme={theme} />);

		for (const mode of ['passthrough', 'compress', 'compress-early']) {
			expect(screen.getByTestId(`gateway-proxy-all-${mode}`)).toBeDisabled();
		}
		expect(screen.getByTestId('gateway-proxy-all-off')).toBeEnabled();
	});

	it('lists every agent by name with its gateway, and leaves terminals out', () => {
		seed(
			agent({ id: 'z', name: 'Zed', toolType: 'codex', gatewayUrl: 'http://localhost:4000' }),
			agent({ id: 'a', name: 'Alpha' }),
			agent({ id: 't', name: 'Shell', toolType: 'terminal' })
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		const rows = screen.getAllByTestId('local-models-gateway-row');
		expect(rows.map((el) => el.getAttribute('data-agent-id'))).toEqual(['a', 'z']);
		expect(within(row('z')).getByRole('textbox')).toHaveValue('http://localhost:4000');
		expect(within(row('z')).getByText('Codex')).toBeInTheDocument();
	});

	it('says there are no agents when there are none', () => {
		seed();

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(screen.getByTestId('local-models-gateway-empty')).toBeInTheDocument();
	});

	it("notes the user's responsibility for subscription terms", () => {
		seed();

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(screen.getByText(/you are responsible for your\s+provider's terms/)).toBeInTheDocument();
	});

	it('saves a gateway on commit, normalized, and flushes it to main', async () => {
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);
		const input = within(row('a')).getByRole('textbox');

		fireEvent.change(input, { target: { value: 'http://127.0.0.1:8787/anthropic/' } });
		await act(async () => {
			fireEvent.keyDown(input, { key: 'Enter' });
		});

		await waitFor(() =>
			expect(useSessionStore.getState().sessions[0].gatewayUrl).toBe(
				'http://127.0.0.1:8787/anthropic'
			)
		);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
		expect(within(row('a')).getByRole('textbox')).toHaveValue('http://127.0.0.1:8787/anthropic');
	});

	it('shows why a value was refused and stores nothing', async () => {
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);
		const input = within(row('a')).getByRole('textbox');

		fireEvent.change(input, { target: { value: 'nope' } });
		await act(async () => {
			fireEvent.blur(input);
		});

		await waitFor(() =>
			expect(within(row('a')).getByTestId('gateway-url-a-status')).toHaveTextContent('not a URL')
		);
		expect(useSessionStore.getState().sessions[0].gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('disables the field for Copilot CLI with the reason', () => {
		seed(agent({ id: 'c', name: 'Copilot', toolType: 'copilot-cli' }));

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(within(row('c')).getByRole('textbox')).toBeDisabled();
		expect(within(row('c')).getByTestId('gateway-url-c-status')).toHaveTextContent(
			'ignores base-URL variables'
		);
	});

	it('warns that a loopback gateway cannot be reached from an SSH remote', () => {
		seed(
			agent({
				id: 'r',
				name: 'Remote',
				gatewayUrl: 'http://127.0.0.1:8787',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
			} as Partial<Session>)
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(within(row('r')).getByTestId('gateway-url-r-status')).toHaveTextContent(
			'SSH remote "box" cannot reach'
		);
	});

	it('shows the effective environment with the gateway as the source', () => {
		seed(agent({ id: 'a', name: 'Alpha', gatewayUrl: 'http://127.0.0.1:8787' }));
		render(<LocalModelsGatewaySection theme={theme} />);

		fireEvent.click(screen.getByTestId('gateway-env-toggle-a'));

		const envRow = within(screen.getByTestId('gateway-env-a')).getByTestId('gateway-env-a-row');
		expect(envRow).toHaveAttribute('data-env-key', 'ANTHROPIC_BASE_URL');
		expect(envRow).toHaveTextContent('http://127.0.0.1:8787');
		expect(envRow).toHaveTextContent('Local Models gateway');
	});

	it("badges the agent's own variable when it beats the gateway", () => {
		seed(
			agent({
				id: 'a',
				name: 'Alpha',
				gatewayUrl: 'http://127.0.0.1:8787',
				customEnvVars: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
			})
		);
		render(<LocalModelsGatewaySection theme={theme} />);

		fireEvent.click(screen.getByTestId('gateway-env-toggle-a'));

		const envRow = within(screen.getByTestId('gateway-env-a')).getByTestId('gateway-env-a-row');
		expect(envRow).toHaveTextContent('https://mine.example.com');
		expect(envRow).toHaveTextContent('This agent');
		expect(within(row('a')).getByTestId('gateway-url-a-status')).toHaveTextContent('Not applied');
	});

	it('offers no environment view for an agent with no gateway', () => {
		seed(agent({ id: 'a', name: 'Alpha' }));

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(screen.queryByTestId('gateway-env-toggle-a')).toBeNull();
	});
});

describe('the Maestro proxy mode', () => {
	it('shows Off for an agent whose gateway is not the proxy', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(runningProxy([]));
		seed(
			agent({ id: 'a', name: 'Alpha' }),
			agent({ id: 'b', name: 'Beta', gatewayUrl: 'http://127.0.0.1:8787' })
		);

		render(<LocalModelsGatewaySection theme={theme} />);
		await screen.findByText(/Listening on/);

		expect(modeSelect('a')).toHaveValue('off');
		expect(modeSelect('b')).toHaveValue('off');
	});

	it('shows Passthrough by default and Compress when stored, for a gateway on the proxy', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(runningProxy(['a', 'b']));
		seed(
			agent({ id: 'a', name: 'Alpha', gatewayUrl: proxyUrl('/anthropic') }),
			agent({
				id: 'b',
				name: 'Beta',
				gatewayUrl: proxyUrl('/anthropic'),
				tokenProxyMode: 'compress',
			})
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		await waitFor(() => expect(modeSelect('a')).toHaveValue('passthrough'));
		expect(modeSelect('b')).toHaveValue('compress');
	});

	it('offers Compress early, and says under the picker what each mode costs', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(runningProxy(['a', 'b']));
		seed(
			agent({
				id: 'a',
				name: 'Alpha',
				gatewayUrl: proxyUrl('/anthropic'),
				tokenProxyMode: 'compress',
			}),
			agent({
				id: 'b',
				name: 'Beta',
				gatewayUrl: proxyUrl('/anthropic'),
				tokenProxyMode: 'compress-early',
			}),
			agent({ id: 'c', name: 'Gamma' })
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		await waitFor(() => expect(modeSelect('b')).toHaveValue('compress-early'));
		expect(Array.from(modeSelect('a').options).map((option) => option.textContent)).toContain(
			'Compress early'
		);
		// The two modes differ in what the model sees; the note is where that is said.
		expect(screen.getByTestId('gateway-proxy-mode-a-note')).toHaveTextContent(
			/after the model has read it once/
		);
		expect(screen.getByTestId('gateway-proxy-mode-b-note')).toHaveTextContent(
			/before the model first reads it/
		);
		// An agent that is not on the proxy has nothing to explain.
		expect(screen.queryByTestId('gateway-proxy-mode-c-note')).not.toBeInTheDocument();
	});

	it('choosing Compress points the agent at the proxy, stores the mode, and re-reads the report', async () => {
		const proxy = window.maestro.localModels.proxy;
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);
		await waitFor(() => expect(proxy.report).toHaveBeenCalledTimes(1));
		vi.mocked(proxy.report).mockResolvedValue(runningProxy(['a']));

		await act(async () => {
			fireEvent.change(modeSelect('a'), { target: { value: 'compress' } });
		});

		await waitFor(() =>
			expect(useSessionStore.getState().sessions[0]).toMatchObject({
				gatewayUrl: proxyUrl('/anthropic'),
				tokenProxyMode: 'compress',
			})
		);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
		// The URL field follows the mode, and the control settles on it once the
		// report names the port.
		await waitFor(() => expect(modeSelect('a')).toHaveValue('compress'));
		expect(within(row('a')).getByRole('textbox')).toHaveValue(proxyUrl('/anthropic'));
		expect(screen.getByTestId('token-proxy-listener')).toHaveTextContent(
			`Listening on 127.0.0.1:${PROXY_PORT} for 1 agent.`
		);
	});

	it('choosing Off clears a gateway that is the proxy', async () => {
		const proxy = window.maestro.localModels.proxy;
		vi.mocked(proxy.report).mockResolvedValue(runningProxy(['a']));
		seed(
			agent({
				id: 'a',
				name: 'Alpha',
				gatewayUrl: proxyUrl('/anthropic'),
				tokenProxyMode: 'compress',
			})
		);
		render(<LocalModelsGatewaySection theme={theme} />);
		await waitFor(() => expect(modeSelect('a')).toHaveValue('compress'));

		await act(async () => {
			fireEvent.change(modeSelect('a'), { target: { value: 'off' } });
		});

		await waitFor(() => expect(useSessionStore.getState().sessions[0].gatewayUrl).toBeUndefined());
		expect(useSessionStore.getState().sessions[0].tokenProxyMode).toBeUndefined();
		expect(modeSelect('a')).toHaveValue('off');
	});

	it('disables the control, with the reason, where the proxy cannot be used', async () => {
		seed(
			agent({ id: 'c', name: 'Copilot', toolType: 'copilot-cli' }),
			agent({
				id: 's',
				name: 'Remote',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			} as Partial<Session>)
		);

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(modeSelect('c')).toBeDisabled();
		expect(modeSelect('c').title).toContain('Copilot CLI ignores base-URL variables');
		expect(modeSelect('s')).toBeDisabled();
		expect(modeSelect('s').title).toContain('SSH remote');
	});

	it('shows why a mode could not be set', async () => {
		vi.mocked(window.maestro.localModels.proxy.ensurePort).mockRejectedValue(
			new Error('no free port')
		);
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);

		await act(async () => {
			fireEvent.change(modeSelect('a'), { target: { value: 'passthrough' } });
		});

		expect(await screen.findByTestId('gateway-proxy-mode-a-error')).toHaveTextContent(
			'no free port'
		);
		expect(useSessionStore.getState().sessions[0].gatewayUrl).toBeUndefined();
	});

	it('names the two refusals the service makes', () => {
		expect(tokenProxyModeBlocker('claude-code', undefined)).toBeUndefined();
		expect(tokenProxyModeBlocker('copilot-cli', undefined)).toContain('Copilot CLI');
		expect(tokenProxyModeBlocker('claude-code', 'Dev Box')).toContain('SSH remote "Dev Box"');
	});
});

describe('the Maestro proxy usage', () => {
	const totals = {
		requests: 12,
		compressRequests: 5,
		originalTokens: 40_000,
		sentTokens: 30_000,
		tokensSaved: 10_000,
		avgAddedLatencyMs: 14,
	};
	const entry = {
		hash: blockHash,
		originalTokens: 2_400,
		compressedTokens: 300,
		compressors: ['logs'],
		agentId: 'a',
		at: Date.now() - 60_000,
	};

	it('says the proxy is not set up until an agent uses it', async () => {
		seed(agent({ id: 'a', name: 'Alpha' }));

		render(<LocalModelsGatewaySection theme={theme} />);

		expect(await screen.findByText(/Not set up\./)).toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-usage-table')).not.toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-recent')).not.toBeInTheDocument();
	});

	it('shows tokens saved and average added latency, in total and per agent', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(
			runningProxy(['a'], {
				usage: {
					range: 'month',
					totals,
					byAgent: [
						{ agentId: 'a', ...totals, requests: 9 },
						{
							agentId: null,
							requests: 3,
							compressRequests: 0,
							originalTokens: 0,
							sentTokens: 0,
							tokensSaved: 0,
							avgAddedLatencyMs: 0,
						},
					],
				},
			})
		);
		seed(agent({ id: 'a', name: 'Alpha', gatewayUrl: proxyUrl('/anthropic') }));

		render(<LocalModelsGatewaySection theme={theme} />);

		const total = await screen.findByTestId('token-proxy-usage-total');
		// A saving is an estimate, and the card says which way it is off.
		expect(screen.getByText('Tokens saved (est.)')).toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-estimate-note')).toHaveTextContent(
			'Token counts are estimates at 4 characters per token.'
		);
		expect(total).toHaveTextContent('All agents');
		expect(total).toHaveTextContent('12');
		expect(total).toHaveTextContent('10,000 (25%)');
		expect(total).toHaveTextContent('14 ms');
		const perAgent = screen.getAllByTestId('token-proxy-usage-agent');
		expect(perAgent[0]).toHaveTextContent('Alpha');
		// A request with no agent was only counted: it has no tokens to report.
		expect(perAgent[1]).toHaveTextContent('No agent (started outside the app)');
		expect(within(perAgent[1]).getAllByText('-')).toHaveLength(2);
	});

	it('opens a diff of original against compressed for a recent block', async () => {
		const proxy = window.maestro.localModels.proxy;
		vi.mocked(proxy.report).mockResolvedValue(runningProxy(['a'], { recentCompressions: [entry] }));
		vi.mocked(proxy.block).mockResolvedValue({
			hash: blockHash,
			original: 'line one\nline two\nline two\nline two\n',
			compressed: 'line one\nline two\n[maestro: 2 more identical lines]\n',
			originalTokens: 2_400,
			compressedTokens: 300,
			compressors: ['logs'],
			createdAt: entry.at,
		});
		seed(agent({ id: 'a', name: 'Alpha', gatewayUrl: proxyUrl('/anthropic') }));
		render(<LocalModelsGatewaySection theme={theme} />);

		const item = await screen.findByTestId('token-proxy-compression');
		expect(item).toHaveTextContent('2,400 to 300 tokens');
		expect(item).toHaveTextContent('Alpha');
		expect(screen.queryByTestId('token-proxy-compression-diff')).not.toBeInTheDocument();

		const toggle = screen.getByTestId(`token-proxy-compression-toggle-${blockHash}`);
		await act(async () => {
			fireEvent.click(toggle);
		});

		expect(proxy.block).toHaveBeenCalledWith(blockHash);
		const diff = await screen.findByTestId('token-proxy-compression-diff');
		expect(diff).toHaveTextContent('[maestro: 2 more identical lines]');
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		await act(async () => {
			fireEvent.click(toggle);
		});
		expect(screen.queryByTestId('token-proxy-compression-diff')).not.toBeInTheDocument();
	});

	it('says so when the cache no longer holds a block or its original', async () => {
		const proxy = window.maestro.localModels.proxy;
		vi.mocked(proxy.report).mockResolvedValue(runningProxy(['a'], { recentCompressions: [entry] }));
		seed(agent({ id: 'a', name: 'Alpha', gatewayUrl: proxyUrl('/anthropic') }));
		render(<LocalModelsGatewaySection theme={theme} />);
		const toggle = await screen.findByTestId(`token-proxy-compression-toggle-${blockHash}`);

		await act(async () => {
			fireEvent.click(toggle);
		});
		expect(await screen.findByTestId('token-proxy-compression-missing')).toBeInTheDocument();

		await act(async () => {
			fireEvent.click(toggle);
		});
		vi.mocked(proxy.block).mockResolvedValue({
			hash: blockHash,
			original: null,
			compressed: 'short',
			originalTokens: 2_400,
			compressedTokens: 300,
			compressors: ['logs'],
			createdAt: entry.at,
		});
		await act(async () => {
			fireEvent.click(toggle);
		});
		expect(await screen.findByTestId('token-proxy-compression-no-original')).toBeInTheDocument();
	});

	it('re-reads the report on Refresh, and shows a read that failed', async () => {
		const proxy = window.maestro.localModels.proxy;
		seed(agent({ id: 'a', name: 'Alpha' }));
		render(<LocalModelsGatewaySection theme={theme} />);
		await screen.findByText(/Not set up\./);
		vi.mocked(proxy.report).mockRejectedValue(new Error('bridge closed'));

		await act(async () => {
			fireEvent.click(screen.getByTestId('token-proxy-refresh'));
		});

		expect(await screen.findByTestId('token-proxy-error')).toHaveTextContent('bridge closed');
		expect(proxy.report).toHaveBeenCalledTimes(2);
	});

	it('describes the listener in each of its states', () => {
		expect(describeProxyListener(proxyReport())).toContain('Not set up');
		expect(describeProxyListener(runningProxy(['a', 'b']))).toBe(
			`Listening on 127.0.0.1:${PROXY_PORT} for 2 agents.`
		);
		const stopped = proxyReport({
			status: {
				port: PROXY_PORT,
				running: false,
				agentIds: [],
				lastError: null,
				gatewayUrls: null,
			},
		});
		expect(describeProxyListener(stopped)).toContain('Stopped');
		expect(
			describeProxyListener({
				...stopped,
				status: { ...stopped.status, lastError: 'another program is using the port' },
			})
		).toContain('Could not start on 127.0.0.1:48123: another program is using the port');
	});

	it('shows a dash, not a zero, where no request was read', () => {
		const unread = { ...totals, compressRequests: 0, tokensSaved: 0, avgAddedLatencyMs: 0 };
		expect(describeTokensSaved(unread)).toBe('-');
		expect(describeAddedLatency(unread)).toBe('-');
		expect(describeTokensSaved(totals)).toBe('10,000 (25%)');
		expect(describeAddedLatency(totals)).toBe('14 ms');
	});
});
