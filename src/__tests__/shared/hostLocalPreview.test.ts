import { describe, expect, it } from 'vitest';
import { isHostLocalPreviewUrl } from '../../shared/hostLocalPreview';

describe('host-local preview classification', () => {
	it.each([
		'http://localhost:3000/app',
		'https://dev.localhost/',
		'http://127.2.3.4:4000/',
		'http://[::1]:8080/',
		'http://0.0.0.0:5000/',
		'http://2130706433:3000/',
	])('keeps %s on host execution', (url) => {
		expect(isHostLocalPreviewUrl(url)).toBe(true);
	});
	it.each([
		'https://localhost.example.com',
		'https://example.com/localhost',
		'https://localhost@evil.example/',
		'http://localhost:99999/',
		'file:///host/file.html',
		'mailto:user@example.com',
	])('does not treat %s as a localhost HTTP preview', (url) => {
		expect(isHostLocalPreviewUrl(url)).toBe(false);
	});
});
