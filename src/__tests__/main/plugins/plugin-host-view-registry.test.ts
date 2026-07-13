import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	collectContributions,
	type HostViewContribution,
} from '../../../shared/plugins/contributions';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
import { applyMovementPayload, useMovementStore } from '../../../renderer/stores/movementStore';
import {
	PluginHostViewRegistry,
	type HostViewMutation,
} from '../../../main/plugins/plugin-host-view-registry';
import { forwardPluginHostViewToRenderer } from '../../../main/plugins/plugin-host-view-forwarder';

function tierZeroManifest(): PluginManifest {
	return {
		id: 'com.example.static-view',
		name: 'Static View',
		version: '1.0.0',
		tier: 0,
		maestro: { minHostApi: '1.0.0' },
		contributes: {
			hostViews: [
				{
					id: 'status',
					surface: 'movement',
					title: 'Static status',
					blocks: [{ kind: 'heading', text: 'Ready' }],
				},
			],
		},
	};
}

function forwardToMovement(mutation: HostViewMutation): boolean {
	if (mutation.view.surface !== 'movement') return true;
	if (mutation.kind === 'remove') {
		applyMovementPayload({ op: 'remove', id: mutation.view.id });
		return true;
	}
	applyMovementPayload({
		op: 'add',
		id: mutation.view.id,
		title: mutation.view.title,
		body: JSON.stringify(mutation.blocks),
	});
	return true;
}

beforeEach(() => {
	useMovementStore.setState({
		items: [],
		viewportWidth: 0,
		viewportHeight: 0,
		hidden: false,
		flashedId: null,
	});
});

