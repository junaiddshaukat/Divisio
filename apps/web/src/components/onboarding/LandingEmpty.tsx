import { BrandMark } from "../BrandMark.tsx";
import { Button } from "../ui/Button.tsx";
import { AddProjectIcon } from "../ui/icons.ts";

interface Props {
  onAddProject(): void;
}

/**
 * Home with no project yet. The composer stays hidden until there is a folder
 * to work in — a disabled prompt is worse than a clear next step.
 */
export function LandingEmpty({ onAddProject }: Props) {
  return (
    <div className="landing-empty">
      <BrandMark size={56} />
      <h1 className="draft-headline">What should we build?</h1>
      <p className="draft-sub">Add a project first — the agent needs a folder to work in.</p>
      <Button variant="primary" icon={<AddProjectIcon />} onClick={onAddProject}>
        Add a project
      </Button>
    </div>
  );
}
