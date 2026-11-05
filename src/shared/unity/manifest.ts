// Packages/manifest.json and the editor bridge: the package that lets `unity command` / `unity eval` (Unity Pipeline,
// Unity 6 and later) or MCP for Unity (Coplay) drive a running editor. Edited only when the user asks. Pure text.

export const PIPELINE_PACKAGE = 'com.unity.pipeline';
export const COPLAY_PACKAGE = 'com.coplaydev.unity-mcp';
export const COPLAY_PACKAGE_URL = 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.3.0';
/** The Pipeline version added when none is given (0.10 is the one the plan was written against). */
export const DEFAULT_PIPELINE_VERSION = '0.10.0';

export type Bridge = 'pipeline' | 'coplay';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,50})?(\+[0-9A-Za-z.-]{1,50})?$/;

interface ManifestJson {
  dependencies?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseManifest(text: string): ManifestJson {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error('Packages/manifest.json is over 1 MB');
  const json: unknown = JSON.parse(text.replace(/^﻿/, ''));
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    throw new Error('Packages/manifest.json is not an object');
  const m = json as ManifestJson;
  if (
    m.dependencies !== undefined &&
    (typeof m.dependencies !== 'object' || m.dependencies === null || Array.isArray(m.dependencies))
  )
    throw new Error('Packages/manifest.json: dependencies is not an object');
  return m;
}

/** Which bridge the project has, or null (also for a file that is not a manifest). */
export function bridgeOf(text: string): Bridge | null {
  try {
    const deps = parseManifest(text).dependencies ?? {};
    if (PIPELINE_PACKAGE in deps) return 'pipeline';
    if (COPLAY_PACKAGE in deps) return 'coplay';
    return null;
  } catch {
    // Not JSON or not a manifest: no bridge to report.
    return null;
  }
}

/** The manifest with the bridge added or removed: key order, 2-space indent, trailing newline and CRLF kept. */
export function withBridge(text: string, bridge: Bridge, on: boolean, pipelineVersion?: string): string {
  const m = parseManifest(text);
  const name = bridge === 'pipeline' ? PIPELINE_PACKAGE : COPLAY_PACKAGE;
  if (on) {
    const version = pipelineVersion ?? DEFAULT_PIPELINE_VERSION;
    if (bridge === 'pipeline' && !SEMVER.test(version)) throw new Error('not a package version: ' + version);
    const deps = (m.dependencies ??= {});
    deps[name] = bridge === 'pipeline' ? version : COPLAY_PACKAGE_URL;
  } else if (m.dependencies) {
    delete m.dependencies[name];
  }
  const out = JSON.stringify(m, null, 2) + '\n';
  return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
}
