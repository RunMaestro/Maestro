// src/main/process-manager/spawners/AcpSpawner.ts

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { ACPProcess, type ACPProcessConfig } from '../../acp';
import type { ProcessConfig, ManagedProcess, SpawnResult, ParsedEvent } from '../types';

const LOG_CONTEXT = '[AcpSpawner]';

/**
 * Handles spawning of ACP (Agent Client Protocol) processes.
 * Used for agents that support the ACP protocol like OpenCode.
 *
 * ACP provides a standardized JSON-RPC based communication protocol
 * that eliminates the need for custom output parsers.
 */
export class AcpSpawner {
	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter
	) {}

	/**
	 * Spawn an ACP process for a session
	 */
	async spawn(config: ProcessConfig): Promise<SpawnResult> {
		const {
			sessionId,
			toolType,
			cwd,
			command,
			args,
			prompt,
			images,
			contextWindow,
			customEnvVars,
			acpSessionId,
			acpShowStreaming = true,
			acpArgs,
		} = config;

		logger.info(`${LOG_CONTEXT} Spawning ACP process`, LOG_CONTEXT, {
			sessionId,
			toolType,
			command,
			hasPrompt: !!prompt,
			hasImages: !!(images && images.length > 0),
			acpSessionId,
			acpShowStreaming,
		});

		try {
			// Convert base64 images to the format expected by ACP
			const acpImages = await this.convertImages(images);

			// Build ACP process config
			const acpConfig: ACPProcessConfig = {
				sessionId,
				toolType,
				cwd,
				command,
				args, // Pass through any custom args (SSH wrapper, etc.)
				acpArgs, // Agent-specific ACP args (e.g., ['acp'] for OpenCode, ['--acp'] for Gemini CLI)
				prompt,
				images: acpImages,
				acpSessionId,
				customEnvVars,
				contextWindow,
				// YOLO mode: auto-approve all permission requests
				// This matches the behavior of other agents in Maestro
				autoApprovePermissions: true,
				// OpenCode uses flat content blocks, other agents use spec format
				useFlatContentBlocks: toolType === 'opencode',
			};

			// Create and configure ACP process
			const acpProcess = new ACPProcess(acpConfig);

			// Create managed process entry
			const managedProcess: ManagedProcess = {
				sessionId,
				toolType,
				acpProcess,
				cwd,
				pid: -1, // Will be updated after start
				isTerminal: false,
				isBatchMode: true,
				isAcpMode: true,
				acpShowStreaming,
				startTime: Date.now(),
				contextWindow,
				command,
				args,
				querySource: config.querySource,
				tabId: config.tabId,
				projectPath: config.projectPath,
				sshRemoteId: config.sshRemoteId,
				sshRemoteHost: config.sshRemoteHost,
			};

			this.processes.set(sessionId, managedProcess);

			// Wire up ACP events to ProcessManager events
			this.setupEventHandlers(acpProcess, sessionId, acpShowStreaming);

			// Start the ACP process
			const result = await acpProcess.start();

			// Update PID after start
			managedProcess.pid = result.pid;

			logger.info(`${LOG_CONTEXT} ACP process started`, LOG_CONTEXT, {
				sessionId,
				pid: result.pid,
				success: result.success,
			});

			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`${LOG_CONTEXT} Failed to spawn ACP process: ${message}`, LOG_CONTEXT, {
				sessionId,
			});

			// Emit error and exit events
			this.emitter.emit('agent-error', sessionId, {
				type: 'unknown',
				message,
				recoverable: false,
			});
			this.emitter.emit('exit', sessionId, 1);

			return { pid: -1, success: false };
		}
	}

	/**
	 * Convert base64 image strings to ACP image format
	 */
	private async convertImages(
		images?: string[]
	): Promise<Array<{ data: string; mimeType: string }> | undefined> {
		if (!images || images.length === 0) {
			return undefined;
		}

		const acpImages: Array<{ data: string; mimeType: string }> = [];

		for (const image of images) {
			// Check if it's a base64 data URL
			const dataUrlMatch = image.match(/^data:([^;]+);base64,(.+)$/);
			if (dataUrlMatch) {
				acpImages.push({
					mimeType: dataUrlMatch[1],
					data: dataUrlMatch[2],
				});
			} else if (image.startsWith('/') || image.match(/^[A-Za-z]:\\/)) {
				// It's a file path - read and convert to base64
				try {
					const fileBuffer = fs.readFileSync(image);
					const base64Data = fileBuffer.toString('base64');
					const ext = path.extname(image).toLowerCase();
					const mimeType = this.getMimeType(ext);
					acpImages.push({
						mimeType,
						data: base64Data,
					});
				} catch (err) {
					logger.warn(`${LOG_CONTEXT} Failed to read image file: ${image}`, LOG_CONTEXT, {
						error: String(err),
					});
				}
			} else {
				// Assume it's raw base64 data
				acpImages.push({
					mimeType: 'image/png', // Default to PNG
					data: image,
				});
			}
		}

		return acpImages.length > 0 ? acpImages : undefined;
	}

	/**
	 * Get MIME type from file extension
	 */
	private getMimeType(ext: string): string {
		const mimeTypes: Record<string, string> = {
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.gif': 'image/gif',
			'.webp': 'image/webp',
			'.svg': 'image/svg+xml',
		};
		return mimeTypes[ext] || 'image/png';
	}

	/**
	 * Set up event handlers to bridge ACP events to ProcessManager events
	 */
	private setupEventHandlers(
		acpProcess: ACPProcess,
		sessionId: string,
		showStreaming: boolean
	): void {
		// Handle parsed data events from ACP
		acpProcess.on('data', (_sid: string, event: ParsedEvent) => {
			// For 'text' events, only emit if streaming is enabled
			// The 'result' event will contain the final text regardless
			if (event.type === 'text' && !showStreaming) {
				logger.debug(
					`${LOG_CONTEXT} Suppressing streaming text (acpShowStreaming=false)`,
					LOG_CONTEXT,
					{
						sessionId,
						textLength: event.text?.length,
					}
				);
				return;
			}

			// Emit the parsed event directly - ACP already produces ParsedEvent objects
			this.emitter.emit('data', sessionId, event);

			// Also emit specific events based on event type
			switch (event.type) {
				case 'init':
					// Session ID is provided in the 'init' event
					if (event.sessionId) {
						this.emitter.emit('session-id', sessionId, event.sessionId);
					}
					break;
				case 'usage':
					if (event.usage) {
						this.emitter.emit('usage', sessionId, event.usage);
					}
					break;
				case 'tool_use':
					// Tool execution events - emit tool-execution for UI
					if (event.toolName && event.toolState) {
						this.emitter.emit('tool-execution', sessionId, {
							toolName: event.toolName,
							state: event.toolState,
							timestamp: Date.now(),
						});
					}
					break;
			}
		});

		// Handle agent errors
		acpProcess.on('agent-error', (_sid: string, error: unknown) => {
			this.emitter.emit('agent-error', sessionId, error);
		});

		// Handle process exit
		acpProcess.on('exit', (_sid: string, code: number) => {
			const managedProcess = this.processes.get(sessionId);

			// Emit query-complete event for stats tracking
			if (managedProcess) {
				this.emitter.emit('query-complete', sessionId, {
					sessionId,
					agentType: managedProcess.toolType,
					source: managedProcess.querySource || 'user',
					startTime: managedProcess.startTime,
					duration: Date.now() - managedProcess.startTime,
					projectPath: managedProcess.projectPath,
					tabId: managedProcess.tabId,
				});
			}

			this.emitter.emit('exit', sessionId, code);
			this.processes.delete(sessionId);
		});
	}
}
