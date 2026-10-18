import { describe, it, expect } from 'vitest';
import { urlTransformAllowingMaestro } from '../../../renderer/utils/markdownUrlTransform';

describe('urlTransformAllowingMaestro', () => {
	it('keeps http(s) and internal schemes', () => {
		expect(urlTransformAllowingMaestro('https://x.com')).toBe('https://x.com');
		expect(urlTransformAllowingMaestro('maestro://agent/1')).toBe('maestro://agent/1');
		expect(urlTransformAllowingMaestro('file:///tmp/a.png')).toBe('file:///tmp/a.png');
	});

	it('keeps routing-hinted http(s) URLs intact for the click handler', () => {
		expect(urlTransformAllowingMaestro('maestro+https://x.com/p')).toBe('maestro+https://x.com/p');
		expect(urlTransformAllowingMaestro('system+http://localhost:5173')).toBe(
			'system+http://localhost:5173'
		);
	});

	it('blanks a hint in front of a dangerous scheme', () => {
		expect(urlTransformAllowingMaestro('maestro+javascript:alert(1)')).toBe('');
		expect(urlTransformAllowingMaestro('javascript:alert(1)')).toBe('');
	});
});
