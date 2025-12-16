import { ipcMain, BrowserWindow, App } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[AutoRun]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess,
});

// State managed by this module
const autoRunWatchers = new Map<string, fsSync.FSWatcher>();
let autoRunWatchDebounceTimer: NodeJS.Timeout | null = null;

// Tree node interface for directory scanning
interface TreeNode {
  name: string;
  type: 'file' | 'folder';
  path: string; // Relative path from root folder
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
 * Flatten tree structure to flat list of paths
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
 * Register all Auto Run-related IPC handlers.
 *
 * These handlers provide Auto Run document operations:
 * - Document listing with tree structure
 * - Document read/write operations
 * - Image management (save, delete, list)
 * - Folder watching for external changes
 * - Folder deletion (wizard "start fresh" feature)
 */
export function registerAutorunHandlers(deps: {
  mainWindow: BrowserWindow | null;
  getMainWindow: () => BrowserWindow | null;
  app: App;
}): void {
  const { getMainWindow, app } = deps;

  // List markdown files in a directory for Auto Run (with recursive subfolder support)
  ipcMain.handle(
    'autorun:listDocs',
    createIpcHandler(handlerOpts('listDocs'), async (folderPath: string) => {
      // Validate the folder path exists
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

  // Read a markdown document for Auto Run (supports subdirectories)
  ipcMain.handle(
    'autorun:readDoc',
    createIpcHandler(handlerOpts('readDoc'), async (folderPath: string, filename: string) => {
      // Reject obvious traversal attempts
      if (filename.includes('..')) {
        throw new Error('Invalid filename');
      }

      // Ensure filename has .md extension
      const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

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
  ipcMain.handle(
    'autorun:writeDoc',
    createIpcHandler(handlerOpts('writeDoc'), async (folderPath: string, filename: string, content: string) => {
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
  ipcMain.handle(
    'autorun:watchFolder',
    createIpcHandler(handlerOpts('watchFolder'), async (folderPath: string) => {
      // Stop any existing watcher for this folder
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

      // Start watching the folder recursively
      const watcher = fsSync.watch(folderPath, { recursive: true }, (eventType, filename) => {
        // Only care about .md files
        if (!filename || !filename.toLowerCase().endsWith('.md')) {
          return;
        }

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
              eventType, // 'rename' or 'change'
            });
            logger.info(`Auto Run file changed: ${filename} (${eventType})`, LOG_CONTEXT);
          }
        }, 300); // 300ms debounce
      });

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
