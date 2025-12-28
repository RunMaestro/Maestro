import { ipcMain, BrowserWindow, App } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { SshRemoteConfig } from '../../../shared/types';
import { MaestroSettings } from './persistence';
import {
  readDirRemote,
  readFileRemote,
  writeFileRemote,
  existsRemote,
  mkdirRemote,
} from '../../utils/remote-fs';

const LOG_CONTEXT = '[AutoRun]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess,
});

/**
 * Dependencies required for Auto Run handler registration.
 * Optional for backward compatibility - SSH remote support requires settingsStore.
 */
export interface AutorunHandlerDependencies {
  /** The settings store (MaestroSettings) - required for SSH remote lookup */
  settingsStore?: Store<MaestroSettings>;
}

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found or store not provided.
 */
function getSshRemoteById(
  store: Store<MaestroSettings> | undefined,
  sshRemoteId: string
): SshRemoteConfig | undefined {
  if (!store) {
    logger.warn(`${LOG_CONTEXT} Settings store not available for SSH remote lookup`, LOG_CONTEXT);
    return undefined;
  }
  const sshRemotes = store.get('sshRemotes', []) as SshRemoteConfig[];
  return sshRemotes.find((r) => r.id === sshRemoteId);
}

// State managed by this module
const autoRunWatchers = new Map<string, FSWatcher>();
let autoRunWatchDebounceTimer: NodeJS.Timeout | null = null;

/**
 * Tree node interface for autorun directory scanning.
 *
 * Note: This is intentionally different from shared/treeUtils.TreeNode:
 * - Includes a `path` property (pre-computed relative path from scanDirectory)
 * - shared TreeNode has only `name` and constructs paths during traversal
 *
 * @internal
 */
interface TreeNode {
  name: string;
  type: 'file' | 'folder';
  /** Pre-computed relative path from root folder */
  path: string;
  children?: TreeNode[];
}

/**
 * Recursively scan directory for markdown files
 */
async function scanDirectory(dirPath: string, relativePath: string = ''): Promise<TreeNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  // Sort entries: folders first, then files, both alphabetically
  const sortedEntries = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  for (const entry of sortedEntries) {
    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanDirectory(path.join(dirPath, entry.name), entryRelativePath);
      // Only include folders that contain .md files (directly or in subfolders)
      if (children.length > 0) {
        nodes.push({
          name: entry.name,
          type: 'folder',
          path: entryRelativePath,
          children,
        });
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      // Add .md file (without extension in name, but keep in path)
      nodes.push({
        name: entry.name.slice(0, -3),
        type: 'file',
        path: entryRelativePath.slice(0, -3), // Remove .md from path too
      });
    }
  }

  return nodes;
}

/**
 * Recursively scan directory for markdown files on a remote host via SSH.
 * This is the SSH version of scanDirectory.
 */
async function scanDirectoryRemote(
  dirPath: string,
  sshRemote: SshRemoteConfig,
  relativePath: string = ''
): Promise<TreeNode[]> {
  const result = await readDirRemote(dirPath, sshRemote);
  if (!result.success || !result.data) {
    logger.warn(`${LOG_CONTEXT} Failed to read remote directory: ${result.error}`, LOG_CONTEXT);
    return [];
  }

  const nodes: TreeNode[] = [];

  // Sort entries: folders first, then files, both alphabetically
  const sortedEntries = result.data
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  for (const entry of sortedEntries) {
    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory) {
      // Recursively scan subdirectory
      // Use forward slashes for remote paths (Unix style)
      const children = await scanDirectoryRemote(`${dirPath}/${entry.name}`, sshRemote, entryRelativePath);
      // Only include folders that contain .md files (directly or in subfolders)
      if (children.length > 0) {
        nodes.push({
          name: entry.name,
          type: 'folder',
          path: entryRelativePath,
          children,
        });
      }
    } else if (!entry.isDirectory && !entry.isSymlink && entry.name.toLowerCase().endsWith('.md')) {
      // Add .md file (without extension in name, but keep in path)
      nodes.push({
        name: entry.name.slice(0, -3),
        type: 'file',
        path: entryRelativePath.slice(0, -3), // Remove .md from path too
      });
    }
  }

  return nodes;
}

