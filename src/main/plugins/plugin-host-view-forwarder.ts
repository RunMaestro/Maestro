import type { CadenzaPayload } from '../../shared/cadenza-types';
import type { MovementPayload } from '../../shared/movement-types';
import type { HostViewMutation } from './plugin-host-view-registry';

export interface PluginHostViewForwardingDeps {
	sourcePlugin: string;
	isCadenzaEnabled: boolean;
	sendToMain: (
		channel: 'remote:movement' | 'remote:cadenza',
		payload: MovementPayload | CadenzaPayload
	) => void;
	deliverCadenza: (payload: CadenzaPayload) => boolean;
	deliverCadenzaToExistingHud: (payload: CadenzaPayload) => boolean;
}

/**
 * Delivers an authorized host-view mutation to Concerto's renderer channels.
 * A Cadenza close reaches both the HUD and in-app renderer: the latter may
 * retain a fallback card that was opened before a HUD existed.
 */
export function forwardPluginHostViewToRenderer(
	mutation: HostViewMutation,
	deps: PluginHostViewForwardingDeps
): boolean {
	let body: string | undefined;
	if (mutation.kind === 'upsert') {
		try {
			body = JSON.stringify(mutation.blocks);
		} catch {
			return false;
		}
	}

	if (mutation.view.surface === 'movement') {
		const payload: MovementPayload =
			mutation.kind === 'upsert'
				? {
						op: 'add',
						id: mutation.view.id,
						title: mutation.view.title,
						body,
						sourcePlugin: deps.sourcePlugin,
					}
				: { op: 'remove', id: mutation.view.id };
		deps.sendToMain('remote:movement', payload);
		return true;
	}

	const payload: CadenzaPayload =
		mutation.kind === 'upsert'
			? {
					op: 'open',
					id: mutation.view.id,
					viewType: 'view',
					title: mutation.view.title,
					body,
					sourcePlugin: deps.sourcePlugin,
				}
			: { op: 'close', id: mutation.view.id };

	if (mutation.kind === 'remove') {
		deps.deliverCadenzaToExistingHud(payload);
		deps.sendToMain('remote:cadenza', payload);
		return true;
	}

	if (deps.isCadenzaEnabled && deps.deliverCadenza(payload)) return true;
	deps.sendToMain('remote:cadenza', payload);
	return true;
}
