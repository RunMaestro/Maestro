/**
 * Spec Kit Manager
 *
 * Manages bundled spec-kit prompts with support for:
 * - Loading bundled prompts from src/prompts/speckit/
 * - Fetching updates from GitHub's spec-kit repository
 * - User customization with ability to reset to defaults
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { app } from 'electron';
import https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './utils/logger';

const execAsync = promisify(exec);

const LOG_CONTEXT = '[SpecKit]';

// All bundled spec-kit commands with their metadata
const SPECKIT_COMMANDS = [
  { id: 'help', command: '/speckit.help', description: 'Learn how to use spec-kit with Maestro', isCustom: true },
  { id: 'constitution', command: '/speckit.constitution', description: 'Create or update the project constitution', isCustom: false },
  { id: 'specify', command: '/speckit.specify', description: 'Create or update feature specification', isCustom: false },
  { id: 'clarify', command: '/speckit.clarify', description: 'Identify underspecified areas and ask clarification questions', isCustom: false },
  { id: 'plan', command: '/speckit.plan', description: 'Execute implementation planning workflow', isCustom: false },
  { id: 'tasks', command: '/speckit.tasks', description: 'Generate actionable, dependency-ordered tasks', isCustom: false },
  { id: 'analyze', command: '/speckit.analyze', description: 'Cross-artifact consistency and quality analysis', isCustom: false },
  { id: 'checklist', command: '/speckit.checklist', description: 'Generate custom checklist for feature', isCustom: false },
  { id: 'taskstoissues', command: '/speckit.taskstoissues', description: 'Convert tasks to GitHub issues', isCustom: false },
  { id: 'implement', command: '/speckit.implement', description: 'Execute tasks using Maestro Auto Run with worktree support', isCustom: true },
] as const;

export interface SpecKitCommand {
  id: string;
  command: string;
  description: string;
  prompt: string;
  isCustom: boolean;
  isModified: boolean;
}

export interface SpecKitMetadata {
  lastRefreshed: string;
  commitSha: string;
  sourceVersion: string;
  sourceUrl: string;
}

interface StoredPrompt {
  content: string;
  isModified: boolean;
  modifiedAt?: string;
}

interface StoredData {
  metadata: SpecKitMetadata;
  prompts: Record<string, StoredPrompt>;
}

/**
 * Get path to user's speckit customizations file
 */
function getUserDataPath(): string {
  return path.join(app.getPath('userData'), 'speckit-customizations.json');
}

/**
 * Load user customizations from disk
 */
