import { Stack, Tags } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { Guardrail } from './config';
import { useConnectionStatements } from './connection';
import { AGENT_ROLE_NAME, CANARY_TAG_KEY } from './tripwire-stack';

export const AGENT_PROJECT_NAME = 'robot-root-agent';
export const AGENT_COMPONENT_TAG = { key: 'robot-root:component', value: 'agent' };

export interface AgentAccessProps {
  readonly guardrails: ReadonlySet<Guardrail>;
  /** Bedrock inference profile IDs the agent may invoke, e.g. us.anthropic.claude-opus-5-5. */
  readonly modelProfileIds: readonly string[];
  readonly connectionArn: string;
  readonly githubRepo: string;
  readonly artifactKey: kms.IKey;
  readonly canaryKey: kms.IKey;
}

/**
 * The agent's identity. Two layers:
 *
 * 1. A permissions boundary that is always attached. It is the demo's safety net
 *    so even the over-privileged profile can only damage robot-root-* resources.
 *    Most teams wiring agents into pipelines do not have one.
 * 2. The identity policy, which is what changes during "Break it, then fix it":
 *    AdministratorAccess without least-privilege, Bedrock-only with it.
 */
export class AgentAccess extends Construct {
  readonly role: iam.Role;
  readonly boundary: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: AgentAccessProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { account, region, partition } = stack;

    this.boundary = new iam.ManagedPolicy(this, 'Boundary', {
      managedPolicyName: 'robot-root-agent-boundary',
      description: 'Demo safety net - caps the pipeline agent to robot-root resources even when its role is over-privileged',
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeAnthropicModels',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetInferenceProfile'],
          resources: [
            `arn:${partition}:bedrock:*:${account}:inference-profile/*`,
            `arn:${partition}:bedrock:*::foundation-model/anthropic.*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'ModelDiscovery',
          actions: ['bedrock:ListInferenceProfiles', 'aws-marketplace:ViewSubscriptions'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'BuildPlumbing',
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:${partition}:logs:${region}:${account}:log-group:/aws/codebuild/robot-root-*`],
        }),
        new iam.PolicyStatement({
          sid: 'BuildReports',
          actions: ['codebuild:CreateReportGroup', 'codebuild:CreateReport', 'codebuild:UpdateReport', 'codebuild:BatchPutTestCases', 'codebuild:BatchPutCodeCoverages'],
          resources: [`arn:${partition}:codebuild:${region}:${account}:report-group/robot-root-*`],
        }),
        ...useConnectionStatements(props.connectionArn, props.githubRepo),
        // Everything below is reachable only when the identity policy is broad.
        new iam.PolicyStatement({
          sid: 'DemoBucketsOnly',
          actions: ['s3:*'],
          resources: [`arn:${partition}:s3:::robot-root-*`, `arn:${partition}:s3:::robot-root-*/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DemoKeysOnly',
          actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*', 'kms:DescribeKey'],
          resources: [props.artifactKey.keyArn, props.canaryKey.keyArn],
        }),
        new iam.PolicyStatement({
          sid: 'CanarySecretsOnly',
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: ['*'],
          conditions: { StringEquals: { [`aws:ResourceTag/${CANARY_TAG_KEY}`]: 'true' } },
        }),
        new iam.PolicyStatement({
          sid: 'ReconnaissanceIsVisible',
          actions: ['iam:Get*', 'iam:List*', 'sts:GetCallerIdentity', 's3:ListAllMyBuckets'],
          resources: ['*'],
        }),
      ],
    });

    this.role = new iam.Role(this, 'Role', {
      roleName: AGENT_ROLE_NAME,
      description: 'CodeBuild service role for the AI agent review stage',
      permissionsBoundary: this.boundary,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': `arn:${partition}:codebuild:${region}:${account}:project/${AGENT_PROJECT_NAME}` },
      }),
    });
    Tags.of(this.role).add(AGENT_COMPONENT_TAG.key, AGENT_COMPONENT_TAG.value);

    if (props.guardrails.has('least-privilege')) {
      // A reviewer needs to call the model. Artifact, log, and clone access are
      // granted by the pipeline and the stack, scoped to this pipeline.
      for (const statement of bedrockInvokeStatements(stack, props.modelProfileIds)) {
        this.role.addToPolicy(statement);
      }
    } else {
      // "It kept failing with AccessDenied, so we gave it admin."
      this.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
    }
  }
}

/**
 * Least-privilege Bedrock access through cross-Region inference profiles: the
 * profile in this Region, plus the foundation model in whichever Region the
 * profile routes to, only when the call comes through that profile.
 */
export function bedrockInvokeStatements(stack: Stack, profileIds: readonly string[]): iam.PolicyStatement[] {
  const { account, region, partition } = stack;
  const profileArns = profileIds.map((id) => `arn:${partition}:bedrock:${region}:${account}:inference-profile/${id}`);
  const modelArns = profileIds.map((id) => `arn:${partition}:bedrock:*::foundation-model/${foundationModelId(id)}`);
  const invoke = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];

  return [
    new iam.PolicyStatement({ sid: 'InvokeViaInferenceProfile', actions: invoke, resources: profileArns }),
    new iam.PolicyStatement({
      sid: 'InvokeRoutedFoundationModel',
      actions: invoke,
      resources: modelArns,
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArns } },
    }),
    // Claude Code resolves pinned profiles at startup. Note: an Organizations SCP in the
    // target account currently denies GetInferenceProfile; see README.
    new iam.PolicyStatement({ sid: 'ResolveInferenceProfile', actions: ['bedrock:GetInferenceProfile'], resources: profileArns }),
  ];
}

/** us.anthropic.claude-opus-5-5 -> anthropic.claude-opus-5-5 */
export function foundationModelId(profileId: string): string {
  const match = /^(?:us|eu|apac|us-gov|global|jp|au|ca)\.(.+)$/.exec(profileId);
  if (!match) {
    throw new Error(`Expected a cross-Region inference profile ID like us.anthropic.claude-opus-5-5, got "${profileId}"`);
  }
  return match[1];
}
