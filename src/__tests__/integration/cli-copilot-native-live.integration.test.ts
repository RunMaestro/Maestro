import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnNativeSdkAgent } from '../../cli/services/native-sdk-agent';
import { initializeOutputParsers } from '../../main/parsers';

const LIVE = process.env.COPILOT_LIVE === '1';

describe.skipIf(!LIVE)('CLI-owned Copilot native turn', () => {
	let workspace = '';
	afterEach(() => {
		if (workspace) {
			if (process.platform === 'win32') execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', workspace]);
			else rmSync(workspace, { recursive: true, force: true });
		}
	});

	it('answers a real approval through the CLI owner and captures the result', async () => {
		initializeOutputParsers();
		workspace = mkdtempSync(join(tmpdir(), 'maestro-cli-copilot-'));
		let requests = 0;
		const result = await spawnNativeSdkAgent(
			'copilot-cli',
			workspace,
			'Use tools to create cli-owned.txt containing CLI_APPROVED, then stop.',
			undefined,
			{
				harnessControlMode: 'native',
				permissionMode: 'standard',
				nativeSessionId: 'cli-live-owner',
				onHarnessInteraction: (request) => {
					requests += 1;
					expect(request.sessionId).toBe('cli-live-owner');
					return { outcome: 'selected', optionId: 'allow' };
				},
			},
			'copilot'
		);
		expect({ success: result.success, error: result.error }).toEqual({
			success: true,
			error: undefined,
		});
		expect(requests).toBeGreaterThan(0);
		expect(readFileSync(join(workspace, 'cli-owned.txt'), 'utf8').trim()).toBe('CLI_APPROVED');
	}, 150_000);
});
