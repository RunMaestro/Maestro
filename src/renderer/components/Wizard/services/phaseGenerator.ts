/**
 * phaseGenerator.ts
 *
 * Service for generating Auto Run documents based on the wizard's
 * project discovery conversation. Creates actionable task lists organized
 * into phases, with Phase 1 designed to be completable without user input.
 */

import type { ToolType } from '../../../types';
import type { WizardMessage, GeneratedDocument } from '../WizardContext';
import { wizardDocumentGenerationPrompt } from '../../../../prompts';
import {
	substituteTemplateVariables,
	type TemplateContext,
} from '../../../utils/templateVariables';

/**
 * Configuration for document generation
 */
export interface GenerationConfig {
	/** Agent type to use for generation */
	agentType: ToolType;
	/** Working directory for the agent */
	directoryPath: string;
	/** Project name from wizard */
	projectName: string;
	/** Full conversation history from project discovery */
	conversationHistory: WizardMessage[];
	/** Optional subfolder within Auto Run Docs (e.g., "Initiation") */
	subfolder?: string;
}

/**
 * Result of document generation
 */
export interface GenerationResult {
	/** Whether generation was successful */
	success: boolean;
	/** Generated documents (if successful) */
	documents?: GeneratedDocument[];
	/** Error message (if failed) */
	error?: string;
	/** Raw agent output (for debugging) */
	rawOutput?: string;
	/** Whether documents were read from disk (already saved, no need to save again) */
	documentsFromDisk?: boolean;
}

/**
 * Info about a file being created
 */
export interface CreatedFileInfo {
	filename: string;
	size: number;
	path: string;
	timestamp: number;
	/** Brief description extracted from file content (first paragraph after title) */
	description?: string;
	/** Number of tasks (unchecked checkboxes) in the document */
	taskCount?: number;
}

/**
 * Extract a brief description from markdown content
 * Looks for the first paragraph after the title heading
 */
function extractDescription(content: string): string | undefined {
	// Split into lines and find content after the first heading
	const lines = content.split('\n');
	let foundHeading = false;
	const descriptionLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip empty lines before we find the heading
		if (!foundHeading) {
			if (trimmed.startsWith('# ')) {
				foundHeading = true;
			}
			continue;
		}

		// Skip empty lines after heading
		if (trimmed === '' && descriptionLines.length === 0) {
			continue;
		}

		// Stop at next heading or task section
		if (trimmed.startsWith('#') || trimmed.startsWith('- [')) {
			break;
		}

		// Collect description lines (stop at empty line if we have content)
		if (trimmed === '' && descriptionLines.length > 0) {
			break;
		}

		descriptionLines.push(trimmed);
	}

	const description = descriptionLines.join(' ').trim();

	// Truncate if too long
	if (description.length > 150) {
		return description.substring(0, 147) + '...';
	}

	return description || undefined;
}

/**
 * Callbacks for generation progress
 */
export interface GenerationCallbacks {
	/** Called when generation starts */
	onStart?: () => void;
	/** Called with progress updates */
	onProgress?: (message: string) => void;
	/** Called with output chunks (for streaming display) */
	onChunk?: (chunk: string) => void;
	/** Called when a file is created/saved */
	onFileCreated?: (file: CreatedFileInfo) => void;
	/** Called when generation completes */
	onComplete?: (result: GenerationResult) => void;
	/** Called on error */
	onError?: (error: string) => void;
	/** Called when activity occurs (data chunk or file change) - allows external timeout reset */
	onActivity?: () => void;
}

/**
 * Parsed document from agent output
 */
interface ParsedDocument {
	filename: string;
	content: string;
	phase: number;
}

/**
 * Default Auto Run folder name
 */
export const AUTO_RUN_FOLDER_NAME = 'Auto Run Docs';

/**
 * Sanitize a filename to prevent path traversal attacks.
 * Removes path separators, directory traversal sequences, and other dangerous characters.
 *
 * @param filename - The raw filename from AI-generated output
 * @returns A safe filename with dangerous characters removed
 */
export function sanitizeFilename(filename: string): string {
	return (
		filename
			// Remove path separators (both Unix and Windows)
			.replace(/[\/\\]/g, '-')
			// Remove directory traversal sequences
			.replace(/\.\./g, '')
			// Remove null bytes and control characters
			.replace(/[\x00-\x1f\x7f]/g, '')
			// Remove leading dots (hidden files / relative paths)
			.replace(/^\.+/, '')
			// Remove leading/trailing whitespace
			.trim() ||
		// Ensure we have something left, default to 'document' if empty
		'document'
	);
}

/**
 * Generation timeout in milliseconds (20 minutes - large codebases need time for exploration)
 */
const GENERATION_TIMEOUT = 1200000;

/**
 * Debug log entry for wizard troubleshooting
 */
