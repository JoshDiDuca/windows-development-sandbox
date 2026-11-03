// The environment variables of Claude Code worth setting, for the "Claude environment" editor. Every name was found in
// the claude.exe of the sandbox (a bounded grep -a -o -w); descriptions follow code.claude.com/docs (Environment
// variables). Web-safe: no node imports. A flag is written as "1"; an empty value removes the variable.

export const ENV_GROUPS = ['Subagents', 'Models', 'Limits', 'Behaviour', 'Privacy', 'Network', 'Providers'] as const;
export type EnvGroup = (typeof ENV_GROUPS)[number];

export interface EnvVarSpec {
  readonly name: string;
  readonly group: EnvGroup;
  readonly label: string;
  readonly kind: 'flag' | 'number' | 'text' | 'enum';
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** Its value is a login or a token: never shown, never sent to a screen. */
  readonly secret?: boolean;
  readonly description: string;
  /** What Claude does when it is not set (shown beside the value). */
  readonly defaultText?: string;
}

type Extra = Partial<Pick<EnvVarSpec, 'min' | 'max' | 'secret' | 'defaultText'>>;

/** [name, label, description, extra?] of one variable of a group. */
type Row = readonly [string, string, string, Extra?];

const group = (g: EnvGroup, kind: 'flag' | 'number' | 'text', rows: readonly Row[]): EnvVarSpec[] =>
  rows.map(([name, label, description, extra]) => ({
    name,
    group: g,
    label,
    kind,
    description,
    ...(kind === 'number' ? { min: 0 } : {}),
    ...extra,
  }));

/** The variable that sets how many subagents run at once (Claude's code default is 20). */
export const MAX_SUBAGENTS_VAR = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS';
export const MAX_SUBAGENTS_DEFAULT = 20;

