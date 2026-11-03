// Modding apps (P5): Lua tooling for FiveM / RedM resources (lua-language-server, StyLua, selene). Entries of the apps
// catalogue, pure data like catalogue.ts (which lists them); each is a GitHub release checked against the SHA-256
// GitHub publishes for it. CodeWalker is not here: it has no download that can be fetched and checked (it is shared on
// its author's Discord); docs/fivem.md says how to use it with the game mapped read-only from pcInstalls.
import type { AppEntry } from './catalogue.js';

export const MODDING_APPS: readonly AppEntry[] = [
  {
    id: 'lua-language-server',
    name: 'Lua Language Server',
    category: 'cli',
    about:
      'The Lua language server (LuaLS): completion, diagnostics and go-to-definition for Lua in editors and agents that speak LSP. FiveM resources use Lua 5.4 (lua54 in fxmanifest.lua).',
    size: '15 MB',
    source: { github: 'LuaLS/lua-language-server', asset: '^lua-language-server-[\\d.]+-win32-x64\\.zip$' },
    exe: 'lua-language-server.exe',
    cli: true,
  },
  {
    id: 'stylua',
    name: 'StyLua',
    category: 'cli',
    about: 'An opinionated Lua formatter (`stylua .`), configured with a stylua.toml in the project.',
    size: '6 MB',
    source: { github: 'JohnnyMorganz/StyLua', asset: '^stylua-windows-x86_64\\.zip$' },
    exe: 'stylua.exe',
    cli: true,
  },
  {
    id: 'selene',
    name: 'selene',
    category: 'cli',
    about:
      'A Lua linter (`selene .`), configured with a selene.toml (std = "lua54", and a standard library file for the FiveM / RedM globals).',
    size: '7 MB',
    source: { github: 'Kampfkarren/selene', asset: '^selene-[\\d.]+-windows\\.zip$' },
    exe: 'selene.exe',
    cli: true,
  },
];
