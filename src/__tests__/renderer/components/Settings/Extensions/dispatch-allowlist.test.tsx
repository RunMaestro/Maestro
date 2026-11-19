// Source: src/__tests__/renderer/components/Settings/Extensions/AgentDispatchAllowlist.search.test.tsx
// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionDetails.dispatchAllowlist.test.tsx
import { cleanup } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import React from 'react';
import { AgentDispatchAllowlist } from '../../../../../renderer/components/Settings/Extensions/AgentDispatchAllowlist';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../../renderer/types';
import type { Theme } from '../../../../../renderer/types';
import { act } from '@testing-library/react';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import type { UnifiedExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import type { PluginGrantsSnapshot } from '../../../../../main/ipc/handlers/plugins';
import * as allowlist from '../../../../../renderer/components/Settings/Extensions/AgentDispatchAllowlist';
describe('AgentDispatchAllowlist.search', () => {
	const theme = {
		colors: {
			textMain: '#eee',
			textDim: '#999',
			bgMain: '#111',
			accent: '#4af',
			border: '#333',
			warning: '#fa0',
		},
	} as unknown as Theme;
	const agents = [
		{ id: 'agent-alpha', name: 'Alpha Worker' },
		{ id: 'agent-beta', name: 'Beta Worker' },
		{ id: 'agent-gamma', name: 'Gamma Worker' },
	] as Session[];

	beforeEach(() => {
		useSessionStore.setState({ sessions: agents });
		vi.mocked(window.maestro.plugins.setAgentAllowlist).mockReset().mockResolvedValue({
			requested: [],
			granted: [],
		});
	});
	afterEach(cleanup);

	function editor(pluginId = 'plugin-a') {
		return (
			<AgentDispatchAllowlist
				theme={theme}
				pluginId={pluginId}
				grant={{
					capability: 'agents:dispatch',
					scope: 'agent-alpha,agent-beta,deleted-agent',
					grantedAt: 1,
				}}
				onSaved={vi.fn()}
			/>
		);
	}

	describe('AgentDispatchAllowlist search', () => {
		it('matches trimmed case-insensitive names and IDs, shows empty state, and clears', () => {
			render(editor());
			const search = screen.getByRole('textbox', { name: 'Search agents' });
			fireEvent.change(search, { target: { value: '  ALPHA  ' } });
			expect(screen.getAllByTestId('agent-dispatch-allowlist-row')).toHaveLength(1);
			expect(screen.getByText('Alpha Worker')).toBeInTheDocument();
			fireEvent.change(search, { target: { value: 'AGENT-BETA' } });
			expect(screen.getByText('Beta Worker')).toBeInTheDocument();
			expect(screen.queryByText('Alpha Worker')).not.toBeInTheDocument();
			fireEvent.change(search, { target: { value: 'missing' } });
			expect(screen.getByTestId('agent-dispatch-allowlist-no-results')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
			expect(screen.getAllByTestId('agent-dispatch-allowlist-row')).toHaveLength(3);
			expect(search).toHaveValue('');
		});

		it('saves the entire checked set despite a filter, and prunes stale IDs', async () => {
			render(editor());
			fireEvent.change(screen.getByRole('textbox', { name: 'Search agents' }), {
				target: { value: 'gamma' },
			});
			fireEvent.click(screen.getByTestId('agent-dispatch-allowlist-checkbox'));
			expect(screen.getByText('3 of 3 agents allowed (2 hidden by search)')).toBeInTheDocument();
			expect(screen.getByTestId('agent-dispatch-allowlist-stale')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('agent-dispatch-allowlist-save'));
			await waitFor(() =>
				expect(window.maestro.plugins.setAgentAllowlist).toHaveBeenCalledWith('plugin-a', [
					'agent-alpha',
					'agent-beta',
					'agent-gamma',
				])
			);
		});

		it('resets search when the selected plugin changes', () => {
			const view = render(editor());
			fireEvent.change(screen.getByRole('textbox', { name: 'Search agents' }), {
				target: { value: 'alpha' },
			});
			view.rerender(editor('plugin-b'));
			expect(screen.getByRole('textbox', { name: 'Search agents' })).toHaveValue('');
			expect(screen.getAllByTestId('agent-dispatch-allowlist-row')).toHaveLength(3);
		});
	});
});
describe('ExtensionDetails.dispatchAllowlist', () => {
	const { allowlistRenders } = vi.hoisted(() => ({
		allowlistRenders: [] as Array<{ pluginId: string; scope?: string }>,
	}));

	const theme = {
		colors: {
			textMain: '#eee',
			textDim: '#999',
			bgMain: '#111',
			bgActivity: '#222',
			accent: '#4af',
			border: '#333',
			warning: '#fa0',
			error: '#f44',
			success: '#4f4',
		},
	} as unknown as Theme;

	function pluginTile(id: string): UnifiedExtension {
		return {
			key: `plugin:${id}`,
			kind: 'plugin',
			id,
			name: `Plugin ${id}`,
			description: 'A demo.',
			category: 'automation',
			state: 'enabled',
			tier: 1,
			trust: 'trusted',
			version: '1.0.0',
			loadStatus: 'ok',
			record: {
				id,
				source: `/plugins/${id}`,
				folderName: id,
				enabled: true,
				loadStatus: 'ok',
				errors: [],
			} as PluginRecord,
		} as UnifiedExtension;
	}

	function snapshotFor(scope: string): PluginGrantsSnapshot {
		return {
			requested: [{ capability: 'agents:dispatch', scope }],
			granted: [{ capability: 'agents:dispatch', scope, grantedAt: 1 }],
		};
	}

	function baseProps(): React.ComponentProps<typeof ExtensionDetails> {
		return {
			theme,
			ext: pluginTile('plugin-a'),
			contributions: null,
			busy: false,
			onTogglePlugin: vi.fn(),
			onToggleBuiltin: vi.fn(),
			onUninstall: vi.fn(),
			onRevoke: vi.fn(),
			getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
		};
	}

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	describe('ExtensionDetails dispatch allow-list - cross-plugin stale-grant guard', () => {
		it('never renders the previous plugin grant under the new plugin id', async () => {
			allowlistRenders.length = 0;
			vi.spyOn(allowlist, 'AgentDispatchAllowlist').mockImplementation((props) => {
				allowlistRenders.push({ pluginId: props.pluginId, scope: props.grant.scope });
				return null;
			});
			let resolveB: (snap: PluginGrantsSnapshot) => void = () => {};
			const bPending = new Promise<PluginGrantsSnapshot>((resolve) => {
				resolveB = resolve;
			});
			const getGrants = vi.fn(async (id: string) =>
				id === 'plugin-a' ? snapshotFor('agent-A') : bPending
			);

			const { rerender } = render(
				<ExtensionDetails {...baseProps()} ext={pluginTile('plugin-a')} getGrants={getGrants} />
			);
			// The allow-list editor lives on the Permissions tab.
			fireEvent.click(screen.getByTestId('extension-subtab-permissions'));

			// A's editor renders with A's scope once its grant loads.
			await waitFor(() =>
				expect(
					allowlistRenders.some((r) => r.pluginId === 'plugin-a' && r.scope === 'agent-A')
				).toBe(true)
			);

			// Switch to B while B's grant load is still pending.
			rerender(
				<ExtensionDetails {...baseProps()} ext={pluginTile('plugin-b')} getGrants={getGrants} />
			);
			// Switching extensions resets the tab; go back to Permissions while B's
			// grant is still pending, which is the window the guard has to close.
			fireEvent.click(screen.getByTestId('extension-subtab-permissions'));

			// The stale pairing (B's id + A's scope) must NEVER be rendered.
			expect(allowlistRenders.some((r) => r.pluginId === 'plugin-b' && r.scope === 'agent-A')).toBe(
				false
			);

			// Once B's own grant resolves, the editor renders with B's scope.
			await act(async () => {
				resolveB(snapshotFor('agent-B'));
			});
			await waitFor(() =>
				expect(
					allowlistRenders.some((r) => r.pluginId === 'plugin-b' && r.scope === 'agent-B')
				).toBe(true)
			);
			// Still never the stale pairing.
			expect(allowlistRenders.some((r) => r.pluginId === 'plugin-b' && r.scope === 'agent-A')).toBe(
				false
			);
		});
	});
});
