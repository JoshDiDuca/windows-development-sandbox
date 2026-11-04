// What the sandbox last found for Unreal (tools\unreal\status.json): its engines, which engine each project builds
// with, the Epic Games Launcher's install folder, Visual Studio, the debuggers and the derived data cache. The sandbox
// writes it every boot and when a project joins; the Unreal page on this PC reads it. It is written by the guest, so
// the host reads it with this schema (bounded strings and lists) and prints its text through safeText.
import { z } from 'zod';

/** The file in tools\unreal. */
export const UNREAL_STATUS_FILE = 'status.json';

const Text = (max = 400) => z.string().max(max);

export const UnrealStatusSchema = z.object({
  updatedAt: Text(40),
  engines: z
    .array(
      z.object({
        id: Text(100),
        dir: Text(),
        version: Text(40),
        build: z.enum(['installed', 'source']),
        origin: z.enum(['pc', 'pc-folder', 'launcher', 'data', 'project']),
        writable: z.boolean(),
        /** Its size on disk, when it was counted (the launcher's manifest says it). */
        sizeBytes: z.number().int().min(0).nullable(),
      }),
    )
    .max(32),
  projects: z
    .array(
      z.object({
        workspace: Text(),
        /** The engine's folder, null when there is none for it. */
        engine: Text().nullable(),
        reason: Text(),
      }),
    )
    .max(64),
  launcher: z.object({
    installed: z.boolean(),
    /** Where the launcher installs engines; null when it could not be set. */
    installLocation: Text().nullable(),
    /** Why engines would not go to the data disk (shown loudly), null when they do. */
    problem: Text(600).nullable(),
    freeBytes: z.number().min(0).nullable(),
    needBytes: z.number().min(0),
  }),
  visualStudio: z.object({
    version: Text(60),
    path: Text(),
    /** "kept on the data disk", "installed" ... ('' when there is none). */
    how: Text(100),
    /** What UnrealBuildTool's way of looking finds (the Setup API, MSVC, the Windows SDK), in plain words. */
    check: Text(600),
    /** Whether that check found everything a build needs. */
    ok: z.boolean(),
  }),
  /** cdb.exe of the Windows SDK's debuggers, null when they are missing. */
  debugger: Text().nullable(),
  ddc: z.object({ mode: z.enum(['persisted', 'local']), dir: Text().nullable() }),
  /** The editor's MCP server address when the project's engine has the plugin. */
  mcpUrl: Text(200).nullable(),
});
export type UnrealStatus = z.output<typeof UnrealStatusSchema>;
