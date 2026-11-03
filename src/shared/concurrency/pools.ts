// The three pools (one set per process): the limiter instances only, so pure code can take a slot. The guest wires
// them to the downloader and extractor (guest/runtime/pools.ts installPools).
import { Limiter } from './limiter.js';

/** HTTP bodies. */
export const net = new Limiter(4, 'net');
/** extractArchive, 7-Zip/NSIS unpack, npm ci/install, uv/pip, Steam, robocopy of big layouts, rustup/cargo. */
export const heavy = new Limiter(2, 'heavy');
/** Every msiexec, vcredist, DXSETUP and the Visual Studio bootstrapper: Windows runs one install at a time. */
export const installer = new Limiter(1, 'installer');
