#!/usr/bin/env node
/**
 * Refresh Spec Kit Prompts
 *
 * Fetches the latest spec-kit prompts from GitHub and updates the bundled files.
 * Run manually before releases or when spec-kit updates.
 *
 * Usage: npm run refresh-speckit
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { createWriteStream } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPECKIT_DIR = path.join(__dirname, '..', 'src', 'prompts', 'speckit');
const METADATA_PATH = path.join(SPECKIT_DIR, 'metadata.json');

// GitHub spec-kit repository info
const GITHUB_API = 'https://api.github.com';
const REPO_OWNER = 'github';
const REPO_NAME = 'spec-kit';

// Commands to fetch (these are upstream commands, we skip 'implement' as it's custom)
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
 * Make an HTTPS GET request
 */
function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Maestro-SpecKit-Refresher',
      ...options.headers,
    };

    https.get(url, { headers }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpsGet(res.headers.location, options));
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ data, headers: res.headers }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Download file from URL
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(downloadFile(res.headers.location, destPath));
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const file = createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract a specific file from a ZIP archive
 */
async function extractFromZip(zipPath, filePattern, destDir) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  // List files in the ZIP
  const { stdout: listOutput } = await execAsync(`unzip -l "${zipPath}"`);

  // Find matching files
  const lines = listOutput.split('\n');
  const matchingFiles = [];

  for (const line of lines) {
    // Match lines like: "  12345  01-01-2024 00:00   spec-kit-0.0.90/.claude/commands/constitution.md"
    const match = line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/);
    if (match) {
      const filePath = match[1].trim();
      if (filePath.includes('.claude/commands/') && filePath.endsWith('.md')) {
        matchingFiles.push(filePath);
      }
    }
  }

  // Extract matching files
  const extractedFiles = {};
  for (const filePath of matchingFiles) {
    const fileName = path.basename(filePath, '.md');
    // Skip files not in our upstream list
    if (!UPSTREAM_COMMANDS.includes(fileName)) continue;

    // Extract to temp location
    const tempDir = path.join(destDir, '.temp-extract');
    await execAsync(`unzip -o -j "${zipPath}" "${filePath}" -d "${tempDir}"`);

    // Read the extracted content
    const extractedPath = path.join(tempDir, path.basename(filePath));
    if (fs.existsSync(extractedPath)) {
      extractedFiles[fileName] = fs.readFileSync(extractedPath, 'utf8');
      fs.unlinkSync(extractedPath);
    }
  }

  // Clean up temp directory
  const tempDir = path.join(destDir, '.temp-extract');
  if (fs.existsSync(tempDir)) {
    fs.rmdirSync(tempDir, { recursive: true });
  }

  return extractedFiles;
}

/**
 * Get the latest release info from GitHub
 */
async function getLatestRelease() {
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const { data } = await httpsGet(url);
  return JSON.parse(data);
}

/**
 * Find the Claude template ZIP asset in the release
 */
function findClaudeTemplateAsset(release) {
  return release.assets.find(asset =>
    asset.name.includes('claude') && asset.name.endsWith('.zip')
  );
}

/**
 * Main refresh function
 */
async function refreshSpecKit() {
  console.log('🔄 Refreshing Spec Kit prompts from GitHub...\n');

  // Ensure speckit directory exists
  if (!fs.existsSync(SPECKIT_DIR)) {
    console.error('❌ Spec Kit directory not found:', SPECKIT_DIR);
    process.exit(1);
  }

  try {
    // Get latest release
    console.log('📡 Fetching latest release info...');
    const release = await getLatestRelease();
    console.log(`   Found release: ${release.tag_name} (${release.name})`);

    // Find Claude template ZIP
    const claudeAsset = findClaudeTemplateAsset(release);
    if (!claudeAsset) {
      console.error('❌ Could not find Claude template ZIP in release assets');
      process.exit(1);
    }
    console.log(`   Claude template: ${claudeAsset.name}`);

    // Download the ZIP
    const tempZipPath = path.join(SPECKIT_DIR, '.temp-speckit.zip');
    console.log('\n📥 Downloading template ZIP...');
    await downloadFile(claudeAsset.browser_download_url, tempZipPath);
    console.log('   Download complete');

    // Extract prompts from ZIP
    console.log('\n📦 Extracting prompts...');
    const extractedPrompts = await extractFromZip(tempZipPath, '', SPECKIT_DIR);

    // Clean up temp ZIP
    fs.unlinkSync(tempZipPath);

    // Update prompt files
    console.log('\n✏️  Updating prompt files...');
    let updatedCount = 0;
    for (const [commandName, content] of Object.entries(extractedPrompts)) {
      const promptFile = path.join(SPECKIT_DIR, `speckit.${commandName}.md`);
      const existingContent = fs.existsSync(promptFile)
        ? fs.readFileSync(promptFile, 'utf8')
        : '';

      if (content !== existingContent) {
        fs.writeFileSync(promptFile, content);
        console.log(`   ✓ Updated: speckit.${commandName}.md`);
        updatedCount++;
      } else {
        console.log(`   - Unchanged: speckit.${commandName}.md`);
      }
    }

    // Update metadata
    const version = release.tag_name.replace(/^v/, '');
    const metadata = {
      lastRefreshed: new Date().toISOString(),
      commitSha: release.tag_name,
      sourceVersion: version,
      sourceUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
    };

    fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2));
    console.log('\n📄 Updated metadata.json');

    // Summary
    console.log('\n✅ Refresh complete!');
    console.log(`   Version: ${version}`);
    console.log(`   Updated: ${updatedCount} files`);
    console.log(`   Skipped: implement (custom Maestro prompt)`);

  } catch (error) {
    console.error('\n❌ Refresh failed:', error.message);
    process.exit(1);
  }
}

// Run
refreshSpecKit();