export interface WizardDebugLogEntry {
	timestamp: number;
	type: 'info' | 'warn' | 'error' | 'data' | 'file' | 'timeout' | 'spawn' | 'exit';
	message: string;
	data?: Record<string, unknown>;
}

/**
 * Debug log collector for wizard generation
 * Collects detailed logs that can be downloaded for troubleshooting
 */
class WizardDebugLogger {
	private logs: WizardDebugLogEntry[] = [];
	private maxLogs = 10000; // Prevent memory issues
	private startTime: number = 0;
	private configSnapshot: Record<string, unknown> = {};

	/**
	 * Start a new generation session
	 */
	startSession(config: GenerationConfig): void {
		this.logs = [];
		this.startTime = Date.now();
		this.configSnapshot = {
			agentType: config.agentType,
			directoryPath: config.directoryPath,
			projectName: config.projectName,
			conversationHistoryLength: config.conversationHistory.length,
			conversationHistoryPreview: config.conversationHistory.slice(0, 3).map((m) => ({
				role: m.role,
				contentLength: m.content.length,
				preview: m.content.slice(0, 100),
			})),
		};
		this.log('info', 'Generation session started', this.configSnapshot);
	}

	/**
	 * Add a log entry
	 */
	log(type: WizardDebugLogEntry['type'], message: string, data?: Record<string, unknown>): void {
		if (this.logs.length >= this.maxLogs) {
			// Remove oldest entries to make room
			this.logs = this.logs.slice(-Math.floor(this.maxLogs * 0.9));
		}

		this.logs.push({
			timestamp: Date.now(),
			type,
			message,
			data,
		});
	}

	/**
	 * Get elapsed time since session start
	 */
	getElapsedMs(): number {
		return Date.now() - this.startTime;
	}

	/**
	 * Export logs as a downloadable JSON blob
	 */
	exportLogs(): {
		sessionInfo: Record<string, unknown>;
		logs: WizardDebugLogEntry[];
		summary: Record<string, unknown>;
	} {
		const summary = {
			totalLogs: this.logs.length,
			elapsedMs: this.getElapsedMs(),
			logsByType: this.logs.reduce(
				(acc, log) => {
					acc[log.type] = (acc[log.type] || 0) + 1;
					return acc;
				},
				{} as Record<string, number>
			),
			dataChunksReceived: this.logs.filter((l) => l.type === 'data').length,
			filesDetected: this.logs.filter((l) => l.type === 'file').length,
			errors: this.logs.filter((l) => l.type === 'error').map((l) => l.message),
		};

		return {
			sessionInfo: {
				...this.configSnapshot,
				startTime: this.startTime,
				exportTime: Date.now(),
				userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
				platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
			},
			logs: this.logs,
			summary,
		};
	}

	/**
	 * Download logs as a JSON file
	 */
	downloadLogs(): void {
		const data = this.exportLogs();
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wizard-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	/**
	 * Get the current logs (for display or analysis)
	 */
	getLogs(): WizardDebugLogEntry[] {
		return [...this.logs];
	}

	/**
	 * Clear all logs
	 */
	clear(): void {
		this.logs = [];
		this.startTime = 0;
		this.configSnapshot = {};
	}
}

// Singleton debug logger instance
export const wizardDebugLogger = new WizardDebugLogger();

/**
 * Generate the system prompt for document generation
 *
 * This prompt instructs the agent to:
 * - Create multiple Auto Run documents
 * - Make Phase 1 achievable without user input
 * - Make Phase 1 deliver a working prototype
 * - Use checkbox task format
 * - Name files as Phase-XX-Description.md
 */
export function generateDocumentGenerationPrompt(config: GenerationConfig): string {
	const { projectName, directoryPath, conversationHistory, subfolder } = config;
	const projectDisplay = projectName || 'this project';

	// Build conversation summary
	const conversationSummary = conversationHistory
		.filter((msg) => msg.role === 'user' || msg.role === 'assistant')
		.map((msg) => {
			const prefix = msg.role === 'user' ? 'User' : 'Assistant';
			return `${prefix}: ${msg.content}`;
		})
		.join('\n\n');

	// Build the full Auto Run folder path (including subfolder if specified)
	const autoRunFolderPath = subfolder
		? `${AUTO_RUN_FOLDER_NAME}/${subfolder}`
		: AUTO_RUN_FOLDER_NAME;

	// First, handle wizard-specific variables that have different semantics
	// from the central template system. We do this BEFORE the central function
	// so they take precedence over central defaults.
	let prompt = wizardDocumentGenerationPrompt
		.replace(/\{\{PROJECT_NAME\}\}/gi, projectDisplay)
		.replace(/\{\{DIRECTORY_PATH\}\}/gi, directoryPath)
		.replace(/\{\{AUTO_RUN_FOLDER_NAME\}\}/gi, autoRunFolderPath)
		.replace(/\{\{CONVERSATION_SUMMARY\}\}/gi, conversationSummary);

	// Build template context for remaining variables (date/time, etc.)
	const templateContext: TemplateContext = {
		session: {
			id: 'wizard-gen',
			name: projectDisplay,
			toolType: 'claude-code',
			cwd: directoryPath,
			fullPath: directoryPath,
		},
	};

	// Substitute any remaining template variables using the central function
	prompt = substituteTemplateVariables(prompt, templateContext);

	return prompt;
}

/**
 * Parse the agent's output to extract individual documents
 */
export function parseGeneratedDocuments(output: string): ParsedDocument[] {
	const documents: ParsedDocument[] = [];

	// Pattern to match document blocks
	const docPattern =
		/---BEGIN DOCUMENT---\s*\nFILENAME:\s*(.+?)\s*\nCONTENT:\s*\n([\s\S]*?)(?=---END DOCUMENT---|$)/g;

	let match;
	while ((match = docPattern.exec(output)) !== null) {
		const filename = match[1].trim();
		let content = match[2].trim();

		// Remove any trailing ---END DOCUMENT--- marker from content
		content = content.replace(/---END DOCUMENT---\s*$/, '').trim();

		// Extract phase number from filename (Phase-01-..., Phase-02-..., etc.)
		const phaseMatch = filename.match(/Phase-(\d+)/i);
		const phase = phaseMatch ? parseInt(phaseMatch[1], 10) : 0;

		if (filename && content) {
			documents.push({
				filename,
				content,
				phase,
			});
		}
	}

	// Sort by phase number
	documents.sort((a, b) => a.phase - b.phase);

	return documents;
}

/**
 * Count tasks in a document
 */
export function countTasks(content: string): number {
	const taskPattern = /^-\s*\[\s*[xX ]?\s*\]/gm;
	const matches = content.match(taskPattern);
	return matches ? matches.length : 0;
}

/**
 * Validate that generated documents have proper structure
 */
export function validateDocuments(documents: ParsedDocument[]): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (documents.length === 0) {
		errors.push('No documents were generated');
		return { valid: false, errors };
	}

