// Remote access to the web UI: other Windows users of this PC and devices on the local network
// (docs/design/remote-access.md).
export {
  AccessStore,
  CODE_LIFETIME_MS,
  CODE_MAX_WRONG,
  EMPTY_ACCESS,
  newCode,
  normalizeCode,
  parseCredential,
  secretHash,
  showCode,
  type AccessData,
  type Device,
  type PendingCode,
  type RedeemResult,
  type WindowsGrant,
} from './access-store.js';
export { knockOnDoor, parseDoorAnswer, type DoorAnswer } from './door-client.js';
export { CERT_DAYS, fingerprintOf, makeCertificate, type MadeCertificate } from './cert.js';
export {
  addRuleRequest,
  applyFirewall,
  checkFirewall,
  FIREWALL_RULE_NAME,
  networkProblem,
  networkProfile,
  removeRuleRequest,
  spawnRunner,
  type FirewallOutcome,
  type FirewallRequest,
  type NetworkProfile,
  type Runner,
  type ScriptRun,
} from './firewall.js';
export {
  credentialCookie,
  DEVICE_COOKIE,
  deviceName,
  MAX_WRONG_PER_ADDRESS,
  ONCE_LIFETIME_MS,
  RemoteGate,
  WINDOWS_COOKIE,
  type GateOptions,
  type LanState,
  type RemoteAuditEntry,
  type RouteIO,
} from './gate.js';
export {
  chooseLanAddress,
  isLoopbackIPv4,
  isPrivateIPv4,
  lanPeerProblem,
  lanUrl,
  plainIPv4,
  privateAddresses,
  type Interfaces,
  type LanAddress,
} from './lan.js';
export { TlsStore, type TlsMaterial } from './tls-store.js';
export {
  doorPipeName,
  HostToolsHelper,
  knockProblem,
  parseHelperLine,
  type Connection,
  type Knock,
  type WindowsAccount,
  type WindowsHelper,
} from './windows-helper.js';
