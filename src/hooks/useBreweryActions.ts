import { useHass } from '@hakit/core';
import { useCallback } from 'react';
import { useToast } from '../components/Toasts';

export function useBreweryActions() {
  // hakit v6: useHass() is a zustand store whose callService lives under
  // `.helpers`, NOT at the top level. Destructuring `callService` off the root
  // yields undefined, so every write silently threw (and was swallowed below).
  const { helpers } = useHass();
  const toast = useToast();

  // `what` is a human label for the toast (e.g. "Tank 2 status → Ready").
  // We AWAIT the call so a rejected service (bad option, offline, auth) surfaces
  // as a visible error toast instead of vanishing into the console.
  const call = useCallback(
    async (domain: string, service: string, entity_id: string, data: Record<string, any>, what: string) => {
      console.log('WRITE', { domain, service, entity_id, data });
      try {
        const cs: any = (helpers as any)?.callService;
        if (typeof cs !== 'function') throw new Error('callService unavailable (HA not connected?)');
        await cs({ domain, service, target: { entity_id }, serviceData: data });
        toast.ok(what);
      } catch (e) {
        console.error('callService failed', domain, service, entity_id, e);
        const reason = e instanceof Error ? e.message : String(e);
        toast.error(`${what} failed — ${reason}`);
      }
    },
    [helpers, toast],
  );

  // Silent variant: no success toast (used for background reconciles the user
  // didn't explicitly trigger, e.g. syncing batch options). Errors still log.
  const callQuiet = useCallback(
    async (domain: string, service: string, entity_id: string, data: Record<string, any>) => {
      try {
        const cs: any = (helpers as any)?.callService;
        if (typeof cs !== 'function') return;
        await cs({ domain, service, target: { entity_id }, serviceData: data });
      } catch (e) {
        console.error('callService (quiet) failed', domain, service, entity_id, e);
      }
    },
    [helpers],
  );

  return {
    /** Replace a tank's batch-helper options wholesale (background reconcile). */
    setBatchOptions: (t: string, options: string[]) =>
      callQuiet('input_select', 'set_options', `input_select.${t}_batch`, { options }),
    setStatus: (t: string, v: string) =>
      call('input_select', 'select_option', `input_select.${t}_status`, { option: v }, `${label(t)} status → ${v}`),
    setTilt: (t: string, v: string) =>
      call('input_select', 'select_option', `input_select.${t}_tilt`, { option: v }, `${label(t)} Tilt → ${v}`),
    setBatch: (t: string, v: string) =>
      call('input_select', 'select_option', `input_select.${t}_batch`, { option: v }, `${label(t)} batch → ${v}`),
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
