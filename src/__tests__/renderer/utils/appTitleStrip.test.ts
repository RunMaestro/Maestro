import { describe, expect, it } from 'vitest';
import {
	APP_TITLE_STRIP_HEIGHT,
	shouldShowAppTitleStrip,
} from '../../../renderer/utils/appTitleStrip';

describe('shouldShowAppTitleStrip', () => {
	const flags = [
		'isMobileLandscape',
		'useNativeTitleBar',
		'isMdDownViewport',
		'isWebDesktop',
	] as const;

	// Every combination of the four conditions: the strip is drawn only when all
	// of them are false.
	for (let mask = 0; mask < 1 << flags.length; mask++) {
		const conditions = {
			isMobileLandscape: !!(mask & 1),
			useNativeTitleBar: !!(mask & 2),
			isMdDownViewport: !!(mask & 4),
			isWebDesktop: !!(mask & 8),
		};
		const on = flags.filter((f) => conditions[f]);
		it(`is ${mask === 0} with ${on.length ? on.join(' + ') : 'nothing set'}`, () => {
			expect(shouldShowAppTitleStrip(conditions)).toBe(mask === 0);
		});
	}

	it('asks the live runtime when web-desktop is not passed (Electron in tests)', () => {
		expect(
			shouldShowAppTitleStrip({
				isMobileLandscape: false,
				useNativeTitleBar: false,
				isMdDownViewport: false,
			})
		).toBe(true);
	});

	it('matches the 40px strip AppShell pads for', () => {
		expect(APP_TITLE_STRIP_HEIGHT).toBe(40);
	});
});
