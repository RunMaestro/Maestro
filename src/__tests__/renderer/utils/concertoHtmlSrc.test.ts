import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConcertoHtmlSrc } from '../../../renderer/utils/concertoHtmlSrc';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

const mockedIsWebDesktop = vi.mocked(isWebDesktop);

function setConfig(config: unknown): void {
	(window as unknown as Record<string, unknown>).__MAESTRO_CONFIG__ = config;
}

afterEach(() => {
	delete (window as unknown as Record<string, unknown>).__MAESTRO_CONFIG__;
	mockedIsWebDesktop.mockReturnValue(false);
});

describe('resolveConcertoHtmlSrc', () => {
	it('uses the custom scheme in the Electron desktop app', () => {
		mockedIsWebDesktop.mockReturnValue(false);
		expect(resolveConcertoHtmlSrc('movement', 'mockup', 7)).toBe(
			'maestro-concerto://render/?surface=movement&id=mockup&revision=7'
		);
	});

	it('uses the token-scoped HTTP route in web-desktop', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ concertoToken: 'abc123' });
		expect(resolveConcertoHtmlSrc('movement', 'mockup', 7)).toBe(
			'/abc123/concerto/render?surface=movement&id=mockup&revision=7'
		);
	});

	it('percent-encodes ids so a slash cannot escape the route', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ concertoToken: 'abc123' });
		expect(resolveConcertoHtmlSrc('cadenza', 'a/b c', 1)).toBe(
			'/abc123/concerto/render?surface=cadenza&id=a%2Fb+c&revision=1'
		);
	});

	it('falls back to the custom scheme when the server served no concerto token', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ securityToken: 'only-the-master-token' });
		expect(resolveConcertoHtmlSrc('movement', 'mockup', 2)).toBe(
			'maestro-concerto://render/?surface=movement&id=mockup&revision=2'
		);
	});

	it('never puts the web server security token in a document URL', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ securityToken: 'master-secret', concertoToken: 'scoped-token' });
		expect(resolveConcertoHtmlSrc('movement', 'mockup', 3)).not.toContain('master-secret');
	});
});
