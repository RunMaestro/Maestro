import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnNativeSdkAgent } from '../../cli/services/native-sdk-agent';
import { initializeOutputParsers } from '../../main/parsers';

const LIVE = process.env.QWEN_LIVE === '1';

describe.skipIf(!LIVE)('CLI-owned Qwen ACP turn', () => {
	let workspace = '';
	afterEach(() => {
		if (workspace) {
			if (process.platform === 'win32') execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', workspace]);
			else rmSync(workspace, { recursive: true, force: true });
		}
	});

	it('answers an ACP permission request through the CLI owner', async () => {
		initializeOutputParsers();
		workspace = mkdtempSync(join(tmpdir(), 'maestro-cli-acp-'));
		let requests = 0;
		const result = await spawnNativeSdkAgent(
			'qwen3-coder',
			workspace,
			'Use the shell tool to create cli-acp.txt containing CLI_ACP_APPROVED, then stop.',
			undefined,
			{
				harnessControlMode: 'native',
				permissionMode: 'standard',
				nativeSessionId: 'cli-acp-owner',
				onHarnessInteraction: (request) => {
					requests += 1;
					expect(request.sessionId).toBe('cli-acp-owner');
					const option = request.options.find((item) => item.kind === 'allow-once');
					return option
						? { outcome: 'selected', optionId: option.optionId }
						: { outcome: 'cancelled', reason: 'cancelled' };
				},
			},
			'C:/Users/Administrator/AppData/Roaming/npm/qwen.cmd'
		);
		expect({ success: result.success, error: result.error }).toEqual({
			success: true,
			error: undefined,
		});
		expect(requests).toBeGreaterThan(0);
		expect(readFileSync(join(workspace, 'cli-acp.txt'), 'utf8').trim()).toBe('CLI_ACP_APPROVED');
	}, 180_000);
});
