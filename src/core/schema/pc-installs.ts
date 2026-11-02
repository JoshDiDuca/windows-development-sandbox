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
    unrealEngines: pick(
      z.string().regex(/^(UE_)?\d+\.\d+$/),
      'Unreal Engine versions installed with the Epic Games Launcher',
      '["5.4"]',
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
