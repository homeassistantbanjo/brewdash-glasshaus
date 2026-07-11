# Home Observability & Self-Healing Engine — Design

**Status:** DESIGN (not built). Review before implementing.
**Scope:** the *entire* home, not just GlassHaus — Home Assistant, the network, the
GlassHaus brew system, **all Unraid containers**, Unraid itself, and PBS.

---

## The goal (Jordan's words, distilled)

Two things:
- **A. Catch things that are down / problematic** — including *before* they fully
  fail (predict degradation, not just detect outages).
- **B. Auto-remediate issues, with graduated sign-off** — observe a problem, apply
  a fix, learn `{symptom → fix → outcome}` so the system gets more confident and
  more autonomous over time for the *safe* stuff, while keeping a human in the loop
  for anything risky.

The "training" is **NOT fine-tuning a model** — see "Learning" below.

---

## What already exists (don't rebuild)

The home already runs three-fifths of an observability stack; the gap is **cohesion
and intelligence**, not raw collection:

| Tool | Watches | Gap it leaves |
|---|---|---|
| **Netdata** (Unraid) | host + container metrics, real-time | per-node, no cross-signal correlation, noisy thresholds |
| **Scrutiny** | disk SMART | siloed from everything that *depends* on those disks |
| **Uptime Kuma** | HTTP/ping up-down | binary; no *why*, no metrics |
| **Home Assistant** | physical/IoT + `sensor.glasshaus_health` | blind to containers / Unraid / PBS / network |
| **Watchtower** | image updates | not health |

