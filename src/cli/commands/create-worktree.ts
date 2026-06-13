// Create-worktree command - create a new agent in a git worktree branched off
// an existing parent agent, without requiring an Auto Run playbook.
//
// Mirrors the desktop "create worktree" flow: the parent agent must already
// exist in the running Maestro app; the desktop creates the worktree on disk,
// builds a child session linked to the parent, and returns the new agent ID.
//
// An optional --message is then delivered to the new agent as a plain prompt
// (not an Auto Run loop) over the SAME live connection, addressing the agent by
// the id the desktop just returned. We deliberately do NOT route this through
// the `dispatch` command: dispatch re-resolves the agent against the CLI's
// persisted sessions file, but a freshly created worktree agent only exists in
// the desktop's in-memory store until its debounced persistence flushes - so
// disk resolution would race and intermittently fail with "Agent not found".
// The desktop resolves send_command against live state, so it always sees it.

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';

interface CreateWorktreeOptions {
	agent?: string;
	branch?: string;
	baseBranch?: string;
	message?: string;
	json?: boolean;
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<void> {
	const json = !!options.json;
	const fail = (msg: string): never => {
		if (json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(`Error: ${msg}`);
		}
		process.exit(1);
	};

	if (!options.branch || options.branch.trim() === '') {
		return fail('--branch <name> is required');
	}

	// Resolve the parent agent (supports partial IDs); exits with a friendly
	// message if the agent is ambiguous or not found.
	const parentSessionId = resolveTargetSessionId(options.agent);
	const branchName = options.branch.trim();
	const message = options.message?.trim();

	try {
		const { created, dispatched } = await withMaestroClient(async (client) => {
			const createdResult = await client.sendCommand<{
				type: string;
				success: boolean;
				sessionId?: string;
				error?: string;
			}>(
				{
					type: 'create_worktree_session',
					parentSessionId,
					branchName,
					baseBranch: options.baseBranch?.trim() || undefined,
				},
				'create_worktree_session_result'
			);

			// Deliver the optional initial prompt on the same connection, using the
			// authoritative id the desktop just handed back.
			let dispatchedResult: { tabId?: string } | undefined;
			if (createdResult.success && createdResult.sessionId && message) {
				dispatchedResult = await client.sendCommand<{ tabId?: string }>(
					{
						type: 'send_command',
						sessionId: createdResult.sessionId,
						command: message,
						inputMode: 'ai',
					},
					'command_result'
				);
			}

			return { created: createdResult, dispatched: dispatchedResult };
		});

		if (!created.success || !created.sessionId) {
			return fail(created.error || 'Failed to create worktree agent');
		}

		const newAgentId = created.sessionId;

		if (json) {
			console.log(
				JSON.stringify({
					success: true,
					agentId: newAgentId,
					branch: branchName,
					...(message ? { messageDispatched: true, tabId: dispatched?.tabId ?? null } : {}),
				})
			);
		} else {
			console.log(`Created worktree agent on branch "${branchName}"`);
			console.log(`  ID: ${newAgentId}`);
			if (message) {
				console.log(
					`  Dispatched initial message${dispatched?.tabId ? ` (tab: ${dispatched.tabId})` : ''}`
				);
			}
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
