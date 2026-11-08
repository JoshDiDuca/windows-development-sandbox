// Windows Sandbox behind the engine interface: the .wsb file, and the existing start / wait / running code.
import path from 'node:path';
import type { Config } from '../../../core/types.js';
import { fail, isWin } from '../../../core/util/index.js';
import {
  confirmSandboxStarted,
  findWsb,
  isSandboxRunning,
  sandboxFeatureInstalled,
  startSandbox,
} from '../../sandbox/index.js';
import type { SandboxEngine } from '../engine.js';
import type { EngineCapabilities, EngineCheck, EnginePlan, LaunchPlan, RunningSandbox } from '../types.js';
import { wsbText } from './wsb-text.js';

const WSB_FILE = 'agent.wsb';

export class WindowsSandboxEngine implements SandboxEngine {
  readonly id = 'windows-sandbox';

  /** `hasWsbCli`: whether wsb.exe is on this PC (adding folders to a running sandbox needs it). */
  constructor(
    private readonly sandbox: Config['sandbox'],
    private readonly hasWsbCli: () => boolean = () => findWsb() !== null,
  ) {}

  capabilities(): EngineCapabilities {
    return {
      desktop: true,
      textClipboard: this.sandbox.clipboard !== 'off',
      gpu: this.sandbox.vGpu,
      clipboard: this.sandbox.clipboard === 'shared',
      audio: this.sandbox.audioInput,
      video: this.sandbox.videoInput,
      printers: this.sandbox.printerRedirection,
      liveFolderAdd: this.hasWsbCli(),
      attachedDisks: false,
      multipleInstances: false,
      hvsocket: false,
    };
  }

  check(): Promise<EngineCheck> {
    if (!isWin)
      return Promise.resolve({
        available: false,
        reasons: ['Windows Sandbox only runs on Windows.'],
        fixes: ['Use sandbox generate to only write the files.'],
      });
    if (!sandboxFeatureInstalled())
      return Promise.resolve({
        available: false,
        reasons: ['Windows Sandbox is not enabled on this PC.'],
        fixes: [
          'Run in an admin PowerShell, then reboot: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All  (needs Windows Pro, Enterprise or Education)',
        ],
      });
    return Promise.resolve({ available: true, reasons: [], fixes: [] });
  }

  plan(launch: LaunchPlan): EnginePlan {
    const entry = path.join(launch.launchPath, WSB_FILE);
    return { engine: this.id, files: [{ path: entry, text: wsbText(launch) }], entry };
  }

  async start(plan: EnginePlan): Promise<RunningSandbox> {
    startSandbox(plan.entry);
    await confirmSandboxStarted(plan.entry);
    return { id: path.basename(path.dirname(plan.entry)), engine: this.id, started: Date.now() };
  }

  running(): Promise<boolean> {
    return Promise.resolve(isSandboxRunning());
  }

  stop(): Promise<void> {
    // Windows Sandbox shuts itself down from inside, through the session channel; it is never killed from outside.
    return Promise.resolve().then(() =>
      fail('Windows Sandbox is not stopped from outside.', 'Use sandbox stop (it shuts down from inside).'),
    );
  }
}
