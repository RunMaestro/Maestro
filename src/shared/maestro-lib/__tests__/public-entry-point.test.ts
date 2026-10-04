import { describe, it, expect } from 'vitest';

describe('Maestro Library Public Entry Point', () => {
	it('should be importable from index.ts', async () => {
		// The main purpose of this test is to verify that index.ts exists
		// and can be imported. More granular symbol verification is handled
		// by the actual usage - if a symbol is missing, the consumer's
		// import will fail at type-check time.
		const indexModule = await import('../index');
		expect(indexModule).toBeDefined();
		expect(Object.keys(indexModule).length).toBeGreaterThan(0);
	});

	it('should export key symbols commonly imported from deep paths', async () => {
		const indexModule = await import('../index');

		// Test a sampling of commonly used symbols from each module area
		const requiredSymbols = [
			// launch/
			'buildAgentLaunchPlan',
			'resolveSshLaunchTarget',
			'checkCustomPath',

			// parsers/
			'createOutputParser',
			'ClaudeOutputParser',

			// providers/
			'getAgentDefinition',
			'hasCapability',

			// streaming/
			'BufferedLineReader',

			// run/
			'startTurn',
			'TurnCapture',

			// control/
			'stopProcess',

			// host.ts
			'setMaestroLibLogger',
			'logger',
		];

		for (const symbol of requiredSymbols) {
			expect(indexModule, `index.ts should export ${symbol}`).toHaveProperty(symbol);
		}
	});

	it('should not include bin/ modules', async () => {
		// Verify that internal modules are not exposed
		const content = require('fs').readFileSync(
			require('path').join(__dirname, '../index.ts'),
			'utf-8'
		);

		expect(content).not.toContain("from './bin/");
	});
});
