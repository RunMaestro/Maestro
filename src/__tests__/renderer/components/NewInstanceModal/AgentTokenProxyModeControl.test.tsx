/**
 * Tests for Edit Agent's Retrieval switch, under the Maestro token proxy mode
 * on the Models tab: it is drawn only for a compressing mode, it applies at
 * once and flushes to main, and a refusal is shown under it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AgentTokenProxyModeControl } from '../../../../renderer/components/NewInstanceModal/AgentTokenProxyModeControl';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session, Theme } from '../../../../renderer/types';
import { TOKEN_PROXY_RETRIEVAL_DESCRIPTIONS } from '../../../../shared/local-models/token-proxy';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#a78bfa33',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const PORT = 48123;
const ON_PROXY = `http://127.0.0.1:${PORT}/anthropic`;
const proxy = () => window.maestro.localModels.proxy;
const toggle = () =>
	screen.getByRole('switch', { name: 'Let the model of Backend retrieve compressed originals' });
const stored = (): Session => useSessionStore.getState().sessions[0];

function seed(overrides: Partial<Session> = {}): void {
	useSessionStore.setState({
		sessions: [
			{ id: 'agent-1', name: 'Backend', toolType: 'claude-code', aiTabs: [], ...overrides },
		],
	} as never);
}

/** The control as Edit Agent mounts it: the stored values come from the live store entry. */
function Mounted() {
	const session = useSessionStore((s) => s.sessions[0]);
	// The store is emptied after each test while the tree is still mounted.
	if (!session) return null;
	return (
		<AgentTokenProxyModeControl
			theme={theme}
			agentId="agent-1"
			agentName="Backend"
			toolType="claude-code"
			gatewayUrl={session.gatewayUrl ?? ''}
			storedMode={session.tokenProxyMode}
			storedRetrieval={session.tokenProxyRetrieval}
			onGatewayUrlChange={() => {}}
		/>
	);
}

beforeEach(() => {
	vi.mocked(proxy().report)
		.mockReset()
		.mockResolvedValue({
			status: { port: PORT, running: true, agentIds: [], lastError: null, gatewayUrls: null },
			agents: [],
			usage: null,
			recentCompressions: [],
		} as never);
	vi.mocked(window.maestro.sessions.setMany)
		.mockReset()
		.mockResolvedValue(undefined as never);
});

afterEach(() => {
	useSessionStore.setState({ sessions: [] } as never);
});

describe('AgentTokenProxyModeControl - Retrieval', () => {
	it.each(['compress', 'compress-early'] as const)('is offered in %s mode', async (mode) => {
		seed({ gatewayUrl: ON_PROXY, tokenProxyMode: mode });
		render(<Mounted />);

		expect(await screen.findByTestId('edit-agent-proxy-retrieval')).toBeInTheDocument();
		expect(toggle()).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByText(TOKEN_PROXY_RETRIEVAL_DESCRIPTIONS.off, { exact: false })).toBeTruthy();
	});

	it.each([
		['passthrough', { gatewayUrl: ON_PROXY, tokenProxyMode: 'passthrough' as const }],
		['off', {}],
	])('is not offered in %s mode', async (_mode, record) => {
		seed(record);
		render(<Mounted />);

		await waitFor(() => expect(proxy().report).toHaveBeenCalled());
		expect(screen.queryByTestId('edit-agent-proxy-retrieval')).toBeNull();
	});

	it('turns it on at once and flushes it to main', async () => {
		seed({ gatewayUrl: ON_PROXY, tokenProxyMode: 'compress-early' });
		render(<Mounted />);

		fireEvent.click(await screen.findByRole('switch', { name: /retrieve compressed originals/ }));

		await waitFor(() => expect(stored().tokenProxyRetrieval).toBe(true));
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', tokenProxyRetrieval: true })],
			[]
		);
		await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
		expect(screen.getByText(TOKEN_PROXY_RETRIEVAL_DESCRIPTIONS.on, { exact: false })).toBeTruthy();
	});

	it('turns it off, which removes the field', async () => {
		seed({ gatewayUrl: ON_PROXY, tokenProxyMode: 'compress', tokenProxyRetrieval: true });
		render(<Mounted />);

		fireEvent.click(await screen.findByRole('switch', { name: /retrieve compressed originals/ }));

		await waitFor(() => expect(stored().tokenProxyRetrieval).toBeUndefined());
	});

	it('shows a refusal under the switch and stores nothing', async () => {
		seed({ gatewayUrl: ON_PROXY, tokenProxyMode: 'compress' });
		render(<Mounted />);
		const sw = await screen.findByRole('switch', { name: /retrieve compressed originals/ });
		// The proxy lost its port between the render and the click: the agent is
		// no longer on it, so on is refused.
		vi.mocked(proxy().report).mockResolvedValue({
			status: { port: null, running: false, agentIds: [], lastError: null, gatewayUrls: null },
			agents: [],
			usage: null,
			recentCompressions: [],
		} as never);

		fireEvent.click(sw);

		expect(await screen.findByTestId('edit-agent-proxy-retrieval-error')).toHaveTextContent(
			'compress or compress-early'
		);
		expect(stored().tokenProxyRetrieval).toBeUndefined();
	});
});
