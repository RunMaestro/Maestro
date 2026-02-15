# Maestro Symphony Registry

The central registry for open source projects participating in Symphony.

## Overview

Symphony connects open source maintainers with AI-powered contributors. Maintainers register their repositories, create Auto Run documents, and open GitHub Issues with the `runmaestro.ai` label. Contributors browse available tasks and complete them via Maestro's Auto Run feature.

## Repository Structure

The registry lives in the main Maestro repository:

```
RunMaestro/Maestro/
├── symphony-registry.json    # Central list of all projects
└── docs/
    └── SYMPHONY_REGISTRY.md  # This documentation
```

## symphony-registry.json Schema

```json
{
  "schemaVersion": "1.0",
  "lastUpdated": "2025-01-01T00:00:00Z",
  "repositories": [
    {
      "slug": "owner/repo-name",
      "name": "Human Readable Name",
      "description": "Short description of the project",
      "url": "https://github.com/owner/repo-name",
      "category": "developer-tools",
      "tags": ["cli", "productivity"],
      "maintainer": {
        "name": "Name",
        "url": "https://..."
      },
      "isActive": true,
      "featured": false,
      "addedAt": "2025-01-01"
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | Yes | Repository identifier in `owner/repo` format |
| `name` | string | Yes | Human-readable project name |
| `description` | string | Yes | Short description (max 200 chars) |
| `url` | string | Yes | Full GitHub repository URL |
| `category` | string | Yes | Primary category (see Categories below) |
| `tags` | string[] | No | Optional tags for search/filtering |
| `maintainer.name` | string | Yes | Maintainer or organization name |
| `maintainer.url` | string | No | Optional link to maintainer profile |
| `isActive` | boolean | Yes | Whether repo is accepting contributions |
| `featured` | boolean | No | Show in featured section (default: false) |
| `addedAt` | string | Yes | ISO 8601 date when registered |

## How It Works

1. **Maintainers register once** by submitting a PR to add their repo to `symphony-registry.json`
2. **Maintainers create Auto Run documents** in their repository (e.g., `.maestro/autorun/`)
3. **Maintainers open GitHub Issues** with the `runmaestro.ai` label, listing document paths
4. **Contributors browse** available issues in Maestro Symphony
5. **One-click contribution** clones the repo, creates a draft PR (claiming the issue), and runs Auto Run
6. **Finalize PR** when all documents are processed
7. **Maintainer reviews** and merges the contribution

## Categories

| ID | Label | Use Case |
|----|-------|----------|
| `ai-ml` | AI & ML | AI/ML tools and libraries |
| `developer-tools` | Developer Tools | Developer productivity tools |
| `infrastructure` | Infrastructure | DevOps, cloud, infrastructure |
| `documentation` | Documentation | Documentation projects |
| `web` | Web | Web frameworks and libraries |
| `mobile` | Mobile | Mobile development |
| `data` | Data | Data processing, databases |
| `security` | Security | Security tools |
| `other` | Other | Miscellaneous projects |

## Registering a Repository

### Prerequisites

Before registering, ensure your repository:

- Has a clear README explaining the project
- Has contribution guidelines (CONTRIBUTING.md)
- Uses a license compatible with open source (MIT, Apache 2.0, etc.)
- Has at least one Auto Run document ready

### Registration Steps

1. **Fork** the `RunMaestro/Maestro` repository
2. **Add your entry** to `symphony-registry.json`:

```json
{
  "slug": "your-org/your-repo",
  "name": "Your Project Name",
  "description": "Brief description of your project",
  "url": "https://github.com/your-org/your-repo",
  "category": "developer-tools",
  "tags": ["typescript", "cli"],
  "maintainer": {
    "name": "Your Name",
    "url": "https://github.com/your-username"
  },
  "isActive": true,
  "featured": false,
  "addedAt": "2025-01-15"
}
```

3. **Submit a PR** with your repository details
4. Once merged, **create issues** with the `runmaestro.ai` label to enable contributions

### After Registration

Once your repository is in the registry:

1. Create a `.maestro/autorun/` directory in your repo (optional, but recommended)
2. Write Auto Run documents for contribution tasks
3. Open GitHub Issues with the `runmaestro.ai` label
4. List the document paths in the issue body

See [SYMPHONY_ISSUES.md](SYMPHONY_ISSUES.md) for detailed issue formatting guidelines.

## Updating Your Entry

To update your registry entry (e.g., change category, update description):

1. Submit a PR modifying your entry in `symphony-registry.json`
2. Keep your `slug` unchanged to maintain history

## Removing Your Repository

To remove your repository from Symphony:

1. Set `isActive: false` in your registry entry, OR
2. Submit a PR removing your entry entirely

Note: Setting `isActive: false` hides your repo from the contributor UI but preserves contribution history.

## Registry Caching

The Symphony client caches the registry for 2 hours to reduce API calls. Changes to the registry may take up to 2 hours to propagate to all users.

## Questions?

- See [SYMPHONY_ISSUES.md](SYMPHONY_ISSUES.md) for issue formatting
- Check the [Maestro documentation](https://docs.runmaestro.ai) for Auto Run guides
- Open an issue on the Maestro repository for support
