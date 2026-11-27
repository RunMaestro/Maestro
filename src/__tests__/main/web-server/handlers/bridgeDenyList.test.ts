/**
 * @file bridgeDenyList.test.ts
 * @description The IPC channels a web client may never invoke over the bridge.
 */

import { describe, it, expect } from 'vitest';
import {
	bridgeDeniedChannelError,
	isBridgeDeniedChannel,
} from '../../../../main/web-server/handlers/bridgeDenyList';

describe('isBridgeDeniedChannel', () => {
	it.each(['webLogin:createUser', 'promptLinks:create', 'updates:rollback'])(
		'denies %s',
		(channel) => {
			expect(isBridgeDeniedChannel(channel)).toBe(true);
		}
	);

	it('denies rolling the host back but leaves the rest of the updates namespace open', () => {
		expect(isBridgeDeniedChannel('updates:check')).toBe(false);
		expect(isBridgeDeniedChannel('updates:listRollbackTargets')).toBe(false);
		expect(isBridgeDeniedChannel('updates:getStatus')).toBe(false);
	});

	it('names the channel in its refusal', () => {
		expect(bridgeDeniedChannelError('updates:rollback')).toContain('updates:rollback');
	});
});
