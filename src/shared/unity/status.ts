// What the sandbox last found for Unity (tools\unity\status.json): the CLI, the editors, which editor each project
// opens with, the licence, the Asset Store cache. The sandbox writes it; the Unity page on this PC reads it with this
// schema (bounded strings and lists) and prints its text through safeText.
import { z } from 'zod';

/** The file in tools\unity. */
export const UNITY_STATUS_FILE = 'status.json';

const Text = (max = 400) => z.string().max(max);

export const UnityStatusSchema = z.object({
  updatedAt: Text(40),
  cli: z.object({ version: Text(40), path: Text() }).nullable(),
  editors: z
    .array(
      z.object({
        version: Text(40),
        root: Text(),
        origin: z.enum(['pc', 'data']),
        writable: z.boolean(),
        modules: z.array(Text(60)).max(20),
        sizeBytes: z.number().int().min(0).nullable(),
      }),
    )
    .max(32),
  projects: z
    .array(
      z.object({
        workspace: Text(),
        /** The version its ProjectVersion.txt asks for. */
        version: Text(40).nullable(),
        /** The root of the editor it opens with, null when there is none for it. */
        editor: Text().nullable(),
        reason: Text(),
        bridge: z.enum(['pipeline', 'coplay']).nullable(),
      }),
    )
    .max(64),
  licence: z.object({
    state: z.enum(['active', 'none', 'invalid', 'unknown']),
    kind: Text(60),
    detail: Text(),
    user: Text(256).nullable(),
  }),
  assetCache: z.object({ mode: z.enum(['persisted', 'pc', 'local']), dir: Text().nullable() }),
  pcAssets: z.array(Text()).max(4),
  hub: z.object({ installed: z.boolean(), path: Text().nullable() }),
  /** The MCP server's name when it was registered. */
  mcp: Text(100).nullable(),
  skills: z.boolean(),
  problem: Text(600).nullable(),
});
export type UnityStatus = z.infer<typeof UnityStatusSchema>;
