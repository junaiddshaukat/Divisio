import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderView } from "@divisio/contracts";
import { modelLabel, modelsForProvider, type ProviderModelOption } from "../providerModels.ts";
import { ProviderMark } from "./ProviderMark.tsx";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./ui/icons.ts";

interface Props {
  provider: string;
  model: string | null;
  providers: ProviderView[];
  /** True when the thread already has messages — provider change requires handoff. */
  hasHistory: boolean;
  busy: boolean;
  onSelect(next: { provider: string; model: string | null; viaHandoff: boolean }): void;
}

/**
 * Nested menu: agents on the left, models on the right.
 */
export function AgentPicker({ provider, model, providers, hasHistory, busy, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [browseKind, setBrowseKind] = useState(provider);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = providers.find((p) => p.kind === provider);
  const browse = providers.find((p) => p.kind === browseKind) ?? current;
  const options = useMemo(() => modelsForProvider(browseKind), [browseKind]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setBrowseKind(provider);
    setQuery("");
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, provider]);

  const triggerModel = modelLabel(provider, model);

  const pickModel = (opt: ProviderModelOption) => {
    const nextModel = opt.isDefault ? null : opt.id;
    const viaHandoff = hasHistory && browseKind !== provider;
    onSelect({ provider: browseKind, model: nextModel, viaHandoff });
    setOpen(false);
  };

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        type="button"
        className="pill agent-picker-trigger"
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ProviderMark kind={provider} />
        <span className="agent-picker-trigger-text">
          {current?.label ?? provider}
          {triggerModel ? ` · ${triggerModel}` : ""}
        </span>
        <ChevronDownIcon className="agent-picker-trigger-chevron" />
      </button>
      {open && (
        <div className="agent-picker-popover" role="dialog" aria-label="Choose agent">
          <aside className="agent-picker-rail">
            <div className="agent-picker-section">Agents</div>
            {providers.map((p) => {
              const active = p.kind === browseKind;
              const isCurrent = p.kind === provider;
              return (
                <button
                  key={p.kind}
                  type="button"
                  className={`agent-picker-rail-item${active ? " active" : ""}`}
                  disabled={!p.available && p.kind !== provider}
                  title={p.available ? p.label : (p.detail ?? "unavailable")}
                  onClick={() => setBrowseKind(p.kind)}
                >
                  <ProviderMark kind={p.kind} />
                  <span className="agent-picker-rail-label">{p.label}</span>
                  <span className="agent-picker-trailing">
                    {isCurrent ? <CheckIcon className="agent-picker-check" /> : null}
                  </span>
                </button>
              );
            })}
          </aside>
          <div className="agent-picker-main">
            <div className="agent-picker-section">
              {browse?.label ?? browseKind}
              {browse?.source === "community" ? (
                <span className="agent-picker-section-meta">community</span>
              ) : null}
            </div>
            {hasHistory && browseKind !== provider && (
              <p className="agent-picker-warn">
                Switching agent runs Hand off (one turn on {current?.label ?? provider}).
              </p>
            )}
            <label className="agent-picker-search-wrap">
              <SearchIcon />
              <input
                ref={searchRef}
                className="agent-picker-search"
                placeholder="Search models"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <ul className="agent-picker-list">
              {filtered.map((opt) => {
                const selected =
                  browseKind === provider && (opt.isDefault ? !model : model === opt.id);
                return (
                  <li key={opt.id}>
                    <button
                      type="button"
                      className={`agent-picker-option${selected ? " selected" : ""}`}
                      disabled={!browse?.available && browseKind !== provider}
                      onClick={() => pickModel(opt)}
                    >
                      <span className="agent-picker-option-label">{opt.label}</span>
                      {opt.isDefault && <span className="agent-picker-option-tag">Default</span>}
                      <span className="agent-picker-trailing">
                        {selected ? <CheckIcon className="agent-picker-check" /> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && <li className="agent-picker-empty">No matches</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
