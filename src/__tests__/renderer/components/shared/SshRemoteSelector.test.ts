import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ webDesktop: false }));

vi.mock('../../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => mocks.webDesktop,
}));

import {
	localExecutionLabel,
	withSshRemoteChoice,
} from '../../../../renderer/components/shared/SshRemoteSelector';

describe('withSshRemoteChoice', () => {
	it('enables SSH for a remote and defaults history sharing off, in both fields', () => {
		expect(withSshRemoteChoice(undefined, 'box')).toEqual({
			enabled: true,
			remoteId: 'box',
			workingDirOverride: undefined,
			syncHistory: false,
			shareHistoryToProjectDir: false,
		});
	});

	it('runs locally on null and keeps the sibling fields', () => {
		expect(
			withSshRemoteChoice(
				{
					enabled: true,
					remoteId: 'box',
					workingDirOverride: '/srv/app',
					syncHistory: true,
					shareHistoryToProjectDir: true,
				},
				null
			)
		).toEqual({
			enabled: false,
			remoteId: null,
			workingDirOverride: '/srv/app',
			syncHistory: true,
			shareHistoryToProjectDir: true,
		});
	});

	it('treats only null as local, never an empty id', () => {
		expect(withSshRemoteChoice(undefined, '')).toMatchObject({ enabled: true, remoteId: '' });
	});

	it('keeps an existing history sync choice when switching remotes', () => {
		const next = withSshRemoteChoice({ enabled: true, remoteId: 'a', syncHistory: true }, 'b');
		expect(next.remoteId).toBe('b');
		expect(next.syncHistory).toBe(true);
	});
});

describe('localExecutionLabel', () => {
	beforeEach(() => {
		mocks.webDesktop = false;
	});

	it('names this machine on the desktop', () => {
		expect(localExecutionLabel()).toBe('Local');
	});

	it('names the connected host in a browser client', () => {
		mocks.webDesktop = true;
		expect(localExecutionLabel()).toBe('Connected Maestro host');
	});
});
