// Writes the HCS documents our code generates for a small plan, from the Server Core image Docker has pulled, so
// Test-HcsLifecycle.ps1 can drive HcsHost.exe with them. Needs `npm run build` first. Writes only under <outDir>.
// Usage: node export-documents.mjs <outDir> <id>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [outDir, id] = process.argv.slice(2);
if (!outDir || !id || !path.isAbsolute(outDir)) {
  console.error('Usage: node export-documents.mjs <absolute outDir> <id>');
  process.exit(2);
}
const dist = path.resolve(import.meta.dirname, '..', '..', '..', 'dist', 'host', 'engines', 'hcs');
const { DockerImageStore } = await import(pathToFileURL(path.join(dist, 'images.js')).href);
const { buildDocuments } = await import(pathToFileURL(path.join(dist, 'documents.js')).href);

const found = new DockerImageStore().find();
if (!found.image) {
  console.error('No image: ' + found.reason);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const disk = path.join(outDir, 'agent.vhdx');
const scratch = path.join(outDir, 'scratch.vhdx');
const docs = buildDocuments({
  launch: {
    launchPath: outDir,
    memoryMb: 2048,
    cpuLimit: 'none',
    networking: false,
    devices: {
      gpu: false,
      clipboard: false,
      audioInput: false,
      videoInput: false,
      printers: false,
      protectedClient: true,
    },
    mappings: [],
    logonCommand: 'cmd.exe /c exit 0',
    storage: [{ kind: 'disk', image: disk, guest: 'C:\\AgentData', maxGb: 1 }],
  },
  image: found.image,
  id,
  scratchVhdx: scratch,
  hostCpus: 2,
});
fs.writeFileSync(path.join(outDir, 'uvm.json'), JSON.stringify(docs.uvm));
fs.writeFileSync(path.join(outDir, 'container.json'), JSON.stringify(docs.container));
const plan = { uvmId: docs.uvmId, containerId: docs.containerId, disks: [disk, scratch], layers: found.image.layers };
fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan));
