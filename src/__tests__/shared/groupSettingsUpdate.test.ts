/**
 * Tests for the wire shape of a Group Settings write: what the WebSocket
 * boundary accepts, and the combinations it refuses before the app is asked.
 */

import { describe, it, expect } from 'vitest';
import {
	GROUP_SETTINGS_PATCH_KEYS,
	parseGroupSettingsUpdateRequest,
} from '../../shared/groupSettingsUpdate';

describe('parseGroupSettingsUpdateRequest', () => {
	it('accepts a config patch, an ssh patch, a label and a publish', () => {
		const parsed = parseGroupSettingsUpdateRequest({
			configPatch: { customModel: 'opus', nudgeMessage: null },
			sshPatch: { enabled: true, remoteId: 'box' },
			shortLabel: 'BE',
			publish: true,
		});
		expect(parsed).toEqual({
			ok: true,
			request: {
				configPatch: { customModel: 'opus', nudgeMessage: null },
				sshPatch: { enabled: true, remoteId: 'box' },
				shortLabel: 'BE',
				publish: true,
			},
		});
	});

	it('keeps an empty short label, which clears it', () => {
		const parsed = parseGroupSettingsUpdateRequest({ shortLabel: '' });
		expect(parsed).toEqual({ ok: true, request: { shortLabel: '' } });
	});

	it('names a key that is not a group default instead of ignoring it', () => {
		const parsed = parseGroupSettingsUpdateRequest({
			configPatch: { customModel: 'opus', bookmarked: true },
		});
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain('bookmarked');
	});

	it('names an SSH key it does not know', () => {
		const parsed = parseGroupSettingsUpdateRequest({ sshPatch: { host: 'x' } });
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain('host');
	});

	it('rejects a request that changes nothing', () => {
		expect(parseGroupSettingsUpdateRequest({})).toEqual({ ok: false, error: 'Nothing to update' });
		expect(parseGroupSettingsUpdateRequest({ configPatch: {} })).toEqual({
			ok: false,
			error: 'Nothing to update',
		});
	});

	it('rejects wrongly typed fields', () => {
		expect(parseGroupSettingsUpdateRequest({ shortLabel: 3 }).ok).toBe(false);
		expect(parseGroupSettingsUpdateRequest({ publish: 'yes' }).ok).toBe(false);
		expect(parseGroupSettingsUpdateRequest({ configPatch: [] }).ok).toBe(false);
		expect(parseGroupSettingsUpdateRequest(null).ok).toBe(false);
	});

	it('refuses clearing the defaults beside setting some', () => {
		const parsed = parseGroupSettingsUpdateRequest({
			clearDefaults: true,
			configPatch: { customModel: 'opus' },
		});
		expect(parsed.ok).toBe(false);
	});

	it('refuses publishing a clear, which has no values to write', () => {
		const parsed = parseGroupSettingsUpdateRequest({ clearDefaults: true, publish: true });
		expect(parsed.ok).toBe(false);
	});

	it('lets a clear travel with a short label, which a clear does not touch', () => {
		const parsed = parseGroupSettingsUpdateRequest({ clearDefaults: true, shortLabel: 'BE' });
		expect(parsed).toEqual({ ok: true, request: { clearDefaults: true, shortLabel: 'BE' } });
	});

	it('never lists a name, id or runtime field as a default', () => {
		for (const key of ['name', 'id', 'groupId', 'aiTabs', 'state', 'bookmarked']) {
			expect(GROUP_SETTINGS_PATCH_KEYS).not.toContain(key);
		}
	});
});
