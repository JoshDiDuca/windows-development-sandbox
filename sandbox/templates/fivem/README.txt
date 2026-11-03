Templates for sbx-fivem (docs/fivem.md):
- server.cfg: what `sbx-fivem init` writes into a new server folder. It holds no key: sbx-fivem serve reads the
  Cfx.re key from a cfg on the sandbox's own disk (+exec) before this one.
- lua, js, ts, cs: one folder per language for `sbx-fivem new <resource> --lua | --js | --ts | --cs`.
Placeholders: {{name}} (the resource), {{namespace}} (its name as a C# namespace), {{game}} (gta5 or rdr3) and
{{gameLines}} (the manifest's game lines).
