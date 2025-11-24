# Contributing to Maestro

Thank you for your interest in contributing to Maestro! This document provides guidelines and instructions for contributing.

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Start development server: `npm run dev`

## Code Style

- TypeScript for all new code
- Use ESLint and Prettier (configs coming soon)
- Follow existing code patterns
- Add JSDoc comments for public APIs

## Commit Messages

Use conventional commits:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Test additions/changes
- `chore:` - Build process or tooling changes

Example: `feat: add context usage visualization`

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Add tests if applicable
4. Update documentation
5. Submit PR with clear description
6. Wait for review

## Architecture Guidelines

### Main Process (Backend)
- Keep IPC handlers simple and focused
- Use TypeScript interfaces for all data structures
- Handle errors gracefully
- No blocking operations

### Renderer Process (Frontend)
- Use React hooks
- Keep components small and focused
- Use Tailwind for styling
- Maintain keyboard accessibility

### Security
- Never expose Node.js APIs to renderer
- Use preload script for all IPC
- Sanitize all user inputs
- Use `execFile` instead of `exec`

## Testing

```bash
# Run tests (when available)
npm test

# Type checking
npm run build:main
```

## Questions?

Open a GitHub Discussion or reach out in Issues.
