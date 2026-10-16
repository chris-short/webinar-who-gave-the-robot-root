#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { PipelineStack } from '../lib/pipeline-stack';
import { TripwireStack } from '../lib/tripwire-stack';

const app = new App();
const config = loadConfig(app.node);
const env = {
  account: app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const tripwire = new TripwireStack(app, 'RobotRootTripwire', {
  env,
  description: 'Who gave the robot root - canary resources and alerts for the agent demo',
  alertEmail: config.alertEmail,
});

new PipelineStack(app, 'RobotRootPipeline', {
  env,
  description: 'Who gave the robot root - CI/CD pipeline with an AI agent review stage',
  config,
  canarySecret: tripwire.canarySecret,
  canaryKey: tripwire.canaryKey,
});

Tags.of(app).add('project', 'robot-root-webinar');
