# ADR 0001: Own the implementation

## Status

Accepted

## Context

The agent-harness control surface is an active category with several existing products, some open source. Starting from someone else's application tree would ship faster in the first weeks, then charge interest indefinitely: their schema decisions, their import paths, their migration debt, their identity. Products that took that route still carry legacy state directories from the codebase they started in.

We also intend to run a public adapter SDK. That requires contracts we control and can version deliberately.

## Decision

Write the application ourselves.

- Contracts, storage, orchestration, and UI are our own code
- Ordinary OSS dependencies are encouraged — React, SQLite, PTY, git tooling, and similar
- Do not vendor another product's application tree, stylesheet, or UI package into this repo
- Learning from prior art is normal engineering; the output is our implementation, described in our own terms

## Consequences

- Slower Phase 0 than adopting an existing tree; cleaner long-term ownership
- We version the adapter contract on our own schedule
- Public docs describe this product on its own merits rather than by comparison
- Competitive analysis lives in `docs/internal/`, which is not published
