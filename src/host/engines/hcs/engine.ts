// The HCS engine (alpha): a Hyper-V isolated Windows container for agents, behind the SandboxEngine interface.
// plan() is pure and tested; start() is DISABLED until the owner's go/no-go test (docs/design/engines.md) has passed
// on a real PC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { fail, UserError } from '../../../core/util/index.js';
import { selfTestRunning } from '../../test-guard.js';
import type { SandboxEngine } from '../engine.js';
import type { EngineCapabilities, EngineCheck, EnginePlan, LaunchPlan, RunningSandbox } from '../types.js';
import { checkHcs, realHcsProbes, type HcsProbes } from './check.js';
import { buildDocuments, HCS_OWNER, type HcsImage } from './documents.js';
import { HcsHelper, hcsHostExe, isMySystemId, userSystemPrefix } from './helper.js';
import { findImage } from './images.js';

export const HCS_CAPABILITIES: EngineCapabilities = {
  desktop: false,
  gpu: false,
  clipboard: false,
  audio: false,
  video: false,
  printers: false,
  liveFolderAdd: true,
  attachedDisks: true,
  multipleInstances: true,
  hvsocket: true,
};

export const HCS_ALPHA_MESSAGE =
  'The HCS engine is in alpha and starting it is not enabled yet; see docs/design/engines.md';
export const HCS_FLAG = 'AGENT_SANDBOX_HCS_EXPERIMENTAL';

/** Starting is allowed only with the owner's flag, and never inside the self-test. */
export function hcsStartEnabled(env: NodeJS.ProcessEnv, selfTest: boolean): boolean {
  return env[HCS_FLAG] === '1' && !selfTest;
}

const PlanFileSchema = z.object({
  version: z.literal(1),
  uvmId: z.string().regex(/^agent-sandbox-[A-Za-z0-9._-]{1,100}$/),
  containerId: z.string().regex(/^agent-sandbox-[A-Za-z0-9._-]{1,100}$/),
  uvmFile: z.string(),
  containerFile: z.string(),
  scratchVhdx: z.string(),
  disks: z.array(z.object({ image: z.string(), maxGb: z.number().int().min(1).max(4096), lun: z.number().int() })),
  logonCommand: z.string(),
  notes: z.array(z.string()),
});
type PlanFile = z.infer<typeof PlanFileSchema>;

const SystemListSchema = z.array(z.object({ Id: z.string(), Owner: z.string().optional() }).passthrough());

export interface HcsEngineDeps {
  readonly helper?: HcsHelper;
  readonly env?: NodeJS.ProcessEnv;
  /** Inside the self-test, starting is refused whatever the flag says. */
  readonly selfTest?: () => boolean;
  readonly hostCpus?: () => number;
  readonly exists?: (file: string) => boolean;
}

export class HcsEngine implements SandboxEngine {
  readonly id = 'hcs';

  /** `image` and `probes` come from the check (see HcsEngine.open); `storageRoot` is where HcsHost.exe is built. */
  constructor(
    private readonly image: HcsImage | null,
    private readonly probes: HcsProbes,
    private readonly storageRoot: string,
    private readonly deps: HcsEngineDeps = {},
  ) {}

  /** The engine for this PC when its check passes; otherwise a clear stop with the check's reasons and fixes. */
  static async open(
    storageRoot: string,
    probes: HcsProbes = realHcsProbes(),
    deps: HcsEngineDeps = {},
  ): Promise<HcsEngine> {
    const check = checkHcs(probes);
    if (!check.available)
      fail('The HCS engine cannot run on this PC: ' + check.reasons.join(' '), 'Fix: ' + check.fixes.join(' | '));
    return new HcsEngine(findImage(probes.imageStores()).image, probes, storageRoot, deps);
  }

  capabilities(): EngineCapabilities {
    return HCS_CAPABILITIES;
  }

  check(): Promise<EngineCheck> {
    return Promise.resolve(checkHcs(this.probes));
  }

