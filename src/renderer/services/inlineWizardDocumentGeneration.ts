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
import {
  wizardDocumentGenerationPrompt,
  wizardInlineIterateGenerationPrompt,
} from '../../prompts';
import { substituteTemplateVariables, type TemplateContext } from '../utils/templateVariables';

/**
 * Auto Run folder name constant.
 */
export const AUTO_RUN_FOLDER_NAME = 'Auto Run Docs';

/**
 * Generation timeout in milliseconds (5 minutes).
 */
const GENERATION_TIMEOUT = 300000;

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
  return filename
    // Remove path separators (both Unix and Windows)
    .replace(/[\/\\]/g, '-')
    // Remove directory traversal sequences
    .replace(/\.\./g, '')
    // Remove null bytes and control characters
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Remove leading dots (hidden files / relative paths)
    .replace(/^\.+/, '')
    // Remove leading/trailing whitespace
    .trim()
    // Ensure we have something left, default to 'document' if empty
    || 'document';
}

/**
 * Sanitize a project name for use as a subfolder name.
 * More restrictive than filename sanitization to ensure valid directory names.
 *
 * @param projectName - The project name from wizard
 * @returns A safe folder name
 */
export function sanitizeFolderName(projectName: string): string {
  return projectName
    // Replace spaces with hyphens
    .replace(/\s+/g, '-')
    // Remove path separators
    .replace(/[\/\\]/g, '-')
    // Remove special characters that are problematic in folder names
    .replace(/[<>:"|?*]/g, '')
    // Remove directory traversal sequences
    .replace(/\.\./g, '')
    // Remove null bytes and control characters
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Remove leading dots
    .replace(/^\.+/, '')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Trim whitespace
    .trim()
    // Ensure we have something left
    || 'wizard-project';
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
      const content = (doc as ExistingDocument & { content?: string }).content || '(Content not loaded)';
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
 * @returns The complete prompt for the agent
 */
function generateDocumentPrompt(config: DocumentGenerationConfig): string {
  const { projectName, directoryPath, conversationHistory, mode, goal, existingDocuments } = config;
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
  const basePrompt = mode === 'iterate'
    ? wizardInlineIterateGenerationPrompt
    : wizardDocumentGenerationPrompt;

  // Handle wizard-specific template variables
  let prompt = basePrompt
    .replace(/\{\{PROJECT_NAME\}\}/gi, projectDisplay)
    .replace(/\{\{DIRECTORY_PATH\}\}/gi, directoryPath)
    .replace(/\{\{AUTO_RUN_FOLDER_NAME\}\}/gi, AUTO_RUN_FOLDER_NAME)
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
  const phaseSectionPattern = /(?:^|\n)(#{1,2}\s*Phase\s*\d+[^\n]*)\n([\s\S]*?)(?=\n#{1,2}\s*Phase\s*\d+|$)/gi;

  let match;
  let phaseNumber = 1;

  while ((match = phaseSectionPattern.exec(content)) !== null) {
    const header = match[1].trim();
    const sectionContent = match[2].trim();

    // Create a proper document from this section
    const fullContent = `${header}\n\n${sectionContent}`;

    // Try to extract a description from the header
    const descMatch = header.match(/Phase\s*\d+[:\s-]*(.*)/i);
    const description = descMatch && descMatch[1].trim()
      ? descMatch[1].trim().replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-')
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
 * For document generation, we restrict tool usage to read-only operations
 * to prevent the agent from directly writing files instead of outputting
 * document markers for the application to save.
 */
function buildArgsForAgent(agent: { id: string; args?: string[] }): string[] {
  const agentId = agent.id;

  switch (agentId) {
    case 'claude-code': {
      const args = [...(agent.args || [])];
      if (!args.includes('--include-partial-messages')) {
        args.push('--include-partial-messages');
      }
      // Restrict to read-only tools during document generation
      // The agent should output document markers (---BEGIN DOCUMENT--- / ---END DOCUMENT---)
      // which the application parses and saves to the Auto Run folder.
      // This prevents the agent from directly creating files in the project directory.
      if (!args.includes('--allowedTools')) {
        args.push('--allowedTools', 'Read', 'Glob', 'Grep', 'LS');
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

  const action = doc.isUpdate ? 'Updating' : 'Creating';
  console.log(`[InlineWizardDocGen] ${action} document:`, filename);

  // Write the document (creates or overwrites as needed)
  const result = await window.maestro.autorun.writeDoc(
    autoRunFolderPath,
    filename,
    doc.content
  );

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

  // Create a sanitized subfolder name from the project name
  const subfolderName = sanitizeFolderName(projectName);
  const subfolderPath = `${autoRunFolderPath}/${subfolderName}`;

  callbacks?.onStart?.();
  callbacks?.onProgress?.('Preparing to generate your Playbook...');

  try {
    // Get the agent configuration
    const agent = await window.maestro.agents.get(agentType);
    if (!agent || !agent.available) {
      throw new Error(`Agent ${agentType} is not available`);
    }

    // Generate the prompt
    const prompt = generateDocumentPrompt(config);

    callbacks?.onProgress?.('Generating Auto Run Documents...');

    // Spawn agent and collect output
    const sessionId = `inline-wizard-gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const argsForSpawn = buildArgsForAgent(agent);

    const result = await new Promise<{ success: boolean; rawOutput: string; error?: string }>((resolve) => {
      let outputBuffer = '';
      let dataListenerCleanup: (() => void) | undefined;
      let exitListenerCleanup: (() => void) | undefined;

      // Set up timeout (5 minutes for complex generation)
      const timeoutId = setTimeout(() => {
        console.error('[InlineWizardDocGen] TIMEOUT fired! Session:', sessionId);
        cleanupListeners();
        window.maestro.process.kill(sessionId).catch(() => {});
        resolve({
          success: false,
          rawOutput: outputBuffer,
          error: 'Generation timed out after 5 minutes. Please try again.',
        });
      }, GENERATION_TIMEOUT);

      function cleanupListeners() {
        if (dataListenerCleanup) {
          dataListenerCleanup();
          dataListenerCleanup = undefined;
        }
        if (exitListenerCleanup) {
          exitListenerCleanup();
          exitListenerCleanup = undefined;
        }
      }

      // Set up data listener
      dataListenerCleanup = window.maestro.process.onData(
        (receivedSessionId: string, data: string) => {
          if (receivedSessionId === sessionId) {
            outputBuffer += data;
            callbacks?.onChunk?.(data);
          }
        }
      );

      // Set up exit listener
      exitListenerCleanup = window.maestro.process.onExit(
        (receivedSessionId: string, code: number) => {
          if (receivedSessionId === sessionId) {
            clearTimeout(timeoutId);
            cleanupListeners();

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
          console.log('[InlineWizardDocGen] Agent spawned successfully');
        })
        .catch((error: Error) => {
          cleanupListeners();
          clearTimeout(timeoutId);
          resolve({
            success: false,
            rawOutput: outputBuffer,
            error: `Failed to spawn agent: ${error.message}`,
          });
        });
    });

    if (!result.success) {
      callbacks?.onError?.(result.error || 'Generation failed');
      return {
        success: false,
        error: result.error,
        rawOutput: result.rawOutput,
      };
    }

    // Parse the output
    callbacks?.onProgress?.('Parsing generated documents...');

    const rawOutput = result.rawOutput;

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
    if (sessionId && savedDocuments.length > 0) {
      callbacks?.onProgress?.('Creating playbook configuration...');
      try {
        playbookInfo = await createPlaybookForDocuments(
          sessionId,
          projectName,
          subfolderName,
          savedDocuments
        );
        console.log('[InlineWizardDocGen] Created playbook:', playbookInfo);
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
