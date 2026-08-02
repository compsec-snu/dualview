# scripts/

Utility scripts for project management, status reporting, and developer tooling.

## Rules

- Read this file before modifying anything in this directory.
- Scripts must be self-contained and runnable without additional installation.
- Python scripts must work with Python 3.8+ (no third-party dependencies).
- Include usage documentation in script docstrings or `--help` output.

## Anti-patterns

- Do not add scripts that duplicate existing `npx tsx` test commands.
- Do not add scripts that require environment-specific configuration without documenting it.

## Dependencies

- Imports from: none (standalone utilities)
- Imported by: none
