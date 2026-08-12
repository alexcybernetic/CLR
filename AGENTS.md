# AGENTS.md

This file provides guidance for working with code in this repository.

## Development Setup

See `README.md` for development environment and running instructions.

## Docs

Documents marked optional may not exist. Their absence is expected and must not be reported as an error.

The following documents contain project documentation:

- [Product](docs/0-Product.md)
- [Architecture](docs/1-Architecture.md)
- [Architecture-Visual-Schema](docs/2-Architecture-Visual-Schema.md) (optional)
- [Roadmap-Todo](docs/3-Roadmap-Todo.md)
- [Roadmap-Ideas](docs/4-Roadmap-Ideas.md) (optional)
- [Coding Guide](docs/5-Coding-Guide.md) (optional)

- After every turn involving changes (e.g., feature development or bug fixing), we must keep the documentation up to date.
- Topics or features from the near-term roadmap that have been converted into specs should be removed from that roadmap.

## Specs

Specs are Markdown documents containing specifications for each version.
A near-term to-do item is converted into a spec, resulting in a focused spec file.
A spec is a short, focused document that defines a problem or feature, its requirements and constraints, the reasoning behind key decisions, and the implementation approach.
A spec requires explicit review and approval by the user.
Do not begin implementing a spec until the user explicitly approves it.
A roadmap item is considered converted into a spec once the user explicitly approves the spec.

## Versioning

Use SemVer syntax for iterations:

- `0.MINOR.0`: one coherent capability/spec batch.
- `0.MINOR.PATCH`: fixes, polish, corrections, or small follow-ups to that batch.
- After `0.9.0` comes `0.10.0`.
- `1.0.0` only when we intentionally declare the product/runtime contract stable.

## Use what is available in the codebase (components, tools, helpers, utilities, styles)

- Use available components whenever possible.
- If an available component does not fully cover the intended use case, consider whether it can be extended in a general, reusable way and make a suggestion.
- If no component fits the intended use case, suggest developing a new component.
- If multiple components fit the intended use case, discuss the options with the user before choosing one.

## Git

Never perform Git operations that modify repository state without the user's explicit approval (for example: `git add`, `git commit`, `git push`, `git merge`, `git rebase`, `git reset`, or `git checkout` that changes the working tree).

The read-only Git commands `git status` and `git diff` do not require approval.

After making changes:

1. Wait for the user to test or otherwise verify the changes.
2. Wait for explicit approval.
3. Only then perform the requested Git operation.

## Development containers

- If development containers are used in this development environment:
  - The container setup is defined in `README.md` and the corresponding Docker files.
  - The user runs the development server and build commands.
  - The agent may run tests and linting commands.
  - All npm commands must be executed in the development container.
  - The container is already up and running. If not, ask the user to start it.
