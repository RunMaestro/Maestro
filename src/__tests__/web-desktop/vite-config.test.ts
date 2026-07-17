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

		const output = config.build?.rolldownOptions?.output as
			| {
					minify?: { compress?: { dropDebugger?: boolean } };
			  }
			| undefined;

		expect(config.oxc).toBeUndefined();
		expect(output?.minify?.compress?.dropDebugger).toBe(true);

		const result = await build({
			configFile: false,
			logLevel: 'silent',
			root,
			build: {
				minify: false,
				rolldownOptions: {
					input: debuggerDropFixture,
					output: { minify: output?.minify },
				},
				write: false,
			},
		});
		const emittedOutput = Array.isArray(result)
			? result.flatMap((entry) => entry.output)
			: result.output;
		const code = emittedOutput
			.filter((entry) => entry.type === 'chunk')
			.map((entry) => entry.code)
			.join('\n');

		expect(code).not.toMatch(/\bdebugger\b/);
		expect(code).toContain('console-kept');
	});
});
