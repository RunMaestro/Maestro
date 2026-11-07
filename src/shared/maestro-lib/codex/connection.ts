import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexAppServerRpc } from './rpc-client';
import { isCodexResponse, isCodexServerRequest, type CodexAppServerMessage } from './protocol';
import { answerCodexServerRequest } from './server-requests';
import { BufferedLineReader } from '../streaming/buffered-line-reader';
import { stopProcess } from '../control/termination';
import type { TranslationRpc } from '../translation/types';

/** No turns, tools, permission expansion, or context-free exec fallback on this channel. */
export async function openCodexTranslationConnection(options: {
	binary: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The host can supply an SSH child; env.CODEX_HOME still pins the remote account. */
	spawn?: () => ChildProcessWithoutNullStreams;
}): Promise<TranslationRpc & { close(): void }> {
	const child = options.spawn
		? options.spawn()
		: spawn(options.binary, ['app-server'], {
				cwd: options.cwd,
				env: options.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
	const listeners = new Set<(method: string, params: unknown) => void>();
	const reader = new BufferedLineReader();
	const rpc = new CodexAppServerRpc((line) => {
		if (!child.stdin.writable) throw new Error('Codex stdin closed');
		child.stdin.write(line + '\n');
	});
	// Preserve UTF-8 characters split across transport chunks before framing JSON lines.
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		for (const line of reader.push(chunk)) {
			try {
				const message = JSON.parse(line) as CodexAppServerMessage;
				if (isCodexResponse(message)) rpc.handleResponse(message);
				else if (isCodexServerRequest(message))
					rpc.respond(message.id, answerCodexServerRequest(message, { grantApprovals: false }));
				else if (message.method)
					for (const listener of listeners) listener(message.method, message.params);
			} catch {
				rpc.close('Invalid Codex app-server frame');
			}
		}
	});
	// Drain without exposing provider diagnostics or credentials in migration reports.
	child.stderr.resume();
	child.stdin.once('error', () => rpc.close('Codex app-server stdin failed'));
	child.stdout.once('error', () => rpc.close('Codex app-server stdout failed'));
	child.stderr.once('error', () => rpc.close('Codex app-server stderr failed'));
	child.stdout.once('end', () => rpc.close('Codex app-server stdout ended'));
	child.once('close', () => rpc.close('Codex app-server connection closed'));
	child.once('error', (error) => rpc.close(error.message));
	child.once('exit', () => rpc.close('Codex app-server exited'));
	const close = (): void => {
		rpc.close('Translation connection closed');
		listeners.clear();
		child.stdin.end();
		stopProcess({ child }, { from: 'terminate', graceMs: 1000 });
	};
	try {
		const initialized = await rpc.request<{ codexHome: string }>(
			'initialize',
			{ clientInfo: { name: 'maestro', version: '1' }, capabilities: { experimentalApi: true } },
			{ timeoutMs: 30000 }
		);
		if (initialized.codexHome !== options.env.CODEX_HOME)
			throw new Error('Codex app-server returned a different account root');
		rpc.notify('initialized');
	} catch (error) {
		close();
		throw error;
	}
	return {
		request: <T>(method: string, params?: unknown) =>
			rpc.request<T>(method, params, { timeoutMs: 30000 }),
		onNotification: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close,
	};
}
