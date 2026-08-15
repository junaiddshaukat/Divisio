import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalog, ProviderView } from "@divisio/contracts";
import { displayLabel, isProviderEnabled, loadProviderPrefs } from "../providerPrefs.ts";
import {
  modelLabel,
  modelsForProvider,
  setCustomProviderModels,
  type ProviderModelOption,
} from "../providerModels.ts";
import { ProviderMark } from "./ProviderMark.tsx";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./ui/icons.ts";

interface Props {
  provider: string;
  model: string | null;
  providers: ProviderView[];
  /** Live catalogs from `provider.models`. Missing kinds fall back to curated aliases. */
  catalogs?: Record<string, ModelCatalog>;
  /** True when the thread already has messages — provider change requires handoff. */
  hasHistory: boolean;
  busy: boolean;
  onSelect(next: { provider: string; model: string | null; viaHandoff: boolean }): void;
}

/**
 * Nested menu: agents on the left, models on the right.
 */
export function AgentPicker({ provider, model, providers, catalogs, hasHistory, busy, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [browseKind, setBrowseKind] = useState(provider);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState(loadProviderPrefs);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = providers.find((p) => p.kind === provider);
  const browse = providers.find((p) => p.kind === browseKind) ?? current;
  const currentLabel = displayLabel(provider, current?.label ?? provider, prefs);
  const browseLabel = displayLabel(browseKind, browse?.label ?? browseKind, prefs);
  const options = useMemo(
    () => modelsForProvider(browseKind, catalogs?.[browseKind]),
    [browseKind, catalogs],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    for (const p of providers) {
      if (p.kind.startsWith("custom_") && p.preferredModel) {
        setCustomProviderModels(p.kind, p.preferredModel, p.label);
      }
    }
  }, [providers]);

  useEffect(() => {
    const sync = () => setPrefs(loadProviderPrefs());
    window.addEventListener("divisio:provider-prefs", sync);
    return () => window.removeEventListener("divisio:provider-prefs", sync);
  }, []);

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

  const triggerModel = modelLabel(provider, model, catalogs?.[provider]);

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
        <ProviderMark kind={provider} accent={prefs[provider]?.accent} />
        <span className="agent-picker-trigger-text">
          {currentLabel}
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
              const enabled = isProviderEnabled(p.kind, prefs);
              return (
                <button
                  key={p.kind}
                  type="button"
                  className={`agent-picker-rail-item${active ? " active" : ""}`}
                  disabled={(!p.available || !enabled) && p.kind !== provider}
                  title={
                    !enabled
                      ? "Disabled in Settings → Providers"
                      : p.available
                        ? displayLabel(p.kind, p.label, prefs)
                        : (p.detail ?? "unavailable")
                  }
                  onClick={() => setBrowseKind(p.kind)}
                >
                  <ProviderMark kind={p.kind} accent={prefs[p.kind]?.accent} />
                  <span className="agent-picker-rail-label">{displayLabel(p.kind, p.label, prefs)}</span>
                  <span className="agent-picker-trailing">
                    {isCurrent ? <CheckIcon className="agent-picker-check" /> : null}
                  </span>
                </button>
              );
            })}
          </aside>
          <div className="agent-picker-main">
            <div className="agent-picker-section">
              {browseLabel}
              {browse?.source === "community" ? (
                <span className="agent-picker-section-meta">community</span>
              ) : browse?.source === "custom" ? (
                <span className="agent-picker-section-meta">BYOK</span>
              ) : null}
            </div>
            {hasHistory && browseKind !== provider && (
              <p className="agent-picker-warn">
                Switching agent runs Hand off (one turn on {currentLabel}).
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
