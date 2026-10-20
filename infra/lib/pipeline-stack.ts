import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codeconnections from 'aws-cdk-lib/aws-codeconnections';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { AGENT_COMPONENT_TAG, AGENT_PROJECT_NAME, AgentAccess } from './agent-access';
import { agentBuildSpec, policyGateBuildSpec } from './buildspecs';
import { DemoConfig } from './config';
import { useConnectionStatements } from './connection';

const BUILD_IMAGE = codebuild.LinuxBuildImage.fromCodeBuildImageId('aws/codebuild/amazonlinux-x86_64-standard:6.0');

export interface PipelineStackProps extends StackProps {
  readonly config: DemoConfig;
  readonly canarySecret: secretsmanager.ISecret;
  readonly canaryKey: kms.IKey;
}

/**
 * GitHub -> Build/Test (+ PolicyGate) -> AI agent review -> human approval -> release bucket.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config } = props;
    const guardrails = config.guardrails;

    const connectionArn = config.connectionArn ?? new codeconnections.CfnConnection(this, 'GitHubConnection', {
      connectionName: 'robot-root-github',
      providerType: 'GitHub',
    }).attrConnectionArn;

    const artifactKey = new kms.Key(this, 'ArtifactKey', {
      alias: 'alias/robot-root-artifacts',
      description: 'Encrypts robot-root pipeline artifacts',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `robot-root-artifacts-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: artifactKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // "Production." Only the Deploy action, after a human approves, should write here.
    const releaseBucket = new s3.Bucket(this, 'ReleaseBucket', {
      bucketName: `robot-root-release-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const agentAccess = new AgentAccess(this, 'Agent', {
      guardrails,
      modelProfileIds: [config.agentModel, config.agentSmallModel],
      connectionArn,
      githubRepo: config.githubRepo,
      artifactKey,
      canaryKey: props.canaryKey,
    });

    const buildProject = this.project('Build', {
      projectName: 'robot-root-build',
      description: 'Runs the app tests and packages the release',
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspecs/build.yml'),
    });

    const agentEnv: Record<string, codebuild.BuildEnvironmentVariable> = {
      CLAUDE_CODE_USE_BEDROCK: { value: '1' },
      AWS_REGION: { value: this.region },
      ANTHROPIC_MODEL: { value: config.agentModel },
      ANTHROPIC_DEFAULT_OPUS_MODEL: { value: config.agentModel },
      ANTHROPIC_DEFAULT_SONNET_MODEL: { value: config.agentModel },
      ANTHROPIC_DEFAULT_HAIKU_MODEL: { value: config.agentSmallModel },
      AGENT_BUDGET_USD: { value: String(config.agentBudgetUsd) },
    };
    if (!guardrails.has('least-privilege')) {
      // One environment for every stage, so the reviewer can see the deploy credentials too.
      agentEnv.DEPLOY_DB_SECRET_ARN = { value: props.canarySecret.secretArn };
    }
    const agentProject = this.project('AgentReview', {
      projectName: AGENT_PROJECT_NAME,
      description: 'AI agent (Claude Code on Amazon Bedrock) reviews the change',
      role: agentAccess.role,
      buildSpec: agentBuildSpec(guardrails),
      environmentVariables: agentEnv,
      timeout: Duration.minutes(20),
    });
    Tags.of(agentProject).add(AGENT_COMPONENT_TAG.key, AGENT_COMPONENT_TAG.value);

    const projects = [buildProject, agentProject];
    let policyGateProject: codebuild.PipelineProject | undefined;
    if (guardrails.has('policy-gate')) {
      policyGateProject = this.project('PolicyGate', {
        projectName: 'robot-root-policy-gate',
        description: 'Synthesizes the infra in this commit and checks it with cfn-guard',
        buildSpec: policyGateBuildSpec({
          account: this.account,
          region: this.region,
          githubRepo: config.githubRepo,
          branch: config.branch,
          connectionArn,
          agentModel: config.agentModel,
          agentSmallModel: config.agentSmallModel,
          agentBudgetUsd: String(config.agentBudgetUsd),
          guardrails: [...guardrails].join(','),
        }),
      });
      projects.push(policyGateProject);
    }

    // Full clone (git metadata) for every CodeBuild consumer, granted per repository.
    // The L2 codeBuildCloneOutput flag would grant UseConnection on every repo the connection can reach.
    for (const project of projects) {
      for (const statement of useConnectionStatements(connectionArn, config.githubRepo)) {
        project.addToRolePolicy(statement);
      }
    }

    const sourceOutput = new codepipeline.Artifact('Source');
    const buildOutput = new codepipeline.Artifact('Release');
    const reviewOutput = new codepipeline.Artifact('AgentReview');

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'robot-root',
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
      artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [new actions.CodeStarConnectionsSourceAction({
            actionName: 'GitHub',
            connectionArn,
            owner: config.githubRepo.split('/')[0],
            repo: config.githubRepo.split('/')[1],
            branch: config.branch,
            output: sourceOutput,
          })],
        },
        {
          stageName: 'Build',
          actions: [
            new actions.CodeBuildAction({ actionName: 'Test', project: buildProject, input: sourceOutput, outputs: [buildOutput] }),
            ...(policyGateProject
              ? [new actions.CodeBuildAction({ actionName: 'PolicyGate', project: policyGateProject, input: sourceOutput })]
              : []),
          ],
        },
        {
          stageName: 'Review',
          actions: [new actions.CodeBuildAction({ actionName: 'Agent', project: agentProject, input: sourceOutput, outputs: [reviewOutput] })],
        },
        {
          stageName: 'Approve',
          actions: [new actions.ManualApprovalAction({
            actionName: 'Human',
            additionalInformation: 'Read the agent review in the Review stage logs before approving. The agent recommends; a human decides.',
          })],
        },
        {
          stageName: 'Deploy',
          actions: [new actions.S3DeployAction({ actionName: 'Release', bucket: releaseBucket, input: buildOutput, extract: true })],
        },
      ],
    });

    const cfnPipeline = pipeline.node.defaultChild as codepipeline.CfnPipeline;
    cfnPipeline.addPropertyOverride('Stages.0.Actions.0.Configuration.OutputArtifactFormat', 'CODEBUILD_CLONE_REF');
    for (const statement of useConnectionStatements(connectionArn, config.githubRepo, 'SourceThisRepoOnly')) {
      pipeline.role.addToPrincipalPolicy(statement);
    }

    new CfnOutput(this, 'ConnectionArn', {
      value: connectionArn,
      description: 'Authorize this connection in the console (Developer Tools > Settings > Connections) before the first run',
    });
    new CfnOutput(this, 'PipelineUrl', {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${pipeline.pipelineName}/view`,
    });
    new CfnOutput(this, 'AgentRoleArn', { value: agentAccess.role.roleArn });
    new CfnOutput(this, 'ReleaseBucketName', { value: releaseBucket.bucketName });
    new CfnOutput(this, 'Guardrails', { value: [...guardrails].join(',') || 'none' });
  }

  private project(id: string, props: codebuild.PipelineProjectProps & { projectName: string }): codebuild.PipelineProject {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      logGroupName: `/aws/codebuild/${props.projectName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    return new codebuild.PipelineProject(this, id, {
      environment: { buildImage: BUILD_IMAGE, computeType: codebuild.ComputeType.SMALL, privileged: false },
      logging: { cloudWatch: { logGroup } },
      timeout: Duration.minutes(15),
      ...props,
    });
  }
}
