"use client";

import { useState } from "react";

export default function MatchPage() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawText: text }),
      });
      const json = await res.json();
      setNote(json.error ?? JSON.stringify(json));
    } catch (e: any) {
      setNote(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Match a listing</div>
          <div className="subtle">
            Paste an MLS listing and see which of your buyers fit — and why.
          </div>
        </div>
      </div>

      <div className="card">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the full MLS listing text (address, price, beds/baths, features, description)…"
          rows={10}
          style={{
            width: "100%",
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 12,
            fontFamily: "inherit",
            fontSize: 14,
            resize: "vertical",
          }}
        />
        <div style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary"
            onClick={run}
            disabled={!text.trim() || busy}
          >
            {busy ? "Matching…" : "Find matching buyers"}
          </button>
        </div>
      </div>

      {note && (
        <div className="card">
          <p className="subtle">{note}</p>
        </div>
      )}

      <div className="card">
        <p className="subtle" style={{ fontSize: 13 }}>
          Matching + drafting turn on once the AI jobs are wired to a real KW
          export (Phase 2–4 in the plan). This screen is the entry point:
          paste → extract listing features → hard-filter by price/beds →
          AI-rank the rest → pick buyers → generate personal Gmail drafts.
        </p>
      </div>
    </>
  );
}