export const CLAUDE_ENV: readonly EnvVarSpec[] = [
  ...group('Subagents', 'number', [
    [
      MAX_SUBAGENTS_VAR,
      'Subagents at once',
      'How many subagents may run at the same time.',
      { min: 1, max: 1000, defaultText: String(MAX_SUBAGENTS_DEFAULT) },
    ],
    [
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
      'Subagent nesting depth',
      'How deep subagents may start subagents.',
      { min: 1, max: 20 },
    ],
    [
      'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
      'Subagents per session',
      'The most subagents one session may start.',
      { min: 1 },
    ],
    [
      'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS',
      'Workflow agents at once',
      'How many agents one workflow runs at the same time.',
      { min: 1 },
    ],
  ]),
  ...group('Subagents', 'text', [
    [
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'Subagent model',
      'The model subagents use (an alias such as sonnet, or a full model name).',
    ],
  ]),
  ...group('Subagents', 'flag', [
    [
      'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
      'Force the subagent model',
      'Use the subagent model even where an agent asks for another one.',
    ],
    ['CLAUDE_CODE_FORK_SUBAGENT', 'Forked subagents', 'Let subagents start from a copy of the conversation so far.'],
  ]),

  ...group('Models', 'text', [
    ['ANTHROPIC_MODEL', 'Model', 'The model Claude uses (an alias such as opus, or a full model name).'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'Model behind "opus"', 'The model the opus alias stands for.'],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'Model behind "sonnet"', 'The model the sonnet alias stands for.'],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'Model behind "haiku"', 'The model the haiku alias stands for.'],
    ['ANTHROPIC_SMALL_FAST_MODEL', 'Small, fast model', 'The model used for light background work.'],
  ]),
  {
    name: 'CLAUDE_CODE_EFFORT_LEVEL',
    group: 'Models',
    label: 'Effort level',
    kind: 'enum',
    choices: ['low', 'medium', 'high', 'xhigh', 'max'],
    description: 'How hard Claude thinks, for every session.',
  },
  ...group('Models', 'number', [
    ['MAX_THINKING_TOKENS', 'Thinking budget (tokens)', 'The most tokens Claude may spend thinking before it answers.'],
  ]),
  ...group('Models', 'flag', [
    ['CLAUDE_CODE_DISABLE_THINKING', 'No extended thinking', 'Turn extended thinking off.'],
    [
      'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
      'No adaptive thinking',
      'Use a fixed thinking budget instead of letting the model decide.',
    ],
    ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'No 1M-token context', 'Do not use the one-million-token context window.'],
    ['CLAUDE_CODE_DISABLE_FAST_MODE', 'No fast mode', 'Turn fast mode off.'],
  ]),

  ...group('Limits', 'number', [
    ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'Output tokens per reply', 'The most tokens one reply may have.', { min: 1 }],
    [
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'Context size (tokens)',
      'The most tokens Claude keeps in the conversation.',
      { min: 1 },
    ],
    [
      'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
      'Tokens per file read',
      'The most tokens one file read may return.',
      { min: 1 },
    ],
    ['MAX_MCP_OUTPUT_TOKENS', 'Tokens per MCP result', 'The most tokens one MCP tool result may have.', { min: 1 }],
    [
      'BASH_DEFAULT_TIMEOUT_MS',
      'Command timeout (ms)',
      'How long a shell command runs before it is stopped, unless the command asks for more.',
      { min: 1 },
    ],
    [
      'BASH_MAX_TIMEOUT_MS',
      'Longest command timeout (ms)',
      'The longest timeout a shell command may ask for.',
      { min: 1 },
    ],
    [
      'BASH_MAX_OUTPUT_LENGTH',
      'Command output (characters)',
      'The most characters of a shell command output kept.',
      { min: 1 },
    ],
    [
      'TASK_MAX_OUTPUT_LENGTH',
      'Subagent output (characters)',
      'The most characters of a subagent output kept.',
      { min: 1 },
    ],
    ['MCP_TIMEOUT', 'MCP start timeout (ms)', 'How long an MCP server may take to start.', { min: 1 }],
    ['MCP_TOOL_TIMEOUT', 'MCP tool timeout (ms)', 'How long one MCP tool call may take.', { min: 1 }],
    ['API_TIMEOUT_MS', 'API timeout (ms)', 'How long a request to the API may take.', { min: 1 }],
    ['CLAUDE_CODE_MAX_RETRIES', 'API retries', 'How many times a failed API request is tried again.'],
    [
      'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
      'Tools at once',
      'How many tool calls may run at the same time.',
      { min: 1 },
    ],
    ['CLAUDE_CODE_MAX_TURNS', 'Most turns', 'The most turns Claude takes on one request.', { min: 1 }],
    [
      'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION',
      'Web searches per session',
      'The most web searches one session may do.',
    ],
    ['CLAUDE_CODE_GLOB_TIMEOUT_SECONDS', 'File search timeout (s)', 'How long a file search may take.', { min: 1 }],
    [
      'SLASH_COMMAND_TOOL_CHAR_BUDGET',
      'Slash command text budget',
      'The characters of slash command descriptions Claude is told about.',
      { min: 1 },
    ],
    [
      'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
      'Compact at (% full)',
      'When the context is this full, Claude compacts it.',
      { min: 1, max: 100 },
    ],
    [
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'Compaction window (tokens)',
      'The context size compaction is measured against.',
      { min: 1 },
    ],
  ]),
  ...group('Limits', 'flag', [
    ['DISABLE_AUTO_COMPACT', 'No automatic compaction', 'Never compact the context by itself.'],
  ]),

  ...group('Behaviour', 'text', [
    ['CLAUDE_CODE_SHELL', 'Shell', 'The shell Claude runs commands in.'],
    ['CLAUDE_CODE_GIT_BASH_PATH', 'Git Bash path', 'Where bash.exe of Git for Windows is.'],
    ['CLAUDE_CODE_TMPDIR', 'Temp folder', 'The folder Claude keeps its temporary files in.'],
    ['CLAUDE_ENV_FILE', 'Shell setup file', 'A script run before every shell command.'],
  ]),
  ...group('Behaviour', 'flag', [
    [
      'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
      'Stay in the project folder',
      'Return to the project folder after every shell command.',
    ],
    [
      'USE_BUILTIN_RIPGREP',
      'Use the built-in ripgrep',
      'Use the ripgrep that comes with Claude rather than the one on PATH.',
    ],
    ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'No background tasks', 'Do not let commands run in the background.'],
    ['CLAUDE_CODE_ENABLE_TASKS', 'Task list', 'Turn the task list tools on.'],
    ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'No automatic memory', 'Claude does not write memory notes by itself.'],
    ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'Ignore CLAUDE.md files', 'Do not load CLAUDE.md files.'],
    [
      'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS',
      'No built-in git instructions',
      'Leave the git instructions out of the prompt.',
    ],
    ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'Keep the terminal title', 'Do not change the terminal title.'],
    ['CLAUDE_CODE_NO_FLICKER', 'Flicker-free screen', 'Draw the screen in its own buffer, which stops flicker.'],
    ['CLAUDE_CODE_SIMPLE', 'Simple mode', 'Start with fewer tools and a short prompt.'],
    ['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION', 'Prompt suggestions', 'Suggest what to type next.'],
    ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'Agent teams (experimental)', 'Turn the experimental agent teams on.'],
    [
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'No experimental betas',
      'Do not send experimental beta headers to the API.',
    ],
    ['CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'Do not keep prompt history', 'Do not save what you type.'],
    [
      'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL',
      'No editor extension install',
      'Do not install the editor extension by itself.',
    ],
    ['ENABLE_TOOL_SEARCH', 'Tool search', 'Load MCP tools when they are needed instead of at the start.'],
  ]),

  ...group('Privacy', 'flag', [
    ['DISABLE_TELEMETRY', 'No telemetry', 'Do not send usage statistics.'],
    ['DISABLE_ERROR_REPORTING', 'No error reports', 'Do not send error reports.'],
    ['DISABLE_COST_WARNINGS', 'No cost warnings', 'Hide the cost warnings.'],
    [
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'Only essential traffic',
      'Turn off telemetry, error reports, updates and the survey in one go.',
    ],
    ['CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY', 'No feedback survey', 'Do not ask for feedback.'],
    [
      'DISABLE_AUTOUPDATER',
      'No automatic updates',
      'Do not update Claude by itself. The sandbox sets this: it installs Claude itself.',
    ],
    ['DISABLE_PROMPT_CACHING', 'No prompt caching', 'Turn prompt caching off.'],
    ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OpenTelemetry', 'Turn OpenTelemetry metrics on.'],
  ]),

  ...group('Network', 'text', [
    ['HTTPS_PROXY', 'HTTPS proxy', 'A proxy for HTTPS requests (http://host:port).'],
    ['NO_PROXY', 'Hosts without the proxy', 'Hosts that do not go through the proxy, separated by commas.'],
    ['ANTHROPIC_BASE_URL', 'API address', 'Send API requests to this address instead of Anthropic (a gateway).'],
    [
      'ANTHROPIC_CUSTOM_HEADERS',
      'Extra API headers',
      'Headers added to every API request, one "Name: value" per line.',
      { secret: true },
    ],
  ]),

  ...group('Providers', 'flag', [
    ['CLAUDE_CODE_USE_BEDROCK', 'Use Amazon Bedrock', 'Run the models through Amazon Bedrock.'],
    ['CLAUDE_CODE_USE_VERTEX', 'Use Google Vertex AI', 'Run the models through Google Vertex AI.'],
    ['CLAUDE_CODE_USE_FOUNDRY', 'Use Microsoft Foundry', 'Run the models through Microsoft Foundry.'],
  ]),
  ...group('Providers', 'text', [
    ['AWS_BEARER_TOKEN_BEDROCK', 'Bedrock token', 'A bearer token for Amazon Bedrock.', { secret: true }],
    [
      'ANTHROPIC_AUTH_TOKEN',
      'Auth token',
      'A token sent as the Authorization header (for a gateway).',
      { secret: true },
    ],
    [
      'ANTHROPIC_API_KEY',
      'API key',
      'An Anthropic API key. To keep a key for later, use Accounts > Save an API key instead.',
      { secret: true },
    ],
  ]),
];

