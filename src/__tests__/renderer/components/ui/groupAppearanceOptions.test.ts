import { describe, expect, it } from 'vitest';
import { Folder } from 'lucide-react';
import type { IconPackContribution } from '../../../../shared/plugins/contributions';
import { resolveGroupAppearance } from '../../../../renderer/components/ui/groupAppearanceOptions';

const iconPacks: IconPackContribution[] = [
	{
		id: 'com.acme/bright',
		localId: 'bright',
		pluginId: 'com.acme',
		label: 'Acme Bright',
		icons: [
			{
				id: 'com.acme/bright/bolt',
				localId: 'bolt',
				label: 'Bolt',
				path: 'M13 2L3 14H12L11 22L21 10H12L13 2',
			},
		],
		colors: [
			{
				id: 'com.acme/bright/lime',
				localId: 'lime',
				label: 'Lime',
				value: '#22C55E',
			},
		],
	},
];

describe('resolveGroupAppearance', () => {
	it('resolves contributed icon paths and color values', () => {
		const appearance = resolveGroupAppearance(
			'com.acme/bright/bolt',
			'com.acme/bright/lime',
			iconPacks
		);

		expect(appearance).toMatchObject({
			icon: {
				kind: 'plugin',
				path: 'M13 2L3 14H12L11 22L21 10H12L13 2',
			},
			color: '#22C55E',
		});
	});

	it('falls back without mutating stored plugin ids when the pack is unavailable', () => {
		const group = {
			icon: 'com.acme/bright/bolt',
			color: 'com.acme/bright/lime',
		};

		const appearance = resolveGroupAppearance(group.icon, group.color, []);

		expect(appearance.icon).toEqual({ kind: 'missing', Icon: Folder });
		expect(appearance.color).toBeUndefined();
		expect(group).toEqual({
			icon: 'com.acme/bright/bolt',
			color: 'com.acme/bright/lime',
		});
	});
});
