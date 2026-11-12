/**
 * Tests for launchOffer: whether the Exchange offers Launch for a playbook, before any agent is
 * chosen. The tile's badge and the detail footer both read it, so these pin each state and the
 * words of the reason a Download-only playbook gives.
 */

import { describe, expect, it } from 'vitest';
import {
	getLaunchOffer,
	specForPlatform,
} from '../../../../../renderer/components/MarketplaceModal/launch/launchOffer';
import type {
	MarketplacePlaybook,
	PlaybookLaunchSpec,
} from '../../../../../shared/marketplace-types';
import { makePlaybook } from '../_fixtures';

function spec(overrides: Partial<PlaybookLaunchSpec> = {}): PlaybookLaunchSpec {
	return { inputs: [], outro: { summary: 'Done.', nextSteps: [] }, ...overrides };
}

describe('getLaunchOffer', () => {
	const withLaunch = (launch?: PlaybookLaunchSpec, overrides: Partial<MarketplacePlaybook> = {}) =>
		makePlaybook({ launch, ...overrides });

	it('offers nothing for a playbook without a launch block, whatever the machine', () => {
		expect(getLaunchOffer(withLaunch(), '1.0.0', 'darwin')).toEqual({ status: 'none' });
		expect(getLaunchOffer(withLaunch(), '1.0.0', '')).toEqual({ status: 'none' });
	});

	it('offers Launch for a bare launch block on any platform', () => {
		for (const platform of ['darwin', 'linux', 'win32', '']) {
			expect(getLaunchOffer(withLaunch(spec()), '1.0.0', platform)).toEqual({
				status: 'available',
			});
		}
	});

	it('offers Launch on a platform the block lists, and says why not on another', () => {
		const macOnly = withLaunch(spec({ preconditions: { platforms: ['darwin'] } }));

		expect(getLaunchOffer(macOnly, '1.0.0', 'darwin')).toEqual({ status: 'available' });
		expect(getLaunchOffer(macOnly, '1.0.0', 'win32')).toEqual({
			status: 'unavailable',
			reason: 'This playbook runs on macOS only.',
		});
	});

	it('does not refuse a platform it cannot read (web-desktop): main checks it again', () => {
		const macOnly = withLaunch(spec({ preconditions: { platforms: ['darwin'] } }));

		expect(getLaunchOffer(macOnly, '1.0.0', '')).toEqual({ status: 'available' });
	});

	it("applies the block's own minimum Maestro version", () => {
		const playbook = withLaunch(spec({ minMaestroVersion: '9.0.0' }));

		expect(getLaunchOffer(playbook, '1.0.0', 'darwin')).toEqual({
			status: 'unavailable',
			reason: 'Launch needs Maestro 9.0.0 or newer (this is 1.0.0).',
		});
		expect(getLaunchOffer(playbook, '9.0.0', 'darwin')).toEqual({ status: 'available' });
	});

	it("applies the playbook's top-level minimum too, because Download is gated on it", () => {
		const playbook = withLaunch(spec(), { minMaestroVersion: '9.0.0' });

		expect(getLaunchOffer(playbook, '1.0.0', 'darwin')).toEqual({
			status: 'unavailable',
			reason: 'Update Maestro to 9.0.0 or newer to launch this playbook.',
		});
		expect(getLaunchOffer(playbook, '9.1.0', 'darwin')).toEqual({ status: 'available' });
	});

	it('reports the top-level minimum before the platform', () => {
		const playbook = withLaunch(spec({ preconditions: { platforms: ['darwin'] } }), {
			minMaestroVersion: '9.0.0',
		});

		expect(getLaunchOffer(playbook, '1.0.0', 'win32')).toMatchObject({
			status: 'unavailable',
			reason: 'Update Maestro to 9.0.0 or newer to launch this playbook.',
		});
	});

	it('leaves maestro-cli to the dialog: it needs an agent, and the Exchange has none yet', () => {
		const needsCli = withLaunch(spec({ preconditions: { maestroCli: 'required' } }));

		expect(getLaunchOffer(needsCli, '1.0.0', 'darwin')).toEqual({ status: 'available' });
	});

	it('does not change the playbook it was given', () => {
		const playbook = withLaunch(spec({ preconditions: { platforms: ['darwin'] } }));

		getLaunchOffer(playbook, '1.0.0', '');

		expect(playbook.launch?.preconditions?.platforms).toEqual(['darwin']);
	});
});

describe('specForPlatform', () => {
	const macOnly = spec({ preconditions: { platforms: ['darwin'] } });

	it('is the spec itself on a platform it can read', () => {
		expect(specForPlatform(macOnly, 'darwin')).toBe(macOnly);
		expect(specForPlatform(macOnly, 'win32')).toBe(macOnly);
	});

	it('lifts the platform list when the platform is unknown, without touching the rest', () => {
		const lifted = specForPlatform(
			{
				...macOnly,
				minMaestroVersion: '2.0.0',
				preconditions: { platforms: ['darwin'], maestroCli: 'required' },
			},
			''
		);

		expect(lifted.preconditions).toEqual({ platforms: [], maestroCli: 'required' });
		expect(lifted.minMaestroVersion).toBe('2.0.0');
	});

	it('returns a spec without a platform list as it is, and never changes its input', () => {
		const plain = spec();

		expect(specForPlatform(plain, '')).toBe(plain);
		specForPlatform(macOnly, '');
		expect(macOnly.preconditions?.platforms).toEqual(['darwin']);
	});
});
