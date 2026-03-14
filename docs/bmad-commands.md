---
title: BMAD Commands
description: Use BMAD Method workflows inside Maestro's AI Commands panel.
---

# BMAD Commands

Maestro bundles a curated set of prompts from [bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) and exposes them in **Settings -> AI Commands**.

You can review, edit, reset, and refresh these prompts the same way you can with Spec-Kit and OpenSpec.

## What Is Included

The BMAD bundle covers the main workflow families published by BMAD:

- **Core utilities** like `/bmad-help`, `/bmad-brainstorming`, `/bmad-party-mode`, `/bmad-index-docs`, and review-oriented prompts
- **Analysis workflows** like `/bmad-bmm-market-research`, `/bmad-bmm-domain-research`, `/bmad-bmm-technical-research`, and `/bmad-bmm-create-product-brief`
- **Planning workflows** like `/bmad-bmm-create-prd`, `/bmad-bmm-validate-prd`, `/bmad-bmm-edit-prd`, and `/bmad-bmm-create-ux-design`
- **Solutioning workflows** like `/bmad-bmm-create-architecture`, `/bmad-bmm-create-epics-and-stories`, and `/bmad-bmm-check-implementation-readiness`
- **Implementation workflows** like `/bmad-bmm-sprint-planning`, `/bmad-bmm-create-story`, `/bmad-bmm-dev-story`, `/bmad-bmm-code-review`, and `/bmad-bmm-qa-automate`
- **Quick flow workflows** like `/bmad-bmm-quick-spec`, `/bmad-bmm-quick-dev`, and `/bmad-bmm-quick-dev-new-preview`

## Important Prerequisite

Many BMAD prompts assume the target repository already contains BMAD's project artifacts such as the `_bmad/` directory, workflow configs, sprint files, and generated planning documents.

If those files are missing, the prompt may still provide guidance, but BMAD works best when the repository has already been prepared with the BMAD installer or equivalent project structure.

## Updating The Bundle

From the AI Commands settings panel, use **Check for Updates** in the BMAD section to pull the latest upstream workflow text from BMAD.

This updates Maestro's cached copy of the upstream prompts while preserving any local edits you have made in the app.

## Editing Prompts

Each bundled BMAD command can be:

- expanded to inspect the current prompt
- edited and saved locally
- reset back to the bundled default

Local edits are stored in Maestro's application data and do not modify the upstream BMAD project.
