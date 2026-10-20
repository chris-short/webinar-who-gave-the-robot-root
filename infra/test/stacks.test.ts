import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { foundationModelId } from '../lib/agent-access';
import { GUARDRAILS, loadConfig, parseGuardrails } from '../lib/config';
import { PipelineStack } from '../lib/pipeline-stack';
import { TripwireStack } from '../lib/tripwire-stack';

const CONNECTION_ARN = 'arn:aws:codeconnections:us-east-1:111111111111:connection/00000000-0000-0000-0000-000000000000';
const env = { account: '111111111111', region: 'us-east-1' };

function synth(context: Record<string, string>) {
  const app = new App({
    context: { githubRepo: 'example-org/robot-root', connectionArn: CONNECTION_ARN, ...context },
  });
  const config = loadConfig(app.node);
  const tripwire = new TripwireStack(app, 'Tripwire', { env });
  const pipeline = new PipelineStack(app, 'Pipeline', {
    env, config, canarySecret: tripwire.canarySecret, canaryKey: tripwire.canaryKey,
  });
  return { app, pipeline: Template.fromStack(pipeline), tripwire: Template.fromStack(tripwire) };
}

function agentRole(template: Template) {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'robot-root-agent' } });
  assert.equal(Object.keys(roles).length, 1);
  return Object.values(roles)[0].Properties;
}

function agentBuildSpec(template: Template): string {
  const projects = template.findResources('AWS::CodeBuild::Project', { Properties: { Name: 'robot-root-agent' } });
  return Object.values(projects)[0].Properties.Source.BuildSpec;
}

describe('config', () => {
  it('defaults to the hardened profile', () => {
    assert.deepEqual([...parseGuardrails()], [...GUARDRAILS]);
  });
  it('maps overprivileged to no guardrails', () => {
    assert.equal(parseGuardrails('overprivileged').size, 0);
  });
  it('lets an explicit list override the profile', () => {
    assert.deepEqual([...parseGuardrails('overprivileged', 'least-privilege, policy-gate')], ['least-privilege', 'policy-gate']);
  });
  it('rejects unknown guardrails and profiles', () => {
    assert.throws(() => parseGuardrails(undefined, 'least-privilege,yolo'), /Unknown guardrails: yolo/);
    assert.throws(() => parseGuardrails('medium'), /Unknown agentProfile/);
  });
  it('strips the geography prefix from inference profile IDs', () => {
    assert.equal(foundationModelId('us.anthropic.claude-opus-4-5-20251101-v1:0'), 'anthropic.claude-opus-4-5-20251101-v1:0');
    assert.equal(foundationModelId('global.anthropic.claude-haiku-4-5-20251001-v1:0'), 'anthropic.claude-haiku-4-5-20251001-v1:0');
    assert.throws(() => foundationModelId('anthropic.claude-opus-4-5-20251101-v1:0'), /cross-Region inference profile/);
  });
  it('uses the main model for background calls unless told otherwise', () => {
    const config = (context: Record<string, string>) =>
      loadConfig(new App({ context: { githubRepo: 'example-org/robot-root', ...context } }).node);
    assert.equal(config({}).agentSmallModel, 'us.anthropic.claude-opus-4-5-20251101-v1:0');
    assert.equal(config({ agentModel: 'us.anthropic.other' }).agentSmallModel, 'us.anthropic.other');
    assert.equal(config({ agentSmallModel: 'us.anthropic.small' }).agentSmallModel, 'us.anthropic.small');
  });
});

