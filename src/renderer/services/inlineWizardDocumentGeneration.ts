/**
 * inlineWizardDocumentGeneration.ts
 *
 * Service for generating Auto Run documents during inline wizard mode.
 * This service handles constructing the generation prompt, spawning the AI agent,
 * parsing document markers from the response, and saving documents to disk.
 *
 * Reuses patterns from the onboarding wizard's phaseGenerator.ts but adapted
 * for the inline wizard's stateless service approach.
 */

import type { ToolType } from '../types';
import type { InlineWizardMessage, InlineGeneratedDocument } from '../hooks/useInlineWizard';
import type { ExistingDocument } from '../utils/existingDocsDetector';
import { logger } from '../utils/logger';
import { wizardDocumentGenerationPrompt, wizardInlineIterateGenerationPrompt } from '../../prompts';
import { substituteTemplateVariables, type TemplateContext } from '../utils/templateVariables';

/**
 * Auto Run folder name constant.
 */
export const AUTO_RUN_FOLDER_NAME = 'Auto Run Docs';

/**
 * Generation timeout in milliseconds (20 minutes).
 */
const GENERATION_TIMEOUT = 1200000;

/**
 * Extract displayable text from streaming JSON chunks.
 * Parses Claude's stream-json format and extracts text from content_block_delta
 * events and assistant messages.
 *
 * @param chunk - Raw JSON chunk from the streaming output
 * @param agentType - Type of agent to determine parsing strategy
 * @returns Extracted text to display, or empty string if no text found
 */
export function extractDisplayTextFromChunk(chunk: string, agentType: ToolType): string {
	// Split into lines in case multiple JSON objects are in one chunk
	const lines = chunk.split('\n').filter((line) => line.trim());
	const textParts: string[] = [];

	for (const line of lines) {
		try {
			const msg = JSON.parse(line);

			// Claude Code stream-json format
			if (agentType === 'claude-code') {
				// content_block_delta contains streaming text
				if (msg.type === 'content_block_delta' && msg.delta?.text) {
					textParts.push(msg.delta.text);
				}
				// assistant message chunks
				else if (msg.type === 'assistant' && msg.message?.content) {
					for (const block of msg.message.content) {
						if (block.type === 'text' && block.text) {
							textParts.push(block.text);
						}
					}
				}
			}

			// OpenCode format
			else if (agentType === 'opencode') {
				if (msg.type === 'text' && msg.part?.text) {
					textParts.push(msg.part.text);
				}
			}

			// Codex format
			else if (agentType === 'codex') {
				if (msg.type === 'agent_message' && msg.content) {
					for (const block of msg.content) {
						if (block.type === 'text' && block.text) {
							textParts.push(block.text);
						}
					}
				}
				if (msg.type === 'message' && msg.text) {
					textParts.push(msg.text);
				}
			}
		} catch {
			// Ignore non-JSON lines or parse errors
		}
	}

	return textParts.join('');
}

/**
 * Callbacks for document generation progress.
 */
export interface DocumentGenerationCallbacks {
	/** Called when generation starts */
	onStart?: () => void;
	/** Called with progress updates */
	onProgress?: (message: string) => void;
	/** Called with output chunks (for streaming display) */
	onChunk?: (chunk: string) => void;
	/** Called when a single document is complete and saved */
	onDocumentComplete?: (doc: InlineGeneratedDocument) => void;
	/** Called when all documents are complete */
	onComplete?: (documents: InlineGeneratedDocument[]) => void;
	/** Called on error */
	onError?: (error: string) => void;
}

/**
 * Configuration for document generation.
 */
export interface DocumentGenerationConfig {
	/** Agent type to use for generation */
	agentType: ToolType;
	/** Working directory for the agent */
	directoryPath: string;
	/** Project name from wizard */
	projectName: string;
	/** Conversation history from the wizard */
	conversationHistory: InlineWizardMessage[];
	/** Existing documents (for iterate mode) */
	existingDocuments?: ExistingDocument[];
	/** Wizard mode */
	mode: 'new' | 'iterate';
	/** Goal for iterate mode */
	goal?: string;
	/** Auto Run folder path (base path, subfolder will be created) */
	autoRunFolderPath: string;
	/** Session ID for playbook creation */
	sessionId?: string;
	/** Optional callbacks */
	callbacks?: DocumentGenerationCallbacks;
}

