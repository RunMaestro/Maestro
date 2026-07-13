import type { PluginRecord } from '../../shared/plugins/plugin-registry';
import type { ClosedPanelBridge } from '../../shared/plugins/interactive-panel';
import type { WorkspaceProjection } from './plugin-workspace-registry';
import type { InteractivePanelDescriptor } from './plugin-interactive-panel-host';

function keyFor(ownerPluginId: string, panelLocalId: string): string {
	return `${ownerPluginId}\u0000${panelLocalId}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDescriptor(value: unknown): value is ClosedPanelBridge {
	if (!isRecord(value) || !Object.isFrozen(value)) return false;
	return (
		isRecord(value.requestSchemas) &&
		isRecord(value.eventSchemas) &&
		isRecord(value.resultSchemas) &&
		isRecord(value.errorSchemas)
	);
}

/**
 * Main-process-only lookup for immutable panel bridges declared in validated,
 * trusted plugin manifests. There is deliberately no plugin or renderer mutation API.
 */
export class PluginPanelDescriptorRegistry {
	private descriptors = new Map<string, InteractivePanelDescriptor>();

	sync(records: readonly PluginRecord[]): void {
		const next = new Map<string, InteractivePanelDescriptor>();
		for (const record of records) {
			if (
				record.loadStatus !== 'ok' ||
				!record.enabled ||
				record.signature?.status !== 'trusted' ||
				!record.manifest?.workspaceFoundation
			)
				continue;
			const foundation = record.manifest.workspaceFoundation;
			const panel = foundation.panel;
			if (foundation.ownerPluginId !== record.id || !isDescriptor(panel.bridge)) {
				throw new TypeError('InvalidPluginPanelDescriptor');
			}
			const key = keyFor(record.id, panel.localId);
			if (next.has(key)) throw new Error('DuplicatePluginPanelDescriptor');
			next.set(key, panel.bridge);
		}
		this.descriptors = next;
	}

	remove(ownerPluginId: string): void {
		for (const key of this.descriptors.keys()) {
			if (key.startsWith(`${ownerPluginId}\u0000`)) this.descriptors.delete(key);
		}
	}

	get(projection: WorkspaceProjection): InteractivePanelDescriptor | null {
		return this.descriptors.get(keyFor(projection.ownerPluginId, projection.panel.localId)) ?? null;
	}
}
