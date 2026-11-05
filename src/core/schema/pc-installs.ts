// pcInstalls: games, engines and editors already installed on this PC, mapped read-only into the sandbox (nothing is
// copied). Yours only: a project file can never map folders of this PC.
import { z } from 'zod';

const pick = <T extends z.ZodType>(item: T, what: string, example: string) =>
  z
    .union([z.boolean(), z.array(item)])
    .describe(
      what +
        ' of this PC, read-only in the sandbox under C:\\PcInstalls: true = all of them, false = none, or a list (e.g. ' +
        example +
        '). The agent can read their files.',
    );

export const PcInstallsSchema = z
  .strictObject({
    steamGames: pick(
      z.number().int().positive(),
      'Steam games (true maps each library; a list of app IDs maps only those games)',
      '[480, 730]',
    ),
    epicGames: pick(
      z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
      'Epic Games Launcher games (by their app name)',
      '["Fortnite"]',
    ),
    unrealEngines: z
      .union([z.literal('auto'), z.boolean(), z.array(z.string().regex(/^(UE_)?\d+\.\d+$/))])
      .describe(
        'Unreal Engine versions installed on this PC (with the Epic Games Launcher, or source builds it lists), read-only in the sandbox under C:\\PcInstalls\\unreal and registered there, so projects build with them without a download. "auto" = all of them whenever the sandbox is set up for Unreal, true = always, false = never, or a list (e.g. ["5.4"]).',
      ),
    unrealEngineFolders: z
      .array(z.string().min(3).max(260))
      .max(8)
      .describe(
        'Unreal Engine folders of this PC to use in the sandbox, writable (a source build, or a copy you build plugins into): each must hold Engine\\Build\\Build.version. Mapped under C:\\PcInstalls\\unreal and registered there.',
      ),
    unrealAssets: z
      .union([z.literal('auto'), z.boolean()])
      .describe(
        'The Epic Games Launcher\'s vault cache of this PC (the Fab and Marketplace packs you downloaded), read-only in the sandbox at C:\\PcInstalls\\unreal\\Vault: what you download on your PC is there for the agents at once. "auto" = whenever the sandbox is set up for Unreal, true = always, false = never.',
      ),
    unityEditors: pick(
      z.string().regex(/^\d+\.\d+\.\d+[abfp]\d+$/),
      'Unity editors installed with Unity Hub',
      '["6000.0.32f1"]',
    ),
  })
  .describe(
    "Games, engines and editors installed on this PC, mapped read-only into sandboxes (no copy, no room on the sandbox's disk).",
  );
