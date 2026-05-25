import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const whyDidYouRender = vi.hoisted(() => vi.fn());

vi.mock('@welldone-software/why-did-you-render', () => ({
	default: whyDidYouRender,
}));

describe('wdyr.dev', () => {
	it('configures why-did-you-render synchronously for development profiling', async () => {
		await import('../../renderer/wdyr.dev');

		expect(whyDidYouRender).toHaveBeenCalledWith(
			React,
			expect.objectContaining({
				trackAllPureComponents: true,
				trackHooks: true,
				logOnDifferentValues: true,
				collapseGroups: true,
				include: [],
				exclude: [expect.any(RegExp), expect.any(RegExp), expect.any(RegExp)],
			})
		);
	});
});
