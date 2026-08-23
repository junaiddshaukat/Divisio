import { useEffect, useRef, useState } from "react";
import type { ModelCatalog, PermissionMode, ProviderView } from "@divisio/contracts";
import { PermissionModeSelect } from "./ApprovalBar.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { MenuSelect } from "./MenuSelect.tsx";
import { Button, IconButton } from "./ui/Button.tsx";
import { AttachIcon, CloseIcon, ProjectIcon, SendIcon, StopIcon } from "./ui/icons.ts";
import { capabilityOn, vendorResumeNote } from "../capabilityFlags.ts";

export interface ComposerImage {
  id: string;
  name: string;
  mimeType: string;
  previewUrl: string;
  dataBase64: string;
}

interface Props {
  busy: boolean;
  provider: string;
  model: string | null;
  providers: ProviderView[];
  catalogs?: Record<string, ModelCatalog>;
  permissionMode: PermissionMode;
  hasHistory: boolean;
  /** Vendor-native session id last persisted for this thread, if any. */
  vendorSessionId?: string | null;
  /** Larger textarea + draft placeholder for an empty draft thread. */
  hero?: boolean;
  /** Home landing: real prompt before a thread exists. */
  landing?: boolean;
  projectId?: string;
  projects?: Array<{ id: string; name: string; root?: string }>;
  onProjectChange?(id: string): void;
  onSend(
    text: string,
    model: string | null,
    images: Array<{ name: string; mimeType: string; dataBase64: string }>,
  ): void;
  onInterrupt(): void;
  onPermissionMode(mode: PermissionMode): void;
  onAgentSelect(next: { provider: string; model: string | null; viaHandoff: boolean }): void;
}

const MAX_IMAGES = 8;
const MAX_BYTES = 5 * 1024 * 1024;

function shortFolder(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

function readImageFile(file: File): Promise<ComposerImage | null> {
  if (!file.type.startsWith("image/")) return Promise.resolve(null);
  if (file.size > MAX_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : "";
      if (!dataBase64) {
        resolve(null);
        return;
      }
      resolve({
        id: `img-${crypto.randomUUID()}`,
        name: file.name || "image.png",
        mimeType: file.type || "image/png",
        previewUrl: URL.createObjectURL(file),
        dataBase64,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  busy,
  provider,
  model,
  providers,
  catalogs,
  permissionMode,
  hasHistory,
  vendorSessionId = null,
  hero,
  landing,
  projectId,
  projects,
  onProjectChange,
  onSend,
  onInterrupt,
  onPermissionMode,
  onAgentSelect,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tall = hero || landing;

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, tall ? 320 : 200)}px`;
  }, [text, tall]);

  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
    };
    // Only revoke on unmount — per-image revoke happens on remove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSend = (!!text.trim() || images.length > 0) && !busy && !(landing && (!projects || projects.length === 0));
  const resumeNote = vendorResumeNote({
    hasHistory,
    sessionResume: capabilityOn(providers.find((p) => p.kind === provider)?.capabilities, "sessionResume"),
    hasVendorSession: !!vendorSessionId,
  });

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return;
    const next: ComposerImage[] = [];
    for (const file of list.slice(0, room)) {
      const img = await readImageFile(file);
      if (img) next.push(img);
    }
    if (next.length) setImages((prev) => [...prev, ...next]);
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const gone = prev.find((i) => i.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const submit = () => {
    if (!canSend) return;
    const value = text.trim();
    const payload = images.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }));
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
    setText("");
    setImages([]);
    onSend(value, model, payload);
  };

  return (
    <div
      className={`composer-wrap${tall ? " composer-hero" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files?.length) return;
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="composer">
        {images.length > 0 && (
          <div className="composer-attachments" aria-label="Attached images">
            {images.map((img) => (
              <div key={img.id} className="composer-thumb">
                <img src={img.previewUrl} alt={img.name} />
                <button
                  type="button"
                  className="composer-thumb-remove"
                  aria-label={`Remove ${img.name}`}
                  onClick={() => removeImage(img.id)}
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          rows={tall ? 3 : 1}
          autoFocus={landing}
          placeholder={
            busy
              ? "Running…"
              : landing
                ? "Do anything."
                : hero
                  ? "Describe what to build…"
                  : "Ask for follow-up…"
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length > 0 && Array.from(files).some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <IconButton
            label="Attach images"
            icon={<AttachIcon />}
            size="sm"
            disabled={busy || images.length >= MAX_IMAGES}
            title="Attach images"
            onClick={() => fileRef.current?.click()}
          />
          {landing && projects && projects.length > 0 && onProjectChange ? (
            <MenuSelect
              aria-label="Project"
              className="composer-project"
              variant="pill"
              value={projectId || projects[0]!.id}
              options={projects.map((p) => ({
                value: p.id,
                label: p.name,
                detail: p.root ? shortFolder(p.root) : undefined,
                icon: <ProjectIcon />,
              }))}
              onChange={onProjectChange}
              disabled={busy}
            />
          ) : null}
          <AgentPicker
            provider={provider}
            model={model}
            providers={providers}
            catalogs={catalogs}
            hasHistory={hasHistory}
            busy={busy}
            onSelect={onAgentSelect}
          />
          <PermissionModeSelect
            mode={permissionMode}
            mediated={providers.find((p) => p.kind === provider)?.capabilities.approvals === true}
            onChange={onPermissionMode}
          />
          <span className="composer-spacer" />
          {busy ? (
            <Button variant="danger" size="sm" icon={<StopIcon />} onClick={onInterrupt}>
              Stop
            </Button>
          ) : (
            <button
              type="button"
              className="composer-send"
              disabled={!canSend}
              aria-label="Send"
              onClick={submit}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      {resumeNote && <p className="composer-resume-note">{resumeNote}</p>}
    </div>
  );
}
