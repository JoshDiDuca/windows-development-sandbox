// What the VPN commands and the menu need: your settings, whether a login is saved, the running sandbox's tunnel.
// No printing here, and the login is never returned: only saved, unreadable or none.
import type { Config } from '../../core/types.js';
import type { VpnProvider } from '../../core/schema/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import type { SecretStore } from '../../host/secrets/index.js';
import {
  hostPublicIp,
  readVpnLine,
  VpnLogin,
  type LoginState,
  type VpnCredentials,
  type VpnLine,
} from '../../host/vpn/index.js';
import type { Context } from '../commands/context.js';

export interface VpnReport {
  readonly enabled: boolean;
  readonly provider: VpnProvider;
  readonly protocol: Config['vpn']['protocol'];
  readonly country: string;
  readonly killSwitch: boolean;
  readonly login: LoginState;
  readonly loginSavedAt: string | null;
  /** The running sandbox's tunnel, when one runs with the VPN on. */
  readonly running: VpnLine | null;
}

export class VpnService {
  private readonly login: VpnLogin;

  constructor(
    private readonly ctx: Context,
    secrets?: SecretStore,
  ) {
    this.login = new VpnLogin(ctx.storageRoot, secrets);
  }

  private get config(): Config['vpn'] {
    return this.ctx.loaded.config.vpn;
  }

  get provider(): VpnProvider {
    return this.config.provider;
  }

  /** Without `tunnel` the sandbox is not asked (no request to the network): `running` is then null. */
  async report({ tunnel = true }: { tunnel?: boolean } = {}): Promise<VpnReport> {
    const c = this.config;
    const running = tunnel && isSandboxRunning();
    return {
      enabled: c.enabled,
      provider: c.provider,
      protocol: c.protocol,
      country: c.country,
      killSwitch: c.killSwitch,
      login: this.login.state(c.provider),
      loginSavedAt: this.login.savedAt(c.provider),
      running: running ? readVpnLine(this.ctx.dataPath, await hostPublicIp()) : null,
    };
  }

  loginState(): LoginState {
    return this.login.state(this.provider);
  }

  save(credentials: VpnCredentials): void {
    this.login.save(this.provider, credentials);
  }

  remove(): boolean {
    return this.login.remove(this.provider);
  }
}
