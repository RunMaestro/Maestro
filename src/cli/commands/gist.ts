// Gist create - publish an agent's session transcript to a GitHub gist.
// Routes through the running Maestro desktop app (which holds live tab
// transcripts) and reuses the existing `gh gist create` IPC handler.
//
// `--session` narrows the publish to one provider session instead of the
// agent's open AI tabs. Headless callers (Maestro Relay, playbooks, Cue, CI)
// hold a session id from `send -s <id>` and have no desktop tab, so without it
// they publish whatever unrelated conversation the agent has open.

import { resolveAgentId } from '../services/storage';
import { withMaestroClient } from '../services/maestro-client';

interface GistCreateOptions {
	description?: string;
	public?: boolean;
	session?: string;
}

interface GistCreateResponse {
	success: boolean;
	agentId?: string;
	agentSessionId?: string;
	gistUrl?: string;
	error?: string;
	code?: string;
}

function emitErrorJson(error: string, code: string): void {
	const payload: GistCreateResponse = { success: false, error, code };
	console.log(JSON.stringify(payload, null, 2));
}

export async function gistCreate(agentIdArg: string, options: GistCreateOptions): Promise<void> {
	let agentId: string;
	try {
		agentId = resolveAgentId(agentIdArg);
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		emitErrorJson(msg, 'AGENT_NOT_FOUND');
		process.exit(1);
	}

	const description = options.description ?? '';
	const isPublic = Boolean(options.public);

	// Reject a blank `--session` rather than dropping it: falling through to the
	// agent's open tabs would publish a different conversation than the one the
	// caller named, and a gist is readable by anyone with the URL.
	const agentSessionId = options.session?.trim();
	if (options.session !== undefined && !agentSessionId) {
		emitErrorJson('--session requires a non-empty session id', 'INVALID_SESSION');
		process.exit(1);
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				gistUrl?: string;
				error?: string;
			}>(
				{
					type: 'create_gist',
					sessionId: agentId,
					description,
					isPublic,
					...(agentSessionId ? { agentSessionId } : {}),
				},
				'create_gist_result',
				60000
			)
		);

		if (!result.success || !result.gistUrl) {
			emitErrorJson(result.error ?? 'Failed to create gist', 'GIST_CREATE_FAILED');
			process.exit(1);
		}

		const response: GistCreateResponse = {
			success: true,
			agentId,
			...(agentSessionId ? { agentSessionId } : {}),
			gistUrl: result.gistUrl,
		};
		console.log(JSON.stringify(response, null, 2));
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const lower = msg.toLowerCase();
		if (
			lower.includes('econnrefused') ||
			lower.includes('connection refused') ||
			lower.includes('websocket') ||
			lower.includes('enotfound') ||
			lower.includes('etimedout') ||
			lower.includes('not running')
		) {
			emitErrorJson('Maestro desktop is not running or not reachable', 'MAESTRO_NOT_RUNNING');
		} else {
			emitErrorJson(`Gist creation failed: ${msg}`, 'GIST_CREATE_FAILED');
		}
		process.exit(1);
	}
}