async function loadUserCustomizations(): Promise<StoredData | null> {
  try {
    const content = await fs.readFile(getUserDataPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save user customizations to disk
 */
async function saveUserCustomizations(data: StoredData): Promise<void> {
  await fs.writeFile(getUserDataPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get the path to bundled prompts directory
 * In development, this is src/prompts/speckit
 * In production, this is in the app resources
 */
function getBundledPromptsPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'prompts', 'speckit');
  }
  // In development, use the source directory
  return path.join(__dirname, '..', '..', 'src', 'prompts', 'speckit');
}

/**
 * Get the user data directory for storing downloaded spec-kit prompts
 */
function getUserPromptsPath(): string {
  return path.join(app.getPath('userData'), 'speckit-prompts');
}

/**
 * Get bundled prompts by reading from disk
 * Checks user prompts directory first (for downloaded updates), then falls back to bundled
 */
async function getBundledPrompts(): Promise<Record<string, { prompt: string; description: string; isCustom: boolean }>> {
  const bundledPromptsDir = getBundledPromptsPath();
  const userPromptsDir = getUserPromptsPath();
  const result: Record<string, { prompt: string; description: string; isCustom: boolean }> = {};

  for (const cmd of SPECKIT_COMMANDS) {
    // For custom commands, always use bundled
    if (cmd.isCustom) {
      try {
        const promptPath = path.join(bundledPromptsDir, `speckit.${cmd.id}.md`);
        const prompt = await fs.readFile(promptPath, 'utf-8');
        result[cmd.id] = {
          prompt,
          description: cmd.description,
          isCustom: cmd.isCustom,
        };
      } catch (error) {
        logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, LOG_CONTEXT);
        result[cmd.id] = {
          prompt: `# ${cmd.id}\n\nPrompt not available.`,
          description: cmd.description,
          isCustom: cmd.isCustom,
        };
      }
      continue;
    }

    // For upstream commands, check user prompts directory first (downloaded updates)
    try {
      const userPromptPath = path.join(userPromptsDir, `speckit.${cmd.id}.md`);
      const prompt = await fs.readFile(userPromptPath, 'utf-8');
      result[cmd.id] = {
        prompt,
        description: cmd.description,
        isCustom: cmd.isCustom,
      };
      continue;
    } catch {
      // User prompt not found, try bundled
    }

    // Fall back to bundled prompts
    try {
      const promptPath = path.join(bundledPromptsDir, `speckit.${cmd.id}.md`);
      const prompt = await fs.readFile(promptPath, 'utf-8');
      result[cmd.id] = {
        prompt,
        description: cmd.description,
        isCustom: cmd.isCustom,
      };
    } catch (error) {
      logger.warn(`Failed to load bundled prompt for ${cmd.id}: ${error}`, LOG_CONTEXT);
      result[cmd.id] = {
        prompt: `# ${cmd.id}\n\nPrompt not available.`,
        description: cmd.description,
        isCustom: cmd.isCustom,
      };
    }
  }

  return result;
}

/**
 * Get bundled metadata by reading from disk
 * Checks user prompts directory first (for downloaded updates), then falls back to bundled
 */
async function getBundledMetadata(): Promise<SpecKitMetadata> {
  const bundledPromptsDir = getBundledPromptsPath();
  const userPromptsDir = getUserPromptsPath();

  // Check user prompts directory first (downloaded updates)
  try {
    const userMetadataPath = path.join(userPromptsDir, 'metadata.json');
    const content = await fs.readFile(userMetadataPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // User metadata not found, try bundled
  }

  // Fall back to bundled metadata
  try {
    const metadataPath = path.join(bundledPromptsDir, 'metadata.json');
    const content = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Return default metadata if file doesn't exist
    return {
      lastRefreshed: '2024-01-01T00:00:00Z',
      commitSha: 'bundled',
      sourceVersion: '0.0.90',
      sourceUrl: 'https://github.com/github/spec-kit',
    };
  }
}

/**
 * Get current spec-kit metadata
 */
export async function getSpeckitMetadata(): Promise<SpecKitMetadata> {
  const customizations = await loadUserCustomizations();
  if (customizations?.metadata) {
    return customizations.metadata;
  }
  return getBundledMetadata();
}

/**
 * Get all spec-kit prompts (bundled defaults merged with user customizations)
 */
export async function getSpeckitPrompts(): Promise<SpecKitCommand[]> {
  const bundled = await getBundledPrompts();
  const customizations = await loadUserCustomizations();

  const commands: SpecKitCommand[] = [];

  for (const [id, data] of Object.entries(bundled)) {
    const customPrompt = customizations?.prompts?.[id];
    const isModified = customPrompt?.isModified ?? false;
    const prompt = isModified && customPrompt ? customPrompt.content : data.prompt;

    commands.push({
      id,
      command: `/speckit.${id}`,
      description: data.description,
      prompt,
      isCustom: data.isCustom,
      isModified,
    });
  }

  return commands;
}

/**
 * Save user's edit to a spec-kit prompt
 */
export async function saveSpeckitPrompt(id: string, content: string): Promise<void> {
  const customizations = await loadUserCustomizations() ?? {
    metadata: await getBundledMetadata(),
    prompts: {},
  };

  customizations.prompts[id] = {
    content,
    isModified: true,
    modifiedAt: new Date().toISOString(),
  };

  await saveUserCustomizations(customizations);
  logger.info(`Saved customization for speckit.${id}`, LOG_CONTEXT);
}

/**
 * Reset a spec-kit prompt to its bundled default
 */
export async function resetSpeckitPrompt(id: string): Promise<string> {
  const bundled = await getBundledPrompts();
  const defaultPrompt = bundled[id];

  if (!defaultPrompt) {
    throw new Error(`Unknown speckit command: ${id}`);
  }

  const customizations = await loadUserCustomizations();
  if (customizations?.prompts?.[id]) {
    delete customizations.prompts[id];
    await saveUserCustomizations(customizations);
    logger.info(`Reset speckit.${id} to bundled default`, LOG_CONTEXT);
  }

  return defaultPrompt.prompt;
}

/**
 * Download a file from a URL using https
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl: string) => {
      https.get(currentUrl, { headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location!);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const file = fsSync.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * Upstream commands to fetch (we skip 'implement' as it's custom)
 */
const UPSTREAM_COMMANDS = [
  'constitution',
  'specify',
  'clarify',
  'plan',
  'tasks',
  'analyze',
  'checklist',
  'taskstoissues',
];

/**
 * Fetch latest prompts from GitHub spec-kit repository
 * Updates all upstream commands except our custom 'implement'
 */
export async function refreshSpeckitPrompts(): Promise<SpecKitMetadata> {
  logger.info('Refreshing spec-kit prompts from GitHub...', LOG_CONTEXT);

  // First, get the latest release info
  const releaseResponse = await fetch('https://api.github.com/repos/github/spec-kit/releases/latest');
  if (!releaseResponse.ok) {
    throw new Error(`Failed to fetch release info: ${releaseResponse.statusText}`);
  }

  const releaseInfo = await releaseResponse.json() as {
    tag_name: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const version = releaseInfo.tag_name;

  // Find the Claude template asset
  const claudeAsset = releaseInfo.assets?.find((a) =>
    a.name.includes('claude') && a.name.endsWith('.zip')
  );

  if (!claudeAsset) {
    throw new Error('Could not find Claude template in release assets');
  }

  // Create temp directory for download
  const tempDir = path.join(app.getPath('temp'), 'maestro-speckit-refresh');
  await fs.mkdir(tempDir, { recursive: true });

  const tempZipPath = path.join(tempDir, 'speckit.zip');

  try {
    // Download the ZIP file
    logger.info(`Downloading ${version} from ${claudeAsset.browser_download_url}`, LOG_CONTEXT);
    await downloadFile(claudeAsset.browser_download_url, tempZipPath);
    logger.info('Download complete', LOG_CONTEXT);

    // Extract prompts from ZIP
    logger.info('Extracting prompts...', LOG_CONTEXT);

    // List files in the ZIP to find prompt files
    const { stdout: listOutput } = await execAsync(`unzip -l "${tempZipPath}"`);
    const lines = listOutput.split('\n');
    const promptFiles: string[] = [];

    for (const line of lines) {
      // Match lines like: "  12345  01-01-2024 00:00   spec-kit-0.0.90/.claude/commands/constitution.md"
      const match = line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/);
      if (match) {
        const filePath = match[1].trim();
        if (filePath.includes('.claude/commands/') && filePath.endsWith('.md')) {
          promptFiles.push(filePath);
        }
      }
    }

    // Create user prompts directory
    const userPromptsDir = getUserPromptsPath();
    await fs.mkdir(userPromptsDir, { recursive: true });

    // Extract and save each prompt
    const extractedPrompts: Record<string, string> = {};
    for (const filePath of promptFiles) {
      const fileName = path.basename(filePath, '.md');
      // Skip files not in our upstream list
      if (!UPSTREAM_COMMANDS.includes(fileName)) continue;

      // Extract to temp location
      const tempExtractDir = path.join(tempDir, 'extract');
      await fs.mkdir(tempExtractDir, { recursive: true });
      await execAsync(`unzip -o -j "${tempZipPath}" "${filePath}" -d "${tempExtractDir}"`);

      // Read the extracted content
      const extractedPath = path.join(tempExtractDir, path.basename(filePath));
      try {
        const content = await fs.readFile(extractedPath, 'utf8');
        extractedPrompts[fileName] = content;

        // Save to user prompts directory
        const destPath = path.join(userPromptsDir, `speckit.${fileName}.md`);
        await fs.writeFile(destPath, content, 'utf8');
        logger.info(`Updated: speckit.${fileName}.md`, LOG_CONTEXT);
      } catch {
        logger.warn(`Failed to extract ${fileName}`, LOG_CONTEXT);
      }
    }

    // Update metadata with new version info
    const newMetadata: SpecKitMetadata = {
      lastRefreshed: new Date().toISOString(),
      commitSha: version,
      sourceVersion: version.replace(/^v/, ''),
      sourceUrl: 'https://github.com/github/spec-kit',
    };

    // Save metadata to user prompts directory
    await fs.writeFile(
      path.join(userPromptsDir, 'metadata.json'),
      JSON.stringify(newMetadata, null, 2),
      'utf8'
    );

    // Also save to customizations file for compatibility
    const customizations = await loadUserCustomizations() ?? {
      metadata: newMetadata,
      prompts: {},
    };
    customizations.metadata = newMetadata;
    await saveUserCustomizations(customizations);

    logger.info(`Refreshed spec-kit prompts to ${version}`, LOG_CONTEXT);

    return newMetadata;
  } finally {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get a single spec-kit command by ID
 */
export async function getSpeckitCommand(id: string): Promise<SpecKitCommand | null> {
  const commands = await getSpeckitPrompts();
  return commands.find((cmd) => cmd.id === id) ?? null;
}

/**
 * Get a spec-kit command by its slash command string (e.g., "/speckit.constitution")
 */
export async function getSpeckitCommandBySlash(slashCommand: string): Promise<SpecKitCommand | null> {
  const commands = await getSpeckitPrompts();
  return commands.find((cmd) => cmd.command === slashCommand) ?? null;
}
