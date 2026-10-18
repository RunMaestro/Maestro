import { describe, it, expect } from 'vitest';
import { buildAgentEnvironment } from '../../../shared/maestro-lib/launch/env';
import { resolveAgentAccountKey } from '../../../shared/providerProfiles';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	nativeRecordKey,
	translationArtifact,
	translationHash,
} from '../../../shared/maestro-lib/translation/identity';
import { CodexAppServerRpc } from '../../../shared/maestro-lib/codex/rpc-client';
import { CodexAppServerRpc as MainRpc } from '../../../main/codex-app-server/rpc-client';
import { isCodexResponse } from '../../../shared/maestro-lib/codex/protocol';
import { answerCodexServerRequest } from '../../../shared/maestro-lib/codex/server-requests';

describe('translation evidence contract', () => {
	it('resolves the migration account through the launch environment including explicit unset values', () => {
		const env = buildAgentEnvironment({
			surface: 'desktop',
			globalShellEnvVars: { CODEX_HOME: '/global/account' },
			sessionCustomEnvVars: { CODEX_HOME: ' ' },
		});
		expect(resolveAgentAccountKey('codex', env as Record<string, string>, '/isolated')).toBe(
			'/isolated/.codex'
		);
	});
	it('archives byte-exact evidence separately from deterministic semantic identity', () => {
		const bytes = Buffer.from('opaque\r\nunknown\n');
		const artifact = translationArtifact(
			'transcript',
			'/isolated/source.jsonl',
			'source.jsonl',
			bytes
		);
		expect(Buffer.from(artifact.bytesBase64, 'base64')).toEqual(bytes);
		expect(artifact.sha256).toBe(translationHash(bytes));
		expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
	});
	it('separates accounts and repeated events', () => {
		const identity = {
			provider: 'codex' as const,
			version: '0.162.1',
			accountRoot: '/one',
			projectRoot: '/project',
		};
		expect(nativeRecordKey(identity, 's', '1')).not.toBe(nativeRecordKey(identity, 's', '2'));
		expect(nativeRecordKey(identity, 's', '1')).not.toBe(
			nativeRecordKey({ ...identity, accountRoot: '/two' }, 's', '1')
		);
	});
	it('keeps desktop and translation on one RPC implementation and denies tool execution', async () => {
		expect(MainRpc).toBe(CodexAppServerRpc);
		const rpc = new CodexAppServerRpc(() => {});
		const pending = rpc.request('thread/read');
		const response = { id: 1, result: { thread: { id: 'native' } } };
		expect(isCodexResponse(response)).toBe(true);
		rpc.handleResponse(response);
		await expect(pending).resolves.toEqual(response.result);
		expect(
			answerCodexServerRequest({ id: 1, method: 'item/tool/call' }, { grantApprovals: false })
		).toEqual({ result: { success: false, contentItems: [] } });
	});
});
