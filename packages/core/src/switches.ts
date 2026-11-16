import type { SwitchRecord } from './ports/index.ts';

export const DEFAULT_SWITCHES: SwitchRecord = {
  v: 1,
  enabled: null,
  writable: null,
  discoverable: true,
  inheritWorkspace: true,
};

export function resolveSwitches(
  global: boolean,
  workspace: SwitchRecord = DEFAULT_SWITCHES,
  session: SwitchRecord = DEFAULT_SWITCHES,
) {
  const enabled = global && (session.enabled ?? workspace.enabled ?? true);
  return {
    enabled,
    writable: enabled && (session.writable ?? workspace.writable ?? true),
    discoverable: session.discoverable,
    inheritWorkspace: session.inheritWorkspace,
    source: !global
      ? ('global' as const)
      : session.enabled !== null
        ? ('session' as const)
        : workspace.enabled !== null
          ? ('workspace' as const)
          : ('global' as const),
  };
}
