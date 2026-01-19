/**
 * @file group-chat-test-utils.ts
 * @description Test utilities for Group Chat integration tests.
 *
 * These utilities provide:
 * - Agent selection helpers for test roles
 * - Response waiting utilities with timeouts
 * - Cleanup functions for test isolation
 */

import { loadGroupChat, deleteGroupChat } from '../../main/group-chat/group-chat-storage';
import { readLog } from '../../main/group-chat/group-chat-log';
import { killModerator } from '../../main/group-chat/group-chat-moderator';

/**
 * Selection of agents for integration test roles.
 */
export interface TestAgentSelection {
	moderator: string;
	agentA: string;
	agentB: string;
}

/**
 * Get available agents on the system.
 * This would typically call the agent detector, but for integration tests
 * we need to access the main process APIs.
 */
export async function getAvailableAgents(): Promise<string[]> {
	// In a real integration test environment, this would call the agent detector
	// For now, we return common agents that might be available
	// The actual implementation would integrate with the electron main process
	const potentialAgents = ['claude-code', 'opencode'];

	// In practice, you'd check which are actually installed
	// For integration tests, we assume at least one is available
	return potentialAgents;
}

/**
 * Randomly select agents for test roles.
 *
 * @param available - Array of available agent IDs
 * @returns Selection of agents for moderator and participant roles
 */
export function selectTestAgents(available: string[]): TestAgentSelection {
	if (available.length === 0) {
		throw new Error('No agents available for testing');
	}

	const shuffled = [...available].sort(() => Math.random() - 0.5);
	return {
		moderator: shuffled[0],
		agentA: shuffled[Math.min(1, shuffled.length - 1)],
		agentB: shuffled[Math.min(2, shuffled.length - 1)],
	};
}

/**
 * Wait for a response from a specific participant in the chat log.
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the participant to wait for
 * @param timeoutMs - Maximum time to wait (default: 60 seconds)
 * @returns The content of the participant's response
 * @throws Error if timeout is reached
 */
export async function waitForAgentResponse(
	groupChatId: string,
	participantName: string,
	timeoutMs: number = 60000
): Promise<string> {
	const startTime = Date.now();
	const chat = await loadGroupChat(groupChatId);

	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	let lastMessageCount = (await readLog(chat.logPath)).length;

	while (Date.now() - startTime < timeoutMs) {
		const messages = await readLog(chat.logPath);
		const newMessages = messages.slice(lastMessageCount);
		const agentMsg = newMessages.find((m) => m.from === participantName);

		if (agentMsg) {
			return agentMsg.content;
		}

		// Update count to avoid re-checking old messages
		if (messages.length > lastMessageCount) {
			lastMessageCount = messages.length;
		}

		// Poll every 500ms
		await new Promise((r) => setTimeout(r, 500));
	}

	throw new Error(`Timeout waiting for ${participantName} response after ${timeoutMs}ms`);
}

/**
 * Wait for moderator response.
 *
 * @param groupChatId - The ID of the group chat
 * @param timeoutMs - Maximum time to wait (default: 30 seconds)
 * @returns The content of the moderator's response
 */
export async function waitForModeratorResponse(
	groupChatId: string,
	timeoutMs: number = 30000
): Promise<string> {
	return waitForAgentResponse(groupChatId, 'moderator', timeoutMs);
}

/**
 * Extract the first number from text.
 *
 * @param text - The text to search
 * @returns The first number found
 * @throws Error if no number is found
 */
export function extractNumber(text: string): number {
	const match = text.match(/\d+/);
	if (!match) {
		throw new Error(`No number found in: ${text}`);
	}
	return parseInt(match[0], 10);
}

/**
 * Clean up a group chat after test.
 * Attempts to kill the moderator and delete all group chat data.
 *
 * @param id - The ID of the group chat to clean up
 */
export async function cleanupGroupChat(id: string): Promise<void> {
	try {
		// Try to kill the moderator if active
		await killModerator(id);
	} catch {
		// Ignore errors - moderator might not be active
	}

	try {
		// Delete all group chat data
		await deleteGroupChat(id);
	} catch {
		// Ignore errors - chat might already be deleted
	}
}

/**
 * Check if integration tests should be skipped.
 * Integration tests are skipped when SKIP_INTEGRATION_TESTS is set.
 */
export function shouldSkipIntegrationTests(): boolean {
	return process.env.SKIP_INTEGRATION_TESTS === 'true';
}

/**
 * Wait for a condition to become true with polling.
 *
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait
 * @param pollIntervalMs - How often to check the condition
 * @returns Promise that resolves when condition is true
 * @throws Error on timeout
 */
export async function waitForCondition(
	condition: () => Promise<boolean> | boolean,
	timeoutMs: number = 30000,
	pollIntervalMs: number = 500
): Promise<void> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		if (await condition()) {
			return;
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}

	throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Get all messages from a participant in the chat log.
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the participant
 * @returns Array of messages from that participant
 */
export async function getParticipantMessages(
	groupChatId: string,
	participantName: string
): Promise<string[]> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	const messages = await readLog(chat.logPath);
	return messages.filter((m) => m.from === participantName).map((m) => m.content);
}
