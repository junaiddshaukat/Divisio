import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { ProjectView, ProviderView } from "@divisio/contracts";
import { PRODUCT_NAME } from "@divisio/shared/brand";
import { canPickDirectory, listenFolderDrop, pathFromDroppedFolder } from "../../platform.ts";
import { BrandMark } from "../BrandMark.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { ProviderMark } from "../ProviderMark.tsx";
import {
  CheckIcon,
  CopyIcon,
  ErrorIcon,
  NewIcon,
  ProjectIcon,
  SearchIcon,
  ThreadIcon,
} from "../ui/icons.ts";

/**
 * First run.
 *
 * Deliberately not a slideshow. This product has one genuine prerequisite — an
 * agent CLI that is installed and signed in — and a tour cannot satisfy it. So
 * onboarding is a live readiness check against the real machine: it shows what
 * is actually installed, hands over the exact command for what is not, and
 * re-checks without a restart.
 *
 * The user is never blocked. Every step can be skipped, because someone who
 * already knows what they are doing should not have to click through us.
 */

export interface OnboardingProps {
  providers: ProviderView[];
  projects: ProjectView[];
  detecting: boolean;
  onRefreshProviders(): Promise<void>;
  onPickFolder(): Promise<string | null>;
  onCreateProject(name: string, rootPath: string): Promise<ProjectView | null>;
  onStartThread(projectId: string, provider: string, prompt: string): Promise<void>;
  onSkip(): void;
}

type Step = "welcome" | "providers" | "project" | "first-prompt";

const SUGGESTIONS = [
  "Give me a tour of this codebase — what are the main pieces?",
  "Find the riskiest part of this code and explain why.",
  "Write tests for the file I have open.",
  "What would you refactor first, and what would it break?",
];

function projectNameFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "project";
}

