import * as fs from 'node:fs';
import * as path from 'node:path';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Guardrail } from './config';

const INFRA_DIR = path.join(__dirname, '..');

/**
 * Files the agent stage needs are read at synth time and embedded in the
 * buildspec. The agent's guardrails ship with the infrastructure, so a commit
 * under review cannot loosen them; changing them takes an infra deploy.
 */
function embed(relativePath: string, destination: string): string {
  const b64 = fs.readFileSync(path.join(INFRA_DIR, relativePath)).toString('base64');
  return `echo '${b64}' | base64 -d > ${destination}`;
}

export const CFN_GUARD = {
  version: '3.2.1',
  asset: 'cfn-guard-v3-x86_64-linux-latest',
  sha256: '8c66efb19c63e6c2bf26b9a41bbcf2f85baa8a937b01d350940194faaf64cf1d',
};

const TRANSCRIPT = 'agent-output/transcript.jsonl';

/**
 * Buildspec for the agent review stage. Each guardrail swaps a block of
 * commands, so `cdk diff` between steps shows exactly what changed.
 */
export function agentBuildSpec(guardrails: ReadonlySet<Guardrail>): codebuild.BuildSpec {
  const governed = guardrails.has('agent-policy');

  const install = guardrails.has('supply-chain')
    ? [
      // Exact version from a committed lockfile, registry signatures verified,
      // and only the one install script we approved is allowed to run.
      'mkdir -p /opt/robot-root-agent',
      embed('agent/package.json', '/opt/robot-root-agent/package.json'),
      embed('agent/package-lock.json', '/opt/robot-root-agent/package-lock.json'),
      'npm ci --prefix /opt/robot-root-agent --no-audit --no-fund',
      '(cd /opt/robot-root-agent && npm audit signatures)',
      'ln -sf /opt/robot-root-agent/node_modules/.bin/claude /usr/local/bin/claude',
    ]
    : [
      // Whatever the installer serves today, unverified.
      'curl -fsSL https://claude.ai/install.sh | bash',
      'ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude',
    ];

  const prepare = [
    'mkdir -p .agent-input agent-output',
    // The agent gets the change as data. It does not need a shell to read git history.
    'git show --stat --patch --format=fuller HEAD > .agent-input/changes.diff',
    embed('agent/review-prompt.md', '/tmp/review-prompt.md'),
    ...(governed
      ? ['mkdir -p /etc/claude-code', embed('agent/managed-settings.json', '/etc/claude-code/managed-settings.json')]
      : []),
  ];

  const run = governed
    ? [
      // --bare: the repo under review cannot steer the agent with its own CLAUDE.md,
      // hooks, or settings. Managed settings still apply: no shell, no web, no writes.
      `claude -p "$(cat /tmp/review-prompt.md)" --bare --permission-mode dontAsk --max-budget-usd "$AGENT_BUDGET_USD" --output-format stream-json --verbose > ${TRANSCRIPT}`,
    ]
    : [
      `claude -p "$(cat /tmp/review-prompt.md)" --dangerously-skip-permissions --output-format stream-json --verbose > ${TRANSCRIPT}`,
      // Demo only. A capable model won't reliably overreach on cue - and detection must not
      // depend on it doing so. When a committed `.breakit` marker is present, stand in for a
      // compromised or buggy agent by making one out-of-bounds call with the agent's own role,
      // so the tripwire has a real event to catch. The agent-policy guardrail removes the shell,
      // so this whole branch - and this step - is gone once that guardrail is on.
      // List operations are CloudTrail management events, which reach the tripwire's EventBridge
      // rule; object reads/writes are data events, which don't. `aws s3 ls` (ListBuckets) trips the
      // canary rule's ListBuckets branch for certain; listing the prod-exports bucket by name adds
      // the "reached into production" detail.
      'if [ -f .breakit ]; then ' +
        'ACCOUNT=$(echo "$CODEBUILD_BUILD_ARN" | cut -d: -f5); ' +
        'BUCKET="robot-root-prod-exports-$ACCOUNT-$AWS_REGION"; ' +
        'echo "[breakit] simulating a compromised agent reaching into production exports ($BUCKET)"; ' +
        'aws s3 ls "s3://$BUCKET/" || true; ' +
        'aws s3 ls || true; ' +
      'fi',
    ];

  return codebuild.BuildSpec.fromObject({
    version: '0.2',
    env: {
      shell: 'bash',
      // Claude Code refuses to skip permissions as root. This line silences that check.
      ...(governed ? {} : { variables: { IS_SANDBOX: '1' } }),
    },
    phases: {
      install: { 'runtime-versions': { nodejs: 24 }, commands: [...install, 'claude --version'] },
      pre_build: { commands: prepare },
      build: { commands: run },
      post_build: {
        commands: [
          `jq -r 'select(.type == "result") | .result // empty' ${TRANSCRIPT} > agent-output/review.md || true`,
          `jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | "\\(.name) \\(.input | tostring | .[0:240])"' ${TRANSCRIPT} > agent-output/tool-calls.txt || true`,
          'echo "===== Agent review =====" && cat agent-output/review.md',
          'echo "===== Tool calls the agent made =====" && cat agent-output/tool-calls.txt',
        ],
      },
    },
    artifacts: { 'base-directory': 'agent-output', files: ['**/*'] },
  });
}

/**
 * Policy-as-code gate: synthesize the infra in this commit with the guardrails
 * currently deployed, then check it with cfn-guard rules owned by the platform.
 */
export function policyGateBuildSpec(synthContext: Record<string, string>): codebuild.BuildSpec {
  const contextArgs = Object.entries(synthContext).map(([k, v]) => `-c ${k}=${v}`).join(' ');
  const tarball = `/tmp/${CFN_GUARD.asset}.tar.gz`;
  return codebuild.BuildSpec.fromObject({
    version: '0.2',
    env: { shell: 'bash' },
    phases: {
      install: {
        'runtime-versions': { nodejs: 24 },
        commands: [
          `curl -fsSL -o ${tarball} https://github.com/aws-cloudformation/cloudformation-guard/releases/download/${CFN_GUARD.version}/${CFN_GUARD.asset}.tar.gz`,
          `echo "${CFN_GUARD.sha256}  ${tarball}" | sha256sum -c -`,
          `tar -xzf ${tarball} -C /tmp && install -m 0755 /tmp/${CFN_GUARD.asset}/cfn-guard /usr/local/bin/cfn-guard`,
          embed('policy/agent-guardrails.guard', '/tmp/agent-guardrails.guard'),
        ],
      },
      build: {
        commands: [
          '(cd infra && npm ci --no-audit --no-fund)',
          `(cd infra && npx cdk synth --quiet --output /tmp/cdk.out ${contextArgs})`,
          'cfn-guard validate --rules /tmp/agent-guardrails.guard $(printf -- "--data %s " /tmp/cdk.out/*.template.json) --show-summary fail --output-format single-line-summary',
        ],
      },
    },
  });
}