  plan(launch: LaunchPlan): EnginePlan {
    if (!this.image) fail('No base image is available for the HCS engine.', 'Run: sandbox engine check hcs');
    const slug = path.basename(launch.launchPath).replace(/[^A-Za-z0-9._-]/g, '-');
    const dir = path.join(launch.launchPath, 'hcs');
    const scratchVhdx = path.join(dir, 'scratch.vhdx');
    const docs = buildDocuments({
      launch,
      image: this.image,
      id: userSystemPrefix() + slug,
      scratchVhdx,
      hostCpus: (this.deps.hostCpus ?? (() => os.cpus().length))(),
    });
    const planFile: PlanFile = {
      version: 1,
      uvmId: docs.uvmId,
      containerId: docs.containerId,
      uvmFile: path.join(dir, 'uvm.json'),
      containerFile: path.join(dir, 'container.json'),
      scratchVhdx,
      disks: [...docs.disks],
      logonCommand: launch.logonCommand,
      notes: [...docs.notes],
    };
    const entry = path.join(dir, 'plan.json');
    const pretty = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
    return {
      engine: this.id,
      entry,
      files: [
        { path: planFile.uvmFile, text: pretty(docs.uvm) },
        { path: planFile.containerFile, text: pretty(docs.container) },
        { path: entry, text: pretty(planFile) },
      ],
    };
  }

  private helper(): HcsHelper {
    return this.deps.helper ?? new HcsHelper(() => hcsHostExe(this.storageRoot));
  }

  async start(plan: EnginePlan): Promise<RunningSandbox> {
    const enabled = hcsStartEnabled(this.deps.env ?? process.env, (this.deps.selfTest ?? selfTestRunning)());
    if (!enabled) fail(HCS_ALPHA_MESSAGE);
    const file = PlanFileSchema.parse(JSON.parse(fs.readFileSync(plan.entry, 'utf8')));
    const exists = this.deps.exists ?? fs.existsSync;
    const helper = this.helper();
    const disks = [...file.disks.map((d) => d.image), file.scratchVhdx];
    for (const d of file.disks) if (!exists(d.image)) helper.createVhdx(d.image, d.maxGb);
    // The writable layer is made by HcsInitializeWritableLayer, which this phase does not have.
    if (!exists(file.scratchVhdx)) fail('The writable layer of this sandbox has not been prepared (not built yet).');
    const created: string[] = [];
    try {
      for (const disk of disks) helper.grantVmAccess(file.uvmId, disk);
      helper.create(file.uvmId, fs.readFileSync(file.uvmFile, 'utf8'));
      created.push(file.uvmId);
      helper.start(file.uvmId);
      helper.create(file.containerId, fs.readFileSync(file.containerFile, 'utf8'));
      created.push(file.containerId);
      helper.start(file.containerId);
    } catch (e) {
      for (const id of created.reverse()) this.tryTerminate(helper, id);
      throw e;
    }
    return { id: file.uvmId, engine: this.id, started: Date.now() };
  }

  private tryTerminate(helper: HcsHelper, id: string): void {
    try {
      helper.terminate(id);
    } catch (e) {
      if (!(e instanceof UserError)) throw e; // a system that is already gone is fine
    }
  }

  /** Ours: the compute systems the helper lists with our owner name and this Windows user's id prefix. */
  private ours(helper: HcsHelper): string[] {
    const parsed = SystemListSchema.safeParse(JSON.parse(helper.enumerate().json || '[]'));
    return parsed.success
      ? parsed.data.filter((s) => s.Owner === HCS_OWNER && isMySystemId(s.Id)).map((s) => s.Id)
      : [];
  }

  running(): Promise<boolean> {
    try {
      return Promise.resolve(this.ours(this.helper()).length > 0);
    } catch {
      return Promise.resolve(false); // no helper or no service: nothing of ours can be running
    }
  }

  stop(): Promise<void> {
    const helper = this.helper();
    // The container goes before the machine that hosts it.
    const ids = this.ours(helper).sort((a, b) => Number(b.endsWith('-c')) - Number(a.endsWith('-c')));
    for (const id of ids) this.tryTerminate(helper, id);
    return Promise.resolve();
  }
}
