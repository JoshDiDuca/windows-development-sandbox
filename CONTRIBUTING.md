# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Set up

You need Windows 10/11 Pro, Enterprise or Education, and Node.js 22 or newer (CI also tests 22.0.0).

```powershell
git clone https://github.com/JoshDiDuca/windows-development-sandbox
cd windows-development-sandbox
npm ci            # installs and builds
npm test          # must end with ALL TESTS PASSED
```

`npm run build` works anywhere, but `npm test` runs only inside a Windows Sandbox or on GitHub Actions: start one with
`sandbox start` and run it there. Running one suite, and the test helpers: [docs/development.md](docs/development.md#tests).

Developing this tool with an agent inside its own sandbox? Install a copy (`npm run install:global`), never a link
([why](docs/development.md#working-on-it-with-an-agent)).

## Where things are

[CLAUDE.md](CLAUDE.md) has the code layout, the coding standard, the rules and the traps we already fell into. Read it
first. In short:

- **New setting:** the schema in `src/core/schema/`, the default in `DEFAULTS` (`src/core/config/defaults.ts`), then
  `config.example.json` and the docs.
- **New feature or command:** define it once in `src/app/features/<area>` (an operation, query or view with a CLI
  hint), and the command line, the menu and the web UI draw it
  ([shared-core.md](docs/design/shared-core.md#how-to-add-a-feature-walkthrough)). Commands not moved yet live in
  `src/cli/manifest.ts`. Then update [docs/commands.md](docs/commands.md).
- **Every change gets a test** in `src/selftest/`.

## Pull requests

1. Keep each pull request to one change.
2. `npm test` passes, and so do `npm run lint` and `npm run format:check`.
3. The docs and `config.example.json` match the code.
4. Describe what changed and why. Do not bump the version: maintainers do that when releasing.

Security problems: do not open a public issue. See [SECURITY.md](SECURITY.md).
