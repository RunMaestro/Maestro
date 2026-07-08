import { describe, expect, it } from 'vitest';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getSyntaxStyle } from '../../../renderer/utils/syntaxTheme';

describe('getSyntaxStyle', () => {
	it('returns the light syntax style for light mode', () => {
		expect(getSyntaxStyle('light')).toBe(vs);
	});

	it('returns the dark syntax style for non-light modes', () => {
		expect(getSyntaxStyle('dark')).toBe(vscDarkPlus);
		expect(getSyntaxStyle('vibe')).toBe(vscDarkPlus);
	});
});