describe('PluginHostViewRegistry', () => {
	it('renders a tier-0 static Movement host view when enabled and removes it when disabled', () => {
		const views = collectContributions(tierZeroManifest()).hostViews;
		let enabled = true;
		const registry = new PluginHostViewRegistry({
			isEnabled: () => enabled,
			getHostViews: () => (enabled ? views : []),
			isPluginRecordPresent: () => true,
			forward: forwardToMovement,
		});

		registry.sync();
		expect(useMovementStore.getState().items).toMatchObject([
			{
				id: 'com.example.static-view/status',
				title: 'Static status',
				spec: [{ kind: 'heading', text: 'Ready' }],
			},
		]);

		enabled = false;
		registry.sync();
		expect(useMovementStore.getState().items).toEqual([]);
	});

	it('replays active static views after a renderer becomes available and refreshes changed tier-0 data', () => {
		const initial = collectContributions(tierZeroManifest()).hostViews;
		let views = initial;
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => views,
			isPluginRecordPresent: () => true,
			forward,
		});

		registry.sync();
		registry.replay();
		views = [
			{
				...initial[0],
				title: 'Static status updated',
				blocks: [{ kind: 'heading', text: 'Updated' }],
			},
		];
		registry.sync();

		expect(forward).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ kind: 'upsert', view: initial[0] })
		);
		expect(forward).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kind: 'upsert', view: initial[0] })
		);
		expect(forward).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				kind: 'upsert',
				view: expect.objectContaining({ title: 'Static status updated' }),
				blocks: [{ kind: 'heading', text: 'Updated' }],
			})
		);
	});

	it('retries a static view that was discovered before the renderer existed', () => {
		const views = collectContributions(tierZeroManifest()).hostViews;
		let rendererAvailable = false;
		const forward = vi.fn(() => rendererAvailable);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => views,
			isPluginRecordPresent: () => true,
			forward,
		});

		registry.sync();
		rendererAvailable = true;
		registry.replay();

		expect(forward).toHaveBeenCalledTimes(2);
		expect(forward).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: 'upsert', view: views[0] })
		);
	});

	it('forwards only declared runtime views and purges them when the sandbox stops', () => {
		const view: HostViewContribution = {
			id: 'com.example.runtime/status',
			localId: 'status',
			pluginId: 'com.example.runtime',
			surface: 'cadenza',
			title: 'Runtime status',
		};
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => [view],
			isPluginRecordPresent: () => true,
			forward,
		});

		expect(registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }])).toBe(
			true
		);
		expect(registry.update('com.example.runtime', 'not-declared', [])).toBe(false);
		registry.purge('com.example.runtime');

		expect(forward).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ kind: 'upsert', view, blocks: [{ kind: 'text', text: 'Live' }] })
		);
		expect(forward).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kind: 'remove', view, force: true })
		);
	});

	it('removes a live runtime view when a loaded plugin replaces its declaration on sync', () => {
		const view: HostViewContribution = {
			id: 'com.example.runtime/status',
			localId: 'status',
			pluginId: 'com.example.runtime',
			surface: 'cadenza',
			title: 'Runtime status',
		};
		let views: readonly HostViewContribution[] = [view];
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => views,
			isPluginRecordPresent: () => true,
			forward,
		});

		registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
		views = [
			{
				...view,
				id: 'com.example.runtime/replacement',
				localId: 'replacement',
			},
		];
		registry.sync();
		registry.purge('com.example.runtime');

		expect(forward).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'remove', view }));
		expect(forward.mock.calls[1][0]).not.toHaveProperty('force');
		expect(forward).toHaveBeenCalledTimes(2);
	});

	it('removes a live runtime view when its loaded plugin has zero declarations', () => {
		const view: HostViewContribution = {
			id: 'com.example.runtime/status',
			localId: 'status',
			pluginId: 'com.example.runtime',
			surface: 'cadenza',
			title: 'Runtime status',
		};
		let views: readonly HostViewContribution[] = [view];
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => views,
			isPluginRecordPresent: () => true,
			forward,
		});

		registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
		views = [];
		registry.sync();

		expect(forward).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'remove', view }));
		expect(forward.mock.calls[1][0]).not.toHaveProperty('force');
	});

	it('retains a live runtime view while its plugin record is transiently unavailable', () => {
		const view: HostViewContribution = {
			id: 'com.example.runtime/status',
			localId: 'status',
			pluginId: 'com.example.runtime',
			surface: 'cadenza',
			title: 'Runtime status',
		};
		let views: readonly HostViewContribution[] = [view];
		let pluginRecordPresent = true;
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => views,
			isPluginRecordPresent: () => pluginRecordPresent,
			forward,
		});

		registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
		views = [];
		pluginRecordPresent = false;
		registry.sync();
		registry.replay();

		expect(forward).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kind: 'upsert', view, blocks: [{ kind: 'text', text: 'Live' }] })
		);
		expect(forward).toHaveBeenCalledTimes(2);
	});

	it('purges a live runtime view when the record persists in a failed load state', () => {
		// A reload that produces an `invalid`/`incompatible` record keeps the record
		// PRESENT while dropping its declarations — that is a permanent failure, not
		// a transient window, so the stale runtime view must not keep replaying.
		const view: HostViewContribution = {
			id: 'com.example.runtime/status',
			localId: 'status',
			pluginId: 'com.example.runtime',
			surface: 'movement',
			title: 'Runtime status',
		};
		let views: readonly HostViewContribution[] = [view];
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => views,
			isPluginRecordPresent: () => true,
			forward,
		});

		registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
		views = [];
		registry.sync();
		registry.replay();

		expect(forward).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'remove' }));
		expect(forward).toHaveBeenCalledTimes(2);
	});

	it('forwards a Cadenza close to both an existing HUD and the main renderer', () => {
		const view: HostViewContribution = {
			id: 'com.example.runtime/status',
			localId: 'status',
			pluginId: 'com.example.runtime',
			surface: 'cadenza',
			title: 'Runtime status',
		};
		const sendToMain = vi.fn();
		const deliverCadenzaToExistingHud = vi.fn(() => false);
		const forward = (mutation: HostViewMutation) =>
			forwardPluginHostViewToRenderer(mutation, {
				sourcePlugin: view.pluginId,
				isCadenzaEnabled: true,
				sendToMain,
				deliverCadenza: vi.fn(() => false),
				deliverCadenzaToExistingHud,
			});
		const registry = new PluginHostViewRegistry({
			isEnabled: () => true,
			getHostViews: () => [view],
			isPluginRecordPresent: () => true,
			forward,
		});

		registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
		deliverCadenzaToExistingHud.mockReturnValue(true);
		registry.purge('com.example.runtime');

		expect(deliverCadenzaToExistingHud).toHaveBeenCalledWith({ op: 'close', id: view.id });
		expect(sendToMain).toHaveBeenNthCalledWith(
			1,
			'remote:cadenza',
			expect.objectContaining({ op: 'open', id: view.id })
		);
		expect(sendToMain).toHaveBeenNthCalledWith(2, 'remote:cadenza', {
			op: 'close',
			id: view.id,
		});
	});

	it('does not forward or retain runtime updates while either feature gate is off', () => {
		const forward = vi.fn(() => true);
		const registry = new PluginHostViewRegistry({
			isEnabled: () => false,
			getHostViews: () => [
				{
					id: 'com.example.disabled/status',
					localId: 'status',
					pluginId: 'com.example.disabled',
					surface: 'movement',
					title: 'Disabled',
				},
			],
			forward,
			isPluginRecordPresent: () => true,
		});

		expect(registry.update('com.example.disabled', 'status', [])).toBe(false);
		expect(forward).not.toHaveBeenCalled();
	});
});
