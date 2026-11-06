import { describe, expect, it } from 'vitest';
import { resolveBoardLocation } from '../../../main/board/board-location';

describe('Board worker location', () => {
	it.each([
		[{ sessionSshRemoteConfig: { enabled: true, remoteId: 'r' } }, { kind: 'ssh', remoteId: 'r' }],
		[{ sshRemoteId: 'r' }, { kind: 'ssh', remoteId: 'r' }],
		[
			{ sshRemoteId: 'r', sessionSshRemoteConfig: { enabled: true, remoteId: 'r' } },
			{ kind: 'ssh', remoteId: 'r' },
		],
		[
			{ sshRemoteId: 'other', sessionSshRemoteConfig: { enabled: true, remoteId: 'r' } },
			{ kind: 'invalid' },
		],
		[{ sessionSshRemoteConfig: { enabled: true } }, { kind: 'invalid' }],
		[{}, { kind: 'local' }],
	])('resolves %o safely', (session, expected) => {
		expect(resolveBoardLocation(session)).toEqual(expected);
	});
});
