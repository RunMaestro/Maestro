/**
 * Federation Hosting Default-Off Migration
 *
 * Hosted agents (`federationHostedAgents`) and automatic moves onto a host
 * (`federationAutoMove`) shipped ON by default. They are now opt-in. Changing
 * the defaults alone does not reach existing installs: electron-store writes
 * its defaults into the settings file on first run, so those installs hold a
 * persisted `true` that reads exactly like an explicit opt-in.
 *
 * The store cannot tell the two apart, so this flips both to `false` once and
 * records a marker. A user who wants hosting turns the switch on again
 * afterwards, and the marker keeps this from ever overriding that choice.
 *
 * Switching hosting off is the designed kill switch (`HOSTED_AGENTS_SETTING`):
 * a hosted agent keeps its record and its `liftedTo` pointer and works as the
 * SSH agent it was, from this machine. This migration writes two settings keys
 * and nothing else: no agent record and nothing on any remote host is touched,
 * so turning hosting on again restores every hosted agent as it was.
 */

import type Store from 'electron-store';

import { FEDERATION_AUTO_MOVE_SETTING } from '../../../shared/federationAuto';
import { HOSTED_AGENTS_SETTING } from '../../../shared/maestro-lib/agents/lift-pointer';
import { logger } from '../../utils/logger';
import type { MaestroSettings } from '../types';

/** Settings key marking the one-time Federation default-off reset as done. */
export const FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER =
	'migration_federationHostingDefaultOffV1';

/** Turn hosted agents and automatic moves off once, on every existing install. */
export function migrateFederationHostingDefaultOff(store: Store<MaestroSettings>): void {
	if (store.get(FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER)) {
		return;
	}

	const wasOn = [HOSTED_AGENTS_SETTING, FEDERATION_AUTO_MOVE_SETTING].filter(
		(key) => store.get(key) === true
	);
	store.set(HOSTED_AGENTS_SETTING, false);
	store.set(FEDERATION_AUTO_MOVE_SETTING, false);

	store.set(FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER, true);
	logger.info(
		`Federation hosting default-off migration complete - turned off: ${
			wasOn.length > 0 ? wasOn.join(', ') : 'nothing (already off)'
		}`,
		'Migration'
	);
}
