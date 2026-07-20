/**
 * Dispatch allow-list editor: cross-plugin stale-grant guard (issue #1250).
 *
 * The editor reads the selected plugin's agents:dispatch grant. Grants load
 * asynchronously, so switching from plugin A to plugin B must NEVER render A's
 * grant under B's id - not even for a single transient render before B's own
 * grant loads - otherwise a save would target B with A's scope.
 *
 * We spy on AgentDispatchAllowlist and record every (pluginId, scope) it renders
 * with, making A and B distinguishable by scope. The guard is that the stale
 * pairing (pluginId=B, scope from A) is NEVER recorded. A `waitFor` on the DOM
 * would not catch this: the pre-guard effect-based reset cleared the grant a tick
 * later, so the transient stale render still happened but left no lasting trace.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import type { UnifiedExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { Theme } from '../../../../../renderer/types';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import type { PluginGrantsSnapshot } from '../../../../../main/ipc/handlers/plugins';

const { allowlistRenders } = vi.hoisted(() => ({
	allowlistRenders: [] as Array<{ pluginId: string; scope?: string }>,
}));

vi.mock('../../../../../renderer/components/Settings/Extensions/AgentDispatchAllowlist', () => ({
	AgentDispatchAllowlist: (props: { pluginId: string; grant: { scope?: string } }) => {
		allowlistRenders.push({ pluginId: props.pluginId, scope: props.grant.scope });
		return null;
	},
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
		onBack: vi.fn(),
		onTogglePlugin: vi.fn(),
		onToggleBuiltin: vi.fn(),
		onUninstall: vi.fn(),
		onRevoke: vi.fn(),
		getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
	};
}

afterEach(cleanup);

describe('ExtensionDetails dispatch allow-list - cross-plugin stale-grant guard', () => {
	it('never renders the previous plugin grant under the new plugin id', async () => {
		allowlistRenders.length = 0;
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

		// A's editor renders with A's scope once its grant loads.
		await waitFor(() =>
			expect(allowlistRenders.some((r) => r.pluginId === 'plugin-a' && r.scope === 'agent-A')).toBe(
				true
			)
		);

		// Switch to B while B's grant load is still pending.
		rerender(
			<ExtensionDetails {...baseProps()} ext={pluginTile('plugin-b')} getGrants={getGrants} />
		);

		// The stale pairing (B's id + A's scope) must NEVER be rendered.
		expect(allowlistRenders.some((r) => r.pluginId === 'plugin-b' && r.scope === 'agent-A')).toBe(
			false
		);

		// Once B's own grant resolves, the editor renders with B's scope.
		await act(async () => {
			resolveB(snapshotFor('agent-B'));
		});
		await waitFor(() =>
			expect(allowlistRenders.some((r) => r.pluginId === 'plugin-b' && r.scope === 'agent-B')).toBe(
				true
			)
		);
		// Still never the stale pairing.
		expect(allowlistRenders.some((r) => r.pluginId === 'plugin-b' && r.scope === 'agent-A')).toBe(
			false
		);
	});
});
