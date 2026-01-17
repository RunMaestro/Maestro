# Local Manifest for Custom Playbooks

The local manifest feature allows you to extend the Playbook Exchange with custom or work-in-progress playbooks that are stored locally instead of in the public GitHub repository.

## Overview

- **File Location:** `<userData>/local-manifest.json` (same directory as `marketplace-cache.json`)
- **Format:** Same structure as the official `manifest.json` from GitHub
- **Optional:** If the file doesn't exist, Maestro works normally with official playbooks only
- **Hot Reload:** Changes to `local-manifest.json` automatically refresh the Playbook Exchange

## Use Cases

### 1. Bespoke Playbooks
Create organization-specific playbooks that aren't suitable for public sharing:
- Internal tools and workflows
- Proprietary processes
- Environment-specific automation
- Company-specific security policies

### 2. Playbook Development
Iterate on new playbooks locally before submitting them to the [Maestro-Playbooks repository](https://github.com/pedramamini/Maestro-Playbooks):
- Test playbook structure and documents
- Refine prompts and loop behavior
- Validate asset bundling
- Preview in the UI before publishing

## How It Works

### Merge Semantics

When both official and local manifests exist, they are merged by `id`:

1. **Override:** Local playbooks with the same `id` as official ones **override** the official version
2. **Append:** Local playbooks with unique `id`s are **added** to the catalog
3. **Source Tagging:** All playbooks are tagged with `source: 'official' | 'local'` for UI distinction

**Example:**
```
Official playbooks: [A, B, C]
Local playbooks:    [B_custom, D]
Merged result:      [A, B_custom, C, D]
                         ↑ override   ↑ append
```

### Path Resolution

Local playbooks support local filesystem paths:

- **Absolute paths:** `/Users/me/.maestro/custom-playbooks/security`
- **Tilde paths:** `~/maestro-playbooks/security`
- **Import behavior:** Files are copied from the local path instead of fetched from GitHub

## Schema

The local manifest uses the exact same structure as the official manifest. See [examples/local-manifest.json](./examples/local-manifest.json) for a complete example.

### Required Fields

Each playbook entry must include:

- `id` - Unique identifier (use same ID as official to override)
- `title` - Display name
- `description` - Short description for search and tiles
- `category` - Top-level category
- `author` - Creator name
- `lastUpdated` - Date in YYYY-MM-DD format
- `path` - **Local filesystem path** or GitHub path
- `documents` - Array of document entries with `filename` and `resetOnCompletion`
- `loopEnabled` - Whether to loop through documents
- `prompt` - Custom prompt or `null` for Maestro default

### Optional Fields

- `subcategory` - Nested category
- `authorLink` - URL to author's website
- `tags` - Searchable keyword array
- `maxLoops` - Maximum loop iterations (null for unlimited)
- `assets` - Asset files from `assets/` subfolder

## Creating a Local Playbook

### Step 1: Create Playbook Files

Organize your playbook in a local directory:

```
~/my-playbooks/security-audit/
├── 1_SCAN.md
├── 2_ANALYZE.md
├── 3_REPORT.md
├── README.md (optional)
└── assets/
    ├── config.yaml
    └── rules.json
```

### Step 2: Create local-manifest.json

Location: `<userData>/local-manifest.json`

On macOS: `~/Library/Application Support/Maestro/local-manifest.json`

```json
{
  "lastUpdated": "2026-01-17",
  "playbooks": [
    {
      "id": "security-audit-internal",
      "title": "Internal Security Audit",
      "description": "Custom security audit for our infrastructure",
      "category": "Security",
      "author": "Security Team",
      "lastUpdated": "2026-01-17",
      "path": "~/my-playbooks/security-audit",
      "documents": [
        { "filename": "1_SCAN", "resetOnCompletion": false },
        { "filename": "2_ANALYZE", "resetOnCompletion": true },
        { "filename": "3_REPORT", "resetOnCompletion": false }
      ],
      "loopEnabled": false,
      "prompt": null,
      "assets": ["config.yaml", "rules.json"]
    }
  ]
}
```

### Step 3: Open Playbook Exchange

Your local playbook will appear with a **"Local"** badge, distinguishing it from official playbooks.

### Step 4: Import and Use

Import works the same as official playbooks - files are copied from your local path to the Auto Run folder.

## Hot Reload

Changes to `local-manifest.json` trigger an automatic refresh:

1. Edit your local manifest
2. Save the file
3. The Playbook Exchange automatically reloads (500ms debounce)
4. No need to restart Maestro

This enables rapid iteration during playbook development.

## Error Handling

### Invalid JSON
**Behavior:** Warning logged, empty array used, Maestro continues with official playbooks only

**Fix:** Validate JSON syntax using a JSON validator

### Missing Required Fields
**Behavior:** Invalid entries are skipped with warnings, valid entries are loaded

**Fix:** Ensure all playbooks have `id`, `title`, `path`, and `documents`

### Local Path Doesn't Exist
**Behavior:** Clear error message during import, playbook listing works normally

**Fix:** Verify the `path` field points to an existing directory

### File Watch Errors
**Behavior:** Warning logged, hot reload disabled, normal operation continues

**Effect:** You'll need to restart Maestro to see manifest changes

## UI Indicators

Local playbooks are visually distinguished in the Playbook Exchange:

- **Badge:** Blue "Local" badge next to category
- **Tooltip:** "Custom local playbook" on hover
- **Search:** Works across both official and local playbooks
- **Categories:** New categories from local playbooks appear in filters

## Development Workflow

### Testing Before Publishing

1. Create your playbook files locally
2. Add to `local-manifest.json`
3. Test import and execution in Maestro
4. Refine documents and prompts
5. When ready, submit a PR to [Maestro-Playbooks](https://github.com/pedramamini/Maestro-Playbooks)
6. Remove from local manifest once published

### Overriding Official Playbooks

Use the same `id` as the official playbook to test modifications:

```json
{
  "id": "development-security",  // Same as official
  "title": "Dev Security (Custom)",
  "path": "~/my-version/dev-security",
  ...
}
```

This allows you to:
- Add custom documents
- Modify prompts
- Change loop behavior
- Test improvements before contributing

## Troubleshooting

### Playbook Doesn't Appear

1. Check JSON syntax in `local-manifest.json`
2. Verify all required fields are present
3. Look for warnings in console logs
4. Ensure `path` field is set correctly

### Import Fails

1. Verify the local `path` exists
2. Check file permissions on playbook directory
3. Ensure documents have `.md` extension
4. Verify assets exist in `assets/` subfolder

### Hot Reload Not Working

1. Check console for file watcher errors
2. Verify `local-manifest.json` path is correct
3. Try restarting Maestro
4. Check file system permissions

## Related Files

- **Manifest types:** `src/shared/marketplace-types.ts`
- **Marketplace handlers:** `src/main/ipc/handlers/marketplace.ts`
- **Import logic:** `marketplace:importPlaybook` handler
- **UI component:** `src/renderer/components/MarketplaceModal.tsx`
- **React hook:** `src/renderer/hooks/batch/useMarketplace.ts`

## Security Considerations

- Local manifest is **not synced** or shared
- Paths are validated before file operations
- Local-only playbooks remain private
- No network requests for local paths
- File watching is non-blocking and fails gracefully

## Future Enhancements

Potential improvements for consideration:

- JSON schema validation
- Visual editor for local manifest
- UI controls to manage local playbooks
- Relative paths from Auto Run directory
- Local manifest templates
- Import/export for sharing local manifests
