// What "heavy load" means, decided once for the host watchdog and the guest governor (pure, no I/O). Every
// protection is on by default; the gentle profile (vGPU on: a graphics driver hang can freeze the whole PC) triggers
// earlier and runs the sandbox with less CPU.

export type LoadProfile = 'normal' | 'gentle';

/**
 * One step of the guest governor's dial. It turns up when available RAM falls below `availablePercent` of the
 * sandbox's RAM, commit rises above `commitPercent` of its limit, or (from step 3) the commit would reach its limit
 * within `secondsToLimit` at the rate it is growing. It turns down one step after `calmSamples` samples in a row that
 * are clear of the step by the margins below.
 */
export interface DialStep {
  readonly availablePercent: number;
  readonly commitPercent: number;
  readonly secondsToLimit?: number;
}

/** Steps 1 to 4 of the dial, per profile (index 0 is step 1). The gentle profile (vGPU on) turns earlier. */
export const DIAL_STEPS: Readonly<Record<LoadProfile, readonly DialStep[]>> = {
  normal: [
    { availablePercent: 15, commitPercent: 80 },
    { availablePercent: 10, commitPercent: 88 },
    { availablePercent: 6, commitPercent: 94, secondsToLimit: 20 },
    { availablePercent: 4, commitPercent: 97, secondsToLimit: 8 },
  ],
  gentle: [
    { availablePercent: 20, commitPercent: 75 },
    { availablePercent: 15, commitPercent: 85 },
    { availablePercent: 8, commitPercent: 92, secondsToLimit: 25 },
    { availablePercent: 5, commitPercent: 96, secondsToLimit: 10 },
  ],
};

/** How clear of a step a sample must be to count as calm: this much more RAM free and this much less commit. */
export const DIAL_EXIT_MARGIN = { availablePercent: 5, commitPercent: 4 } as const;
export const DIAL_CALM_SAMPLES = 3;

/** The CPU share (percent of the sandbox) the compilers get together at each step; 100 = no cap. */
export const DIAL_CPU_RATE: readonly number[] = [100, 100, 60, 35, 15];

/** How many of the compilers running may go on at each step (the rest wait their turn), as a share of them. */
export function compilersAllowed(step: number, running: number): number {
  if (step <= 1 || running <= 1) return running;
  if (step === 2) return Math.max(1, Math.ceil(running * 0.6));
  if (step === 3) return Math.max(1, Math.ceil(running / 3));
  return 1;
}

/** The PC watchdog: when this PC itself is low. */
export interface HostThresholds {
  /** Low when available RAM is below max(this, availableShare of total RAM)... */
  readonly availableMinMb: number;
  readonly availablePercent: number;
  /** ...or available commit is below this share of the commit limit (percent)... */
  readonly commitAvailablePercent: number;
  /** ...or below half the reserveHostMb. Recovered above 1.25 times each limit for `calmSamples` samples. */
  readonly calmSamples: number;
  /** Total CPU above this (percent) for cpuSeconds. */
  readonly cpuPercent: number;
  readonly cpuSeconds: number;
  /** The disks' queue length (all together) at or above this for diskSeconds: builds writing through mapped folders. */
  readonly diskQueue: number;
  readonly diskSeconds: number;
}

export const HOST_THRESHOLDS: Readonly<Record<LoadProfile, HostThresholds>> = {
  normal: {
    availableMinMb: 4096,
    availablePercent: 12,
    commitAvailablePercent: 15,
    calmSamples: 3,
    cpuPercent: 95,
    cpuSeconds: 60,
    diskQueue: 32,
    diskSeconds: 40,
  },
  gentle: {
    availableMinMb: 6144,
    availablePercent: 15,
    commitAvailablePercent: 20,
    calmSamples: 3,
    cpuPercent: 90,
    cpuSeconds: 45,
    diskQueue: 16,
    diskSeconds: 30,
  },
};

/** The CPU cap (percent of the PC) the gentle profile uses: 15 points lower, never below 50. "none" = 100. */
export function gentleCpuLimit(cpuLimit: 'none' | number): number {
  return Math.max(50, (cpuLimit === 'none' ? 100 : cpuLimit) - 15);
}

/** The CPU cap the sandbox runs with (percent; null = none) for a profile. */
export function effectiveCpuLimit(cpuLimit: 'none' | number, profile: LoadProfile): number | null {
  if (profile === 'gentle') return Math.min(gentleCpuLimit(cpuLimit), cpuLimit === 'none' ? 100 : cpuLimit);
  return cpuLimit === 'none' ? null : cpuLimit;
}

/**
 * The build budget of the whole sandbox: how many compile jobs fit together (about 3 GB each after 6 GB for Windows,
 * the agents and their tools), never more than the processors the sandbox may use. The governor slows them down when
 * memory runs short anyway; this keeps builds from starting far more than fits.
 */
export function buildJobs(cpus: number, memoryGb: number): number {
  return Math.max(2, Math.min(cpus, Math.floor((memoryGb - 6) / 3)));
}

/** Links that may run at once in the whole sandbox ("auto"): one per 3 GB after 6 GB, 2 to 8. */
export function linkSlotsFor(memoryGb: number): number {
  return Math.max(2, Math.min(8, Math.floor((memoryGb - 6) / 3)));
}

/** The processors the sandbox's programs may use with a CPU cap of `percent` (affinity): at least 2. */
export function usableCpus(cpus: number, percent: number | null): number {
  if (percent === null || percent >= 100) return cpus;
  return Math.max(2, Math.min(cpus, Math.floor((cpus * percent) / 100)));
}

/** Cargo jobs for one more agent session: what fits the memory and CPUs, shared with the sessions already building. */
export function cargoJobs(cpus: number, memoryGb: number, sessions: number): number {
  const byCpu = Math.max(2, Math.min(8, Math.floor(cpus / 4)));
  const byMemory = Math.max(1, Math.floor(memoryGb / 4));
  const jobs = Math.min(byCpu, byMemory);
  return Math.max(1, Math.min(jobs, Math.floor(buildJobs(cpus, memoryGb) / Math.max(1, sessions))));
}

/** The most heavy compilers (rustc, clippy-driver, link ...) that run at once in the agents' job: only with vGPU on. */
export function maxCompilers(cpus: number, profile: LoadProfile): number | null {
  return profile === 'gentle' ? Math.max(2, Math.floor(cpus / 4)) : null;
}
