import { useEffect, useState } from "react";
import type { CustomProviderView, ProviderView } from "@divisio/contracts";
import {
  ACCENT_SWATCHES,
  displayLabel,
  isProviderEnabled,
  loadProviderPrefs,
  setProviderPref,
  type ProviderAccent,
  type ProviderPrefsMap,
} from "../../providerPrefs.ts";
import { confirmDanger } from "../../confirm.ts";
import { setCustomProviderModels } from "../../providerModels.ts";
import type { Client } from "../../client.ts";
import { ProviderMark } from "../ProviderMark.tsx";
import { Button } from "../ui/Button.tsx";
import { CAPABILITY_FLAGS, capabilityOn } from "../../capabilityFlags.ts";

interface Props {
  providers: ProviderView[];
  onRefresh(): void;
  /** Daemon client for BYOK CRUD. */
  client: Client | null;
}

function shortStatus(p: ProviderView): { label: string; tone: "ok" | "warn" | "muted"; title?: string } {
  if (!p.available) return { label: "Not found", tone: "warn", title: p.detail ?? undefined };
  if (p.source === "custom") return { label: "BYOK", tone: "ok" };
  if (p.version) return { label: `v${p.version}`, tone: "ok" };
  return { label: "Ready", tone: "ok" };
}

type Draft = {
  id?: string;
  label: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
};

const EMPTY_DRAFT: Draft = {
  label: "",
  baseUrl: "https://api.openai.com/v1",
  modelId: "",
  apiKey: "",
};

