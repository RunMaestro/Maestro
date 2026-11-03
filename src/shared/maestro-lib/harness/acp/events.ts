import type { SessionNotification } from '@agentclientprotocol/sdk';

export interface AcpTranslationResult {
	lines: string[];
}

/** ACP v1 session updates to the small JSONL vocabulary AcpOutputParser consumes. */
export class AcpEventTranslator {
	private assistantText = '';
	private thoughtText = '';

	/** Aggregated assistant text across all message chunks in the turn. */
	get finalText(): string {
		return this.assistantText;
	}

	/** Aggregated reasoning text across all thought chunks in the turn. */
	get finalThought(): string {
		return this.thoughtText;
	}

	/** Translate one ACP session update into the renderer's existing JSONL event vocabulary. */
	handle(notification: SessionNotification): AcpTranslationResult {
		const { sessionId, update } = notification;
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				if (update.content.type !== 'text') return { lines: [] };
				this.assistantText += update.content.text;
				return {
					lines: [JSON.stringify({ type: 'acp.text', sessionId, text: update.content.text })],
				};
			case 'agent_thought_chunk':
				if (update.content.type !== 'text') return { lines: [] };
				this.thoughtText += update.content.text;
				return {
					lines: [
						JSON.stringify({
							type: 'acp.text',
							sessionId,
							text: update.content.text,
							reasoning: true,
						}),
					],
				};
			case 'tool_call':
			case 'tool_call_update':
				return {
					lines: [
						JSON.stringify({
							type: 'acp.tool',
							sessionId,
							toolCallId: update.toolCallId,
							toolName: update.name ?? update.title ?? update.kind ?? 'tool',
							state: update,
						}),
					],
				};
			case 'available_commands_update':
				return {
					lines: [
						JSON.stringify({
							type: 'acp.commands',
							sessionId,
							commands: update.availableCommands.map((command) => `/${command.name}`),
						}),
					],
				};
			case 'usage_update':
				return {
					lines: [
						JSON.stringify({
							type: 'acp.usage',
							sessionId,
							usage: {
								contextUsed: update.used,
								contextWindow: update.size,
								costUsd: update.cost?.amount,
							},
						}),
					],
				};
			default:
				return { lines: [JSON.stringify({ type: 'acp.system', sessionId, update })] };
		}
	}
}