	// Check each document
	for (const doc of documents) {
		const taskCount = countTasks(doc.content);

		if (taskCount === 0) {
			errors.push(`${doc.filename} has no tasks (checkbox items)`);
		}

		// Check for required structure
		if (!doc.content.includes('# Phase')) {
			errors.push(`${doc.filename} is missing a phase header`);
		}

		if (!doc.content.includes('## Tasks')) {
			errors.push(`${doc.filename} is missing a Tasks section`);
		}
	}

	// Ensure we have a Phase 1
	const hasPhase1 = documents.some((d) => d.phase === 1);
	if (!hasPhase1) {
		errors.push('No Phase 1 document was generated');
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Intelligent splitting of a single large document into phases
 *
 * If the agent generates one large document instead of multiple phases,
 * this function attempts to split it intelligently.
 */
export function splitIntoPhases(content: string): ParsedDocument[] {
	const documents: ParsedDocument[] = [];

	// Try to find phase-like sections within the content
	const phaseSectionPattern =
		/(?:^|\n)(#{1,2}\s*Phase\s*\d+[^\n]*)\n([\s\S]*?)(?=\n#{1,2}\s*Phase\s*\d+|$)/gi;

	let match;
	let phaseNumber = 1;

	while ((match = phaseSectionPattern.exec(content)) !== null) {
		const header = match[1].trim();
		const sectionContent = match[2].trim();

		// Create a proper document from this section
		const fullContent = `${header}\n\n${sectionContent}`;

		// Try to extract a description from the header
		const descMatch = header.match(/Phase\s*\d+[:\s-]*(.*)/i);
		const description =
			descMatch && descMatch[1].trim()
				? descMatch[1]
						.trim()
						.replace(/[^a-zA-Z0-9\s-]/g, '')
						.trim()
						.replace(/\s+/g, '-')
				: 'Tasks';

		documents.push({
			filename: `Phase-${String(phaseNumber).padStart(2, '0')}-${description}.md`,
			content: fullContent,
			phase: phaseNumber,
		});

		phaseNumber++;
	}

	// If no phase sections found, treat the whole content as Phase 1
	if (documents.length === 0 && content.trim()) {
		documents.push({
			filename: 'Phase-01-Initial-Setup.md',
			content: content.trim(),
			phase: 1,
		});
	}

	return documents;
}

/**
 * Extract the result from Claude's stream-json format
 */
function extractResultFromStreamJson(output: string): string | null {
	try {
		const lines = output.split('\n');
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.type === 'result' && msg.result) {
					return msg.result;
				}
			} catch {
				// Ignore non-JSON lines
			}
		}
	} catch {
		// Fallback to raw output
	}
	return null;
}

