# GlassHaus — Deployment Checklist

One place for every remaining install/deploy step, in order. All code is built,
tested, and pushed; what's left is infra setup on YOUR machines (HA + Unraid).
Nothing here requires more coding.

Legend: ✅ done · ⬜ your step

Hosts:
- **HA** = Home Assistant @ `192.168.50.127:8123`
- **Unraid** = NAS @ `192.168.50.118` (Docker, PBS datastore, GlassHaus container)
- **Tablet** = wall kiosk (on Tailscale/LAN)
- Images (all TOKEN-FREE, on ghcr, public package):
  - `ghcr.io/homeassistantbanjo/brewdash-glasshaus:latest` (dashboard) — ✅ deployed
  - `ghcr.io/homeassistantbanjo/brewdash-glasshaus-analyzer:latest` (LLM insights)
  - `ghcr.io/homeassistantbanjo/brewdash-glasshaus-programs:latest` (fermentation control)

---

## ⚡ RE-PULL RUNBOOK — updating the 3 containers (the `:latest` cache gotcha)

Editing a container in the Unraid UI and hitting *Apply* often **re-runs the SAME cached
`:latest` image** — that's why "update" appeared to do nothing before. The fix is to force-
remove the local image so Docker MUST re-pull. Do this in the **Unraid web terminal** (the
`>_` icon, top-right of the Unraid GUI).

**Order matters** (the app + notify automations read `sensor.tank_N_derived`, which only the
*programs* container writes): **programs → dashboard → analyzer**.

Container names below assume the Unraid defaults `Glasshaus`, `Glasshaus-programs`,
`Glasshaus-analyzer`. If yours differ, run `docker ps --format '{{.Names}}\t{{.Image}}'`
first and substitute.

```sh
# ── 0. See what's actually running + on which image ──────────────────────────
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

# ── 1. PROGRAMS first (writes sensor.tank_N_derived → feeds the whole app) ────
docker stop Glasshaus-programs && docker rm Glasshaus-programs
docker rmi ghcr.io/homeassistantbanjo/brewdash-glasshaus-programs:latest
docker pull ghcr.io/homeassistantbanjo/brewdash-glasshaus-programs:latest
#   → then recreate from the Unraid UI: Docker tab → Glasshaus-programs is now
#     an "orphan" template → click it → Apply. It rebuilds with your saved env
#     (HA_URL, HA_TOKEN, DRY_RUN=true) on the freshly-pulled image.
#   Verify:  docker logs -f Glasshaus-programs   (should tick + log per-tank derive)

# ── 2. DASHBOARD ─────────────────────────────────────────────────────────────
docker stop Glasshaus && docker rm Glasshaus
docker rmi ghcr.io/homeassistantbanjo/brewdash-glasshaus:latest
docker pull ghcr.io/homeassistantbanjo/brewdash-glasshaus:latest
#   → recreate via Docker tab → Glasshaus template → Apply.

# ── 3. ANALYZER (only if you want LLM insight notifications) ─────────────────
docker stop Glasshaus-analyzer && docker rm Glasshaus-analyzer
docker rmi ghcr.io/homeassistantbanjo/brewdash-glasshaus-analyzer:latest
docker pull ghcr.io/homeassistantbanjo/brewdash-glasshaus-analyzer:latest
#   → recreate via Docker tab → Glasshaus-analyzer template → Apply.
```

**Why `docker rm` + recreate-from-template instead of just `docker restart`?** `restart`
reuses the running container (old image). Removing it and re-Applying the Unraid template
recreates it on the newly-pulled image **while keeping every env var / port / path** you set
in the template — nothing to re-type.

**Alternative (no UI, if you prefer):** the Unraid UI stores the exact `docker run` in
`/boot/config/plugins/dockerMan/templates-user/my-<Name>.xml`. But recreating from the UI
template (above) is safer than hand-writing `docker run` — it can't drift from your saved config.

### After the re-pull — verify it took (run from anywhere on the LAN)
```sh
# programs is writing the derived entity? (empty result = still old image)
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  http://192.168.50.127:8123/api/states/sensor.tank_1_derived | head -c 200
# dashboard bundle changed? (compare the hash before/after)
curl -s http://192.168.50.118:8099/ | grep -oE 'assets/index-[^"]+\.js'
# analyzer alive?
curl -s http://192.168.50.118:8091/health
```
Then hard-reload the dashboard/kiosk (Ctrl-Shift-R, or Fully Kiosk → clear cache) so the
tablet drops the old JS bundle. Pace / attenuation / alerts populate once step 1 is live.

---