`sensor.glasshaus_health` (programs container's `monitor.mjs`) is already the model
to generalize: a domain that computes its own health and publishes structured JSON.

### Fleet inventory (as of design; ~30 containers, host up 13d, all healthy)

Critical/stateful: `Plex`, `paperless`(+`-db` postgres, `-redis`, `-tika`,
`-gotenberg`), `Home Assistant`* , the 4 GlassHaus containers, `gluetun` (VPN — the
*arr stack routes through it), `Tailscale`. Disposable/restart-safe: the `binhex-*`
*arr apps, `sabnzbd`, `bazarr`, `recyclarr`, `Decluttarr`, `calibre`, `tautulli`,
`speedtest-tracker`, `rclone`. Observability: `netdata`, `scrutiny`, `UptimeKuma`.

**PBS is NOT on Unraid** — it's a separate host. The collector reaches it over the
network (PBS has a native Prometheus metrics endpoint + API), not via the local
Docker socket. Same for the network gear (UniFi/router exporter).

\* HA runs as HAOS on its own box (192.168.50.127), not an Unraid container.

---

## Architecture: collect → store → reason → act

**Key decision (revised from Jordan's input): a dedicated collector on Unraid, NOT
HA-centric.** Do not route network/host metrics *through* Home Assistant — HA's
integrations are thin and it becomes a single point of failure for the whole
pipeline. Instead a **Telegraf** container scrapes every source directly, and HA is
just *one* of those sources (for the IoT/brew signals only). If HA is down, you still
see the network + containers + host.

```
  COLLECT (Telegraf on Unraid)          STORE              REASON              ACT
  ────────────────────────────          ─────              ──────              ───
 SNMP → Asus router ────────┐                          ┌ stat anomaly ─┐
 [[inputs.docker]] all 30 ──┤                          │ (ML, no LLM)  │
 [[inputs.system/smart]] ───┼─► VictoriaMetrics ──────►│               ├─► Tier-0
 [[inputs.ping/http]] up/dn ┤   (metrics)              ├ SANITIZER ──► │   reflexive
 HTTP → PBS prom (remote) ──┤                          │  Claude (RCA, │   remediate
 HTTP → HA API ─────────────┤   Loki (logs)            │  NL query)    └─► runbook DB
   (GlassHaus health, Tilt,  │   Alertmanager          └ runbook RAG       (learns)
    ASUSWRT presence, IoT)   │   Grafana (1 pane)
 glasshaus_health ──────────┘
```

- **Collector = Telegraf** (decided). Native plugins: `snmp` (router direct),
  `docker` (all containers), `system`/`disk`/`smart` (Unraid host), `ping`/`http`
  (up-down — subsumes Uptime Kuma's role), `http` → PBS Prometheus (remote host) and
  → HA API (brew/IoT/presence). Writes Prometheus-format to VictoriaMetrics.
- **VictoriaMetrics** over vanilla Prometheus — lighter, better retention for a
  homelab, Prometheus-wire-compatible.
- **Loki** for logs (container stderr, HA log, syslog). Grafana unifies both.
- **Alertmanager** for dedupe/group/route → phone (reuse HA notify or a direct
  ntfy/Pushover channel — see open questions).
- The **reason** and **act** layers are later phases; collector+store is Phase 1.

### Network: router direct via SNMP (HA integration is too thin)

The **stock ASUSWRT HA integration is thin** — verified live it exposes only WAN
throughput (`sensor.192_168_50_1_download/_upload[_speed]`), connected-device count
(37), and 6 `device_tracker` presence entities. No router CPU/RAM/temp, no
per-interface or per-client stats.

- **Now (stock fw):** enable **SNMP** on the router; Telegraf `[[inputs.snmp]]`
  pulls real per-interface throughput, CPU, uptime — HA-independent. Keep the HA
  integration only for **device presence** (who's home), which SNMP doesn't give.
- **Upgrade path (Jordan is willing to flash):** **Asuswrt-Merlin** + the community
  **`asusrouter`** HACS integration unlocks CPU/RAM/temperature, per-client traffic,
  wifi signal quality, port/LED state. Flash is supported on most Asus models and
  reversible. Documented as the Phase-1.5 network-depth upgrade.
- **Coming: Firewalla Gold-class (mid/upper tier — Gold Pro or the model just below
  the top).** This is NOT a small inline bridge — the Gold family is a full
  **router/firewall appliance**, so it will likely become the network BACKBONE, with
  the Asus demoted to AP/AiMesh (or bridge) mode. Design implications:
  - **Role shift:** Firewalla becomes the PRIMARY network-flow + security source;
    Asus SNMP narrows to AP/wifi-host health (or drops out if bridged). Don't invest
    heavily in Asus-specific depth (Merlin) if Firewalla is landing soon — it would
    be superseded. Sequence the network work around Firewalla's arrival.
  - **What it sees (that nothing else can):** per-device AND per-*app* flows,
    new-device-joined, intrusion/port-scan/abnormal-upload alarms, DNS/domain-level
    traffic, per-device bandwidth, WAN quality. Gold Pro also has the throughput
    headroom to run deep inspection without becoming the bottleneck.
  - **Ingest:** Firewalla **MSP API** (richest, structured), a native **HA
    integration**, and Telegraf polling. Its security alarms are high-value events
    for the RCA + anomaly layers ("internet slow" → which device/app is saturating;
    "unknown device at 3am" → a genuine SECURITY escalation, a class the engine
    should treat as Tier-2 always-notify, never auto-remediate).
  - **Recommendation:** hold Merlin/deep-Asus work; do SNMP-basic now for Phase 1,
    then make Firewalla the network story when it arrives (Phase 1.5).

### Tilt Pi — a monitored single point of failure (new coverage)

The **Tilt Pi** (Raspberry Pi bridging the Tilt hydrometers → network) has been an
UNMONITORED SPOF: if it dies, all gravity data stops, and there's currently no host
liveness on it. Jordan now has Tilt Pi monitoring. Fold it in:
- Telegraf `ping` + (if the Pi runs it) an SNMP/node-exporter scrape → Pi host
  up/CPU/temp.
- Correlate with the existing per-Tilt staleness (GlassHaus already computes
  `gravityAgeMin`): "all Tilts stale AT ONCE" ⇒ the Pi, not a single hydrometer.
  A single Tilt stale ⇒ that hydrometer/battery. This distinction is a good early
  fingerprint for the learning loop.
- NOTE (live at design time): `binary_sensor.tilt_black_signal_lost` and both tilt
  automations were `unavailable`, and `tilt_red_temperature` was 82m stale — i.e.
  Tilt signal-loss detection is presently degraded. Exactly the SPOF this closes.

---

## The AI question — answered honestly

### You do NOT need a local LLM. You do NOT fine-tune.

Two ways to make AI "learn your home's failures":

| Approach | Reality | Verdict |
|---|---|---|
| **Fine-tune** (retrain weights on incidents) | needs hundreds of clean labeled examples/type, a GPU, retrain pipelines, still hallucinates | ❌ wrong tool for a homelab |
| **RAG over a growing runbook DB** | store every `fingerprint → fix → outcome`; retrieve similar past cases at incident time, hand to Claude as context | ✅ correct — "learning" = the DB grows; the model never changes |

So the intelligence lives in a **database you own, back up, and inspect** — not in
model weights. Works from incident #1. Cloud **Claude** is the right model: reasoning
is per-incident/per-question (cheap, a few calls/day), and the "memory" is your DB,
not something you'd retrain. No GPU, no ongoing inference cost, no power draw.

### AI's four roles and where each runs

| Role | Engine | Frequency |
|---|---|---|
| Anomaly detection / **prediction** | **local statistical ML** (Prophet/rolling-stats) — NOT an LLM (LLMs are bad + expensive at continuous numeric anomaly detection) | continuous |
| Explain / correlate (RCA) | **Claude API** over *redacted* context + retrieved runbooks | per incident |
| Natural-language querying | **Claude API** → metric/log queries → answer | on demand |
| Remediation *decision* | **deterministic** (allowlist + runbook match). LLM *proposes*, never *executes* | per incident |

---

## The secret-exposure problem (Jordan's concern) — the SANITIZER

Jordan correctly flagged: **RCA + remediation feed logs to the LLM, and logs leak
secrets.** Key truth: **a local LLM does NOT solve this** — a local model can still
surface a secret into a summary you screenshot/push/store. The fix is **redaction
before any model sees anything**, cloud or local.

**Nothing talks to the LLM directly.** Everything crosses a sanitizing gateway:

```
raw logs/metrics/events ─► SANITIZER ─► redacted context ─► Claude
```

The sanitizer (a small owned service):
- **Denylist patterns:** `sk-ant-\w+`, `eyJ[\w-]+\.[\w-]+\.` (JWT), `user:pass@`,
  RFC1918 + public IPs → `[IP]`, emails, high-entropy strings ≥32 chars → `[TOKEN]`.
  (These are the exact classes we guarded by hand all session: HA token, BF apikey,
  Anthropic key, the `jordanielafontaine@gmail.com` that showed up in a Tilt reading.)
- **Allowlist mode for PII-heavy sources:** paperless etc. — never pass free-text
  OCR/filenames; only structured fields (status, error class, counts).
- **Per-source policy:** `glasshaus_health` JSON is already clean → verbatim ok;
  container stderr → aggressive redaction; paperless content → structured-only.

---

## Trust model for remediation — THREE tiers

Not a single "earn it" ladder. Blast radius sets a hard ceiling; safe things are
auto from day one; the middle earns trust.

| Tier | Examples | Behavior |
|---|---|---|
| **0 — Reflexive** (safe, standard SOP, idempotent) | container exited/unhealthy → restart; wedged Z2M feed → bridge restart; stale HA integration → reload | **AUTO from day 1.** The fix *is* the diagnosis; requiring it to "earn trust" is pure friction. |
| **1 — Earned** (reversible, not obviously-correct) | restart a specific misbehaving service; clear a stuck queue; kill a runaway process | propose-only → graduates to auto after proven history |
| **2 — Never auto** (irreversible / wide) | array ops, deletes, PBS prune, network/config writes | **always asks, forever.** No graduation, regardless of success count. |

### Tier-0 loop (Jordan's spec: "restart up to twice, then alert")

```
container exited/unhealthy
 ├ attempt 1: restart → recheck health
 │    └ healthy? → quiet log "auto-recovered <name> (1)". DONE.
 ├ attempt 2 (still down): restart → recheck
 │    └ healthy? → NOTIFY "recovered <name> after 2 tries (was flaky)". DONE.
 └ still down after 2 → 🚨 ESCALATE "<name> down, 2 restarts failed — needs you"
                        + last 50 log lines (REDACTED). STOP trying.
```

Guardrails even at Tier 0:
- **Restart-storm cap:** same container >3× in 24h → stop auto-restarting, escalate
  as "chronically failing — real bug, not a blip." (Anti-masking: auto-restarting a
  memory-leaking container hides the defect forever.)
- **Dependency ordering:** don't restart `paperless` when `paperless-db` is the
  actual cause; restart the dependency first. The fingerprint must consider "is a
  thing this depends on also down?" (paperless stack = 5 containers; *arr stack
  depends on `gluetun`).

### Tier-1 graduation (within reversible class only)

Auto-apply requires BOTH gates:
1. **Risk-class ceiling** (hard, set once): only `REVERSIBLE` actions are *eligible*.
   `IRREVERSIBLE/WIDE` can never graduate no matter the history — this makes
   prompt-injection into a destructive action *architecturally impossible*, because
   the LLM can only ever select from a hardcoded allowlist of parameterized actions
   (`restart_container(name ∈ known_set)`), never emit arbitrary commands.
2. **Earned trust** (soft, learns): ≥5 approvals of that exact fix for that exact
   fingerprint, 100% success in the last 5 (any failure resets), and not >3×/24h.

**Demotion is easy:** a graduated fix drops back to propose-only on a single failure
or a storm-escalation. Trust is lost fast, by design.

---

## The COMMAND CENTER UI (Jordan: "I LOVE DATA" + wants transparency + promotion)

Not just dashboards — a control surface with three distinct jobs. Most observability
tools do only the first; the value is in 2 and 3.

### 1. See everything (the data firehose, done well)
Whole-house at a glance AND drill-down: uptime/status per host + per container +
network + brew + PBS; live + historical metrics; the open-issues list; SLA-style
uptime history; energy; "what changed recently." Grafana provides the deep
dashboards; a **top-level "house status" summary** (green/degraded/incident, counts,
current incidents) is the home screen. This is the "I love data" layer — expose it
all, but lead with a legible summary so it's not just 40 panels.

### 2. Automation transparency — "what WILL it do when it observes X?"
A browsable, human-readable catalog of every remediation the engine KNOWS, so it's
never a black box. For each entry:
- **Trigger/fingerprint** in plain English ("container `X` reports unhealthy for >2m")
- **What it will do** ("restart up to 2×, recheck health between, escalate if still
  down") — the actual runbook, readable
- **Tier** (0 reflexive / 1 earned / 2 never-auto) and **current autonomy state**
  (propose-only vs auto-apply) with the WHY ("auto: 8/8 success" or "asks: 2/5")
- **History:** last N times it fired, outcomes, success rate
- **Controls:** manually promote/demote, disable, edit the runbook, dry-run it

This is what makes graduated trust *trustable* — you can always read exactly what the
system is empowered to do, and revoke it in one tap.

### 3. "Shift-left" queue — promote frequent manual fixes to AI automation
The engine watches WHAT YOU DO, not just what breaks. It surfaces:
- **Recurring manual incidents:** "you've manually resolved 'sabnzbd queue stuck' 6×
  in 3 weeks — here's what you did each time; **automate it?**" One tap turns your
  repeated manual fix into a Tier-1 runbook (propose-only first).
- **Graduation nudges:** "'restart z2m bridge' has 5/5 approvals — **let it run
  unattended?**" (the Tier-1 → auto promotion, surfaced instead of silent).
- **Anti-masking flags:** "'restart plex' fired 5× in 2 days — this is a real defect,
  not a blip. Investigate?" (frequency escalation, made visible).
- **Novel-pattern digest:** issues seen with no runbook yet, ranked by frequency —
  your backlog of "things worth teaching it."

This queue is the engine's growth path: the left-to-AI shift is a deliberate,
reviewable action you take FROM THE UI, informed by real history — not something that
happens behind your back.

**Where it lives:** a new view (own app or a Grafana-embedded panel + a small
control API on the `home-observer` container). Reuses the GlassHaus HUD design
language so the whole house feels like one system.

## Learning loop (B) — how it gets smarter without fine-tuning

```
1 OBSERVE   detector (deterministic + statistical) fires
2 FINGERPRINT structured signature: {service, error-class, correlated signals,
             metric deltas, dependency state} — hashable, comparable
3 RETRIEVE  RAG: find nearest past fingerprints + their runbooks in the DB
4 PROPOSE   known? "matches incident #17/#23/#31, fix 'restart z2m', 3/3 success,
             [Apply]". novel? Claude reasons a candidate fix → new runbook entry.
5 SIGN-OFF  you approve/edit/reject (unless Tier-0 or graduated Tier-1)
6 ACT       deterministic executor runs the allowlisted action
7 LEARN     record {fingerprint → fix → outcome (did symptom STAY gone?) → success++}
8 PREDICT   statistical layer recognizes the early SHAPE of a known failure
             (SMART reallocated-sectors creeping, mem climbing, cycles rising)
             → warn before it trips
```

**Feedback-poisoning guard:** a fix that *coincidentally* preceded recovery must not
be learned as causal. Track whether the symptom *stayed* gone; require a min sample;
let Jordan flag "that was luck."

---

## Knowledge store (decided): a dedicated container

A **`home-observer`** container (mirrors the `glasshaus_brewfather` pattern) owning:
- the incident/runbook DB (**SQLite** to start; Postgres if it outgrows it),
- fingerprinting + RAG retrieval,
- the sanitizer,
- the Claude client,
- the deterministic action executor (Docker socket for container actions; SSH/API
  for Unraid/PBS/network — scoped, allowlisted).

Testable in isolation (pure functions for fingerprint/redact/match), same as
`derived.mjs`/`monitor.mjs`.

---

## Phased build (each phase independently useful)

- **Phase 1 — UNIFY (decided first).** VictoriaMetrics + Loki + Grafana +
  Alertmanager. Point netdata, scrutiny, PBS (remote), HA (prometheus exporter),
  network exporter, docker metrics, and `glasshaus_health` at it. One dashboard, one
  alert channel. **No AI.** Kills "check five places." You can't safely automate what
  you can't see coherently — and this store is the data source every later phase
  queries.
- **Phase 2 — Tier-0 reflexive remediation.** `home-observer` container: watch
  docker events + health, the restart-up-to-2 loop, dependency ordering, storm cap,
  escalation. Still no LLM.
- **Phase 3 — Sanitizer + Claude RCA.** Redacted context → Claude → phone. The "why."
- **Phase 4 — Runbook DB + RAG + Tier-1 graduation.** The learning loop.
- **Phase 5 — Statistical anomaly / prediction.** Continuous ML for early warning.
- **Phase 6 — NL querying.** Chat over the (redacted) store.
- **Command Center UI — built up ACROSS phases, not last.** Its three jobs land as
  their backing data does: (1) *See-everything* summary ships with Phase 1 (Grafana +
  a house-status home screen). (2) *Automation-transparency catalog* ships with
  Phase 2 (as soon as Tier-0 runbooks exist — they must be legible from birth).
  (3) *Shift-left queue* ships with Phase 4 (needs the runbook DB + your manual-fix
  history). Don't defer the UI to the end — transparency is what makes each
  automation phase safe to turn on.

---

## Realistic expectations

Fleet is stable (13d uptimes, all healthy, nothing exited). This engine will be
**quiet most of the time** — that's the goal. Estimated: a handful of Tier-0
auto-recoveries/week (mostly *arr apps + feeds hiccupping), a genuine "needs you"
escalation every 1–2 weeks. Value isn't volume — it's that the rare 3am wedge
(the Z2M freeze, the Brewfather integration going empty, an OOM) is caught and often
self-healed instead of rotting silently for hours like the glycol sensor did.

## Decisions locked
- **Collector:** Telegraf container on Unraid.
- **Store:** VictoriaMetrics (metrics) + Loki (logs) + Grafana + Alertmanager.
- **Network now:** Asus stock fw → SNMP; HA integration for presence only.
- **Network later:** Merlin + `asusrouter` (willing to flash); **Firewalla** incoming
  as primary flow/security source.
- **AI:** cloud Claude (no local LLM, no fine-tune); learning = RAG over a runbook DB.
- **Knowledge store:** dedicated `home-observer` container + SQLite→Postgres.
- **Trust model:** Tier 0 auto-from-day-1 (restart×2 then escalate), Tier 1 earned,
  Tier 2 never-auto.
- **Phase 1 first:** unify collection+store+dashboards; no AI.

## Open questions for build time
- **PBS metrics:** native Prometheus endpoint vs API scrape — confirm reachability
  from Unraid + a scoped read-only token.
- **Alert channel:** reuse HA `notify.mobile_app_jordans_phone`, or stand up `ntfy`
  for infra alerts so brew alerts and infra alerts are separable? (Leaning ntfy —
  keeps a dead-HA scenario from silencing infra alerts.)
- **Unraid host metrics:** Telegraf `system`/`smart` plugins vs re-use netdata's
  stream — Telegraf keeps one collector; decide at build.
- **SNMP enablement** on the Asus router (Administration → SNMP) — confirm before
  Phase 1 network scrape.
- **Firewalla ingest:** MSP API vs HA integration vs Telegraf — pick when it arrives.
