// @vitest-environment node
import path from 'path';
import { build } from 'vite';
import { describe, expect, test } from 'vitest';
import webDesktopConfig from '../../../vite.config.web-desktop.mts';

const root = path.resolve(__dirname, '../../..');
const debuggerDropFixture = path.join(__dirname, 'fixtures/debugger-drop.ts');

describe('Web Desktop production transform', () => {
	test('removes debugger statements without dropping console calls', async () => {
		const config = webDesktopConfig({
			command: 'build',
			mode: 'production',
			isSsrBuild: false,
			isPreview: false,
		});

		expect(config.oxc).toMatchObject({ drop: ['debugger'] });
		expect(config.build?.minify).toBe('oxc');
		expect(config.esbuild).toBeUndefined();

		const result = await build({
			configFile: false,
			logLevel: 'silent',
			oxc: config.oxc,
			root,
			build: {
				minify: config.build?.minify,
				rollupOptions: { input: debuggerDropFixture },
				write: false,
			},
		});
		const output = Array.isArray(result) ? result.flatMap((entry) => entry.output) : result.output;
		const code = output
			.filter((entry) => entry.type === 'chunk')
			.map((entry) => entry.code)
			.join('\n');

		expect(code).not.toMatch(/\bdebugger\b/);
		expect(code).toContain('console-kept');
	});
});