## 0. Already live ✅
- Dashboard container running on Unraid → `http://192.168.50.118:8099/`.
- HA packages `glasshaus_derived.yaml` + `glasshaus_automations.yaml` installed.
- PBS backup: NFS automount fixed; JorYoga backup runs as a system service.

## 1. Wall tablet kiosk ⬜
- Install **Fully Kiosk Browser** on the tablet.
- Start URL: `http://192.168.50.118:8099/` (or the Unraid Tailscale name).
- Enable: keep screen on, launch on boot, auto-reload on connection loss.
- Tablet must be on the tailnet / same LAN.

## 2. LLM insights — analyzer container ⬜
Prereqs: an **Anthropic API key**; a **dedicated scoped HA long-lived token** (recommended
over reusing the dashboard's).
1. HA: enable `rest_command` if not already — add to `configuration.yaml`:
   ```yaml
   rest_command:
     glasshaus_insight_trigger:
       url: "http://192.168.50.118:8091/trigger"
       method: POST
       content_type: "application/json"
       payload: '{"reason": "{{ reason }}"}'
   ```
   (The `gh_insight_trigger_on_alert` automation in `glasshaus_automations.yaml` calls this.)
2. Unraid → Docker → Add Container:
   - Repository: `ghcr.io/homeassistantbanjo/brewdash-glasshaus-analyzer:latest`
   - Port: container `8091` → host `8091`
   - Env: `HA_URL=http://192.168.50.127:8123`, `HA_TOKEN=<scoped token>`,
     `ANTHROPIC_API_KEY=<key>`  (optional: `DIGEST_HOURS=8`)
3. Verify: `docker logs -f Glasshaus-analyzer` — should log a startup digest and write
   `sensor.glasshaus_insight`. The app shows an insight badge; phone gets a notify.

## 3. Fermentation programs — HA helpers ⬜
1. Copy `ha/glasshaus_programs.yaml` → HA `<config>/packages/glasshaus_programs.yaml`.
2. Developer Tools → YAML → Check Configuration → **restart HA** (input_* helpers need it).
3. Verify the helpers exist: `input_select.tank_1_program`, `input_number.tank_1_program_phase`,
   `input_datetime.tank_1_program_phase_started`, `input_button.tank_1_confirm_crash`.
   → The app's ⚙ Manage modal now shows the Program picker (was "not installed yet").

## 4. Fermentation programs — control container (DRY_RUN FIRST) ⬜
1. Unraid → Docker → Add Container:
   - Repository: `ghcr.io/homeassistantbanjo/brewdash-glasshaus-programs:latest`
   - Env: `HA_URL=http://192.168.50.127:8123`, `HA_TOKEN=<scoped token>`
   - **Leave `DRY_RUN=true`** (baked into the image — do NOT set false yet).
   - (optional: `TICK_MINUTES=5` default, `TANKS=tank_1,tank_2,tank_3`)
2. In the app, pick a program on Tank 1 (⚙ Manage → Fermentation Program).
3. **Watch `docker logs -f Glasshaus-programs`** — it logs what it WOULD command
   (e.g. "would set tank_1 to 64°F, holding for 50% attenuation"), writing NOTHING.
   Confirm the decisions look right against the real tank for a tick or two.
4. **Go live:** set the container's `DRY_RUN=false` and restart it. It now writes
   `number.tank_N_setpoint_raw` + advances phases + waits for your ❄ crash confirm.

### Program safety recap (built in)
- Per-program setpoint clamp (kveik 32–98°F, ale/lager 32–75°F); ≤5°F per write.
- Cold crash is GATED — never fires until you tap "❄ Confirm cold crash".
- Stale/lost gravity → holds, won't advance a data-driven phase.
- Starting a program mid-ferment auto-jumps to the phase the beer is actually in.

## 5. Loose ends (PBS) ⬜ — via the PBS web-UI Shell (Claude's SSH key was removed)
- Remove the leftover `claude-code-pbs-access` line from `/root/.ssh/authorized_keys`
  (inert — no private key exists — but tidy it).
- Remove the corrupt stub snapshot `host/JorYoga/2026-07-08T04:23:58Z`.
- (Optional) Switch backup failure-alerting from the container return-code to a
  `sensor.backup_joryoga_status` staleness check (fire if no fresh backup >26h).

## 6. Housekeeping ⬜
- Old exposed HA token: delete it in HA if not already (a token was pasted in chat earlier;
  a new one was generated for the dashboard container).
- Update laptop `.env.local` with the current HA token so `npm run dev` works.
- Stale local Vite dev servers (ports 5173–5177) — stop the extras; keep one.
