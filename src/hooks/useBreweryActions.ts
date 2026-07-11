import { useCallback } from 'react';
import { useToast } from '../components/Toasts';
import { HA_WRITE_BASE, HA_TOKEN } from '../config';

export function useBreweryActions() {
  const toast = useToast();

  // Writes go through HA's REST API directly (POST /api/services/<domain>/<service>),
  // NOT hakit's callService. hakit's service-call shape kept shifting across versions
  // and was producing ZERO outbound HA traffic on assign (verified in the Network tab
  // — selecting a tilt/batch fired no request). The REST path is verified-working and
  // uses the same HA_URL/HA_TOKEN the app already connects with. `what` is the toast
  // label. Surfaces a visible error toast on any non-2xx / network failure.
  const call = useCallback(
    async (domain: string, service: string, entity_id: string, data: Record<string, any>, what: string) => {
      try {
        const r = await fetch(`${HA_WRITE_BASE}/api/services/${domain}/${service}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ entity_id, ...data }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`HA ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}`);
        toast.ok(what);
      } catch (e) {
        console.error('HA write failed', domain, service, entity_id, e);
        toast.error(`${what} failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [toast],
  );

  // Silent variant: no success toast (background writes, e.g. the ferm plan JSON).
  const callQuiet = useCallback(
    async (domain: string, service: string, entity_id: string, data: Record<string, any>) => {
      try {
        const r = await fetch(`${HA_WRITE_BASE}/api/services/${domain}/${service}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ entity_id, ...data }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) console.error('HA write (quiet) failed', domain, service, entity_id, r.status);
      } catch (e) {
        console.error('HA write (quiet) failed', domain, service, entity_id, e);
      }
    },
    [],
  );

  return {
    setStatus: (t: string, v: string) =>
      call('input_select', 'select_option', `input_select.${t}_status`, { option: v }, `${label(t)} status → ${v}`),
    setTilt: (t: string, v: string) =>
      call('input_select', 'select_option', `input_select.${t}_tilt`, { option: v }, `${label(t)} Tilt → ${v}`),
    /** Assign a batch by writing the Brewfather batch NUMBER (stable ID) as free
     *  text — no options list, so HA can never reset it on restart. Empty string
     *  = unassigned. The picker passes the batchNo; display resolves it live. */
    setBatch: (t: string, batchNo: string) =>
      call('input_text', 'set_value', `input_text.${t}_batch`, { value: batchNo }, `${label(t)} batch → ${batchNo || 'unassigned'}`),
    setExpectedFg: (t: string, fg: number) =>
      call('input_number', 'set_value', `input_number.${t}_expected_fg`, { value: fg }, `${label(t)} expected FG → ${fg}`),
    markCleaned: (t: string, iso: string) =>
      call('input_datetime', 'set_datetime', `input_datetime.${t}_last_cleaned`, { date: iso }, `${label(t)} marked cleaned`),
    setSetpoint: (t: string, tempF: number) =>
      call('number', 'set_value', `number.${t}_setpoint_raw`, { value: Math.round(tempF * 10) }, `${label(t)} setpoint → ${tempF}°F`),

    // --- fermentation programs ---
    // Start/select a program: set the program helper + reset phase to 0 + stamp start.
    // The programs container picks it up on its next tick and drives the setpoint.
    setProgram: async (t: string, program: string) => {
      await call('input_select', 'select_option', `input_select.${t}_program`, { option: program }, `${label(t)} program → ${program}`);
      // reset phase state so the program starts from the top
      await callQuiet('input_number', 'set_value', `input_number.${t}_program_phase`, { value: 0 });
      await callQuiet('input_datetime', 'set_datetime', `input_datetime.${t}_program_phase_started`, { datetime: new Date().toISOString() });
    },
    // Write a Claude-generated (+ edited) plan JSON to input_text.tank_N_program_plan
    // and set the program to 'Generated' so the runner picks it up. Phase reset so it
    // starts from the top. The plan is per-batch, reboot-proof (input_text).
    setGeneratedPlan: async (t: string, planJson: string) => {
      await callQuiet('input_text', 'set_value', `input_text.${t}_program_plan`, { value: planJson });
      await call('input_select', 'select_option', `input_select.${t}_program`, { option: 'Generated' }, `${label(t)} → generated ferm plan`);
      await callQuiet('input_number', 'set_value', `input_number.${t}_program_phase`, { value: 0 });
      await callQuiet('input_datetime', 'set_datetime', `input_datetime.${t}_program_phase_started`, { datetime: new Date().toISOString() });
    },
    // Stop/cancel: back to manual (program None). Setpoint stays where it is.
    cancelProgram: (t: string) =>
      call('input_select', 'select_option', `input_select.${t}_program`, { option: 'None' }, `${label(t)} program cancelled`),
    // Confirm the gated cold-crash (the container is awaiting this).
    confirmCrash: (t: string) =>
      call('input_button', 'press', `input_button.${t}_confirm_crash`, {}, `${label(t)} — cold crash confirmed`),
  };
}

/** 'tank_2' → 'Tank 2' for readable toasts. */
function label(tankId: string): string {
  const n = tankId.replace('tank_', '');
  return `Tank ${n}`;
}