/** The catalogue entry of a variable name. */
export function envSpec(name: string): EnvVarSpec | undefined {
  return CLAUDE_ENV.find((s) => s.name === name);
}

/** A variable name anyone may set (the same shape the settings accept). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;

/**
 * What a typed value becomes for this variable: the text to save, null when it removes the variable, or a problem the
 * person can act on. A flag is "1" or removed; a number is whole and in range; ANTHROPIC_API_KEY must pass the key
 * check it is given. Pure.
 */
export function envValue(
  spec: EnvVarSpec | undefined,
  raw: string | null,
  /** What is wrong with an Anthropic API key (the host passes anthropicKeyProblem), or null. */
  keyProblem: (key: string) => string | null = () => null,
): { readonly save: string | null } | { readonly problem: string } {
  const value = raw === null ? '' : raw.trim();
  if (value === '') return { save: null };
  if (!spec) return { save: value };
  if (spec.kind === 'flag') {
    const word = value.toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(word)) return { save: '1' };
    if (['0', 'false', 'off', 'no'].includes(word)) return { save: null };
    return { problem: 'Use 1 (on) or leave it empty (off).' };
  }
  if (spec.kind === 'number') {
    const n = Number(value);
    const min = spec.min ?? 0;
    if (!/^\d{1,15}$/.test(value)) return { problem: 'Use a whole number.' };
    if (n < min || (spec.max !== undefined && n > spec.max))
      return { problem: 'Use a number from ' + min + (spec.max !== undefined ? ' to ' + spec.max : ' up') + '.' };
    return { save: String(n) };
  }
  if (spec.kind === 'enum' && !spec.choices?.includes(value))
    return { problem: 'Use one of: ' + (spec.choices ?? []).join(', ') + '.' };
  if (spec.name === 'ANTHROPIC_API_KEY') {
    const problem = keyProblem(value);
    if (problem) return { problem };
  }
  if (/[\r\n\0]/.test(value) && spec.name !== 'ANTHROPIC_CUSTOM_HEADERS') return { problem: 'Use a single line.' };
  return { save: value };
}
