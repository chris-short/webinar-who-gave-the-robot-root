import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * UseConnection reaches every repository the GitHub App can see unless it is
 * conditioned on the repository. Connections carry either service prefix
 * depending on when they were created, and each prefix has its own condition
 * key, so this returns one statement per prefix.
 */
export function useConnectionStatements(connectionArn: string, githubRepo: string, sidPrefix = 'CloneThisRepoOnly'): iam.PolicyStatement[] {
  return ['codeconnections', 'codestar-connections'].map((prefix) => new iam.PolicyStatement({
    sid: `${sidPrefix}${prefix === 'codeconnections' ? '' : 'Legacy'}`,
    actions: [`${prefix}:UseConnection`],
    resources: [connectionArn],
    conditions: { StringEquals: { [`${prefix}:FullRepositoryId`]: githubRepo } },
  }));
}
