import type { AppSettings, Profile, ProxyGroup } from '../domain/app';
import type { RoutingPolicy } from '../core/routing-policy';

interface TrayState {
  tunEnabled: boolean;
  sysProxyEnabled: boolean;
  settings: AppSettings;
  groups: ProxyGroup[];
  activeId: string | null;
  profiles: Profile[];
  routing: RoutingPolicy | null;
}
type TrayFlags = [boolean, boolean, number, string, boolean, boolean, string, string, string[]];

/** 托盘同步不是关键路径；由应用组合层提供主分组和系统适配器。 */
export function createTrayPublisher(port: {
  enabled(): boolean;
  primaryGroup(state: TrayState): string;
  write(...flags: TrayFlags): Promise<unknown>;
  report(error: unknown): void;
}) {
  return async (state: TrayState): Promise<void> => {
    if (!port.enabled()) return;
    const s = state.settings;
    try {
      await port.write(state.tunEnabled, state.sysProxyEnabled, s.mixedPort, s.mode,
        s.traySpeed, s.hideDockOnClose, s.controllerSecret, port.primaryGroup(state), state.groups.map(group => group.name));
    } catch (error) { port.report(error); }
  };
}
