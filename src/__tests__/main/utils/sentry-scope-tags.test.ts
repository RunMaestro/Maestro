import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	attachSentryScopeTags,
	noteSentryAgentInventory,
	noteSentryWorkReasons,
	resetSentryScopeTagsForTests,
	setSentryScopeTags,
} from '../../../main/utils/sentry';

describe('Sentry scope tags (main)', () => {
	beforeEach(() => {
		resetSentryScopeTagsForTests();
	});

	it('holds tags recorded before Sentry initializes and delivers them on attach', () => {
		setSentryScopeTags({ 'autorun.active': 'true' });
		noteSentryAgentInventory([{ toolType: 'codex' }]);

		const setTags = vi.fn();
		attachSentryScopeTags({ setTags });

		expect(setTags).toHaveBeenCalledTimes(1);
		expect(setTags).toHaveBeenCalledWith({
			'autorun.active': 'true',
			'agents.count': '1',
			'agents.providers': 'codex',
		});
	});

	it('only forwards tags whose value changed', () => {
		const setTags = vi.fn();
		attachSentryScopeTags({ setTags });

		noteSentryWorkReasons(['session:a']);
		expect(setTags).toHaveBeenCalledTimes(1);

		// Same summary from a different reason set: nothing changed.
		noteSentryWorkReasons(['session:b']);
		expect(setTags).toHaveBeenCalledTimes(1);

		noteSentryWorkReasons(['session:b', 'autorun:c']);
		expect(setTags).toHaveBeenCalledTimes(2);
		expect(setTags).toHaveBeenLastCalledWith({ 'autorun.active': 'true', 'autorun.count': '1' });
	});

	it('does not attach anything when Sentry never initializes', () => {
		// Crash reporting off: setters still work and nothing throws.
		expect(() => noteSentryWorkReasons(['autorun:x'])).not.toThrow();
	});

	it('swallows a failing scope write so the reporting state change survives', () => {
		attachSentryScopeTags({
			setTags: () => {
				throw new Error('scope gone');
			},
		});
		expect(() => setSentryScopeTags({ 'agents.count': '3' })).not.toThrow();
	});
});
