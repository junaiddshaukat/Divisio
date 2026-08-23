# ADR 0009: Embed a full code editor

## Status

Accepted — amends the "agent command center, not a full IDE" position in
[design/components.md](../design/components.md)

## Context

Until now the product could drive agents well and read their output badly. There
was no file tree, no way to open a file, and no `file.read` in the protocol at
all. A user could watch an agent describe a change and then had to leave the app
to see it.

The original position — a command center rather than an IDE — was a reasonable
scoping decision when the product was chat plus diffs. It stopped being
reasonable once lanes existed: a user running four agents in four worktrees
needs to inspect and correct their output without switching tools four times.

The counter-argument is weight. Monaco is roughly 4 MB, against a 226 KB
application bundle, and this product targets paired devices over a LAN.

## Decision

Embed **Monaco**, the editor from VS Code, as an editable file pane.

- Loaded **lazily**. It arrives the first time the file pane is opened, so the
  eager bundle stays around 225 KB gzipped and first paint is unaffected for users who
  never open a file
- Themed from our own tokens for surfaces; syntax colours stay with Monaco's
  base themes, which are tuned for contrast in a way a neutral palette is not
- Language workers run off the main thread, so language services cannot stutter
  a streaming transcript
- Files resolve against the **thread's working directory**, so a lane-bound
  thread browses its own worktree rather than the primary checkout

The `file.tree`, `file.read`, and `file.write` commands confine every path to
that root. Confinement is checked against the resolved **real** path, after
symlinks, because a symlink inside the project otherwise walks straight out of
it. The daemon runs with the user's full privileges, so an escape would turn a
file browser into "read any file", and with write into code execution through a
shell profile or a git hook.

## Consequences

- The product is now an editor with agents in it, not only a control surface.
  That is a genuine repositioning and the design docs say so rather than
  contradicting the code
- Lazy loading keeps the ADR 0007 budgets intact; a regression here would show
  up as a jump in the eager bundle
- Binary files are reported as binary rather than rendered as mangled text, and
  files above 2 MB are refused rather than freezing the editor
- Still absent, and still deliberate: no integrated terminal, no debugger, no
  extension host. This is an editor for reviewing and correcting agent work, not
  a replacement for the user's own IDE
