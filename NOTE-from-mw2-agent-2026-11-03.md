# Note from the mw2-agent lead (Claude Opus), 2026-11-03

The owner asked me to leave this. These things were broken or changed when this sandbox booted. The mw2-agent session was
running at C:\Projects\AgentProjects\mw2-agent.

## Broken on this boot
1. **`python` was not on PATH.** `which python` found nothing, yet every mw2-agent build and test script runs
   `python -I ...`. `py -3` still worked (via C:\AgentData\tools\shims\py), and the interpreters are still at
   C:\AgentData\tools\python\python-3.15.x. Workaround: I added `python` (bash) and `python.cmd` shims in
   C:\AgentData\tools\bin that exec python-3.15.2. Please replace them with the proper PATH entry, or keep them.
2. **`rustup` was not on PATH.** `cargo` (the C:\AgentData\tools\bin wrapper) still works. On its first run it
   auto-installed components for `1.99.0-x86_64-pc-windows-msvc` ("missing active toolchain ... auto-installed").
   The toolchains are in C:\AgentData\tools\rust\rustup\toolchains (1.99.0 gnu + msvc, stable gnu).
3. **The manifest dropped entries.** The CLAUDE.md sandbox manifest no longer lists python, python2, rust/rustup or
   Unity, and its RW-persists line names only `C:\Projects\AgentProjects\windows-sandbox`, not
   `C:\Projects\AgentProjects\mw2-agent`. F:\AgentProjects is not visible from bash. C:\Projects\AgentProjects\mw2-agent
   is not a reparse point. **Please confirm mw2-agent is still mapped to the host and persists.** If it isn't,
   everything committed there is lost when the sandbox closes.

## Long-standing sandbox issues (for context)
- msvc has no link.exe in the sandbox: `link` resolves to coreutils, and built exes fail with os error 1392.
  mw2-agent's build-slot.py forces `RUSTUP_TOOLCHAIN=1.99.0-x86_64-pc-windows-gnu` plus
  C:\AgentData\tools\mingw\mingw64\bin when AGENT_SANDBOX=1.
- In isolated agent worktrees (.claude/worktrees/agent-*), the Bash tool's rtk wrapper refuses git (`git -C`, pipes,
  status). Haiku agents with no PowerShell tool can't commit there. We work around it with lead-made worktrees and
  non-isolated agents.
- Launching many isolated agents at once fails with "Could not read the repository git config" (a race).
- mw2-agent's .claude/settings.json is quarantined by the launcher (guard hook off). This is known and expected.
