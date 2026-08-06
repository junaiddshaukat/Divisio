interface Props {
  /** "Local" or lane title. */
  envLabel: string;
  branch: string | null;
  /** Relative path hint for the workdir (lane root basename or project name). */
  workdirHint?: string | null;
  dirty?: boolean;
}

/**
 * Context strip under the composer — where the agent is writing.
 */
export function BranchStrip({ envLabel, branch, workdirHint, dirty }: Props) {
  return (
    <div className="branch-strip" aria-label="Working context">
      <span className="branch-pill" title={workdirHint ?? undefined}>
        {envLabel}
      </span>
      {branch && (
        <span className="branch-pill mono" title="Current branch">
          {branch}
        </span>
      )}
      {dirty && <span className="branch-pill dirty">uncommitted</span>}
    </div>
  );
}
