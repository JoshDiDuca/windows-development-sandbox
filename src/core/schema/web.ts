// The web UI settings (sandbox web): not part of LocalOverrides, a repo never turns a way into your agents on.
import { z } from 'zod';

export const WEB_DEFAULT_PORT = 47800;

export const WebSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      '(Beta) The web UI: your sandbox sessions in a browser on this PC (http://127.0.0.1:<port>, this PC only). On: every sandbox start also starts it in the background (it keeps running until sandbox web stop or a restart of the PC). Off: only sandbox web start runs it. Open it signed in with sandbox web open.',
    ),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .describe('Port of the web UI on 127.0.0.1 (this PC only). Pick another when it is taken.'),
  openOnLaunch: z
    .boolean()
    .describe('(Beta) With the web UI on: open it in your browser, already signed in, every time a sandbox starts.'),
});
