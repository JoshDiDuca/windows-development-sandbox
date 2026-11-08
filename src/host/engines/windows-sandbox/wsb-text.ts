// The .wsb file Windows Sandbox starts from: memory, devices and the folders mapped in, written from a LaunchPlan.
import { xmlEscape } from '../../../core/util/index.js';
import { sandboxFolder } from '../../../shared/paths/index.js';
import type { LaunchPlan } from '../types.js';

function element(name: string, value: string): string {
  return '<' + name + '>' + value + '</' + name + '>';
}
function toggle(value: boolean): string {
  return value ? 'Enable' : 'Disable';
}

export function wsbText(plan: LaunchPlan): string {
  const d = plan.devices;
  // Guest paths on other drive letters (F:\x) really live under C:\Mirror\F; bootstrap.ps1 substs F: onto it at boot.
  const folders = plan.mappings
    .map((m) =>
      element(
        'MappedFolder',
        element('HostFolder', xmlEscape(m.host)) +
          element('SandboxFolder', xmlEscape(sandboxFolder(m.guest))) +
          element('ReadOnly', String(m.readOnly)),
      ),
    )
    .join('');
  // The elements are in the order Windows Sandbox expects.
  return element(
    'Configuration',
    element('MemoryInMB', String(plan.memoryMb)) +
      element('vGPU', toggle(d.gpu)) +
      element('Networking', toggle(plan.networking)) +
      element('ClipboardRedirection', toggle(d.sharedClipboard)) +
      element('AudioInput', toggle(d.audioInput)) +
      element('VideoInput', toggle(d.videoInput)) +
      element('PrinterRedirection', toggle(d.printers)) +
      element('ProtectedClient', toggle(d.protectedClient)) +
      element('MappedFolders', folders) +
      element('LogonCommand', element('Command', xmlEscape(plan.logonCommand))),
  );
}
