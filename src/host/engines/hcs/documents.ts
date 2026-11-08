// Pure: the HCS compute-system documents (schema 2.x JSON) for a Hyper-V isolated Windows container, from a
// LaunchPlan.
//
// Two documents, as hcsshim does it for a container with Hyper-V isolation:
//   1. the utility VM: ComputeSystem { VirtualMachine { Chipset, ComputeTopology,
//      Devices { Scsi, VirtualSmb, HvSocket }, GuestConnection } }
//   2. the container inside it: ComputeSystem { HostingSystemId, HostedSystem { Container { GuestOs, Storage, Memory,
//      MappedDirectories, HvSocket } } }
//
// Schema reference used (learn.microsoft.com/virtualization/api/hcs/schemareference), field names and casing taken
// from these tables: ComputeSystem, VirtualMachine, Topology, VirtualMachine_Memory, VirtualMachine_Processor,
// Devices, Scsi, Attachment (AttachmentType "VirtualDisk", CachingMode), VirtualSmb, VirtualSmbShare,
// VirtualSmbShareOptions, VirtualMachine_HvSocket, HvSocketSystemConfig, Chipset, Uefi, UefiBootEntry,
// GuestConnection, HostedSystem, Container, GuestOs, Container_Memory, Layer (PathType "VirtualSmbShareName"),
// MappedDirectory (HostPathType), Container_HvSocket, Version.
//
// NOT verified (each is marked [U] where it is used, and listed in the report):
//   - the boot entry of the utility VM and the "os" share of the base layer's UtilityVM\Files (hcsshim from memory);
//   - the order of the layers (topmost first here);
//   - where a SCSI disk appears inside the utility VM and how a blank VHDX becomes a formatted volume there;
//   - the scratch layer (a writable layer VHDX made by HcsInitializeWritableLayer: not built in this phase);
//   - that Layers / MappedDirectories may name vSMB shares by share name (the PathType values exist in the schema).
import crypto from 'node:crypto';
import type { LaunchPlan } from '../types.js';

export const HCS_OWNER = 'agent-sandbox';
/** Schema 2.1 is the first with VirtualSmb options, SCSI caching and Layer.PathType (Windows 10 1809). */
const SCHEMA = { Major: 2, Minor: 1 } as const;
/** The Container's Windows-side folder for the agent disk's own sub-folders. */
export const AGENT_DISK_FOLDERS = ['tools', 'state', 'logs'] as const;
const GUEST_DATA = 'C:\\AgentData';
/** Placeholder SDDL: SYSTEM and Administrators only. [U] whether this ACL is what the host side of HvSocket needs. */
const HVSOCKET_SDDL = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)';

export type HcsDocument = Readonly<Record<string, unknown>>;

/** A base image already on this PC. Layers are the folders of the image, base layer first. */
export interface HcsImage {
  readonly id: string;
  /** Folders of the image layers, base first. */
  readonly layers: readonly string[];
  /** The base layer's UtilityVM\Files folder (the kernel and files of the utility VM). */
  readonly utilityVmFiles: string;
}

export interface HcsDocumentInput {
  readonly launch: LaunchPlan;
  readonly image: HcsImage;
  /** The utility VM's id; the container's is `<id>-c`. [a-zA-Z0-9._-] only. */
  readonly id: string;
  /** The writable layer (scratch) VHDX of this run: made before start, deleted after. */
  readonly scratchVhdx: string;
  /** Processors of this PC, to turn a CPU percentage into a count. */
  readonly hostCpus: number;
}

export interface HcsDiskPlan {
  readonly image: string;
  readonly maxGb: number;
  readonly lun: number;
}

export interface HcsDocuments {
  readonly uvmId: string;
  readonly containerId: string;
  readonly uvm: HcsDocument;
  readonly container: HcsDocument;
  /** The agent disks (read-write) to create, give the utility VM access to and attach. */
  readonly disks: readonly HcsDiskPlan[];
  /** Things the plan asked for that this engine does not do (shown to the user). */
  readonly notes: readonly string[];
}

/** A GUID made from a path, so a layer has the same id every time. [U] hcsshim names layers the same way. */
export function layerGuid(folder: string): string {
  const h = crypto.createHash('sha1').update(folder.toLowerCase()).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '5' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-');
}

export function containerId(uvmId: string): string {
  return uvmId + '-c';
}

/** Processors for a percentage of this PC ('none' = all of them), at least one. */
export function cpuCount(limit: LaunchPlan['cpuLimit'], hostCpus: number): number {
  if (limit === 'none') return Math.max(1, hostCpus);
  return Math.min(Math.max(1, hostCpus), Math.max(1, Math.ceil((hostCpus * limit) / 100)));
}

const hvSocketConfig = {
  DefaultBindSecurityDescriptor: HVSOCKET_SDDL,
  DefaultConnectSecurityDescriptor: HVSOCKET_SDDL,
  ServiceTable: {},
} as const;