/** Provider rows with enable toggle; expand for display name, accent, and declared capabilities. */
export function ProvidersSettings({ providers, onRefresh, client }: Props) {
  const [prefs, setPrefs] = useState<ProviderPrefsMap>(() => loadProviderPrefs());
  const [openKind, setOpenKind] = useState<string | null>(null);
  const [customs, setCustoms] = useState<CustomProviderView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setPrefs(loadProviderPrefs());
    window.addEventListener("divisio:provider-prefs", sync);
    return () => window.removeEventListener("divisio:provider-prefs", sync);
  }, []);

  useEffect(() => {
    for (const p of providers) {
      if (p.kind.startsWith("custom_") && p.preferredModel) {
        setCustomProviderModels(p.kind, p.preferredModel, p.label);
      }
    }
  }, [providers]);

  const loadCustoms = async () => {
    if (!client) return;
    try {
      const res = await client.send("customProvider.list", {});
      setCustoms(res.providers);
    } catch {
      /* older daemon */
    }
  };

  useEffect(() => {
    void loadCustoms();
  }, [client]);

  const patch = (kind: string, next: { displayName?: string; accent?: ProviderAccent; enabled?: boolean }) => {
    setPrefs(setProviderPref(kind, next));
  };

  const saveDraft = async () => {
    if (!client || !draft) return;
    setBusy(true);
    setError(null);
    try {
      await client.send("customProvider.upsert", {
        ...(draft.id ? { id: draft.id } : {}),
        label: draft.label,
        baseUrl: draft.baseUrl,
        modelId: draft.modelId,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
      });
      setDraft(null);
      await loadCustoms();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async (id: string, label: string) => {
    if (!client) return;
    const ok = await confirmDanger(
      `Remove “${label}”? Threads using it will need another agent.`,
      "Remove endpoint",
      { rememberKey: "remove-custom-provider", confirmLabel: "Remove" },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await client.send("customProvider.delete", { id });
      await loadCustoms();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cliProviders = providers.filter((p) => p.source !== "custom");

  return (
    <div className="settings-section">
      <div className="settings-rows">
        {cliProviders.map((p) => {
          const pref = prefs[p.kind];
          const label = displayLabel(p.kind, p.label, prefs);
          const enabled = isProviderEnabled(p.kind, prefs);
          const expanded = openKind === p.kind;
          const status = shortStatus(p);
          return (
            <div
              key={p.kind}
              className={`settings-row settings-row-stack provider-row${expanded ? " is-open" : ""}${enabled ? "" : " is-disabled"}`}
            >
              <div className="settings-row-main provider-row-main">
                <button
                  type="button"
                  className="provider-row-hit settings-row-button"
                  onClick={() => setOpenKind(expanded ? null : p.kind)}
                  aria-expanded={expanded}
                >
                  <span
                    className={`provider-status-dot tone-${status.tone}`}
                    title={status.title ?? status.label}
                    aria-hidden
                  />
                  <ProviderMark kind={p.kind} accent={pref?.accent} />
                  <div className="settings-row-copy">
                    <span className="settings-row-label">{label}</span>
                    <span className="settings-row-meta" title={status.title}>
                      {status.label}
                      {p.source === "community" ? " · community" : ""}
                    </span>
                  </div>
                </button>
                <label
                  className="provider-toggle"
                  title={enabled ? "Disable for new sessions" : "Enable for new sessions"}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    checked={enabled}
                    aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
                    onChange={(e) =>
                      patch(p.kind, {
                        displayName: pref?.displayName,
                        accent: pref?.accent,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  <span className="provider-toggle-track" aria-hidden />
                </label>
              </div>

              {expanded && (
                <div className="provider-pref-panel">
                  <label className="provider-pref-field">
                    <span>Display name</span>
                    <input
                      className="field"
                      placeholder={p.label}
                      value={pref?.displayName ?? ""}
                      onChange={(e) =>
                        patch(p.kind, {
                          displayName: e.target.value,
                          accent: pref?.accent,
                          enabled: pref?.enabled,
                        })
                      }
                    />
                  </label>
                  <div className="provider-pref-field">
                    <span>Accent color</span>
                    <div className="provider-accent-row" role="radiogroup" aria-label="Accent color">
                      {ACCENT_SWATCHES.map((swatch) => {
                        const active = (pref?.accent ?? "default") === swatch.id;
                        return (
                          <button
                            key={swatch.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={swatch.label}
                            title={swatch.label}
                            className={`provider-accent-swatch${active ? " is-active" : ""}${swatch.id === "default" ? " is-default" : ""}`}
                            style={swatch.id === "default" ? undefined : { background: swatch.color }}
                            onClick={() =>
                              patch(p.kind, {
                                displayName: pref?.displayName,
                                accent: swatch.id,
                                enabled: pref?.enabled,
                              })
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                  <div className="provider-pref-field">
                    <span>What this CLI can do</span>
                    <ul className="capability-matrix" aria-label="What this CLI can do">
                      {CAPABILITY_FLAGS.map((flag) => {
                        const on = capabilityOn(p.capabilities, flag.key);
                        return (
                          <li key={flag.key} className="capability-matrix-row" title={flag.detail}>
                            <span className="capability-matrix-label">{flag.label}</span>
                            <span className={`capability-matrix-value${on ? " is-on" : ""}`}>
                              {on ? "Yes" : "No"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="settings-byok">
        <div className="settings-byok-head">
          <div>
            <h3 className="settings-byok-title">Custom endpoints</h3>
            <p className="settings-byok-copy">
              Bring your own OpenAI-compatible API — OpenRouter, local vLLM, Azure, Groq, etc.
              Keys stay on this machine under Divisio userdata.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!client || busy || draft !== null}
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            Add endpoint
          </Button>
        </div>

        {error && <div className="banner">{error}</div>}

        {draft && (
          <div className="settings-byok-form">
            <label className="provider-pref-field">
              <span>Name</span>
              <input
                className="field"
                placeholder="OpenRouter"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </label>
            <label className="provider-pref-field">
              <span>Base URL</span>
              <input
                className="field"
                placeholder="https://openrouter.ai/api/v1"
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </label>
            <label className="provider-pref-field">
              <span>Model id</span>
              <input
                className="field"
                placeholder="anthropic/claude-sonnet-4"
                value={draft.modelId}
                onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
              />
            </label>
            <label className="provider-pref-field">
              <span>API key{draft.id ? " (leave blank to keep)" : ""}</span>
              <input
                className="field"
                type="password"
                autoComplete="off"
                placeholder={draft.id ? "••••••••" : "sk-…"}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
            <div className="settings-byok-actions">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveDraft()}>
                {draft.id ? "Save" : "Add"}
              </Button>
            </div>
          </div>
        )}

        {customs.length > 0 && (
          <div className="settings-rows">
            {customs.map((c) => (
              <div key={c.id} className="settings-row settings-row-stack provider-row">
                <div className="settings-row-main provider-row-main">
                  <div className="provider-row-hit settings-row-button" style={{ cursor: "default" }}>
                    <span className="provider-status-dot tone-ok" aria-hidden />
                    <ProviderMark kind={c.kind} />
                    <div className="settings-row-copy">
                      <span className="settings-row-label">{c.label}</span>
                      <span className="settings-row-meta">
                        {c.modelId} · {c.apiKeyPreview} · chat only
                      </span>
                    </div>
                  </div>
                  <div className="settings-byok-row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setDraft({
                          id: c.id,
                          label: c.label,
                          baseUrl: c.baseUrl,
                          modelId: c.modelId,
                          apiKey: "",
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void removeCustom(c.id, c.label)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
