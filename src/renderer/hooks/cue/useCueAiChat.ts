/**
 * useCueAiChat — Manages AI assist chat for the Cue YAML editor.
 *
 * Handles agent spawning, streaming responses, message state, and cleanup.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { buildSpawnConfigForAgent } from '../../utils/sessionHelpers';
import { prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';

const AI_SYSTEM_PROMPT = `You are configuring maestro-cue.yaml for the user. Be terse. Plain text only — no markdown, no code fences, no bullet lists, no formatting.

Event types: app.startup (fires once on application start, no extra fields), time.heartbeat (interval_minutes), time.scheduled (schedule_times array, optional schedule_days), file.changed (watch glob), agent.completed (source_session, optional fan_out), github.pull_request (poll_minutes, optional repo), github.issue (poll_minutes, optional repo), task.pending (watch glob, poll_minutes).

Optional filter block on any subscription: AND'd conditions on payload fields. Operators: exact string, "!value" negation, ">N"/"<N" numeric, glob patterns, boolean.

YAML structure:
subscriptions:
  - name: "descriptive name"
    event: <type>
    <type-specific fields>
    filter: {field: value}  # optional
    prompt: path/to/prompt.md
    enabled: true
settings:
  timeout_minutes: 30
  timeout_on_fail: break | continue
  max_concurrent: 1
  queue_size: 10

Multi-agent patterns: Startup (app.startup), Heartbeat (time.heartbeat), Scheduled (time.scheduled), File Enrichment (file.changed), Research Swarm (fan_out + fan-in), Sequential Chain (agent.completed chain), Debate (fan_out to opposing + fan-in to moderator), PR Review (github.pull_request), Issue Triage (github.issue), Task Queue (task.pending).

Edit the file directly using your tools. After editing, summarize what you changed in 1-2 short sentences. If you need clarification, ask briefly.`;

export interface ChatMessage {
	role: 'user' | 'assistant';
	text: string;
}

interface UseCueAiChatOptions {
	sessionId: string;
	projectRoot: string;
	isOpen: boolean;
	onYamlRefresh: () => void;
}

export function useCueAiChat({
	sessionId,
	projectRoot,
	isOpen,
	onYamlRefresh,
}: UseCueAiChatOptions) {
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	const [chatInput, setChatInput] = useState('');
	const [chatBusy, setChatBusy] = useState(false);
	const agentSessionIdRef = useRef<string | null>(null);
	const spawnSessionIdRef = useRef<string>(`${sessionId}-cue-assist-${Date.now()}`);
	const aiCleanupRef = useRef<(() => void)[]>([]);
	const aiResponseRef = useRef('');
	const chatEndRef = useRef<HTMLDivElement>(null);

	const session = useSessionStore(selectSessionById(sessionId));

	// Reset chat state when modal opens — clean up stale listeners first
	useEffect(() => {
		if (isOpen) {
			aiCleanupRef.current.forEach((fn) => fn());
			aiCleanupRef.current = [];
			setChatMessages([]);
			setChatInput('');
			setChatBusy(false);
			agentSessionIdRef.current = null;
			spawnSessionIdRef.current = `${sessionId}-cue-assist-${Date.now()}`;
		}
	}, [isOpen, sessionId]);

	// Cleanup AI assist listeners on unmount
	useEffect(() => {
		return () => {
			aiCleanupRef.current.forEach((fn) => fn());
			aiCleanupRef.current = [];
		};
	}, []);

	// Auto-scroll chat to bottom
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [chatMessages, chatBusy]);

	const handleChatSend = useCallback(async () => {
		const text = chatInput.trim();
		if (!text || !session || chatBusy) return;

		setChatInput('');
		setChatMessages((prev) => [...prev, { role: 'user', text }]);
		setChatBusy(true);
		aiResponseRef.current = '';

		const isFirstMessage = chatMessages.length === 0;
		const yamlPath = `${projectRoot}/.maestro/cue.yaml`;

		// First message gets system prompt + file path; follow-ups are just the user text
		const prompt = isFirstMessage
			? `${AI_SYSTEM_PROMPT}\n\nThe config file is at: ${yamlPath}\n\n${text}`
			: text;

		try {
			const appendSystemPrompt = await prepareMaestroSystemPrompt({
				session,
				agentSessionId: agentSessionIdRef.current,
			});

			const spawnConfig = await buildSpawnConfigForAgent({
				sessionId: spawnSessionIdRef.current,
				toolType: session.toolType,
				cwd: projectRoot,
				prompt,
				appendSystemPrompt,
				agentSessionId: agentSessionIdRef.current ?? undefined,
				sessionCustomPath: session.customPath,
				sessionCustomArgs: session.customArgs,
				sessionCustomEnvVars: session.customEnvVars,
				sessionCustomModel: session.customModel,
				sessionCustomContextWindow: session.customContextWindow,
				sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			});

			if (!spawnConfig) {
				setChatMessages((prev) => [
					...prev,
					{ role: 'assistant', text: 'Agent not available. Is the agent installed?' },
				]);
				setChatBusy(false);
				return;
			}

			// Register listeners before spawning
			const cleanupData = window.maestro.process.onData((sid: string, data: string) => {
				if (sid === spawnSessionIdRef.current) {
					aiResponseRef.current += data;
				}
			});
			aiCleanupRef.current.push(cleanupData);

			const cleanupSessionId = window.maestro.process.onSessionId(
				(sid: string, capturedId: string) => {
					if (sid === spawnSessionIdRef.current) {
						agentSessionIdRef.current = capturedId;
					}
				}
			);
			aiCleanupRef.current.push(cleanupSessionId);

			// Snapshot-and-clear pattern prevents double cleanup if both onExit and onAgentError fire
			const runCleanup = () => {
				const fns = aiCleanupRef.current;
				aiCleanupRef.current = [];
				fns.forEach((fn) => fn());
			};

			const cleanupExit = window.maestro.process.onExit((sid: string) => {
				if (sid === spawnSessionIdRef.current) {
					runCleanup();

					const response = aiResponseRef.current.trim() || 'Done.';
					setChatMessages((prev) => [...prev, { role: 'assistant', text: response }]);
					setChatBusy(false);

					// Refresh YAML from disk to pick up agent changes
					onYamlRefresh();
				}
			});
			aiCleanupRef.current.push(cleanupExit);

			const cleanupError = window.maestro.process.onAgentError(
				(sid: string, error: { message: string }) => {
					if (sid === spawnSessionIdRef.current) {
						const msg = error.message || 'Agent encountered an error.';
						setChatMessages((prev) => [...prev, { role: 'assistant', text: msg }]);
						setChatBusy(false);
						runCleanup();
					}
				}
			);
			aiCleanupRef.current.push(cleanupError);

			await window.maestro.process.spawn(spawnConfig);
		} catch {
			setChatMessages((prev) => [...prev, { role: 'assistant', text: 'Failed to start agent.' }]);
			setChatBusy(false);
			aiCleanupRef.current.forEach((fn) => fn());
			aiCleanupRef.current = [];
		}
	}, [chatInput, session, projectRoot, chatMessages.length, chatBusy, onYamlRefresh]);

	const handleChatKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleChatSend();
			}
		},
		[handleChatSend]
	);

	return {
		chatMessages,
		chatInput,
		setChatInput,
		chatBusy,
		chatEndRef,
		handleChatSend,
		handleChatKeyDown,
	};
}
