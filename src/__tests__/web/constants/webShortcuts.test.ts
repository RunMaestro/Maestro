import { describe, expect, it } from 'vitest';
import {
	resolveWebShortcuts,
	WEB_DEFAULT_SHORTCUTS,
	WEB_SHORTCUT_IDS,
} from '../../../web/constants/webShortcuts';
import { DEFAULT_SHORTCUTS } from '../../../renderer/constants/shortcuts';

describe('webShortcuts', () => {
	it('builds web defaults from the supported desktop shortcut subset', () => {
		expect(Object.keys(WEB_DEFAULT_SHORTCUTS).sort()).toEqual([...WEB_SHORTCUT_IDS].sort());
		for (const id of WEB_SHORTCUT_IDS) {
			expect(WEB_DEFAULT_SHORTCUTS[id]).toEqual(DEFAULT_SHORTCUTS[id]);
		}
	});

	it('returns defaults when no user overrides are provided', () => {
		expect(resolveWebShortcuts(undefined)).toBe(WEB_DEFAULT_SHORTCUTS);
	});

	it('merges supported overrides and ignores unsupported action ids', () => {
		const override = {
			key: 'K',
			metaKey: true,
			ctrlKey: false,
			altKey: false,
			shiftKey: true,
			description: 'Custom quick action',
		};
		const resolved = resolveWebShortcuts({
			quickAction: override,
			unsupportedAction: {
				key: 'X',
				metaKey: true,
				ctrlKey: false,
				altKey: false,
				shiftKey: false,
				description: 'Unsupported',
			},
		});

		expect(resolved.quickAction).toEqual(override);
		expect(resolved.unsupportedAction).toBeUndefined();
		expect(resolved.nextTab).toEqual(WEB_DEFAULT_SHORTCUTS.nextTab);
		expect(resolved).not.toBe(WEB_DEFAULT_SHORTCUTS);
	});
});
