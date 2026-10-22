// src/main/codex-app-server/server-requests.ts

/**
 * Answers for the REQUESTS `codex app-server` sends the client.
 *
 * A server request the client never answers stalls the turn forever, so every
 * one gets an answer the moment it arrives: a policy result for the methods
 * below, and a JSON-RPC error for anything else. The policy is the table in
 * `docs/agent-guides/CODEX-APP-SERVER.md` ("Server-to-client requests"):
 *
 * - With full access (exec's `--dangerously-bypass-approvals-and-sandbox`)
 *   every approval is granted, because exec never asks.
 * - Otherwise every approval is declined, the way `--sandbox read-only`
 *   refuses: the model is told and carries on.
 * - Questions for a human (`requestUserInput`, MCP elicitations) get an empty
 *   answer either way. Nobody is being shown them, so declining lets the turn
 *   continue instead of waiting on a prompt no one can see.
 *
 * Pure, so the whole table is unit-testable without a process.
 */

import type { CodexAppServerRequest, CodexRpcError } from './protocol';

/** JSON-RPC "method not found". */
export const CODEX_RPC_METHOD_NOT_FOUND = -32601;

export type CodexServerRequestAnswer = { result: unknown } | { error: CodexRpcError };

export interface CodexServerRequestPolicy {
	/** True when the turn runs with `danger-full-access`: grant every approval. */
	grantApprovals: boolean;
}

export function answerCodexServerRequest(
	request: CodexAppServerRequest,
	policy: CodexServerRequestPolicy
): CodexServerRequestAnswer {
	const grant = policy.grantApprovals;
	switch (request.method) {
		case 'item/commandExecution/requestApproval':
		case 'item/fileChange/requestApproval':
			return { result: { decision: grant ? 'accept' : 'decline' } };

		case 'item/permissions/requestApproval': {
			if (!grant) return { result: { permissions: {} } };
			const requested = (request.params as { permissions?: unknown } | undefined)?.permissions;
			return { result: { permissions: requested ?? {}, scope: 'turn' } };
		}

		case 'execCommandApproval':
		case 'applyPatchApproval':
			return { result: { decision: grant ? 'approved' : 'denied' } };

		case 'item/tool/requestUserInput':
			return { result: { answers: {} } };

		case 'mcpServer/elicitation/request':
			return { result: { action: 'decline' } };

		case 'item/tool/call':
			return { result: { success: false, contentItems: [] } };

		default:
			// Includes `account/chatgptAuthTokens/refresh` and
			// `attestation/generate`, which Maestro cannot satisfy.
			return {
				error: {
					code: CODEX_RPC_METHOD_NOT_FOUND,
					message: `Maestro does not handle ${request.method}`,
				},
			};
	}
}
