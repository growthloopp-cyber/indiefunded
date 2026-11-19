import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api } from "../lib/api";

import { DEFAULT_SETTINGS } from "../lib/default-settings";
export { DEFAULT_SETTINGS };

const SYNC_CHANNEL = "indifunded-sync";
const SYNC_STORAGE_KEY = "indifunded:sync-ping";

export function broadcastSync(scope = "all") {
  if (typeof window === "undefined") return;
  const payload = { scope, ts: Date.now() };
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel(SYNC_CHANNEL);
      ch.postMessage(payload);
      ch.close();
    }
  } catch {
    // ignore BroadcastChannel restrictions
  }
  try {
    window.localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage quota errors
  }
}

const SettingsContext = createContext({
  settings: DEFAULT_SETTINGS,
  loading: true,
  reload: () => {},
  syncVersion: 0,
});

// Deep merge helper: fills missing keys from defaults
export function mergeSettings(target, source) {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    const out = { ...(target && typeof target === "object" ? target : {}) };
    for (const k of Object.keys(source)) {
      out[k] = mergeSettings(target?.[k], source[k]);
    }
    for (const k of Object.keys(target || {})) {
      if (!(k in out) || out[k] === undefined || out[k] === null) out[k] = target[k];
    }
    return out;
  }
  return source === undefined || source === null ? target : source;
}

const SETTINGS_CACHE_KEY = "if_site_settings_v1";

function readCachedSettings() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_CACHE_KEY);
    return raw ? mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);
  const serverVersionRef = useRef(null);

  const fetchSettings = useCallback(async (force = false) => {
    try {
      const r = await api.get(
        "/settings",
        force ? { params: { _refresh: Date.now() } } : undefined,
      );
      const merged = mergeSettings(DEFAULT_SETTINGS, r.data || {});
      setSettings(merged);
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(r.data || {}));
        } catch {
          // ignore storage quota errors
        }
      }
    } catch (_) {
      /* keep defaults */
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(
    async (force = false) => {
      await fetchSettings(force);
      setSyncVersion((v) => v + 1);
      if (force) {
        broadcastSync("settings");
      }
    },
    [fetchSettings],
  );

  useEffect(() => {
    const cached = readCachedSettings();
    if (cached) setSettings(cached);
    fetchSettings(false);
  }, [fetchSettings]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let alive = true;

    const triggerRefresh = (forceFetch = false) => {
      if (!alive) return;
      fetchSettings(forceFetch);
      setSyncVersion((v) => v + 1);
    };

    const checkServerVersion = async () => {
      if (!alive) return;
      try {
        const res = await api.get("/sync/version", { params: { _t: Date.now() } });
        const v = Number(res.data?.version || 0);
        if (serverVersionRef.current !== null && v > serverVersionRef.current) {
          serverVersionRef.current = v;
          triggerRefresh(true);
        } else if (serverVersionRef.current === null && v > 0) {
          serverVersionRef.current = v;
        }
      } catch {
        // ignore transient network check errors
      }
    };

    let es = null;
    if (typeof EventSource !== "undefined") {
      try {
        es = new EventSource("/api/sync/stream");
        es.addEventListener("sync", (ev) => {
          try {
            const payload = JSON.parse(ev.data || "{}");
            const v = Number(payload.version || 0);
            if (serverVersionRef.current !== null && v > serverVersionRef.current) {
              serverVersionRef.current = v;
              triggerRefresh(true);
            } else if (serverVersionRef.current === null) {
              serverVersionRef.current = v;
            }
          } catch {
            // ignore malformed event data
          }
        });
      } catch {
        es = null;
      }
    }

    let bc = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        bc = new BroadcastChannel(SYNC_CHANNEL);
        bc.onmessage = () => triggerRefresh(true);
      } catch {
        bc = null;
      }
    }

    const onStorage = (e) => {
      if (e.key === SYNC_STORAGE_KEY) triggerRefresh(true);
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        checkServerVersion();
      }
    };
    const onFocus = () => checkServerVersion();

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      alive = false;
      if (es) es.close();
      if (bc) bc.close();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [fetchSettings]);

  return (
    <SettingsContext.Provider value={{ settings, loading, reload, syncVersion }}>
      {children}
    </SettingsContext.Provider>
  );
}

export const useSettings = () => useContext(SettingsContext);