/**
 * Result of document generation.
 */
export interface DocumentGenerationResult {
	/** Whether generation was successful */
	success: boolean;
	/** Generated documents (if successful) */
	documents?: InlineGeneratedDocument[];
	/** Error message (if failed) */
	error?: string;
	/** Raw agent output (for debugging) */
	rawOutput?: string;
	/** Subfolder path where documents were saved (relative to Auto Run Docs) */
	subfolderName?: string;
	/** Full path to the subfolder */
	subfolderPath?: string;
	/** Created playbook (if sessionId was provided) */
	playbook?: {
		id: string;
		name: string;
	};
}

/**
 * Parsed document from agent output.
 */
interface ParsedDocument {
	filename: string;
	content: string;
	phase: number;
	/** Whether this document updates an existing file (vs creating new) */
	isUpdate: boolean;
}

/**
 * Sanitize a filename to prevent path traversal attacks.
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
 * Generate the base folder name for wizard output.
 * Uses date-based naming: "Wizard-YYYY-MM-DD"
 *
 * @returns A date-based folder name
 */
export function generateWizardFolderBaseName(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `Wizard-${year}-${month}-${day}`;
}

/**
 * Generate a unique subfolder name within Auto Run Docs.
 * If the base folder name already exists, appends a numeric suffix (e.g., "-2", "-3").
 *
 * @param autoRunFolderPath - The Auto Run Docs folder path
 * @param baseName - The sanitized base folder name
 * @returns A unique folder name that doesn't conflict with existing folders
 */
async function generateUniqueSubfolderName(
	autoRunFolderPath: string,
	baseName: string
): Promise<string> {
	// List existing folders in the Auto Run Docs directory
	const listResult = await window.maestro.autorun.listDocs(autoRunFolderPath);

	if (!listResult.success || !listResult.tree) {
		// If we can't list, just use the base name (folder may not exist yet)
		return baseName;
	}

	// Extract folder names from the tree structure (top-level items that are directories)
	const existingFolders = new Set<string>();
	for (const item of listResult.tree) {
		// Tree items with children are directories
		if (item && typeof item === 'object' && 'name' in item) {
			existingFolders.add((item as { name: string }).name);
		}
	}

	// If base name doesn't conflict, use it
	if (!existingFolders.has(baseName)) {
		return baseName;
	}

	// Find an available name with numeric suffix
	let suffix = 2;
	let candidateName = `${baseName}-${suffix}`;
	while (existingFolders.has(candidateName) && suffix < 1000) {
		suffix++;
		candidateName = `${baseName}-${suffix}`;
	}

	return candidateName;
}

/**
 * Count tasks (checkbox items) in document content.
 */
export function countTasks(content: string): number {
	const taskPattern = /^-\s*\[\s*[xX ]?\s*\]/gm;
	const matches = content.match(taskPattern);
	return matches ? matches.length : 0;
}

/**
 * Format existing documents for inclusion in the iterate prompt.
 *
 * @param docs - Array of existing documents with content
 * @returns Formatted string for the prompt
 */
function formatExistingDocsForPrompt(docs: ExistingDocument[]): string {
	if (!docs || docs.length === 0) {
		return '(No existing documents found)';
	}

	return docs
		.map((doc, index) => {
			const content =
				(doc as ExistingDocument & { content?: string }).content || '(Content not loaded)';
			return `### ${index + 1}. ${doc.filename}\n\n${content}`;
		})
		.join('\n\n---\n\n');
}

/**
 * Generate the document generation prompt.
 *
 * Uses the iterate-specific prompt when in iterate mode, which includes
 * existing documents and the user's goal for extending/modifying plans.
 *
 * @param config Configuration for generation
 * @param subfolder Optional subfolder name within Auto Run Docs
 * @returns The complete prompt for the agent
 */