export function buildDocuments(input: HcsDocumentInput): HcsDocuments {
  const { launch, image } = input;
  const notes: string[] = [];
  const uvmId = input.id;
  const baseLayers = [...image.layers].reverse(); // topmost first [U]

  // Utility VM shares: the OS files, each image layer, then the folders shared in.
  const shares: Record<string, unknown>[] = [
    {
      Name: 'os',
      Path: image.utilityVmFiles,
      // [U] the options hcsshim gives the OS share of a Windows utility VM.
      Options: { ReadOnly: true, ShareRead: true, CacheIo: true, TakeBackupPrivilege: true, PseudoOplocks: true },
    },
  ];
  const layers = baseLayers.map((folder, i) => {
    const name = 'layer' + i;
    shares.push({ Name: name, Path: folder, Options: { ReadOnly: true, ShareRead: true, NoDirectmap: true } });
    return { Id: layerGuid(folder), Path: name, PathType: 'VirtualSmbShareName' };
  });
  const folderMaps: Record<string, unknown>[] = [];
  launch.mappings.forEach((m, i) => {
    const name = 'dir' + i;
    // NoDirectmap on every folder shared in: no direct file mapping into the guest.
    shares.push({ Name: name, Path: m.host, Options: { ReadOnly: m.readOnly, NoDirectmap: true } });
    folderMaps.push({
      HostPath: name,
      HostPathType: 'VirtualSmbShareName',
      ContainerPath: m.guest,
      ReadOnly: m.readOnly,
    });
  });

  // SCSI controller 0: the agent disks (read-write), then the scratch layer.
  const disks: HcsDiskPlan[] = [];
  const attachments: Record<string, unknown> = {};
  const attach = (file: string, readOnly: boolean, lun: number): void => {
    attachments[String(lun)] = { Type: 'VirtualDisk', Path: file, ReadOnly: readOnly, CachingMode: 'Uncached' };
  };
  for (const a of launch.storage) {
    if (a.kind !== 'disk') continue;
    const lun = disks.length;
    disks.push({ image: a.image, maxGb: a.maxGb, lun });
    attach(a.image, false, lun);
    // [U] the disk is formatted and mounted in the utility VM at this folder (a blank VHDX is not formatted yet).
    const volume = 'C:\\agent-disk' + lun;
    const target = a.guest || GUEST_DATA;
    for (const folder of AGENT_DISK_FOLDERS)
      folderMaps.push({
        HostPath: volume + '\\' + folder,
        HostPathType: 'AbsolutePath',
        ContainerPath: target + '\\' + folder,
        ReadOnly: false,
      });
  }
  attach(input.scratchVhdx, false, disks.length);

  if (launch.networking)
    notes.push('Networking is not available in the HCS engine yet: the sandbox has no network adapter.');
  if (launch.devices.gpu || launch.devices.audioInput || launch.devices.videoInput)
    notes.push('GPU, microphone and camera do not exist in the HCS engine.');

  const uvm: HcsDocument = {
    Owner: HCS_OWNER,
    SchemaVersion: SCHEMA,
    // false on purpose: the helper exits after creating the system, which closes its handle; true would end the
    // system at once. Leftovers are found by owner (sandbox engine clean).
    ShouldTerminateOnLastHandleClosed: false,
    VirtualMachine: {
      StopOnReset: true,
      Chipset: {
        // [U] hcsshim's boot entry for a Windows utility VM.
        Uefi: { BootThis: { DeviceType: 'VmbFs', DevicePath: '\\EFI\\Microsoft\\Boot\\bootmgfw.efi' } },
      },
      ComputeTopology: {
        Memory: { SizeInMB: launch.memoryMb, AllowOvercommit: true },
        Processor: { Count: cpuCount(launch.cpuLimit, input.hostCpus) },
      },
      Devices: {
        Scsi: { '0': { Attachments: attachments } },
        VirtualSmb: { Shares: shares },
        // Placeholder: the control channel's service ids are added when the guest side exists.
        HvSocket: { HvSocketConfig: hvSocketConfig },
        // No NetworkAdapters: no network by default.
      },
      GuestConnection: {},
    },
  };

  const container: HcsDocument = {
    Owner: HCS_OWNER,
    SchemaVersion: SCHEMA,
    ShouldTerminateOnLastHandleClosed: false,
    HostingSystemId: uvmId,
    HostedSystem: {
      SchemaVersion: SCHEMA,
      Container: {
        GuestOs: { HostName: 'agent-sandbox' },
        // [U] Path is the scratch layer's folder as the utility VM sees it.
        Storage: { Layers: layers, Path: 'C:\\scratch' },
        Memory: { SizeInMB: launch.memoryMb },
        MappedDirectories: folderMaps,
        HvSocket: { Config: hvSocketConfig },
        // No Networking section: no endpoint.
      },
    },
  };
  return { uvmId, containerId: containerId(uvmId), uvm, container, disks, notes };
}
