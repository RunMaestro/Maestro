import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnNativeSdkAgent } from '../../cli/services/native-sdk-agent';
import { initializeOutputParsers } from '../../main/parsers';

const LIVE = process.env.HERMES_LIVE === '1';

describe.skipIf(!LIVE)('CLI-owned Hermes gateway turn', () => {
	it('answers clarification through the CLI owner and captures the final response', async () => {
		initializeOutputParsers();
		const workspace = mkdtempSync(join(tmpdir(), 'maestro-cli-hermes-'));
		try {
			let requests = 0;
			const result = await spawnNativeSdkAgent(
				'hermes',
				workspace,
				'Before doing anything else, use clarify exactly once to ask “Continue?” with options “Yes” and “No”. After the answer, respond with exactly CLI_HERMES_APPROVED.',
				undefined,
				{
					harnessControlMode: 'native',
					permissionMode: 'standard',
					nativeSessionId: 'cli-hermes-owner',
					onHarnessInteraction: (request) => {
						requests += 1;
						expect(request.sessionId).toBe('cli-hermes-owner');
						const answers = Object.fromEntries(
							request.questions.map((question) => [
								question.id,
								question.options[0]?.label ?? 'Yes',
							])
						);
						return { outcome: 'answers', answers };
					},
				},
				'C:/Users/Administrator/AppData/Local/hermes/bin/hermes.exe'
			);
			expect({ success: result.success, error: result.error }).toEqual({
				success: true,
				error: undefined,
			});
			expect(requests).toBe(1);
			expect(result.response).toContain('CLI_HERMES_APPROVED');
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	}, 150_000);
});