export function Onboarding({
  providers,
  projects,
  detecting,
  onRefreshProviders,
  onPickFolder,
  onCreateProject,
  onStartThread,
  onSkip,
}: OnboardingProps) {
  const ready = useMemo(() => providers.filter((p) => p.available), [providers]);
  const missing = useMemo(() => providers.filter((p) => !p.available), [providers]);

  const [step, setStep] = useState<Step>("welcome");
  const [project, setProject] = useState<ProjectView | null>(projects[0] ?? null);
  const [provider, setProvider] = useState(ready[0]?.kind ?? "");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const nativePicker = canPickDirectory();

  // Someone installing a CLI in another terminal should see it appear here
  // without restarting the app. Polling only while the step is open and only
  // while nothing is ready keeps it from running forever.
  useEffect(() => {
    if (step !== "providers" || ready.length > 0) return;
    const id = setInterval(() => void onRefreshProviders(), 4000);
    return () => clearInterval(id);
  }, [step, ready.length, onRefreshProviders]);

  useEffect(() => {
    if (ready.length > 0 && !provider) setProvider(ready[0]!.kind);
  }, [ready, provider]);

  const adoptPath = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setError(null);
    setBusy(true);
    try {
      const created = await onCreateProject(projectNameFromPath(trimmed), trimmed);
      if (created) {
        setProject(created);
        setStep("first-prompt");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Desktop shell: native drag-drop yields absolute paths.
  useEffect(() => {
    if (step !== "project") return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenFolderDrop((path) => {
      if (active) void adoptPath(path);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      active = false;
      unlisten?.();
    };
    // adoptPath closes over latest callbacks; rebind when step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, onCreateProject]);

  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };

  const chooseFolder = async () => {
    setError(null);
    const path = await onPickFolder();
    if (!path) {
      if (!nativePicker) {
        setError("Type an absolute folder path below — this browser cannot pick directories.");
      }
      return;
    }
    await adoptPath(path);
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragging(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const path = pathFromDroppedFolder(e.dataTransfer);
    if (path) {
      void adoptPath(path);
      return;
    }
    setError(
      nativePicker
        ? "Could not read that folder’s path. Use Choose a folder, or type the path below."
        : "Browsers cannot reveal dropped folder paths. Type the absolute path below.",
    );
  };

  const start = async (text: string) => {
    if (!project || !provider) return;
    setBusy(true);
    setError(null);
    try {
      await onStartThread(project.id, provider, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const begin = () => {
    setStep(ready.length > 0 ? (projects.length > 0 || project ? "first-prompt" : "project") : "providers");
  };

  if (step === "welcome") {
    return (
      <div className="onboarding onboarding-welcome-screen">
        <div className="onboarding-welcome">
          <BrandMark size={64} />
          <div className="onboarding-welcome-copy">
            <h1>Welcome to {PRODUCT_NAME}</h1>
            <p>
              A local command center for the coding agents you already pay for. Each agent keeps its
              own login — nothing is uploaded.
            </p>
          </div>
          <Button variant="primary" size="lg" onClick={begin}>
            Get started
          </Button>
          <button type="button" className="linkish" onClick={onSkip}>
            Skip — I&rsquo;ll set this up myself
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding-inner">
        <header className="onboarding-head">
          <BrandMark size={32} />
          <h1>{PRODUCT_NAME}</h1>
          <p>
            {PRODUCT_NAME} drives the coding agents you already pay for. It never asks for an API key —
            each agent keeps its own login, and everything stays on this machine.
          </p>
        </header>

        <ol className="onboarding-steps">
          <StepRow n={1} label="Connect an agent" state={ready.length > 0 ? "done" : step === "providers" ? "active" : "todo"} />
          <StepRow n={2} label="Add a project" state={project ? "done" : step === "project" ? "active" : "todo"} />
          <StepRow n={3} label="Run something" state={step === "first-prompt" ? "active" : "todo"} />
        </ol>

        {step === "providers" && (
          <section className="onboarding-panel">
            <h2>Which agents do you have?</h2>
            <p className="onboarding-sub">
              {detecting
                ? "Checking your machine…"
                : ready.length > 0
                  ? `${ready.length} ready to use. Install more any time from Settings.`
                  : "None found yet. Install one below — this list updates on its own."}
            </p>

            <div className="provider-grid">
              {providers.map((p) => (
                <article key={p.kind} className={`provider-card${p.available ? " is-ready" : ""}`}>
                  <div className="provider-card-head">
                    <ProviderMark kind={p.kind} />
                    <span className="provider-card-name">{p.label}</span>
                    {p.available ? (
                      <span className="pill pill-success">
                        <CheckIcon /> Ready
                      </span>
                    ) : (
                      <span className="pill">Not installed</span>
                    )}
                  </div>

                  {p.available ? (
                    <p className="provider-card-note">
                      {p.version ? `v${p.version}` : "Installed"}
                      {/* Auth cannot be probed safely — asking some CLIs starts a
                          login flow — so we say what we know and no more. */}
                      {" · sign-in is checked on your first message"}
                    </p>
                  ) : (
                    <div className="install-stack">
                      {p.install && (
                        <div className="install-row">
                          <code>{p.install}</code>
                          <IconButton
                            label={copied === `${p.kind}-install` ? "Copied" : "Copy install command"}
                            icon={copied === `${p.kind}-install` ? <CheckIcon /> : <CopyIcon />}
                            size="sm"
                            onClick={() => copy(p.install!, `${p.kind}-install`)}
                          />
                        </div>
                      )}
                      {p.signIn && (
                        <div className="install-row">
                          <code>{p.signIn}</code>
                          <IconButton
                            label={copied === `${p.kind}-signin` ? "Copied" : "Copy sign-in command"}
                            icon={copied === `${p.kind}-signin` ? <CheckIcon /> : <CopyIcon />}
                            size="sm"
                            onClick={() => copy(p.signIn!, `${p.kind}-signin`)}
                          />
                        </div>
                      )}
                      {!p.install && !p.signIn && p.detail && (
                        <p className="provider-card-note">{p.detail}</p>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>

            <div className="onboarding-actions">
              <Button variant="ghost" icon={<SearchIcon />} loading={detecting} onClick={() => void onRefreshProviders()}>
                Check again
              </Button>
              <Button
                variant="primary"
                disabled={ready.length === 0}
                onClick={() => setStep(projects.length > 0 || project ? "first-prompt" : "project")}
              >
                Continue
              </Button>
            </div>
            {missing.length > 0 && ready.length === 0 && (
              <p className="onboarding-sub">
                After installing, leave this open — Divisio rechecks every few seconds.
              </p>
            )}
          </section>
        )}

        {step === "project" && (
          <section className="onboarding-panel">
            <h2>Point Divisio at a project</h2>
            <p className="onboarding-sub">
              Agents run with this folder as their working directory. A git repository works best —
              it lets Divisio checkpoint every turn so you can diff and undo.
            </p>

            <button
              type="button"
              className={`folder-drop${dragging ? " is-dragging" : ""}`}
              onClick={() => void chooseFolder()}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              disabled={busy}
            >
              <ProjectIcon />
              <span className="folder-drop-title">
                {dragging ? "Drop to add" : nativePicker ? "Drop a folder, or choose one" : "Drop a folder, or type a path"}
              </span>
              <span className="folder-drop-hint">Nothing is uploaded. Divisio only stores the path.</span>
            </button>

            <div className="onboarding-path-row">
              <input
                className="field"
                placeholder="/absolute/path/to/repo"
                value={typedPath}
                onChange={(e) => setTypedPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && typedPath.trim() && void adoptPath(typedPath)}
                disabled={busy}
              />
              <Button
                variant="ghost"
                disabled={busy || !typedPath.trim()}
                onClick={() => void adoptPath(typedPath)}
              >
                Use path
              </Button>
            </div>

            {projects.length > 0 && (
              <div className="onboarding-existing">
                <span className="onboarding-sub">Or use one you already added:</span>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="nav-row"
                    onClick={() => {
                      setProject(p);
                      setStep("first-prompt");
                    }}
                  >
                    <ProjectIcon />
                    <span className="nav-label">{p.name}</span>
                  </button>
                ))}
              </div>
            )}

            {error && <p className="hint danger">{error}</p>}
          </section>
        )}

        {step === "first-prompt" && (
          <section className="onboarding-panel">
            <h2>Ask it something</h2>
            <p className="onboarding-sub">
              Divisio starts in Confirm first mode, so the agent pauses before it changes anything.
              You can switch to Run freely per chat once you trust it.
            </p>

            {project && (
              <p className="onboarding-sub">
                Working in <code>{project.rootPath}</code>
              </p>
            )}

            {ready.length > 1 && (
              <div className="provider-choice">
                {ready.map((p) => (
                  <button
                    key={p.kind}
                    type="button"
                    className="provider-choice-btn"
                    aria-pressed={provider === p.kind}
                    onClick={() => setProvider(p.kind)}
                  >
                    <ProviderMark kind={p.kind} />
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="suggestion" disabled={busy} onClick={() => void start(s)}>
                  <ThreadIcon />
                  {s}
                </button>
              ))}
            </div>

            <div className="onboarding-custom">
              <input
                className="field"
                placeholder="…or type your own"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && prompt.trim() && void start(prompt)}
              />
              <Button
                variant="primary"
                icon={<NewIcon />}
                loading={busy}
                disabled={!prompt.trim() || !project}
                onClick={() => void start(prompt)}
              >
                Start
              </Button>
            </div>

            {error && (
              <p className="hint danger">
                <ErrorIcon /> {error}
              </p>
            )}
          </section>
        )}

        <footer className="onboarding-foot">
          <button type="button" className="linkish" onClick={onSkip}>
            Skip — I&rsquo;ll set this up myself
          </button>
        </footer>
      </div>
    </div>
  );
}

function StepRow({ n, label, state }: { n: number; label: string; state: "todo" | "active" | "done" }) {
  return (
    <li className={`onboarding-step is-${state}`}>
      <span className="onboarding-step-n">{state === "done" ? <CheckIcon /> : n}</span>
      {label}
    </li>
  );
}