export function generateDocumentPrompt(
	config: DocumentGenerationConfig,
	subfolder?: string
): string {
	const {
		projectName,
		directoryPath,
		conversationHistory,
		mode,
		goal,
		existingDocuments,
		autoRunFolderPath,
	} = config;
	const projectDisplay = projectName || 'this project';

	// Build conversation summary from the wizard conversation
	const conversationSummary = conversationHistory
		.filter((msg) => msg.role === 'user' || msg.role === 'assistant')
		.map((msg) => {
			const prefix = msg.role === 'user' ? 'User' : 'Assistant';
			return `${prefix}: ${msg.content}`;
		})
		.join('\n\n');

	// Choose the appropriate prompt template based on mode
	const basePrompt =
		mode === 'iterate' ? wizardInlineIterateGenerationPrompt : wizardDocumentGenerationPrompt;

	// Build the full Auto Run folder path (including subfolder if specified)
	// Use the user-configured autoRunFolderPath (which may be external to directoryPath)
	const fullAutoRunPath = subfolder ? `${autoRunFolderPath}/${subfolder}` : autoRunFolderPath;

	// The prompt template uses {{DIRECTORY_PATH}}/{{AUTO_RUN_FOLDER_NAME}} as a combined pattern
	// for specifying where documents should be written. Since the user may have configured
	// an external Auto Run folder (not inside directoryPath), we replace the combined pattern
	// with the full absolute path.
	let prompt = basePrompt
		.replace(/\{\{PROJECT_NAME\}\}/gi, projectDisplay)
		// Replace the combined pattern first (for write access paths)
		.replace(/\{\{DIRECTORY_PATH\}\}\/\{\{AUTO_RUN_FOLDER_NAME\}\}/gi, fullAutoRunPath)
		// Then replace remaining individual placeholders (for read access, etc.)
		.replace(/\{\{DIRECTORY_PATH\}\}/gi, directoryPath)
		.replace(/\{\{AUTO_RUN_FOLDER_NAME\}\}/gi, fullAutoRunPath)
		.replace(/\{\{CONVERSATION_SUMMARY\}\}/gi, conversationSummary);

	// Handle iterate-mode specific placeholders
	if (mode === 'iterate') {
		const existingDocsText = formatExistingDocsForPrompt(existingDocuments || []);
		const iterateGoal = goal || '(No specific goal provided)';

		prompt = prompt
			.replace(/\{\{EXISTING_DOCS\}\}/gi, existingDocsText)
			.replace(/\{\{ITERATE_GOAL\}\}/gi, iterateGoal);
	}

	// Build template context for remaining variables
	const templateContext: TemplateContext = {
		session: {
			id: 'inline-wizard-gen',
			name: projectDisplay,
			toolType: config.agentType,
			cwd: directoryPath,
			fullPath: directoryPath,
		},
	};

	// Substitute any remaining template variables
	prompt = substituteTemplateVariables(prompt, templateContext);

	return prompt;
}

/**
 * Parse the agent's output to extract individual documents.
 *
 * Looks for document blocks with markers:
 * ---BEGIN DOCUMENT---
 * FILENAME: Phase-01-Setup.md
 * UPDATE: true  (optional - indicates this updates an existing file)
 * CONTENT:
 * [markdown content]
 * ---END DOCUMENT---
 *
 * When UPDATE: true is present, the document will overwrite an existing file.
 * Otherwise, it creates a new file.
 */
export function parseGeneratedDocuments(output: string): ParsedDocument[] {
	const documents: ParsedDocument[] = [];

	// Split by document markers and process each block
	const blocks = output.split(/---BEGIN DOCUMENT---/);

	for (const block of blocks) {
		if (!block.trim()) continue;

		// Extract filename
		const filenameMatch = block.match(/FILENAME:\s*(.+?)(?:\n|$)/);
		if (!filenameMatch) continue;

		const filename = filenameMatch[1].trim();

		// Check for UPDATE marker (optional)
		const updateMatch = block.match(/UPDATE:\s*(true|false)/i);
		const isUpdate = updateMatch ? updateMatch[1].toLowerCase() === 'true' : false;

		// Extract content - everything after "CONTENT:" line
		const contentMatch = block.match(/CONTENT:\s*\n([\s\S]*?)(?=---END DOCUMENT---|$)/);
		if (!contentMatch) continue;

		let content = contentMatch[1].trim();

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
				isUpdate,
			});
		}
	}

	// Sort by phase number
	documents.sort((a, b) => a.phase - b.phase);

	return documents;
}

