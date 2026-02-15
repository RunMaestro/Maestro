#!/usr/bin/env node

/**
 * Generates docs/releases.md from GitHub releases.
 *
 * Usage:
 *   node scripts/sync-release-notes.mjs
 *
 * Requires: gh CLI authenticated
 */

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

function fetchReleases() {
  try {
    const output = execFileSync(
      'gh',
      ['release', 'list', '--limit', '100', '--json', 'tagName,name,publishedAt,isPrerelease'],
      { encoding: 'utf-8', cwd: projectRoot }
    );
    return JSON.parse(output);
  } catch (error) {
    console.error('Failed to fetch releases:', error.message);
    process.exit(1);
  }
}

function fetchReleaseBody(tagName) {
  try {
    const output = execFileSync(
      'gh',
      ['release', 'view', tagName, '--json', 'body', '-q', '.body'],
      { encoding: 'utf-8', cwd: projectRoot }
    );
    return output.trim();
  } catch {
    return '';
  }
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getMinorVersion(tagName) {
  // v0.12.3 -> v0.12
  const match = tagName.match(/^v?(\d+)\.(\d+)/);
  if (match) {
    return `v${match[1]}.${match[2]}`;
  }
  return tagName;
}

function groupReleasesByMinor(releases) {
  const groups = new Map();

  for (const release of releases) {
    // Skip pre-releases and RC versions for the main listing
    if (release.isPrerelease || release.tagName.includes('-rc') || release.tagName.includes('-RC')) {
      continue;
    }

    const minor = getMinorVersion(release.tagName);
    if (!groups.has(minor)) {
      groups.set(minor, []);
    }
    groups.get(minor).push(release);
  }

  // Sort each group by version descending
  for (const [, releases] of groups) {
    releases.sort((a, b) => {
      const aVer = a.tagName.replace(/^v/, '').split('.').map(Number);
      const bVer = b.tagName.replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((bVer[i] || 0) !== (aVer[i] || 0)) {
          return (bVer[i] || 0) - (aVer[i] || 0);
        }
      }
      return 0;
    });
  }

  return groups;
}

function extractTitle(releaseName) {
  // "v0.12.3 | Thinking, Spec-Kits, Context Management" -> "Thinking, Spec-Kits, Context Management"
  const match = releaseName.match(/\|\s*(.+)$/);
  return match ? match[1].trim() : '';
}

function generateMarkdown(releases) {
  const grouped = groupReleasesByMinor(releases);

  // Sort groups by version descending
  const sortedGroups = Array.from(grouped.entries()).sort((a, b) => {
    const aVer = a[0].replace(/^v/, '').split('.').map(Number);
    const bVer = b[0].replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 2; i++) {
      if ((bVer[i] || 0) !== (aVer[i] || 0)) {
        return (bVer[i] || 0) - (aVer[i] || 0);
      }
    }
    return 0;
  });

  let md = `---
title: Release Notes
description: Version history and changelog for Maestro releases
---

# Release Notes

This page documents the version history of Maestro, including new features, improvements, and bug fixes for each release.

<Tip>
Maestro can update itself automatically! This feature was introduced in **v0.8.7** (December 16, 2025). Enable auto-updates in Settings to stay current.
</Tip>

---

`;

  for (const [minor, minorReleases] of sortedGroups) {
    const latest = minorReleases[0];
    const title = extractTitle(latest.name);
    const titleSuffix = title ? ` - ${title}` : '';

    md += `## ${minor}.x${titleSuffix}\n\n`;
    md += `**Latest: ${latest.tagName}** | Released ${formatDate(latest.publishedAt)}\n\n`;

    // Fetch and include the release body for the latest in this minor
    const body = fetchReleaseBody(latest.tagName);
    if (body) {
      // Clean up the body - remove "Full Changelog" links as they're redundant
      let cleanBody = body
        .replace(/\*\*Full Changelog\*\*:.*$/gm, '')
        .replace(/## What's Changed[\s\S]*?(?=##|$)/g, '') // Remove "What's Changed" sections
        .replace(/## New Contributors[\s\S]*?(?=##|$)/g, '') // Remove "New Contributors" sections
        .trim();

      // If body starts with a list, add context
      if (cleanBody.startsWith('-') || cleanBody.startsWith('*')) {
        md += '### Changes\n\n';
      }

      md += cleanBody + '\n\n';
    }

    // If there are patch releases, list them briefly
    if (minorReleases.length > 1) {
      md += '### Previous Releases in this Series\n\n';
      for (let i = 1; i < minorReleases.length; i++) {
        const rel = minorReleases[i];
        const relTitle = extractTitle(rel.name);
        md += `- **${rel.tagName}** (${formatDate(rel.publishedAt)})`;
        if (relTitle) {
          md += ` - ${relTitle}`;
        }
        md += '\n';
      }
      md += '\n';
    }

    md += '---\n\n';
  }

  md += `## Downloading Releases

All releases are available on the [GitHub Releases page](https://github.com/RunMaestro/Maestro/releases).

Maestro is available for:
- **macOS** - Apple Silicon (arm64) and Intel (x64)
- **Windows** - x64
- **Linux** - x64 and arm64, AppImage, deb, and rpm packages
`;

  return md;
}

async function main() {
  console.log('Fetching releases from GitHub...');
  const releases = fetchReleases();
  console.log(`Found ${releases.length} releases`);

  console.log('Generating markdown...');
  const markdown = generateMarkdown(releases);

  const outputPath = join(projectRoot, 'docs', 'releases.md');
  writeFileSync(outputPath, markdown, 'utf-8');
  console.log(`Written to ${outputPath}`);
}

main().catch(console.error);
