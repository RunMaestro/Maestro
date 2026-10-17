// Gist create - publish an agent's session transcript to a GitHub gist.
// Routes through the running Maestro desktop app (which holds live tab
// transcripts) and reuses the existing `gh gist create` IPC handler.
//
// `--session` narrows the publish to one provider session instead of the
// agent's open AI tabs. Headless callers (Maestro Relay, playbooks, Cue, CI)
// hold a session id from `send -s <id>` and have no desktop tab, so without it
// they publish whatever unrelated conversation the agent has open.
//
// The desktop screens the transcript for secrets before it publishes. A finding
// refuses the gist and comes back masked; `--allow-secrets` is the CLI's form
// of the modal's "Publish anyway".

import { resolveAgentId } from '../services/storage';
import { withMaestroClient } from '../services/maestro-client';
import {
	isSecretScreenRefusal,
	secretScreenReportLines,
	SECRETS_FOUND_CODE,
	type SecretFinding,
} from '../../shared/secretScan';
import type { CreateGistResult } from '../../shared/gitUtils';
import { ExitCode, exitWith, exitCodeForError } from '../exit-codes';

interface GistCreateOptions {
	description?: string;
	public?: boolean;
	session?: string;
	allowSecrets?: boolean;
}

interface GistCreateResponse {
	success: boolean;
	agentId?: string;
	agentSessionId?: string;
	gistUrl?: string;
	error?: string;
	code?: string;
	/** Masked. Present when the secret screen refused the publish. */
	secretFindings?: SecretFinding[];
	secretScreenNote?: string;
}

function emitErrorJson(error: string, code: string, extra?: Partial<GistCreateResponse>): void {
	const payload: GistCreateResponse = { success: false, error, code, ...extra };
	console.log(JSON.stringify(payload, null, 2));
}

export async function gistCreate(agentIdArg: string, options: GistCreateOptions): Promise<void> {
	let agentId: string;
	try {
		agentId = resolveAgentId(agentIdArg);
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		emitErrorJson(msg, 'AGENT_NOT_FOUND');
		exitWith(exitCodeForError(error));
	}

	const description = options.description ?? '';
	const isPublic = Boolean(options.public);

	// Reject a blank `--session` rather than dropping it: falling through to the
	// agent's open tabs would publish a different conversation than the one the
	// caller named, and a gist is readable by anyone with the URL.
	const agentSessionId = options.session?.trim();
	if (options.session !== undefined && !agentSessionId) {
		emitErrorJson('--session requires a non-empty session id', 'INVALID_SESSION');
		exitWith(ExitCode.GeneralError);
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<CreateGistResult>(
				{
					type: 'create_gist',
					sessionId: agentId,
					description,
					isPublic,
					...(agentSessionId ? { agentSessionId } : {}),
					...(options.allowSecrets === true ? { allowSecrets: true } : {}),
				},
				'create_gist_result',
				60000
			)
		);

		if (isSecretScreenRefusal(result)) {
			// stdout stays one JSON document; the readable list goes to stderr.
			emitErrorJson(result.error ?? 'Possible secrets found', SECRETS_FOUND_CODE, {
				secretFindings: result.secretFindings,
				...(result.secretScreenNote ? { secretScreenNote: result.secretScreenNote } : {}),
			});
			for (const line of secretScreenReportLines(result)) console.error(line);
			exitWith(ExitCode.GeneralError);
		}

		if (!result.success || !result.gistUrl) {
			emitErrorJson(result.error ?? 'Failed to create gist', 'GIST_CREATE_FAILED');
			exitWith(ExitCode.GeneralError);
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
		exitWith(exitCodeForError(error));
	}
}