/**
 * Intelligent splitting of a single large document into phases.
 *
 * If the agent generates one large document instead of multiple phases,
 * this function attempts to split it intelligently.
 *
 * Note: Documents created by splitting are always treated as new (isUpdate: false)
 * since we can't determine intent from raw content.
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
			isUpdate: false,
		});

		phaseNumber++;
	}

	// If no phase sections found, treat the whole content as Phase 1
	if (documents.length === 0 && content.trim()) {
		documents.push({
			filename: 'Phase-01-Initial-Setup.md',
			content: content.trim(),
			phase: 1,
			isUpdate: false,
		});
	}

	return documents;
}

/**
 * Extract the result from Claude's stream-json format.
 */
function extractResultFromStreamJson(output: string, agentType: ToolType): string | null {
	try {
		const lines = output.split('\n');

		// For OpenCode: concatenate all text parts
		if (agentType === 'opencode') {
			const textParts: string[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === 'text' && msg.part?.text) {
						textParts.push(msg.part.text);
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
			if (textParts.length > 0) {
				return textParts.join('');
			}
		}

		// For Codex: look for message content
		if (agentType === 'codex') {
			const textParts: string[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === 'agent_message' && msg.content) {
						for (const block of msg.content) {
							if (block.type === 'text' && block.text) {
								textParts.push(block.text);
							}
						}
					}
					if (msg.type === 'message' && msg.text) {
						textParts.push(msg.text);
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
			if (textParts.length > 0) {
				return textParts.join('');
			}
		}

		// For Claude Code: look for result message
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
 * Build CLI args for the agent based on its type and capabilities.
 * For document generation, the agent can write files directly to the Auto Run folder.
 * The prompt strictly enforces the write restriction to prevent writing elsewhere.
 */
function buildArgsForAgent(agent: { id: string; args?: string[] }): string[] {
	const agentId = agent.id;

	switch (agentId) {
		case 'claude-code': {
			const args = [...(agent.args || [])];
			if (!args.includes('--include-partial-messages')) {
				args.push('--include-partial-messages');
			}
			// Allow Write tool so agent can create files directly in Auto Run folder.
			// The prompt strictly limits writes to the Auto Run folder only.
			// This enables real-time streaming of documents as they're created.
			if (!args.includes('--allowedTools')) {
				args.push('--allowedTools', 'Read', 'Glob', 'Grep', 'LS', 'Write');
			}
			return args;
		}

		case 'codex':
		case 'opencode': {
			return [...(agent.args || [])];
		}

		default: {
			return [...(agent.args || [])];
		}
	}
}

/**
 * Save a single document to the Auto Run folder.
 *
 * Handles both creating new files and updating existing ones.
 * The isUpdate flag is used for logging purposes - both operations
 * use writeDoc which will create or overwrite as needed.
 *
 * @param autoRunFolderPath - The Auto Run folder path
 * @param doc - The parsed document to save
 * @returns The saved document with path information
 */
async function saveDocument(
	autoRunFolderPath: string,
	doc: ParsedDocument
): Promise<InlineGeneratedDocument> {
	// Sanitize filename to prevent path traversal attacks
	const sanitized = sanitizeFilename(doc.filename);
	// Ensure filename has .md extension
	const filename = sanitized.endsWith('.md') ? sanitized : `${sanitized}.md`;

	const action = doc.isUpdate ? 'Updated' : 'Created';
	logger.info(`${action} document: ${filename}`, '[InlineWizardDocGen]', {
		filename,
		action,
		autoRunFolderPath,
	});

	// Write the document (creates or overwrites as needed)
	const result = await window.maestro.autorun.writeDoc(autoRunFolderPath, filename, doc.content);

	if (!result.success) {
		throw new Error(result.error || `Failed to ${action.toLowerCase()} ${filename}`);
	}

	const fullPath = `${autoRunFolderPath}/${filename}`;

	return {
		filename,
		content: doc.content,
		taskCount: countTasks(doc.content),
		savedPath: fullPath,
	};
}

/**
 * Generate Auto Run documents based on the inline wizard conversation.
 *
 * This function:
 * 1. Constructs a prompt using wizard-document-generation.md
 * 2. Spawns the AI agent and collects streamed output
 * 3. Parses document markers from the response
 * 4. Creates a project subfolder within Auto Run Docs
 * 5. Saves each document to the subfolder
 * 6. Creates a playbook for the generated documents (if sessionId provided)
 * 7. Returns the list of generated documents and playbook info
 *
 * @param config - Configuration for document generation
 * @returns Result containing generated documents, subfolder path, and playbook info
 */
export async function generateInlineDocuments(
	config: DocumentGenerationConfig
): Promise<DocumentGenerationResult> {
	const { agentType, directoryPath, autoRunFolderPath, projectName, callbacks } = config;

	callbacks?.onStart?.();
	callbacks?.onProgress?.('Preparing to generate your Playbook...');

	// Create a date-based subfolder name: "Wizard-YYYY-MM-DD" (with -1, -2, etc. if needed)
	const baseFolderName = generateWizardFolderBaseName();
	const subfolderName = await generateUniqueSubfolderName(autoRunFolderPath, baseFolderName);
	const subfolderPath = `${autoRunFolderPath}/${subfolderName}`;

	logger.info(`Starting document generation for "${projectName}"`, '[InlineWizardDocGen]', {
		subfolderName,
		baseFolderName,
		autoRunFolderPath,
		agentType,
		mode: config.mode,
		conversationLength: config.conversationHistory.length,
	});

	try {
		// Get the agent configuration
		const agent = await window.maestro.agents.get(agentType);
		if (!agent || !agent.available) {
			throw new Error(`Agent ${agentType} is not available`);
		}

		// Generate the prompt (include subfolder so agent writes to correct location)
		const prompt = generateDocumentPrompt(config, subfolderName);

		callbacks?.onProgress?.('Generating Auto Run Documents...');

		// Spawn agent and collect output
		const sessionId = `inline-wizard-gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const argsForSpawn = buildArgsForAgent(agent);

		// Track documents created via file watcher (for real-time streaming)
		const documentsFromWatcher: InlineGeneratedDocument[] = [];

		const result = await new Promise<{ success: boolean; rawOutput: string; error?: string }>(
			(resolve) => {
				let outputBuffer = '';
				let dataListenerCleanup: (() => void) | undefined;
				let exitListenerCleanup: (() => void) | undefined;
				let fileWatcherCleanup: (() => void) | undefined;
				let lastActivityTime = Date.now();

				/**
				 * Reset the inactivity timeout - called on any activity
				 */
				const resetTimeout = () => {
					clearTimeout(timeoutId);
					lastActivityTime = Date.now();

					timeoutId = setTimeout(() => {
						console.error('[InlineWizardDocGen] TIMEOUT fired! Session:', sessionId);
						cleanupAll();
						window.maestro.process.kill(sessionId).catch(() => {});
						resolve({
							success: false,
							rawOutput: outputBuffer,
							error: 'Generation timed out after 20 minutes of inactivity. Please try again.',
						});
					}, GENERATION_TIMEOUT);
				};

				// Set up timeout (20 minutes for complex generation)
				let timeoutId = setTimeout(() => {
					console.error('[InlineWizardDocGen] TIMEOUT fired! Session:', sessionId);
					cleanupAll();
					window.maestro.process.kill(sessionId).catch(() => {});
					resolve({
						success: false,
						rawOutput: outputBuffer,
						error: 'Generation timed out after 20 minutes. Please try again.',
					});
				}, GENERATION_TIMEOUT);

				function cleanupAll() {
					if (dataListenerCleanup) {
						dataListenerCleanup();
						dataListenerCleanup = undefined;
					}
					if (exitListenerCleanup) {
						exitListenerCleanup();
						exitListenerCleanup = undefined;
					}
					if (fileWatcherCleanup) {
						fileWatcherCleanup();
						fileWatcherCleanup = undefined;
					}
					// Stop watching the subfolder
					window.maestro.autorun.unwatchFolder(subfolderPath).catch(() => {});
				}

				// Set up file watcher for real-time document streaming
				// The agent writes files directly, and we detect them here
				window.maestro.autorun
					.watchFolder(subfolderPath)
					.then((watchResult) => {
						if (watchResult.success) {
							console.log('[InlineWizardDocGen] Started watching folder:', subfolderPath);

							// Set up file change listener
							fileWatcherCleanup = window.maestro.autorun.onFileChanged((data) => {
								if (data.folderPath === subfolderPath) {
									console.log('[InlineWizardDocGen] File activity:', data.filename, data.eventType);

									// Reset timeout on file activity
									resetTimeout();

									// If a file was created/changed, read it and notify
									if (
										data.filename &&
										(data.eventType === 'rename' || data.eventType === 'change')
									) {
										// Re-add the .md extension since main process may strip it
										const filenameWithExt = data.filename.endsWith('.md')
											? data.filename
											: `${data.filename}.md`;
										const fullPath = `${subfolderPath}/${filenameWithExt}`;

										// Use retry logic since file might still be being written
										const readWithRetry = async (retries = 3, delayMs = 200): Promise<void> => {
											for (let attempt = 1; attempt <= retries; attempt++) {
												try {
													const content = await window.maestro.fs.readFile(fullPath);
													if (content && typeof content === 'string' && content.length > 0) {
														console.log(
															'[InlineWizardDocGen] File read successful:',
															filenameWithExt,
															'size:',
															content.length
														);

														// Check if we've already processed this document
														const alreadyProcessed = documentsFromWatcher.some(
															(d) => d.filename === filenameWithExt
														);
														if (alreadyProcessed) {
															console.log(
																'[InlineWizardDocGen] Document already processed:',
																filenameWithExt
															);
															return;
														}

														const doc: InlineGeneratedDocument = {
															filename: filenameWithExt,
															content,
															taskCount: countTasks(content),
															savedPath: fullPath,
														};

														documentsFromWatcher.push(doc);
														callbacks?.onDocumentComplete?.(doc);
														return;
													}
												} catch (err) {
													console.log(
														`[InlineWizardDocGen] File read attempt ${attempt}/${retries} failed for ${filenameWithExt}:`,
														err
													);
												}
												if (attempt < retries) {
													await new Promise((r) => setTimeout(r, delayMs));
												}
											}

											// Even if we couldn't read content, note that file exists
											console.log(
												'[InlineWizardDocGen] Could not read file content:',
												filenameWithExt
											);
										};

										readWithRetry();
									}
								}
							});
						} else {
							console.warn('[InlineWizardDocGen] Could not watch folder:', watchResult.error);
						}
					})
					.catch((err) => {
						console.warn('[InlineWizardDocGen] Error setting up folder watcher:', err);
					});

				// Set up data listener
				dataListenerCleanup = window.maestro.process.onData(
					(receivedSessionId: string, data: string) => {
						if (receivedSessionId === sessionId) {
							outputBuffer += data;
							resetTimeout();
							callbacks?.onChunk?.(data);
						}
					}
				);

				// Set up exit listener
				exitListenerCleanup = window.maestro.process.onExit(
					(receivedSessionId: string, code: number) => {
						if (receivedSessionId === sessionId) {
							clearTimeout(timeoutId);
							cleanupAll();

							console.log('[InlineWizardDocGen] Agent exited with code:', code);

							if (code === 0) {
								resolve({
									success: true,
									rawOutput: outputBuffer,
								});
							} else {
								resolve({
									success: false,
									rawOutput: outputBuffer,
									error: `Agent exited with code ${code}`,
								});
							}
						}
					}
				);

				// Spawn the agent process
				logger.info(`Spawning document generation agent`, '[InlineWizardDocGen]', {
					sessionId,
					agentType,
					cwd: directoryPath,
				});

				window.maestro.process
					.spawn({
						sessionId,
						toolType: agentType,
						cwd: directoryPath,
						command: agent.command,
						args: argsForSpawn,
						prompt,
					})
					.then(() => {
						logger.debug('Document generation agent spawned successfully', '[InlineWizardDocGen]', {
							sessionId,
						});
					})
					.catch((error: Error) => {
						cleanupAll();
						clearTimeout(timeoutId);
						resolve({
							success: false,
							rawOutput: outputBuffer,
							error: `Failed to spawn agent: ${error.message}`,
						});
					});
			}
		);

		if (!result.success) {
			callbacks?.onError?.(result.error || 'Generation failed');
			return {
				success: false,
				error: result.error,
				rawOutput: result.rawOutput,
			};
		}

		const rawOutput = result.rawOutput;

		// If documents were streamed in via file watcher, use those
		// (they were already created directly by the agent)
		if (documentsFromWatcher.length > 0) {
			console.log(
				'[InlineWizardDocGen] Using documents from file watcher:',
				documentsFromWatcher.length
			);

			// Sort by phase number for consistent ordering
			const sortedDocs = [...documentsFromWatcher].sort((a, b) => {
				const phaseA = a.filename.match(/Phase-(\d+)/i)?.[1] || '0';
				const phaseB = b.filename.match(/Phase-(\d+)/i)?.[1] || '0';
				return parseInt(phaseA, 10) - parseInt(phaseB, 10);
			});

			// Create a playbook for the generated documents (if sessionId provided)
			let playbookInfo: { id: string; name: string } | undefined;
			if (config.sessionId && sortedDocs.length > 0) {
				callbacks?.onProgress?.('Creating playbook configuration...');
				try {
					playbookInfo = await createPlaybookForDocuments(
						config.sessionId,
						projectName,
						subfolderName,
						sortedDocs
					);
					logger.info(
						`Created playbook for ${sortedDocs.length} document(s)`,
						'[InlineWizardDocGen]',
						{ playbookId: playbookInfo?.id, playbookName: playbookInfo?.name, subfolderName }
					);
				} catch (error) {
					console.error('[InlineWizardDocGen] Failed to create playbook:', error);
				}
			}

			callbacks?.onProgress?.(`Generated ${sortedDocs.length} Auto Run document(s)`);
			callbacks?.onComplete?.(sortedDocs);

			return {
				success: true,
				documents: sortedDocs,
				rawOutput,
				subfolderName,
				subfolderPath,
				playbook: playbookInfo,
			};
		}

		// Fallback: Parse documents from output (legacy marker-based approach)
		// This handles cases where file watcher didn't detect files
		callbacks?.onProgress?.('Parsing generated documents...');

		// Try to extract result from stream-json format
		const extractedResult = extractResultFromStreamJson(rawOutput, agentType);
		const textToParse = extractedResult || rawOutput;

		let documents = parseGeneratedDocuments(textToParse);

		// If no documents parsed with markers, try splitting intelligently
		if (documents.length === 0 && textToParse.trim()) {
			callbacks?.onProgress?.('Processing document structure...');
			documents = splitIntoPhases(textToParse);
		}

		// Check if we got valid documents with tasks
		const totalTasks = documents.reduce((sum, doc) => sum + countTasks(doc.content), 0);
		if (documents.length === 0 || totalTasks === 0) {
			// Check for files on disk (agent may have written directly)
			callbacks?.onProgress?.('Checking for documents on disk...');
			const diskDocs = await readDocumentsFromDisk(subfolderPath);
			if (diskDocs.length > 0) {
				console.log('[InlineWizardDocGen] Found documents on disk:', diskDocs.length);
				documents = diskDocs;
			}
		}

		if (documents.length === 0) {
			throw new Error('No documents were generated. Please try again.');
		}

		// Save each document to the project subfolder
		callbacks?.onProgress?.(`Saving ${documents.length} document(s) to ${subfolderName}/...`);

		const savedDocuments: InlineGeneratedDocument[] = [];
		for (const doc of documents) {
			try {
				const savedDoc = await saveDocument(subfolderPath, doc);
				savedDocuments.push(savedDoc);
				callbacks?.onDocumentComplete?.(savedDoc);
			} catch (error) {
				console.error('[InlineWizardDocGen] Failed to save document:', doc.filename, error);
				// Continue saving other documents even if one fails
			}
		}

		if (savedDocuments.length === 0) {
			throw new Error('Failed to save any documents. Please check permissions and try again.');
		}

		// Create a playbook for the generated documents (if sessionId provided)
		let playbookInfo: { id: string; name: string } | undefined;
		if (config.sessionId && savedDocuments.length > 0) {
			callbacks?.onProgress?.('Creating playbook configuration...');
			try {
				playbookInfo = await createPlaybookForDocuments(
					config.sessionId,
					projectName,
					subfolderName,
					savedDocuments
				);
				logger.info(
					`Created playbook for ${savedDocuments.length} document(s)`,
					'[InlineWizardDocGen]',
					{ playbookId: playbookInfo?.id, playbookName: playbookInfo?.name, subfolderName }
				);
			} catch (error) {
				console.error('[InlineWizardDocGen] Failed to create playbook:', error);
				// Don't fail the overall operation if playbook creation fails
			}
		}

		callbacks?.onProgress?.(`Generated ${savedDocuments.length} Auto Run document(s)`);
		callbacks?.onComplete?.(savedDocuments);

		return {
			success: true,
			documents: savedDocuments,
			rawOutput,
			subfolderName,
			subfolderPath,
			playbook: playbookInfo,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		console.error('[InlineWizardDocGen] Error:', error);
		callbacks?.onError?.(errorMessage);
		return {
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Default prompt for wizard-generated playbooks.
 * This provides sensible defaults that can be customized by the user later.
 */
const DEFAULT_PLAYBOOK_PROMPT = `Complete the tasks in this document thoroughly and carefully.

Guidelines:
- Work through tasks in order from top to bottom
- Check off each task as you complete it (mark [ ] as [x])
- If a task requires clarification, make a reasonable decision and proceed
- Focus on quality over speed
- Test your changes when appropriate`;

/**
 * Create a playbook configuration for the generated documents.
 *
 * This creates a fully-featured playbook that the user can customize:
 * - Documents ordered by phase number
 * - Sensible default prompt
 * - Looping disabled by default
 * - Reset on completion disabled by default
 *
 * @param sessionId - The session ID for playbook storage
 * @param projectName - Name of the project/playbook
 * @param subfolderName - Subfolder within Auto Run Docs where documents are stored
 * @param documents - The generated documents in order
 * @returns Created playbook info (id and name)
 */
async function createPlaybookForDocuments(
	sessionId: string,
	projectName: string,
	subfolderName: string,
	documents: InlineGeneratedDocument[]
): Promise<{ id: string; name: string }> {
	// Build document entries for the playbook
	// Documents are already sorted by phase from generation
	const documentEntries = documents.map((doc) => ({
		// Include subfolder in the filename path so playbook can find them
		filename: `${subfolderName}/${doc.filename}`,
		resetOnCompletion: false,
	}));

	// Create the playbook via IPC
	const result = await window.maestro.playbooks.create(sessionId, {
		name: projectName,
		documents: documentEntries,
		loopEnabled: false,
		prompt: DEFAULT_PLAYBOOK_PROMPT,
	});

	if (!result.success || !result.playbook) {
		throw new Error('Failed to create playbook');
	}

	return {
		id: result.playbook.id,
		name: result.playbook.name,
	};
}

/**
 * Read documents from the Auto Run folder on disk.
 *
 * This is a fallback for when the agent writes files directly
 * instead of outputting them with markers.
 *
 * Note: Documents read from disk are treated as new (isUpdate: false)
 * since they were written directly by the agent.
 */
async function readDocumentsFromDisk(autoRunFolderPath: string): Promise<ParsedDocument[]> {
	const documents: ParsedDocument[] = [];

	try {
		// List files in the Auto Run folder
		const listResult = await window.maestro.autorun.listDocs(autoRunFolderPath);
		if (!listResult.success || !listResult.files) {
			return [];
		}

		// Read each .md file
		// Note: listDocs returns filenames WITHOUT the .md extension
		for (const fileBaseName of listResult.files) {
			const filename = fileBaseName.endsWith('.md') ? fileBaseName : `${fileBaseName}.md`;

			const readResult = await window.maestro.autorun.readDoc(autoRunFolderPath, fileBaseName);
			if (readResult.success && readResult.content) {
				// Extract phase number from filename
				const phaseMatch = filename.match(/Phase-(\d+)/i);
				const phase = phaseMatch ? parseInt(phaseMatch[1], 10) : 0;

				documents.push({
					filename,
					content: readResult.content,
					phase,
					isUpdate: false,
				});
			}
		}

		// Sort by phase number
		documents.sort((a, b) => a.phase - b.phase);

		return documents;
	} catch (error) {
		console.error('[InlineWizardDocGen] Error reading documents from disk:', error);
		return [];
	}
}
