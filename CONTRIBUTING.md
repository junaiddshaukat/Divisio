# Contributing

Divisio is a local-first command center for third-party coding-agent CLIs. Roadmap phases 0–4 are in the repo. What is left before a public launch is product proof (live smoke), packaging, and docs that match the app — not a new architecture. See [docs/roadmap.md](docs/roadmap.md).

## Before you write code

1. Read [README](README.md), [vision](docs/vision.md), and [AGENTS.md](AGENTS.md)
2. Skim ADRs under [docs/adr](docs/adr/)
3. Prefer the smallest change that matches existing contracts

## Rules of the road

- **No vendored application trees.** PRs add our own implementation, not another product's source
- Prefer specs and ADR updates when proposing architectural change
- Keep PRs small and focused
- Use glossary terms from [docs/specs/glossary.md](docs/specs/glossary.md)
- Never fake adapter capabilities. Never delete the user's project folder from disk.

## Verifying

```bash
bun test
```

Targeted tests for the behavior you changed. Do not require a live Claude/Codex install for the default suite.

## License

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
