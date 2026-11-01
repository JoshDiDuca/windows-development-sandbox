// "What does this project need?": databases and toolchains detected from project files, and the plans built from them.
import { databasesFromServices, detectDatabases, type ProjectFile } from '../core/detect/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { databaseCatalog, planDatabases } from '../host/launch/index.js';
import { decideToolchains, resolveToolchains } from '../core/detect/index.js';
import type { Suite } from './support/suite.js';

const found = (files: ProjectFile[], host: Parameters<typeof detectDatabases>[1] = []): string[] =>
  detectDatabases(files, host).map((d) => d.database);
const file = (path: string, text: string): ProjectFile => ({ path, text });

export const detectSuite: Suite = {
  name: 'detect',
  title: 'database and toolchain detection from project files',
  run: (t) => {
    t.section('databases from project files');
    const compose = file(
      'docker-compose.yml',
      'services:\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: "redis:7"\n  dynamo:\n    image: amazon/dynamodb-local:latest\n',
    );
    t.equal(
      [
        found([compose]),
        found([file('package.json', '{"dependencies":{"pg":"^8.11.0","ioredis":"5","@aws-sdk/client-dynamodb":"3"}}')]),
        found([file('package.json', '{"dependencies":{"pgadmin-ui":"1","mysql-logger":"2","express":"4"}}')]),
        found([file('prisma/schema.prisma', 'datasource db {\n  provider = "mysql"\n  url = env("X")\n}')]),
        found([file('requirements.txt', 'django==5.0\npsycopg2-binary==2.9\npymongo>=4\n')]),
        found([file('Api/Api.csproj', '<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" />')]),
        found([file('.env.example', 'DATABASE_URL=postgresql://user:pass@localhost:5432/app\nM=mongodb+srv://c/x\n')]),
        found([file('template.yaml', 'Resources:\n  Table:\n    Type: AWS::DynamoDB::Table\n')]),
      ],
      [
        ['postgres', 'redis', 'dynamodb'],
        ['postgres', 'redis', 'dynamodb'],
        [],
        ['mysql'],
        ['postgres', 'mongodb'],
        ['sqlserver'],
        ['postgres', 'mongodb'],
        ['dynamodb'],
      ],
      'databases come from compose images, package.json, Prisma, requirements, .NET, .env templates and SAM; names that only contain a driver name do not count',
    );
    const knex = [file('package.json', '{"dependencies":{"knex":"3"}}')];
    t.equal(
      [
        found(knex),
        found(knex, ['mysql']),
        databasesFromServices(['postgresql-x64-16', 'MySQL80', 'MSSQL$SQLEXPRESS', 'Spooler', 'Redis']),
      ],
      [[], ['mysql'], ['postgres', 'mysql', 'sqlserver', 'redis']],
      'an ORM that names no database uses the one installed on this PC (or none); database services are recognised by name',
    );

    // Hostile workspace files (a cloned repository is untrusted): detection must stay linear.
    const hostile = [
      file('.env', 'Server=a;Database=a;'.repeat(12000)),
      file('compose.yaml', 'services:\n  x:\n    image: ' + 'postgres'.repeat(20000) + '!\n'),
      file('appsettings.json', 'Host=a;'.repeat(30000)),
    ];
    const started = Date.now();
    detectDatabases(hostile);
    const took = Date.now() - started;
    t.check(
      took < 2000,
      'database detection stays fast on hostile workspace files (no catastrophic backtracking)',
      'took ' + took + ' ms',
    );

    t.section('the database plan');
    const plan = planDatabases(
      {
        ...DEFAULTS.databases,
        mongodb: { ...DEFAULTS.databases.mongodb, enabled: true },
        redis: { ...DEFAULTS.databases.redis, enabled: false },
      },
      'unused',
      { files: [compose], host: [] },
    );
    t.equal(
      plan.map((p) => p.database + '@' + p.version + ':' + p.port),
      ['postgres@16:5432', 'mongodb@latest:27017', 'dynamodb@latest:8000'],
      'plan: "auto" from the project (compose pins Postgres 16), true always, false never',
    );
    const catalog = databaseCatalog({
      ...DEFAULTS.databases,
      postgres: { ...DEFAULTS.databases.postgres, enabled: false, port: 6543 },
    });
    t.check(
      catalog.map((p) => p.database).join() === 'postgres,mysql,mongodb,redis,dynamodb' && catalog[0].port === 6543,
      'sbx-db catalog: every database that can run (not SQL Server), even ones off at boot, with configured ports',
    );

    t.section('toolchains from project files');
    const tc = DEFAULTS.toolchains;
    const goProject = decideToolchains(tc, ['README.md', 'go.mod', 'api/main.go'], ['python', 'rust']);
    t.equal(
      [goProject.go, [goProject.python.on, goProject.rust.on, goProject.dotnet.on, goProject.java.on]],
      [{ on: true, reason: 'go.mod' }, [false, false, false, false]],
      'a Go project gets Go (and says why) and nothing it does not use, whatever this PC has',
    );
    const fresh = decideToolchains(tc, ['notes.txt'], ['python', 'dotnet']);
    t.check(
      fresh.python.on && fresh.dotnet.on && !fresh.go.on && fresh.python.reason.includes('this PC'),
      'a folder that is no project yet gets the languages this PC has, and the reason names this PC',
    );
    const rusty = decideToolchains({ ...tc, python: { ...tc.python, enabled: true } }, ['Cargo.toml'], []);
    t.check(
      rusty.rust.on && rusty.cpp.on && rusty.python.on && rusty.python.reason === 'enabled in config',
      'Rust brings its C/C++ linker; true in config always wins',
    );
    const game = ['ZombieGame.uproject', 'Source/ZombieGame.Target.cs'];
    const accepted = { ...tc, unreal: { ...tc.unreal, acceptLicense: true } };
    t.check(
      decideToolchains(accepted, game, []).unreal.on &&
        decideToolchains(accepted, ['Plugins/Kit.uplugin'], []).unreal.on &&
        !decideToolchains(accepted, ['go.mod'], []).unreal.on,
      'Unreal: "auto" follows a .uproject or .uplugin',
    );
    const unaccepted = decideToolchains(tc, game, []).unreal;
    t.check(
      !unaccepted.on && unaccepted.reason.includes('toolchains.unreal.acceptLicense'),
      'Unreal is not installed until its licence is accepted, and the reason says how',
    );
    const resolved = resolveToolchains(tc, goProject);
    t.check(
      resolved.go.enabled === true && resolved.python.enabled === false,
      'the sandbox gets plain decisions instead of "auto"',
    );

    t.section('optional tools: Bun, uv, VS Code');
    const uvTools = decideToolchains({ ...tc, python: { ...tc.python, tools: ['ruff'] } }, ['main.py'], []);
    const memHints = decideToolchains(tc, ['README.md'], [], { bun: 'claude-mem needs it', uv: 'claude-mem needs it' });
    t.check(
      decideToolchains(tc, ['bun.lock', 'package.json'], []).bun.on &&
        !decideToolchains(tc, ['package.json'], []).bun.on &&
        decideToolchains(tc, ['uv.lock'], []).uv.on &&
        !decideToolchains(tc, ['README.md'], []).uv.on &&
        decideToolchains(tc, ['README.md'], ['vscode']).vscode.on &&
        !decideToolchains(tc, ['README.md'], []).vscode.on,
      'bun, uv and VS Code: "auto" follows bun.lock, uv.lock and whether this PC has VS Code',
    );
    t.equal(
      [uvTools.uv, memHints.bun, memHints.uv],
      [
        { on: true, reason: 'needed for toolchains.python.tools' },
        { on: true, reason: 'claude-mem needs it' },
        { on: true, reason: 'claude-mem needs it' },
      ],
      'uv is on for Python tools and Bun/uv for claude-mem, and they say why',
    );
  },
};
