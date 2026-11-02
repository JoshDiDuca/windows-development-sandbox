// Service sign-ins kept for sandboxes (accounts.<kind>.share): the sealed store, the one-holder leases, what a launch
// hands over, what a sandbox hands back, and where each kind's sign-in comes from on this PC.
export { accountsDir, ServiceAccountStore, type AccountInfo, type AccountState } from './store.js';
export { AccountLeases, type ClaimResult, type Lease } from './leases.js';
export { prepareServiceAccounts, type AccountDelivery, type DeliveryInput } from './deliver.js';
export { forgetEverywhere, handoffDir, takeHandoffs } from './handoff.js';
export { notAvailableYet, parseRegValue, pcEnv, type HostSource, type PcEnv } from './source.js';
export { HOST_SOURCES } from './sources.js';
