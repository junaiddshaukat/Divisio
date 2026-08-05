# Contributing

Divisio is early. The daemon, protocol, and web UI work end to end; provider breadth and the delivery loop are next. See [docs/roadmap.md](docs/roadmap.md).

## Before you write code

1. Read [README](README.md), [vision](docs/vision.md), and [AGENTS.md](AGENTS.md)
2. Skim ADRs under [docs/adr](docs/adr/)
3. Confirm your idea fits the current phase exit criteria

## Rules of the road

- **No vendored application trees.** PRs add our own implementation, not another product's source
- Prefer specs and ADR updates when proposing architectural change
- Keep PRs small and focused
- Use glossary terms from [docs/specs/glossary.md](docs/specs/glossary.md)

## Issues

Focused bugs and concrete proposals beat vague feature dumps. For providers, specify CLI name, auth flow, and which adapter tier you believe applies.

## License

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
