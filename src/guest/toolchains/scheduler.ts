// The one scheduler: its locks span the boot's run and every project's run.
import { warn } from '../runtime/log.js';
import { setSandboxStatus } from '../runtime/status.js';
import { StepScheduler } from './step-scheduler.js';

export { StepScheduler, type RunOptions, type SchedulerSink } from './step-scheduler.js';

export const scheduler = new StepScheduler({
  warn,
  status: (message, progress) => setSandboxStatus('provisioning', message, progress),
});