describe('overprivileged profile', () => {
  const { pipeline } = synth({ agentProfile: 'overprivileged' });

  it('gives the agent AdministratorAccess, still capped by the boundary', () => {
    const role = agentRole(pipeline);
    assert.match(JSON.stringify(role.ManagedPolicyArns), /AdministratorAccess/);
    assert.ok(role.PermissionsBoundary);
  });

  it('exposes the canary secret ARN to the agent and silences the root check', () => {
    pipeline.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'robot-root-agent',
      Environment: { EnvironmentVariables: Match.arrayWith([Match.objectLike({ Name: 'DEPLOY_DB_SECRET_ARN', Type: 'PLAINTEXT' })]) },
    });
    const spec = agentBuildSpec(pipeline);
    assert.match(spec, /--dangerously-skip-permissions/);
    assert.match(spec, /IS_SANDBOX/);
    assert.match(spec, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  });

  it('has no policy gate', () => {
    pipeline.resourcePropertiesCountIs('AWS::CodeBuild::Project', { Name: 'robot-root-policy-gate' }, 0);
  });
});

describe('hardened profile', () => {
  const { pipeline, tripwire } = synth({ agentProfile: 'hardened' });

  it('gives the agent no managed policies and a confused-deputy-safe trust policy', () => {
    const role = agentRole(pipeline);
    assert.equal(role.ManagedPolicyArns, undefined);
    assert.ok(role.PermissionsBoundary);
    const trust = role.AssumeRolePolicyDocument.Statement[0];
    assert.equal(trust.Condition.StringEquals['aws:SourceAccount'], env.account);
    assert.match(JSON.stringify(trust.Condition.ArnLike['aws:SourceArn']), /project\/robot-root-agent/);
  });

  it('only lets the agent invoke its pinned models through their inference profiles', () => {
    const policies = pipeline.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: Match.stringLikeRegexp('AgentRole') }] },
    });
    const statements = Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const bedrock = statements.filter((s) => JSON.stringify(s.Action).includes('bedrock:'));
    const resources = JSON.stringify(bedrock.map((s) => s.Resource));
    assert.match(resources, /inference-profile\/us\.anthropic\.claude-opus-4-5-20251101-v1:0/);
    assert.match(resources, /foundation-model\/anthropic\.claude-opus-4-5-20251101-v1:0/);
    assert.doesNotMatch(resources, /foundation-model\/anthropic\.\*/);
    // The default main and small models are the same profile, listed once.
    const viaProfile = bedrock.find((s) => s.Sid === 'InvokeViaInferenceProfile');
    assert.equal([viaProfile?.Resource].flat().length, 1);
    const routed = bedrock.find((s) => s.Sid === 'InvokeRoutedFoundationModel');
    assert.ok(routed?.Condition?.StringEquals?.['bedrock:InferenceProfileArn']);
    for (const s of statements) {
      assert.ok(![s.Action].flat().some((a: string) => a === '*' || a.startsWith('iam:') || a.startsWith('secretsmanager:')), `unexpected action in ${s.Sid}`);
    }
  });

  it('runs Claude Code from the lockfile under managed settings, with no secret in its environment', () => {
    const spec = agentBuildSpec(pipeline);
    assert.match(spec, /npm ci --prefix \/opt\/robot-root-agent/);
    assert.match(spec, /npm audit signatures/);
    assert.match(spec, /\/etc\/claude-code\/managed-settings\.json/);
    assert.match(spec, /--bare --permission-mode dontAsk --max-budget-usd/);
    assert.doesNotMatch(spec, /dangerously-skip-permissions|IS_SANDBOX|install\.sh/);
    const project = Object.values(pipeline.findResources('AWS::CodeBuild::Project', { Properties: { Name: 'robot-root-agent' } }))[0];
    assert.ok(!JSON.stringify(project.Properties.Environment.EnvironmentVariables).includes('SECRET'));
  });

  it('adds the policy gate next to the tests', () => {
    pipeline.resourcePropertiesCountIs('AWS::CodeBuild::Project', { Name: 'robot-root-policy-gate' }, 1);
    pipeline.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([Match.objectLike({
        Name: 'Build',
        Actions: Match.arrayWith([Match.objectLike({ Name: 'Test' }), Match.objectLike({ Name: 'PolicyGate' })]),
      })]),
    });
  });

  it('scopes every UseConnection grant to the one repository', () => {
    pipeline.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([Match.objectLike({
        Name: 'Source',
        Actions: [Match.objectLike({ Configuration: Match.objectLike({ OutputArtifactFormat: 'CODEBUILD_CLONE_REF' }) })],
      })]),
    });
    const policies = Object.values(pipeline.findResources('AWS::IAM::Policy'));
    const scoped = policies.flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s) => [s.Action].flat().some((a: string) => a.endsWith(':UseConnection')) && s.Condition);
    // Build, AgentReview, PolicyGate, and the pipeline role, each with both service prefixes.
    assert.equal(scoped.length, 8);
    for (const s of scoped) {
      assert.deepEqual(Object.values(s.Condition.StringEquals), ['example-org/robot-root']);
    }
  });

  it('watches the agent role with read-only management events enabled', () => {
    tripwire.resourcePropertiesCountIs('AWS::Events::Rule', { State: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS' }, 2);
    const rules = Object.values(tripwire.findResources('AWS::Events::Rule'));
    for (const rule of rules) {
      const issuer = rule.Properties.EventPattern.detail.userIdentity.sessionContext.sessionIssuer.arn;
      assert.match(JSON.stringify(issuer), /:role\/robot-root-agent"/);
    }
    const outOfBounds = rules.find((r) => r.Properties.Name === 'robot-root-agent-out-of-bounds')!;
    assert.ok(outOfBounds.Properties.EventPattern.detail.eventSource[0]['anything-but'].includes('bedrock.amazonaws.com'));
    tripwire.hasResourceProperties('AWS::CloudTrail::Trail', { IsLogging: true, IsMultiRegionTrail: false });
  });
});

describe('policy gate rules', { skip: !cfnGuard() && 'cfn-guard not found (set CFN_GUARD=/path/to/cfn-guard)' }, () => {
  const rules = path.join(__dirname, '..', 'policy', 'agent-guardrails.guard');

  function validate(templates: Record<string, unknown>): { ok: boolean; output: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-root-guard-'));
    const args = ['validate', '--rules', rules, '--show-summary', 'fail', '--output-format', 'single-line-summary'];
    for (const [name, template] of Object.entries(templates)) {
      const file = path.join(dir, `${name}.template.json`);
      fs.writeFileSync(file, JSON.stringify(template));
      args.push('--data', file);
    }
    try {
      return { ok: true, output: execFileSync(cfnGuard()!, args, { encoding: 'utf8' }) };
    } catch (err) {
      return { ok: false, output: String((err as { stdout?: string }).stdout ?? err) };
    }
  }

  function templates(context: Record<string, string>) {
    const { pipeline, tripwire } = synth(context);
    return { pipeline: pipeline.toJSON(), tripwire: tripwire.toJSON() };
  }

  it('passes the hardened profile', () => {
    const result = validate(templates({ agentProfile: 'hardened' }));
    assert.ok(result.ok, result.output);
  });

  it('fails the overprivileged profile on every agent rule', () => {
    const result = validate(templates({ agentProfile: 'overprivileged' }));
    assert.equal(result.ok, false);
    for (const rule of ['agent_role_has_no_managed_policies', 'agent_permissions_not_bypassed', 'agent_runtime_is_pinned', 'no_plaintext_secret_env_vars']) {
      assert.match(result.output, new RegExp(rule));
    }
  });

  it('fails a commit that quietly gives the agent iam:*', () => {
    const t = templates({ agentProfile: 'hardened' });
    const resources = (t.pipeline as { Resources: Record<string, { Type: string; Properties: { Roles?: unknown; PolicyDocument: { Statement: unknown[] } } }> }).Resources;
    const agentPolicy = Object.values(resources).find((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes('AgentRole'))!;
    agentPolicy.Properties.PolicyDocument.Statement.push({ Effect: 'Allow', Action: 'iam:*', Resource: '*' });
    const result = validate(t);
    assert.equal(result.ok, false);
    assert.match(result.output, /no_wildcard_actions/);
  });
});

function cfnGuard(): string | undefined {
  if (process.env.CFN_GUARD) return process.env.CFN_GUARD;
  try {
    return execFileSync('which', ['cfn-guard'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}
