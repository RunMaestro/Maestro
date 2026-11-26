/**
 * @file bridgeDenyList.test.ts
 * @description The bridge's remote method inventory refuses rolling the host back.
 *
 * rc's bridge is an exact allowlist: a channel is reachable from a web client only when the
 * inventory names it, and host lifecycle channels are deliberately absent. Rolling back replaces
 * the host's app with an OLDER build, which can reopen vulnerabilities a later release closed, so
 * only the person at the desktop (or its CLI) may run it.
 */

import { describe, it, expect } from 'vitest';
import {
	isRemoteMethodAllowed,
	remoteDeniedChannelError,
} from '../../../../main/web-server/handlers/bridgeDenyList';

describe('remote method inventory', () => {
	it.each(['updates:rollback', 'webLogin:createUser', 'promptLinks:create'])(
		'refuses %s',
		(channel) => {
			expect(isRemoteMethodAllowed(channel)).toBe(false);
		}
	);

	it('names the channel in its refusal', () => {
		expect(remoteDeniedChannelError('updates:rollback')).toContain('updates:rollback');
	});
});
