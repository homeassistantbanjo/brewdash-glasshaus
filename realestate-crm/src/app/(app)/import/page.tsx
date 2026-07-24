"use client";

import { useState } from "react";

interface Summary {
  total: number;
  created: number;
  updated: number;
  skippedSuppressed: number;
  notesChanged: number;
  noEmail: number;
}

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      setSummary(json.summary);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Import CRM data</div>
          <div className="subtle">
            Upload a Keller Williams Command export (.csv). Safe to re-run
            anytime — it updates existing contacts and adds new ones.
          </div>
        </div>
      </div>

      <div className="card">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary"
            onClick={upload}
            disabled={!file || busy}
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>

        <ul className="subtle" style={{ fontSize: 13, marginTop: 16 }}>
          <li>Contacts you’ve unsubscribed or deleted are skipped automatically.</li>
          <li>Your hand-edited contacts are preserved, not overwritten.</li>
          <li>Lifecycle status (bought / cold / do-not-contact) is never reset by an import.</li>
        </ul>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong style={{ color: "var(--danger)" }}>Error:</strong> {error}
        </div>
      )}

      {summary && (
        <div className="card">
          <h3>Import complete</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 12,
              marginTop: 12,
            }}
          >
            <Stat n={summary.created} label="New" cls="chip-ok" />
            <Stat n={summary.updated} label="Updated" cls="chip-accent" />
            <Stat n={summary.notesChanged} label="Notes changed" cls="chip-warn" />
            <Stat
              n={summary.skippedSuppressed}
              label="Skipped (unsubscribed)"
              cls="chip-danger"
            />
            <Stat n={summary.noEmail} label="No email (skipped)" cls="" />
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div
      className="card"
      style={{ boxShadow: "none", textAlign: "center", padding: 16 }}
    >
      <div style={{ fontSize: 28, fontWeight: 800 }}>{n}</div>
      <span className={`chip ${cls}`}>{label}</span>
    </div>
  );
}
