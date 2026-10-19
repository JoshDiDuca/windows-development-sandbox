import path from 'node:path';
import { z } from 'zod';
import type { Config, Overrides, ToolVersions, VersionSpec } from '../types.js';
import { fileExists, readSmallFile } from '../util/index.js';

/** A version spec as version files hold it (20, lts/iron, 3.12.1, v18.*): anything else is ignored, never printed. */
const VERSION_SPEC = /^[\w./*~^-]{1,64}$/;

const firstLine = (file: string): string | null => {
  const text = fileExists(file) ? readSmallFile(file, 64 * 1024) : null;
  if (text === null) return null;
  const line = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l: string) => l.replace(/#.*$/, '').trim())
    .find((l: string) => l !== '');
  return line !== undefined && VERSION_SPEC.test(line) ? line : null;
};

const VOLTA_PIN = 'package.json volta.node';
const PackageJsonSchema = z.object({
  volta: z
    .object({
      node: z
        .string()
        .regex(/^\d+(\.\d+){0,2}$/)
        .optional(),
    })
    .optional(),
});

/**
 * The Node version a Volta project pins ("volta": { "node": "20.11.1" } in package.json), so nvm defaults to it too.
 */
export function voltaNode(workspace: string): string | null {
  const file = path.join(workspace, 'package.json');
  if (!fileExists(file)) return null;
  try {
    return (
      PackageJsonSchema.safeParse(JSON.parse((readSmallFile(file, 4 * 1024 * 1024) ?? '').replace(/^\uFEFF/, ''))).data
        ?.volta?.node ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Picks tool versions. Highest priority first: command line, the folder's .sandbox-config.json,
 * version files in the workspace (.nvmrc, .node-version, .python-version), the tool config, this PC's node version.
 */
export function resolveVersions(
  config: Config,
  workspace: string,
  local: Overrides,
  req: { nodeVersion?: string; pythonVersion?: string },
  hostNodeVersion: string,
): ToolVersions {
  const localTools = (local.toolchains ?? {}) as { node?: { version?: string }; python?: { version?: string } };
  const pick = (
    cli: string | undefined,
    localValue: string | undefined,
    files: string[],
    configured: string,
  ): VersionSpec => {
    if (cli) return { spec: cli, source: 'command line' };
    if (localValue) return { spec: localValue, source: '.sandbox-config.json' };
    for (const name of files) {
      const value = name === VOLTA_PIN ? voltaNode(workspace) : firstLine(path.join(workspace, name));
      if (value) return { spec: value, source: name };
    }
    return { spec: configured, source: 'config' };
  };
  let node = pick(
    req.nodeVersion,
    localTools.node?.version,
    ['.nvmrc', '.node-version', VOLTA_PIN],
    config.toolchains.node.version,
  );
  if (node.spec === 'host') node = { spec: hostNodeVersion.replace(/^v/, ''), source: 'this PC' };
  const python = pick(
    req.pythonVersion,
    localTools.python?.version,
    ['.python-version'],
    config.toolchains.python.version,
  );
  return { node, nodeExtra: config.toolchains.node.extraVersions, python };
}
