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

## Verifying

```bash
bun test
```

Runs the Phase 0 suite (handshake, resume, projections, interrupt via mock peer). Do not require a live Claude/Codex install for these tests.

## License

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
