import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { SettingsProvider, useSettings } from "@/context/SettingsContext";
import { useLiveCandles, useLiveMarketQuotes } from "@/lib/useLiveMarket";
import { api } from "@/lib/api";

function HydrationProbe() {
  const { settings } = useSettings();
  const { quotes, marketStatus } = useLiveMarketQuotes(["NIFTY", "BANKNIFTY"], {
    pollMs: 0,
    enabled: false,
  });
  const { candles, loading } = useLiveCandles("NIFTY", "5m", {
    pollMs: 0,
    enabled: false,
  });
  return (
    <div data-testid="hydration-probe">
      <span>{settings.hero?.brand_name || "IndiFunded"}</span>
      <span>{quotes.length}</span>
      <span>{marketStatus}</span>
      <span>{candles.length}</span>
      <span>{loading ? "loading" : "ready"}</span>
    </div>
  );
}

describe("SSR hydration safety", () => {
  beforeEach(() => {
    vi.spyOn(api, "get").mockResolvedValue({ data: {} } as never);
    window.sessionStorage.setItem(
      "if_site_settings_v1",
      JSON.stringify({ hero: { brand_name: "CustomCachedBrand" } }),
    );
    window.sessionStorage.setItem(
      "if_mkt_cache_v1",
      JSON.stringify({
        marketStatus: "LIVE",
        quotes: {
          NIFTY: {
            quote: { symbol: "NIFTY", ltp: 25600, changePct: 1.2, exchange: "NSE" },
            ts: Date.now(),
          },
        },
        candles: {
          "NIFTY:5m": {
            candles: [{ time: 1731650000, open: 25500, high: 25620, low: 25490, close: 25600 }],
            quote: { symbol: "NIFTY", ltp: 25600, changePct: 1.2 },
            marketStatus: "LIVE",
            ts: Date.now(),
          },
        },
      }),
    );
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("hydrates without mismatch even when sessionStorage contains cached settings and market data", async () => {
    // Simulate SSR (no window during server renderToString)
    const origWindow = globalThis.window;
    // @ts-expect-error simulating server environment without window for renderToString
    delete globalThis.window;
    let ssrHtml = "";
    try {
      ssrHtml = renderToString(
        <SettingsProvider>
          <HydrationProbe />
        </SettingsProvider>,
      );
    } finally {
      globalThis.window = origWindow;
    }

    const container = document.createElement("div");
    container.innerHTML = ssrHtml;
    document.body.appendChild(container);

    const recoverableErrors: unknown[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(
        container,
        <SettingsProvider>
          <HydrationProbe />
        </SettingsProvider>,
        {
          onRecoverableError: (err) => {
            recoverableErrors.push(err);
          },
        },
      );
    });

    expect(recoverableErrors).toEqual([]);
    const hydrationErrors = errorSpy.mock.calls.filter((args) =>
      args.some((a) => String(a).toLowerCase().includes("hydration")),
    );
    expect(hydrationErrors).toEqual([]);

    // After hydration effect runs, cached settings & quotes should be visible cleanly
    expect(container.textContent).toContain("CustomCachedBrand");

    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });
});
