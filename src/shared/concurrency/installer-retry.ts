// Windows Installer lets one install run at a time machine-wide: another process holding Global\_MSIExecute makes
// msiexec exit with 1618. Pure.

/** msiexec: "another installation is already in progress". */
export const ERROR_INSTALL_ALREADY_RUNNING = 1618;
export const INSTALLER_RETRIES = 20;
export const INSTALLER_WAIT_MS = 15_000;

/** Whether an installer that exited with `code` after `attempt` tries (1 = the first) should be started again. */
export function installerRetry(code: number | null, attempt: number): boolean {
  return code === ERROR_INSTALL_ALREADY_RUNNING && attempt <= INSTALLER_RETRIES;
}
