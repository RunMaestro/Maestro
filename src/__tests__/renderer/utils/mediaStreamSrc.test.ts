import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMediaStreamSrc } from '../../../renderer/utils/mediaStreamSrc';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { buildMediaStreamUrl } from '../../../shared/mediaTypes';

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

const mockedIsWebDesktop = vi.mocked(isWebDesktop);
const STREAM_URL = buildMediaStreamUrl('media-token', '/tmp/clip.mp4');
const HEX = STREAM_URL.split('/').pop();

function setConfig(config: unknown): void {
	(window as unknown as Record<string, unknown>).__MAESTRO_CONFIG__ = config;
}

afterEach(() => {
	delete (window as unknown as Record<string, unknown>).__MAESTRO_CONFIG__;
	mockedIsWebDesktop.mockReturnValue(false);
});

describe('resolveMediaStreamSrc', () => {
	it('plays the scheme URL as-is in the Electron desktop app', () => {
		expect(resolveMediaStreamSrc(STREAM_URL)).toBe(STREAM_URL);
	});

	it('maps the scheme URL onto the web server media route in web-desktop', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ securityToken: 'master' });
		expect(resolveMediaStreamSrc(STREAM_URL)).toBe(`/master/media/stream/media-token/${HEX}`);
	});

	it('falls back to the scheme URL when the page carries no security token', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({});
		expect(resolveMediaStreamSrc(STREAM_URL)).toBe(STREAM_URL);
	});
});
