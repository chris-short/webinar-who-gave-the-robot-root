import { Node } from 'constructs';

/**
 * Each guardrail can be switched on independently so the presenter can lock
 * the agent down one step at a time during "Break it, then fix it".
 */
export const GUARDRAILS = [
  // Agent role gets only what a reviewer needs instead of AdministratorAccess.
  'least-privilege',
  // Claude Code runs under platform-owned managed settings: no shell, no web,
  // no repo-controlled CLAUDE.md or settings, spend cap.
  'agent-policy',
  // Claude Code comes from a committed lockfile with signature checks instead
  // of curl | bash at whatever version is latest today.
  'supply-chain',
  // cfn-guard rules run against the synthesized infra before anything ships.
  'policy-gate',
] as const;

export type Guardrail = (typeof GUARDRAILS)[number];

const PROFILES: Record<string, readonly Guardrail[]> = {
  overprivileged: [],
  hardened: GUARDRAILS,
};

export interface DemoConfig {
  /** GitHub repository in owner/repo form. */
  readonly githubRepo: string;
  readonly branch: string;
  /** Existing CodeConnections connection. When omitted, the stack creates one (PENDING until authorized in the console). */
  readonly connectionArn?: string;
  /** Bedrock inference profile ID for the main agent model. */
  readonly agentModel: string;
  /** Bedrock inference profile ID Claude Code uses for lightweight background calls. Defaults to agentModel. */
  readonly agentSmallModel: string;
  /** Hard spend cap per agent run, passed to --max-budget-usd when agent-policy is on. */
  readonly agentBudgetUsd: number;
  readonly guardrails: ReadonlySet<Guardrail>;
  readonly alertEmail?: string;
}

export function loadConfig(node: Node): DemoConfig {
  const githubRepo = node.tryGetContext('githubRepo');
  if (typeof githubRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    throw new Error('Set -c githubRepo=<owner>/<repo>');
  }

  // One model for both roles: in the test accounts, Opus 4.5 is the only Claude model the org allows.
  const agentModel = node.tryGetContext('agentModel') ?? 'us.anthropic.claude-opus-4-5-20251101-v1:0';

  return {
    githubRepo,
    branch: node.tryGetContext('branch') ?? 'main',
    connectionArn: node.tryGetContext('connectionArn'),
    agentModel,
    agentSmallModel: node.tryGetContext('agentSmallModel') ?? agentModel,
    agentBudgetUsd: Number(node.tryGetContext('agentBudgetUsd') ?? 3),
    guardrails: parseGuardrails(node.tryGetContext('agentProfile'), node.tryGetContext('guardrails')),
    alertEmail: node.tryGetContext('alertEmail'),
  };
}

/**
 * `-c agentProfile=overprivileged|hardened` picks a preset (default hardened).
 * `-c guardrails=least-privilege,agent-policy` overrides it with an explicit list.
 */
export function parseGuardrails(profile?: string, list?: string): ReadonlySet<Guardrail> {
  if (list !== undefined) {
    const requested = list.split(',').map((g) => g.trim()).filter(Boolean);
    const unknown = requested.filter((g) => !(GUARDRAILS as readonly string[]).includes(g));
    if (unknown.length > 0) {
      throw new Error(`Unknown guardrails: ${unknown.join(', ')}. Valid: ${GUARDRAILS.join(', ')}`);
    }
    return new Set(requested as Guardrail[]);
  }
  const preset = PROFILES[profile ?? 'hardened'];
  if (!preset) {
    throw new Error(`Unknown agentProfile "${profile}". Valid: ${Object.keys(PROFILES).join(', ')}`);
  }
  return new Set(preset);
}