/**
 * Flatten tree structure to flat list of paths.
 *
 * Note: This is intentionally NOT using shared/treeUtils.getAllFilePaths because:
 * - autorun.ts TreeNode has a pre-computed `path` property from scanDirectory
 * - shared TreeNode builds paths on-the-fly from `name` properties
 * The shared utility would re-construct paths we already have, duplicating work.
 *
 * @internal
 */
function flattenTree(nodes: TreeNode[]): string[] {
  const files: string[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      files.push(node.path);
    } else if (node.children) {
      files.push(...flattenTree(node.children));
    }
  }
  return files;
}

/**
 * Validate path is within allowed folder (prevent directory traversal)
 */
function validatePathWithinFolder(filePath: string, folderPath: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedFolder = path.resolve(folderPath);
  return resolvedPath.startsWith(resolvedFolder + path.sep) || resolvedPath === resolvedFolder;
}

/**
 * Recursively check if a directory contains any markdown files.
 * Optimized to return early as soon as one .md file is found.
 */
async function checkForMarkdownFiles(dirPath: string): Promise<boolean> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files/folders
    if (entry.name.startsWith('.')) {
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      // Found a markdown file - return immediately
      return true;
    }

    if (entry.isDirectory()) {
      // Recursively check subdirectory
      const hasFiles = await checkForMarkdownFiles(path.join(dirPath, entry.name));
      if (hasFiles) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Register all Auto Run-related IPC handlers.
 *
 * These handlers provide Auto Run document operations:
 * - Document listing with tree structure
 * - Document read/write operations
 * - Image management (save, delete, list)
 * - Folder watching for external changes
 * - Folder deletion (wizard "start fresh" feature)
 *
 * SSH remote support: Handlers accept optional sshRemoteId parameter for remote file operations.
 */
export function registerAutorunHandlers(deps: {
  mainWindow: BrowserWindow | null;
  getMainWindow: () => BrowserWindow | null;
  app: App;
} & AutorunHandlerDependencies): void {
  const { getMainWindow, app, settingsStore } = deps;

  // List markdown files in a directory for Auto Run (with recursive subfolder support)
  // Supports SSH remote execution via optional sshRemoteId parameter
  ipcMain.handle(
    'autorun:listDocs',
    createIpcHandler(handlerOpts('listDocs'), async (folderPath: string, sshRemoteId?: string) => {
      // SSH remote: dispatch to remote operations
      if (sshRemoteId) {
        const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
        if (!sshConfig) {
          throw new Error(`SSH remote not found: ${sshRemoteId}`);
        }
        logger.debug(`${LOG_CONTEXT} listDocs via SSH: ${folderPath}`, LOG_CONTEXT);

        const tree = await scanDirectoryRemote(folderPath, sshConfig);
        const files = flattenTree(tree);

        logger.info(`Listed ${files.length} remote markdown files in ${folderPath} (with subfolders)`, LOG_CONTEXT);
        return { files, tree };
      }

      // Local: Validate the folder path exists
      const folderStat = await fs.stat(folderPath);
      if (!folderStat.isDirectory()) {
        throw new Error('Path is not a directory');
      }

      const tree = await scanDirectory(folderPath);
      const files = flattenTree(tree);

      logger.info(`Listed ${files.length} markdown files in ${folderPath} (with subfolders)`, LOG_CONTEXT);
      return { files, tree };
    })
  );

  // Quick check if Auto Run Docs folder exists and contains any .md files
  ipcMain.handle(
    'autorun:hasDocuments',
    createIpcHandler(handlerOpts('hasDocuments', false), async (folderPath: string) => {
      try {
        // First check if the folder exists
        const folderStat = await fs.stat(folderPath);
        if (!folderStat.isDirectory()) {
          return { hasDocuments: false };
        }

        // Check for any .md files (recursively, but stop early once we find one)
        const hasMarkdownFiles = await checkForMarkdownFiles(folderPath);
        return { hasDocuments: hasMarkdownFiles };
      } catch {
        // Folder doesn't exist or other error - no documents
        return { hasDocuments: false };
      }
    })
  );

  // Read a markdown document for Auto Run (supports subdirectories)
  // Supports SSH remote execution via optional sshRemoteId parameter
  ipcMain.handle(
    'autorun:readDoc',
    createIpcHandler(handlerOpts('readDoc'), async (folderPath: string, filename: string, sshRemoteId?: string) => {
      // Reject obvious traversal attempts
      if (filename.includes('..')) {
        throw new Error('Invalid filename');
      }

      // Ensure filename has .md extension
      const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

      // SSH remote: dispatch to remote operations
      if (sshRemoteId) {
        const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
        if (!sshConfig) {
          throw new Error(`SSH remote not found: ${sshRemoteId}`);
        }

        // Construct remote path (use forward slashes)
        const remotePath = `${folderPath}/${fullFilename}`;
        logger.debug(`${LOG_CONTEXT} readDoc via SSH: ${remotePath}`, LOG_CONTEXT);

        const result = await readFileRemote(remotePath, sshConfig);
        if (!result.success || result.data === undefined) {
          throw new Error(result.error || 'Failed to read remote file');
        }

        logger.info(`Read remote Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
        return { content: result.data };
      }

      // Local: Validate and read
      const filePath = path.join(folderPath, fullFilename);

      // Validate the file is within the folder path (prevent traversal)
      if (!validatePathWithinFolder(filePath, folderPath)) {
        throw new Error('Invalid file path');
      }

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        throw new Error('File not found');
      }

      // Read the file
      const content = await fs.readFile(filePath, 'utf-8');

      logger.info(`Read Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
      return { content };
    })
  );

  // Write a markdown document for Auto Run (supports subdirectories)
  // Supports SSH remote execution via optional sshRemoteId parameter
  ipcMain.handle(
    'autorun:writeDoc',
    createIpcHandler(handlerOpts('writeDoc'), async (folderPath: string, filename: string, content: string, sshRemoteId?: string) => {
      // DEBUG: Log all write attempts to trace cross-session contamination
      logger.info(
        `[DEBUG] writeDoc called: folder=${folderPath}, file=${filename}, content.length=${content.length}, content.slice(0,50)="${content.slice(0, 50).replace(/\n/g, '\\n')}"`,
        LOG_CONTEXT
      );
      console.log(`[DEBUG writeDoc] folder=${folderPath}, file=${filename}, content.length=${content.length}`);

      // Reject obvious traversal attempts
      if (filename.includes('..')) {
        throw new Error('Invalid filename');
      }

      // Ensure filename has .md extension
      const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

      // SSH remote: dispatch to remote operations
      if (sshRemoteId) {
        const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
        if (!sshConfig) {
          throw new Error(`SSH remote not found: ${sshRemoteId}`);
        }

        // Construct remote path (use forward slashes)
        const remotePath = `${folderPath}/${fullFilename}`;

        // Ensure parent directory exists on remote
        const remoteParentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
        if (remoteParentDir && remoteParentDir !== folderPath) {
          const parentExists = await existsRemote(remoteParentDir, sshConfig);
          if (!parentExists.success || !parentExists.data) {
            const mkdirResult = await mkdirRemote(remoteParentDir, sshConfig, true);
            if (!mkdirResult.success) {
              throw new Error(mkdirResult.error || 'Failed to create remote parent directory');
            }
          }
        }

        logger.debug(`${LOG_CONTEXT} writeDoc via SSH: ${remotePath}`, LOG_CONTEXT);

        const result = await writeFileRemote(remotePath, content, sshConfig);
        if (!result.success) {
          throw new Error(result.error || 'Failed to write remote file');
        }

        logger.info(`Wrote remote Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
        return {};
      }

      // Local: Validate and write
      const filePath = path.join(folderPath, fullFilename);

      // Validate the file is within the folder path (prevent traversal)
      if (!validatePathWithinFolder(filePath, folderPath)) {
        throw new Error('Invalid file path');
      }

      // Ensure the parent directory exists (create if needed for subdirectories)
      const parentDir = path.dirname(filePath);
      try {
        await fs.access(parentDir);
      } catch {
        // Parent dir doesn't exist - create it if it's within folderPath
        const resolvedParent = path.resolve(parentDir);
        const resolvedFolder = path.resolve(folderPath);
        if (resolvedParent.startsWith(resolvedFolder)) {
          await fs.mkdir(parentDir, { recursive: true });
        } else {
          throw new Error('Invalid parent directory');
        }
      }

      // Write the file
      await fs.writeFile(filePath, content, 'utf-8');

      logger.info(`Wrote Auto Run doc: ${fullFilename}`, LOG_CONTEXT);
      return {};
    })
  );

  // Save image to Auto Run folder
  ipcMain.handle(
    'autorun:saveImage',
    createIpcHandler(
      handlerOpts('saveImage'),
      async (folderPath: string, docName: string, base64Data: string, extension: string) => {
        // Sanitize docName to prevent directory traversal
        const sanitizedDocName = path.basename(docName).replace(/\.md$/i, '');
        if (sanitizedDocName.includes('..') || sanitizedDocName.includes('/')) {
          throw new Error('Invalid document name');
        }

        // Validate extension (only allow common image formats)
        const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
        const sanitizedExtension = extension.toLowerCase().replace(/[^a-z]/g, '');
        if (!allowedExtensions.includes(sanitizedExtension)) {
          throw new Error('Invalid image extension');
        }

        // Create images subdirectory if it doesn't exist
        const imagesDir = path.join(folderPath, 'images');
        try {
          await fs.mkdir(imagesDir, { recursive: true });
        } catch {
          // Directory might already exist, that's fine
        }

        // Generate filename: {docName}-{timestamp}.{ext}
        const timestamp = Date.now();
        const filename = `${sanitizedDocName}-${timestamp}.${sanitizedExtension}`;
        const filePath = path.join(imagesDir, filename);

        // Validate the file is within the folder path (prevent traversal)
        const resolvedPath = path.resolve(filePath);
        const resolvedFolder = path.resolve(folderPath);
        if (!resolvedPath.startsWith(resolvedFolder)) {
          throw new Error('Invalid file path');
        }

        // Decode and write the image
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(filePath, buffer);

        // Return the relative path for markdown insertion
        const relativePath = `images/${filename}`;
        logger.info(`Saved Auto Run image: ${relativePath}`, LOG_CONTEXT);
        return { relativePath };
      }
    )
  );

  // Delete image from Auto Run folder
  ipcMain.handle(
    'autorun:deleteImage',
    createIpcHandler(handlerOpts('deleteImage'), async (folderPath: string, relativePath: string) => {
      // Sanitize relativePath to prevent directory traversal
      const normalizedPath = path.normalize(relativePath);
      if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath) || !normalizedPath.startsWith('images/')) {
        throw new Error('Invalid image path');
      }

      const filePath = path.join(folderPath, normalizedPath);

      // Validate the file is within the folder path (prevent traversal)
      const resolvedPath = path.resolve(filePath);
      const resolvedFolder = path.resolve(folderPath);
      if (!resolvedPath.startsWith(resolvedFolder)) {
        throw new Error('Invalid file path');
      }

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        throw new Error('Image file not found');
      }

      // Delete the file
      await fs.unlink(filePath);
      logger.info(`Deleted Auto Run image: ${relativePath}`, LOG_CONTEXT);
      return {};
    })
  );

  // List images for a document (by prefix match)
  ipcMain.handle(
    'autorun:listImages',
    createIpcHandler(handlerOpts('listImages', false), async (folderPath: string, docName: string) => {
      // Sanitize docName to prevent directory traversal
      const sanitizedDocName = path.basename(docName).replace(/\.md$/i, '');
      if (sanitizedDocName.includes('..') || sanitizedDocName.includes('/')) {
        throw new Error('Invalid document name');
      }

      const imagesDir = path.join(folderPath, 'images');

      // Check if images directory exists
      try {
        await fs.access(imagesDir);
      } catch {
        // No images directory means no images
        return { images: [] };
      }

      // Read directory contents
      const files = await fs.readdir(imagesDir);

      // Filter files that start with the docName prefix
      const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      const images = files
        .filter((file) => {
          // Check if filename starts with docName-
          if (!file.startsWith(`${sanitizedDocName}-`)) {
            return false;
          }
          // Check if it has a valid image extension
          const ext = file.split('.').pop()?.toLowerCase();
          return ext && imageExtensions.includes(ext);
        })
        .map((file) => ({
          filename: file,
          relativePath: `images/${file}`,
        }));

      return { images };
    })
  );

  // Delete the entire Auto Run Docs folder (for wizard "start fresh" feature)
  ipcMain.handle(
    'autorun:deleteFolder',
    createIpcHandler(handlerOpts('deleteFolder'), async (projectPath: string) => {
      // Validate input
      if (!projectPath || typeof projectPath !== 'string') {
        throw new Error('Invalid project path');
      }

      // Construct the Auto Run Docs folder path
      const autoRunFolder = path.join(projectPath, 'Auto Run Docs');

      // Verify the folder exists
      try {
        const stat = await fs.stat(autoRunFolder);
        if (!stat.isDirectory()) {
          throw new Error('Auto Run Docs path is not a directory');
        }
      } catch (e) {
        // If stat throws ENOENT, folder doesn't exist - nothing to delete
        if (e instanceof Error && e.message.includes('ENOENT')) {
          return {};
        }
        // If it's our own "not a directory" error, rethrow
        if (e instanceof Error && e.message === 'Auto Run Docs path is not a directory') {
          throw e;
        }
        // Folder doesn't exist, nothing to delete
        return {};
      }

      // Safety check: ensure we're only deleting "Auto Run Docs" folder
      const folderName = path.basename(autoRunFolder);
      if (folderName !== 'Auto Run Docs') {
        throw new Error('Safety check failed: not an Auto Run Docs folder');
      }

      // Delete the folder recursively
      await fs.rm(autoRunFolder, { recursive: true, force: true });

      logger.info(`Deleted Auto Run Docs folder: ${autoRunFolder}`, LOG_CONTEXT);
      return {};
    })
  );

  // Start watching an Auto Run folder for changes
  // Supports SSH remote execution via optional sshRemoteId parameter
  // For remote sessions, file watching is not supported (chokidar can't watch remote directories)
  // Returns isRemote: true to indicate the UI should poll using listDocs instead
  ipcMain.handle(
    'autorun:watchFolder',
    createIpcHandler(handlerOpts('watchFolder'), async (folderPath: string, sshRemoteId?: string) => {
      // SSH remote: Cannot use chokidar for remote directories
      // Return success with isRemote flag so UI can fall back to polling
      if (sshRemoteId) {
        const sshConfig = getSshRemoteById(settingsStore, sshRemoteId);
        if (!sshConfig) {
          throw new Error(`SSH remote not found: ${sshRemoteId}`);
        }

        // Ensure remote folder exists (create if not)
        const folderExists = await existsRemote(folderPath, sshConfig);
        if (!folderExists.success || !folderExists.data) {
          const mkdirResult = await mkdirRemote(folderPath, sshConfig, true);
          if (!mkdirResult.success) {
            throw new Error(mkdirResult.error || 'Failed to create remote Auto Run folder');
          }
          logger.info(`Created remote Auto Run folder: ${folderPath}`, LOG_CONTEXT);
        }

        logger.info(`Remote Auto Run folder ready (polling mode): ${folderPath}`, LOG_CONTEXT);
        return { isRemote: true, message: 'File watching not available for remote sessions. Use polling.' };
      }

      // Local: Stop any existing watcher for this folder
      if (autoRunWatchers.has(folderPath)) {
        autoRunWatchers.get(folderPath)?.close();
        autoRunWatchers.delete(folderPath);
      }

      // Create folder if it doesn't exist (agent will create files in it)
      try {
        await fs.stat(folderPath);
      } catch {
        // Folder doesn't exist, create it
        await fs.mkdir(folderPath, { recursive: true });
        logger.info(`Created Auto Run folder for watching: ${folderPath}`, LOG_CONTEXT);
      }

      // Validate folder exists
      const folderStat = await fs.stat(folderPath);
      if (!folderStat.isDirectory()) {
        throw new Error('Path is not a directory');
      }

      // Start watching the folder recursively using chokidar (cross-platform)
      const watcher = chokidar.watch(folderPath, {
        ignored: /(^|[/\\])\../, // Ignore dotfiles
        persistent: true,
        ignoreInitial: true, // Don't emit events for existing files on startup
        depth: 99, // Recursive watching
      });

      // Handler for file changes
      const handleFileChange = (eventType: string) => (filePath: string) => {
        // Only care about .md files
        if (!filePath.toLowerCase().endsWith('.md')) {
          return;
        }

        // Get filename relative to watch folder
        const filename = path.relative(folderPath, filePath);

        // Debounce to avoid flooding with events during rapid saves
        if (autoRunWatchDebounceTimer) {
          clearTimeout(autoRunWatchDebounceTimer);
        }

        autoRunWatchDebounceTimer = setTimeout(() => {
          autoRunWatchDebounceTimer = null;
          // Send event to renderer
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            // Remove .md extension from filename to match autorun conventions
            const filenameWithoutExt = filename.replace(/\.md$/i, '');
            mainWindow.webContents.send('autorun:fileChanged', {
              folderPath,
              filename: filenameWithoutExt,
              eventType,
            });
            logger.info(`Auto Run file changed: ${filename} (${eventType})`, LOG_CONTEXT);
          }
        }, 300); // 300ms debounce
      };

      watcher.on('add', handleFileChange('rename'));
      watcher.on('change', handleFileChange('change'));
      watcher.on('unlink', handleFileChange('rename'));

      autoRunWatchers.set(folderPath, watcher);

      watcher.on('error', (error) => {
        logger.error(`Auto Run watcher error for ${folderPath}`, LOG_CONTEXT, error);
      });

      logger.info(`Started watching Auto Run folder: ${folderPath}`, LOG_CONTEXT);
      return {};
    })
  );

  // Stop watching an Auto Run folder
  ipcMain.handle(
    'autorun:unwatchFolder',
    createIpcHandler(handlerOpts('unwatchFolder', false), async (folderPath: string) => {
      if (autoRunWatchers.has(folderPath)) {
        autoRunWatchers.get(folderPath)?.close();
        autoRunWatchers.delete(folderPath);
        logger.info(`Stopped watching Auto Run folder: ${folderPath}`, LOG_CONTEXT);
      }
      return {};
    })
  );

  // Create a backup copy of a document (for reset-on-completion)
  ipcMain.handle(
    'autorun:createBackup',
    createIpcHandler(handlerOpts('createBackup'), async (folderPath: string, filename: string) => {
      // Reject obvious traversal attempts
      if (filename.includes('..')) {
        throw new Error('Invalid filename');
      }

      // Ensure filename has .md extension
      const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
      const backupFilename = fullFilename.replace(/\.md$/, '.backup.md');

      const sourcePath = path.join(folderPath, fullFilename);
      const backupPath = path.join(folderPath, backupFilename);

      // Validate paths are within folder
      if (!validatePathWithinFolder(sourcePath, folderPath) || !validatePathWithinFolder(backupPath, folderPath)) {
        throw new Error('Invalid file path');
      }

      // Check if source file exists
      try {
        await fs.access(sourcePath);
      } catch {
        throw new Error('Source file not found');
      }

      // Copy the file to backup
      await fs.copyFile(sourcePath, backupPath);

      logger.info(`Created Auto Run backup: ${backupFilename}`, LOG_CONTEXT);
      return { backupFilename };
    })
  );

  // Restore a document from its backup (for reset-on-completion)
  ipcMain.handle(
    'autorun:restoreBackup',
    createIpcHandler(handlerOpts('restoreBackup'), async (folderPath: string, filename: string) => {
      // Reject obvious traversal attempts
      if (filename.includes('..')) {
        throw new Error('Invalid filename');
      }

      // Ensure filename has .md extension
      const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
      const backupFilename = fullFilename.replace(/\.md$/, '.backup.md');

      const targetPath = path.join(folderPath, fullFilename);
      const backupPath = path.join(folderPath, backupFilename);

      // Validate paths are within folder
      if (!validatePathWithinFolder(targetPath, folderPath) || !validatePathWithinFolder(backupPath, folderPath)) {
        throw new Error('Invalid file path');
      }

      // Check if backup file exists
      try {
        await fs.access(backupPath);
      } catch {
        throw new Error('Backup file not found');
      }

      // Copy backup back to original
      await fs.copyFile(backupPath, targetPath);

      // Delete the backup
      await fs.unlink(backupPath);

      logger.info(`Restored Auto Run backup: ${fullFilename}`, LOG_CONTEXT);
      return {};
    })
  );

  // Create a working copy of a document for reset-on-completion loops
  // Working copies are stored in /Runs/ subdirectory with format: {name}-{timestamp}-loop-{N}.md
  ipcMain.handle(
    'autorun:createWorkingCopy',
    createIpcHandler(
      handlerOpts('createWorkingCopy'),
      async (folderPath: string, filename: string, loopNumber: number) => {
        // Reject obvious traversal attempts
        if (filename.includes('..')) {
          throw new Error('Invalid filename');
        }

        // Ensure filename has .md extension for source, remove for naming
        const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
        const baseName = filename.endsWith('.md') ? filename.slice(0, -3) : filename;

        // Handle subdirectory paths (e.g., "Ingest-Loop/0_DISCOVER_NEW")
        const pathParts = baseName.split('/');
        const docName = pathParts[pathParts.length - 1];
        const subDir = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';

        const sourcePath = path.join(folderPath, fullFilename);

        // Validate source path is within folder
        if (!validatePathWithinFolder(sourcePath, folderPath)) {
          throw new Error('Invalid file path');
        }

        // Check if source file exists
        try {
          await fs.access(sourcePath);
        } catch {
          throw new Error('Source file not found');
        }

        // Create Runs directory (with subdirectory if needed)
        const runsDir = subDir
          ? path.join(folderPath, 'Runs', subDir)
          : path.join(folderPath, 'Runs');
        await fs.mkdir(runsDir, { recursive: true });

        // Generate working copy filename: {name}-{timestamp}-loop-{N}.md
        const timestamp = Date.now();
        const workingCopyName = `${docName}-${timestamp}-loop-${loopNumber}.md`;
        const workingCopyPath = path.join(runsDir, workingCopyName);

        // Validate working copy path is within folder
        if (!validatePathWithinFolder(workingCopyPath, folderPath)) {
          throw new Error('Invalid working copy path');
        }

        // Copy the source to working copy
        await fs.copyFile(sourcePath, workingCopyPath);

        // Return the relative path (without .md for consistency with other APIs)
        const relativePath = subDir
          ? `Runs/${subDir}/${workingCopyName.slice(0, -3)}`
          : `Runs/${workingCopyName.slice(0, -3)}`;

        logger.info(`Created Auto Run working copy: ${relativePath}`, LOG_CONTEXT);
        return { workingCopyPath: relativePath, originalPath: baseName };
      }
    )
  );

  // Delete all backup files in a folder
  ipcMain.handle(
    'autorun:deleteBackups',
    createIpcHandler(handlerOpts('deleteBackups'), async (folderPath: string) => {
      // Validate folder exists
      const folderStat = await fs.stat(folderPath);
      if (!folderStat.isDirectory()) {
        throw new Error('Path is not a directory');
      }

      // Find and delete all .backup.md files recursively
      const deleteBackupsRecursive = async (dirPath: string): Promise<number> => {
        let deleted = 0;
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry.name);

          if (entry.isDirectory()) {
            // Recurse into subdirectory
            deleted += await deleteBackupsRecursive(entryPath);
          } else if (entry.isFile() && entry.name.endsWith('.backup.md')) {
            // Delete backup file
            await fs.unlink(entryPath);
            deleted++;
            logger.info(`Deleted Auto Run backup: ${entry.name}`, LOG_CONTEXT);
          }
        }

        return deleted;
      };

      const deletedCount = await deleteBackupsRecursive(folderPath);
      logger.info(`Deleted ${deletedCount} Auto Run backup(s) in ${folderPath}`, LOG_CONTEXT);
      return { deletedCount };
    })
  );

  // Clean up all watchers on app quit
  app.on('before-quit', () => {
    for (const [folderPath, watcher] of autoRunWatchers) {
      watcher.close();
      logger.info(`Cleaned up Auto Run watcher for: ${folderPath}`, LOG_CONTEXT);
    }
    autoRunWatchers.clear();
  });

  logger.debug(`${LOG_CONTEXT} Auto Run IPC handlers registered`);
}

/**
 * Get the current number of active watchers (for testing/debugging)
 */
export function getAutoRunWatcherCount(): number {
  return autoRunWatchers.size;
}