/**
 * PhaseGenerator class
 *
 * Manages the document generation process, including:
 * - Spawning the agent with the generation prompt
 * - Parsing and validating generated documents
 * - Saving documents to the Auto Run folder
 */
class PhaseGenerator {
	private isGenerating = false;
	private outputBuffer = '';
	private dataListenerCleanup?: () => void;
	private exitListenerCleanup?: () => void;
	private currentWatchPath?: string;

	/**
	 * Generate Auto Run documents based on the project discovery conversation
	 */
	async generateDocuments(
		config: GenerationConfig,
		callbacks?: GenerationCallbacks
	): Promise<GenerationResult> {
		if (this.isGenerating) {
			wizardDebugLogger.log('warn', 'Generation already in progress, rejecting new request');
			return {
				success: false,
				error: 'Generation already in progress',
			};
		}

		this.isGenerating = true;
		this.outputBuffer = '';

		// Start debug logging session
		wizardDebugLogger.startSession(config);

		callbacks?.onStart?.();
		callbacks?.onProgress?.('Preparing to generate your Playbook...');

		try {
			// Get the agent configuration
			wizardDebugLogger.log('info', 'Fetching agent configuration', {
				agentType: config.agentType,
			});
			const agent = await window.maestro.agents.get(config.agentType);
			if (!agent || !agent.available) {
				wizardDebugLogger.log('error', 'Agent not available', {
					agentType: config.agentType,
					agent,
				});
				throw new Error(`Agent ${config.agentType} is not available`);
			}
			wizardDebugLogger.log('info', 'Agent configuration retrieved', {
				command: agent.command,
				argsCount: agent.args?.length || 0,
			});

			// Generate the prompt
			const prompt = generateDocumentGenerationPrompt(config);
			wizardDebugLogger.log('info', 'Document generation prompt created', {
				promptLength: prompt.length,
				promptPreview: prompt.slice(0, 200),
			});

			callbacks?.onProgress?.('Generating Auto Run Documents...');

			// Spawn the agent and wait for completion
			wizardDebugLogger.log('info', 'Starting agent run');
			const result = await this.runAgent(agent, config, prompt, callbacks);

			if (!result.success) {
				wizardDebugLogger.log('error', 'Agent run failed', {
					error: result.error,
					rawOutputLength: result.rawOutput?.length || 0,
				});
				callbacks?.onError?.(result.error || 'Generation failed');
				return result;
			}

			wizardDebugLogger.log('info', 'Agent run completed successfully', {
				rawOutputLength: result.rawOutput?.length || 0,
			});

			// Parse the output
			callbacks?.onProgress?.('Parsing generated documents...');

			const rawOutput = result.rawOutput || '';
			wizardDebugLogger.log('info', 'Parsing raw output', {
				rawOutputLength: rawOutput.length,
				rawOutputPreview: rawOutput.slice(0, 500),
			});
			let documents = parseGeneratedDocuments(rawOutput);
			let documentsFromDisk = false;

			wizardDebugLogger.log('info', 'Initial document parsing result', {
				documentsFound: documents.length,
				documentNames: documents.map((d) => d.filename),
			});

			// If no documents parsed with markers, try splitting intelligently
			if (documents.length === 0 && rawOutput.trim()) {
				callbacks?.onProgress?.('Processing document structure...');
				wizardDebugLogger.log('info', 'No documents parsed with markers, trying splitIntoPhases');
				documents = splitIntoPhases(rawOutput);
				wizardDebugLogger.log('info', 'splitIntoPhases result', {
					documentsFound: documents.length,
					documentNames: documents.map((d) => d.filename),
				});
			}

			// Validate that parsed documents contain actual tasks
			// If the agent wrote files directly to disk (Claude Code's normal behavior),
			// the rawOutput won't contain document content, just status messages.
			// splitIntoPhases would create a single document from that status text,
			// which wouldn't contain any valid tasks.
			const totalTasksFromParsed = documents.reduce((sum, doc) => sum + countTasks(doc.content), 0);
			const hasValidParsedDocs = documents.length > 0 && totalTasksFromParsed > 0;

			wizardDebugLogger.log('info', 'Task count from parsed documents', {
				totalTasksFromParsed,
				hasValidParsedDocs,
			});

			// Check for files on disk if:
			// 1. No documents were parsed at all, OR
			// 2. Parsed documents don't contain valid tasks (likely just status output)
			if (!hasValidParsedDocs) {
				callbacks?.onProgress?.('Checking for documents on disk...');
				wizardDebugLogger.log('info', 'Checking for documents on disk (parsed docs invalid)');
				const diskDocs = await this.readDocumentsFromDisk(config.directoryPath);
				if (diskDocs.length > 0) {
					console.log('[PhaseGenerator] Found documents on disk:', diskDocs.length);
					wizardDebugLogger.log('info', 'Found documents on disk', {
						count: diskDocs.length,
						documentNames: diskDocs.map((d) => d.filename),
					});
					// Prefer disk documents if they have more content/tasks
					const totalTasksFromDisk = diskDocs.reduce(
						(sum, doc) => sum + countTasks(doc.content),
						0
					);
					wizardDebugLogger.log('info', 'Task count from disk documents', { totalTasksFromDisk });
					if (totalTasksFromDisk >= totalTasksFromParsed) {
						documents = diskDocs;
						documentsFromDisk = true;
						wizardDebugLogger.log('info', 'Using documents from disk');
					}
				} else {
					wizardDebugLogger.log('warn', 'No documents found on disk');
				}
			}

			// Validate documents
			const validation = validateDocuments(documents);
			wizardDebugLogger.log('info', 'Document validation result', {
				valid: validation.valid,
				errors: validation.errors,
			});
			if (!validation.valid) {
				// Try to salvage what we can if there's at least some content
				if (documents.length > 0) {
					callbacks?.onProgress?.(
						`Note: ${validation.errors.length} validation warning(s), proceeding anyway`
					);
					wizardDebugLogger.log('warn', 'Proceeding despite validation warnings');
				} else {
					wizardDebugLogger.log('error', 'Document validation failed completely', {
						errors: validation.errors,
					});
					throw new Error(`Document validation failed: ${validation.errors.join('; ')}`);
				}
			}

			// Convert to GeneratedDocument format
			// If read from disk, set savedPath since they're already saved
			const autoRunPath = `${config.directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
			const generatedDocs: GeneratedDocument[] = documents.map((doc) => ({
				filename: doc.filename,
				content: doc.content,
				taskCount: countTasks(doc.content),
				savedPath: documentsFromDisk ? `${autoRunPath}/${doc.filename}` : undefined,
			}));

			callbacks?.onProgress?.(`Generated ${generatedDocs.length} Auto Run document(s)`);

			wizardDebugLogger.log('info', 'Generation completed successfully', {
				documentCount: generatedDocs.length,
				totalTasks: generatedDocs.reduce((sum, d) => sum + (d.taskCount || 0), 0),
				documentsFromDisk,
			});

			const finalResult: GenerationResult = {
				success: true,
				documents: generatedDocs,
				rawOutput,
				documentsFromDisk,
			};

			callbacks?.onComplete?.(finalResult);
			return finalResult;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			wizardDebugLogger.log('error', 'Generation failed with exception', {
				errorMessage,
				errorStack: error instanceof Error ? error.stack : undefined,
				outputBufferLength: this.outputBuffer.length,
			});
			callbacks?.onError?.(errorMessage);
			return {
				success: false,
				error: errorMessage,
				rawOutput: this.outputBuffer,
			};
		} finally {
			this.isGenerating = false;
			this.cleanup();
		}
	}

	/**
	 * Run the agent and collect output
	 */
	private runAgent(
		agent: any,
		config: GenerationConfig,
		prompt: string,
		callbacks?: GenerationCallbacks
	): Promise<GenerationResult> {
		const sessionId = `wizard-gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const startTime = Date.now();

		console.log('[PhaseGenerator] Starting agent run:', {
			sessionId,
			agentType: config.agentType,
			cwd: config.directoryPath,
			promptLength: prompt.length,
			timeoutMs: GENERATION_TIMEOUT,
		});

		wizardDebugLogger.log('spawn', 'Starting agent run', {
			sessionId,
			agentType: config.agentType,
			cwd: config.directoryPath,
			promptLength: prompt.length,
			timeoutMs: GENERATION_TIMEOUT,
			command: agent.command,
			args: agent.args,
		});

		return new Promise<GenerationResult>((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout>;
			let lastDataTime = Date.now();
			let dataChunks = 0;
			let fileWatcherCleanup: (() => void) | undefined;

			/**
			 * Reset the inactivity timeout - called on any activity (data chunk or file change)
			 * This ensures the timeout only fires after 5 minutes of NO activity
			 */
			const resetTimeout = () => {
				clearTimeout(timeoutId);
				lastDataTime = Date.now();

				timeoutId = setTimeout(() => {
					const elapsed = Date.now() - startTime;
					const timeSinceLastActivity = Date.now() - lastDataTime;
					console.error('[PhaseGenerator] TIMEOUT after', elapsed, 'ms total');
					console.error('[PhaseGenerator] Time since last activity:', timeSinceLastActivity, 'ms');
					console.error('[PhaseGenerator] Total chunks received:', dataChunks);
					console.error('[PhaseGenerator] Buffer size:', this.outputBuffer.length);
					console.error('[PhaseGenerator] Buffer preview:', this.outputBuffer.slice(-500));

					wizardDebugLogger.log('timeout', 'Generation timed out after 20 minutes of inactivity', {
						elapsedMs: elapsed,
						timeSinceLastActivityMs: timeSinceLastActivity,
						totalChunks: dataChunks,
						bufferSize: this.outputBuffer.length,
						bufferPreview: this.outputBuffer.slice(-1000),
					});

					this.cleanup();
					if (fileWatcherCleanup) {
						fileWatcherCleanup();
					}
					window.maestro.process.kill(sessionId).catch(() => {});
					resolve({
						success: false,
						error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
						rawOutput: this.outputBuffer,
					});
				}, GENERATION_TIMEOUT);
			};

			// Set up data listener
			this.dataListenerCleanup = window.maestro.process.onData((sid: string, data: string) => {
				if (sid === sessionId) {
					this.outputBuffer += data;
					dataChunks++;
					callbacks?.onChunk?.(data);

					// Log every data chunk to debug logger (with truncated preview)
					wizardDebugLogger.log('data', `Received data chunk #${dataChunks}`, {
						chunkSize: data.length,
						totalBufferSize: this.outputBuffer.length,
						elapsedMs: Date.now() - startTime,
						preview: data.slice(0, 200),
					});

					// Reset timeout on activity - any data chunk means the agent is working
					resetTimeout();
					callbacks?.onActivity?.();

					// Log progress every 10 chunks
					if (dataChunks % 10 === 0) {
						console.log('[PhaseGenerator] Progress:', {
							chunks: dataChunks,
							bufferSize: this.outputBuffer.length,
							elapsedMs: Date.now() - startTime,
							timeSinceLastData: Date.now() - lastDataTime,
						});
					}
				}
			});

			// Set up exit listener
			this.exitListenerCleanup = window.maestro.process.onExit((sid: string, code: number) => {
				if (sid === sessionId) {
					clearTimeout(timeoutId);
					this.cleanup();
					if (fileWatcherCleanup) {
						fileWatcherCleanup();
					}

					const elapsed = Date.now() - startTime;
					console.log('[PhaseGenerator] Agent exited:', {
						sessionId,
						exitCode: code,
						elapsedMs: elapsed,
						totalChunks: dataChunks,
						bufferSize: this.outputBuffer.length,
					});

					wizardDebugLogger.log('exit', `Agent exited with code ${code}`, {
						exitCode: code,
						elapsedMs: elapsed,
						totalChunks: dataChunks,
						bufferSize: this.outputBuffer.length,
					});

					if (code === 0) {
						// Try to extract result from stream-json format
						const extracted = extractResultFromStreamJson(this.outputBuffer);
						const output = extracted || this.outputBuffer;

						console.log('[PhaseGenerator] Extraction result:', {
							hadExtraction: !!extracted,
							outputLength: output.length,
						});

						wizardDebugLogger.log('info', 'Agent completed successfully', {
							hadExtraction: !!extracted,
							outputLength: output.length,
						});

						resolve({
							success: true,
							rawOutput: output,
						});
					} else {
						console.error('[PhaseGenerator] Agent failed with code:', code);
						console.error(
							'[PhaseGenerator] Output buffer preview:',
							this.outputBuffer.slice(0, 500)
						);

						wizardDebugLogger.log('error', `Agent failed with exit code ${code}`, {
							exitCode: code,
							bufferPreview: this.outputBuffer.slice(0, 1000),
						});

						resolve({
							success: false,
							error: `Agent exited with code ${code}`,
							rawOutput: this.outputBuffer,
						});
					}
				}
			});

			// Set up file system watcher for Auto Run Docs folder (including subfolder if specified)
			// This detects when the agent creates files and resets the timeout
			const autoRunPath = config.subfolder
				? `${config.directoryPath}/${AUTO_RUN_FOLDER_NAME}/${config.subfolder}`
				: `${config.directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
			wizardDebugLogger.log('info', 'Setting up file watcher', {
				autoRunPath,
				subfolder: config.subfolder,
			});

			// Start watching the folder for file changes
			window.maestro.autorun
				.watchFolder(autoRunPath)
				.then((result) => {
					if (result.success) {
						console.log('[PhaseGenerator] Started watching folder:', autoRunPath);
						wizardDebugLogger.log('info', 'File watcher started successfully', { autoRunPath });
						this.currentWatchPath = autoRunPath;

						// Set up file change listener
						fileWatcherCleanup = window.maestro.autorun.onFileChanged((data) => {
							if (data.folderPath === autoRunPath) {
								console.log(
									'[PhaseGenerator] File system activity:',
									data.filename,
									data.eventType
								);
								wizardDebugLogger.log('file', `File activity: ${data.eventType}`, {
									filename: data.filename,
									eventType: data.eventType,
									folderPath: data.folderPath,
								});

								// Reset timeout on file activity
								resetTimeout();
								callbacks?.onActivity?.();

								// If a file was created/changed, notify about it
								// Note: Main process already filters for .md files but strips the extension
								// when sending the event, so we check for any filename here
								if (data.filename && (data.eventType === 'rename' || data.eventType === 'change')) {
									// Re-add the .md extension since main process strips it
									const filenameWithExt = data.filename.endsWith('.md')
										? data.filename
										: `${data.filename}.md`;
									const fullPath = `${autoRunPath}/${filenameWithExt}`;

									// Use retry logic since file might still be being written
									const readWithRetry = async (retries = 3, delayMs = 200): Promise<void> => {
										for (let attempt = 1; attempt <= retries; attempt++) {
											try {
												const content = await window.maestro.fs.readFile(fullPath);
												if (content && typeof content === 'string' && content.length > 0) {
													console.log(
														'[PhaseGenerator] File read successful:',
														filenameWithExt,
														'size:',
														content.length
													);
													callbacks?.onFileCreated?.({
														filename: filenameWithExt,
														size: new Blob([content]).size,
														path: fullPath,
														timestamp: Date.now(),
														description: extractDescription(content),
														taskCount: countTasks(content),
													});
													return;
												}
											} catch (err) {
												console.log(
													`[PhaseGenerator] File read attempt ${attempt}/${retries} failed for ${filenameWithExt}:`,
													err
												);
											}
											if (attempt < retries) {
												await new Promise((r) => setTimeout(r, delayMs));
											}
										}

										// Even if we couldn't read content, still notify that file exists
										// This provides feedback to user that files are being created
										console.log(
											'[PhaseGenerator] Notifying file creation (without size):',
											filenameWithExt
										);
										callbacks?.onFileCreated?.({
											filename: filenameWithExt,
											size: 0, // Unknown size
											path: fullPath,
											timestamp: Date.now(),
										});
									};

									readWithRetry();
								}
							}
						});
					} else {
						console.warn('[PhaseGenerator] Could not watch folder:', result.error);
						wizardDebugLogger.log('warn', 'Could not watch folder', { error: result.error });
					}
				})
				.catch((err) => {
					console.warn('[PhaseGenerator] Error setting up folder watcher:', err);
					wizardDebugLogger.log('warn', 'Error setting up folder watcher', { error: String(err) });
				});

			// Initialize the timeout
			resetTimeout();
			wizardDebugLogger.log('info', 'Timeout initialized', { timeoutMs: GENERATION_TIMEOUT });

			// Spawn the agent using the secure IPC channel
			console.log('[PhaseGenerator] Spawning agent...');

			// Build args for document generation
			// The agent can write files ONLY to the Auto Run folder (enforced via prompt)
			// This allows documents to stream in via file watcher as they're created
			const argsForSpawn = [...(agent.args || [])];
			if (config.agentType === 'claude-code') {
				if (!argsForSpawn.includes('--include-partial-messages')) {
					argsForSpawn.push('--include-partial-messages');
				}
				// Allow Write tool so agent can create files directly in Auto Run folder
				// The prompt strictly limits writes to the Auto Run folder only
				if (!argsForSpawn.includes('--allowedTools')) {
					argsForSpawn.push('--allowedTools', 'Read', 'Glob', 'Grep', 'LS', 'Write');
				}
			}

			// Use the agent's resolved path if available, falling back to command name
			// This is critical for packaged Electron apps where PATH may not include agent locations
			const commandToUse = agent.path || agent.command;

			wizardDebugLogger.log('spawn', 'Calling process.spawn', {
				sessionId,
				toolType: config.agentType,
				cwd: config.directoryPath,
				command: commandToUse,
				agentPath: agent.path,
				agentCommand: agent.command,
				argsCount: argsForSpawn.length,
				promptLength: prompt.length,
			});
			window.maestro.process
				.spawn({
					sessionId,
					toolType: config.agentType,
					cwd: config.directoryPath,
					command: commandToUse,
					args: argsForSpawn,
					prompt,
				})
				.then(() => {
					console.log('[PhaseGenerator] Agent spawned successfully');
					wizardDebugLogger.log('spawn', 'Agent spawned successfully', { sessionId });
				})
				.catch((error: Error) => {
					console.error('[PhaseGenerator] Spawn failed:', error.message);
					wizardDebugLogger.log('error', 'Spawn failed', {
						errorMessage: error.message,
						errorStack: error.stack,
					});
					clearTimeout(timeoutId);
					this.cleanup();
					if (fileWatcherCleanup) {
						fileWatcherCleanup();
					}
					resolve({
						success: false,
						error: `Failed to spawn agent: ${error.message}`,
					});
				});
		});
	}

	/**
	 * Read documents from the Auto Run Docs folder on disk
	 *
	 * This is a fallback for when the agent writes files directly
	 * instead of outputting them with markers.
	 */
	private async readDocumentsFromDisk(directoryPath: string): Promise<ParsedDocument[]> {
		const autoRunPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
		const documents: ParsedDocument[] = [];

		try {
			// List files in the Auto Run folder
			const listResult = await window.maestro.autorun.listDocs(autoRunPath);
			if (!listResult.success || !listResult.files) {
				return [];
			}

			// Read each .md file
			// Note: listDocs returns filenames WITHOUT the .md extension (see main/index.ts autorun:listDocs)
			// We need to add it back when reading and for the final filename
			for (const fileBaseName of listResult.files) {
				const filename = fileBaseName.endsWith('.md') ? fileBaseName : `${fileBaseName}.md`;

				const readResult = await window.maestro.autorun.readDoc(autoRunPath, fileBaseName);
				if (readResult.success && readResult.content) {
					// Extract phase number from filename
					const phaseMatch = filename.match(/Phase-(\d+)/i);
					const phase = phaseMatch ? parseInt(phaseMatch[1], 10) : 0;

					documents.push({
						filename,
						content: readResult.content,
						phase,
					});
				}
			}

			// Sort by phase number
			documents.sort((a, b) => a.phase - b.phase);

			return documents;
		} catch (error) {
			console.error('[PhaseGenerator] Error reading documents from disk:', error);
			return [];
		}
	}

	/**
	 * Clean up listeners and file watcher
	 */
	private cleanup(): void {
		if (this.dataListenerCleanup) {
			this.dataListenerCleanup();
			this.dataListenerCleanup = undefined;
		}
		if (this.exitListenerCleanup) {
			this.exitListenerCleanup();
			this.exitListenerCleanup = undefined;
		}
		// Stop watching the Auto Run folder
		if (this.currentWatchPath) {
			window.maestro.autorun.unwatchFolder(this.currentWatchPath).catch(() => {});
			this.currentWatchPath = undefined;
		}
	}

	/**
	 * Save generated documents to the Auto Run folder
	 *
	 * Creates the Auto Run Docs folder if it doesn't exist.
	 * @param directoryPath - Project directory path
	 * @param documents - Documents to save
	 * @param onFileCreated - Callback when each file is created
	 * @param subfolder - Optional subfolder within Auto Run Docs (e.g., "Initiation")
	 */
	async saveDocuments(
		directoryPath: string,
		documents: GeneratedDocument[],
		onFileCreated?: (file: CreatedFileInfo) => void,
		subfolder?: string
	): Promise<{ success: boolean; savedPaths: string[]; error?: string; subfolderPath?: string }> {
		const baseAutoRunPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
		const autoRunPath = subfolder ? `${baseAutoRunPath}/${subfolder}` : baseAutoRunPath;
		const savedPaths: string[] = [];

		try {
			// Save each document
			for (const doc of documents) {
				// Sanitize filename to prevent path traversal attacks
				const sanitized = sanitizeFilename(doc.filename);
				// Ensure filename has .md extension
				const filename = sanitized.endsWith('.md') ? sanitized : `${sanitized}.md`;

				console.log('[PhaseGenerator] Saving document:', filename);

				// Write the document (autorun:writeDoc creates the folder if needed)
				const result = await window.maestro.autorun.writeDoc(autoRunPath, filename, doc.content);

				if (result.success) {
					const fullPath = `${autoRunPath}/${filename}`;
					savedPaths.push(fullPath);

					// Update the document with the saved path
					doc.savedPath = fullPath;

					// Notify about file creation
					if (onFileCreated) {
						onFileCreated({
							filename,
							size: new Blob([doc.content]).size,
							path: fullPath,
							timestamp: Date.now(),
							description: extractDescription(doc.content),
							taskCount: countTasks(doc.content),
						});
					}

					console.log('[PhaseGenerator] Saved:', fullPath, 'size:', doc.content.length);
				} else {
					throw new Error(result.error || `Failed to save ${filename}`);
				}
			}

			return { success: true, savedPaths, subfolderPath: subfolder ? autoRunPath : undefined };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Failed to save documents';
			console.error('[PhaseGenerator] Save error:', errorMessage);
			return { success: false, savedPaths, error: errorMessage };
		}
	}

	/**
	 * Get the Auto Run folder path for a directory
	 */
	getAutoRunPath(directoryPath: string): string {
		return `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
	}

	/**
	 * Check if generation is in progress
	 */
	isGenerationInProgress(): boolean {
		return this.isGenerating;
	}

	/**
	 * Abort any in-progress generation and clean up resources.
	 * Call this when the component unmounts to ensure proper cleanup.
	 */
	abort(): void {
		this.isGenerating = false;
		this.cleanup();
	}
}

// Export singleton instance
export const phaseGenerator = new PhaseGenerator();

// Export utility functions for use elsewhere
export const phaseGeneratorUtils = {
	generateDocumentGenerationPrompt,
	parseGeneratedDocuments,
	countTasks,
	validateDocuments,
	splitIntoPhases,
	AUTO_RUN_FOLDER_NAME,
};
