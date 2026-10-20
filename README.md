# Who gave the robot root?

This project is the live demo for the KodeKloud webinar *Who gave the robot root? Securing AI agents in your pipelines*.

It builds a small but real software delivery pipeline in AWS with an AI agent in it. The agent starts out with far more access than it needs, and during the session we take that access away one step at a time. You don't need much AWS experience to follow along. This README explains each AWS term the first time it matters and walks through every step.

## The idea in one minute

A **CI/CD pipeline** is an assembly line for code. Every time someone pushes a change, the pipeline tests it, reviews it, waits for a person to approve it, and then releases it.

Teams are now adding **AI agents** to these pipelines, for example to review each change. An agent is a program that uses an AI model to decide what to do next and then does it: reading files, running commands, calling AWS. Whatever access the pipeline gives the agent, the agent can use. In practice, agents often get far more access than their job needs. That is the "robot with root" in the title. (Root is the all-powerful admin account on a computer.)

This demo shows that risk happening and then fixes it:

```
 You push code to GitHub
          │
          ▼
 ┌─────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────┐
 │ Source  │──►│ Build        │──►│ Review       │──►│ Approve      │──►│ Deploy  │
 │ get the │   │ run the tests│   │ AI agent     │   │ a person     │   │ copy to │
 │ code    │   │ (+ policy    │   │ reviews the  │   │ clicks       │   │ release │
 │         │   │  check)      │   │ change       │   │ Approve      │   │ bucket  │
 └─────────┘   └──────────────┘   └──────┬───────┘   └──────────────┘   └─────────┘
                                         │
                       If the agent touches something it shouldn't,
                       an alarm fires (email + log entry).
```

## AWS terms you'll see

| Term | What it means in this project |
|---|---|
| **AWS account** | Your own space in AWS. Everything you create and pay for belongs to it. It is identified by a 12-digit number. |
| **Region** | Where in the world your resources live. This project uses **US East (N. Virginia)**, also written `us-east-1`. The AWS console shows one Region at a time, so check the selector at the top right if you can't find something. |
| **IAM role** | An identity that a program or AWS service uses, instead of a person. The agent runs as a role named `robot-root-agent`. |
| **IAM policy** | A JSON document listing what a role is allowed to do. `AdministratorAccess` is a built-in policy that allows everything. |
| **Permissions boundary** | A ceiling on a role. Even if someone grants the role more, it can never do more than its boundary allows. |
| **CodePipeline** | The AWS service that runs the stages in order. Our pipeline is named `robot-root`. |
| **CodeBuild** | Runs the commands for a stage on a short-lived machine that is thrown away afterwards. Test, Review, and the policy check each run here. |
| **CodeConnections** | The link that lets AWS read your GitHub repository. |
| **Amazon Bedrock** | The AWS service for calling AI models, including Claude. The agent is Claude Code calling Claude through Bedrock. |
| **S3 bucket** | Storage for files. The "release" bucket plays the part of production. |
| **Secrets Manager** | Storage for passwords and keys. We put a fake database password here as bait. |
| **KMS key** | An encryption key AWS uses to protect stored data. |
| **CloudTrail** | A log of every AWS action taken in the account: who did what, and when. |
| **EventBridge** | Watches for specific events, like "the agent read the fake password", and reacts to them. |
| **SNS** | Sends notifications. Here it sends alert emails. |
| **CloudWatch Logs** | Where programs write their output. You read the agent's review and the alerts here. |
| **CloudFormation stack** | A group of AWS resources created and deleted together from a template. This project makes two stacks: `RobotRootTripwire` and `RobotRootPipeline`. |
| **AWS CDK** | A tool that lets you describe AWS resources in TypeScript code. `cdk deploy` turns that code into CloudFormation stacks. |
| **SCP** | A rule set by whoever manages your company's AWS organization. It can block actions in your account even when your own permissions allow them. |

## Before you start

### 1. Use a sandbox account

> **Warning:** The "before" version of this demo deliberately gives the agent `AdministratorAccess`. A permissions boundary limits it to this project's own resources, but you should still deploy it only to a **sandbox account**: one used for learning, with nothing important in it. Never use a production account.

### 2. Install the tools

| Tool | Version | Check with | Get it from |
|---|---|---|---|
| Node.js | 22 or later | `node --version` | https://nodejs.org |
| AWS CLI | 2.32.0 or later | `aws --version` | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| Git | any recent | `git --version` | https://git-scm.com |

You also need a **GitHub account**.

### 3. Sign in to AWS from your terminal

```bash
aws login
```

A browser window opens. Sign in to your sandbox account and approve the request. This gives your terminal short-term credentials that refresh automatically and last up to 12 hours. Run `aws login` again whenever they expire.

Check that it worked:

```bash
aws sts get-caller-identity
```

You should see JSON with an `Account` (your 12-digit account number) and an `Arn` (who you are signed in as).

- **The browser doesn't open?** Run `aws login --remote`, which prints a link and a code you can use on another device.
- **Your company signs in through IAM Identity Center (SSO)?** Use the `aws sso login --profile <name>` command your company gave you instead.
- **Permission error after signing in?** Your user needs the `SignInLocalDevelopmentAccess` policy. Ask whoever manages the account to add it.

### 4. Turn on Claude in Amazon Bedrock

Claude models are available in Bedrock by default, but each account has two one-time steps before it can use one:

- Anthropic asks for a short use-case form. If your organization's management account already filled it in, you won't see it.
- The first call to each model signs the account up for that model through AWS Marketplace, and accepts the model's license terms. Whoever makes that first call needs the `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe`, and `aws-marketplace:ViewSubscriptions` permissions. Make this call yourself now. The pipeline's agent is deliberately not allowed to sign up for anything, so its first run would fail.

1. Open the AWS console and set the Region (top right) to **US East (N. Virginia)**.
2. Search for **Amazon Bedrock** and open it.
3. Go to **Model catalog**, choose **Claude Opus 4.5**, and open it in the playground.
4. If a use-case form appears, fill it in and submit.
5. Send a short message, such as "hello", and wait for a reply.
6. Check that the model is ready. The command should print `AVAILABLE`. Sign-up can take up to 15 minutes.

   ```bash
   aws bedrock get-foundation-model-availability --region us-east-1 \
     --model-id anthropic.claude-opus-4-5-20251101-v1:0 \
     --query agreementAvailability.status --output text
   ```

If the playground shows an error mentioning `explicit deny in a service control policy` or `AWS Marketplace actions`, your organization blocks Claude. See **Organization rules** under "Check before the live session".

The agent uses Claude Opus 4.5 for the review and for Claude Code's small background tasks. To use a cheaper model for the background tasks, turn it on with steps 3 to 5, then add `-c agentSmallModel=<inference profile ID>` when you deploy.

### 5. Put this project on GitHub

Create a new, empty repository on GitHub, then from this project's folder run:

```bash
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-github-name>/<your-repo>.git
git push -u origin main
```

The pipeline watches the `main` branch of this repository.

## Set it up

Setup takes about 15 minutes, most of it waiting.

### Step 1: Install the project's dependencies

```bash
cd infra
npm ci
```

`npm ci` installs the exact library versions recorded in `package-lock.json`.

### Step 2: Save two values for this terminal session

```bash
export REPO=<your-github-name>/<your-repo>
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

Later commands use `$REPO` and `$ACCOUNT`. These variables last only until you close the terminal window, so if you open a new one, run these two lines again.

### Step 3: Prepare the account for CDK (once per account)

```bash
npx cdk bootstrap aws://$ACCOUNT/us-east-1 -c githubRepo=$REPO
```

This creates a small stack named `CDKToolkit` that CDK uses to upload files during deploys. You only need to do it once per account and Region. CDK runs this project's code before bootstrapping, so it needs `githubRepo` here too. If you see `Set -c githubRepo=<owner>/<repo>`, `$REPO` is empty: run the two lines from Step 2 again.

### Step 4: Deploy the demo in its "before" state

```bash
npx cdk deploy --all \
  -c githubRepo=$REPO \
  -c agentProfile=overprivileged \
  -c alertEmail=<you@example.com>
```

- `--all` deploys both stacks.
- Each `-c name=value` is a setting. `agentProfile=overprivileged` means "start with every guardrail off". `alertEmail` is where alarm emails go; leave it out if you don't want email.
- CDK lists the permission changes it's about to make and asks `Do you wish to deploy these changes (y/n)?`. Type `y`. It may ask once for each stack.

The deploy usually takes 5 to 10 minutes. At the end, CDK prints **Outputs**, including:

- `PipelineUrl`: a link to your pipeline in the AWS console.
- `ConnectionArn`: the ID of the GitHub connection you approve in the next step.

### Step 5: Approve the GitHub connection

AWS can't read your repository until you approve the connection in the console. There is no command for this step.

1. In the AWS console, search for **CodePipeline** and open it.
2. In the left menu, choose **Settings**, then **Connections**.
3. Select **robot-root-github**. Its status shows **Pending**.
4. Choose **Update pending connection**.
5. Choose **Install a new app**. GitHub opens. Pick your repository, then choose **Install**. For a repository owned by a GitHub organization, an organization owner has to do this.
6. Back in AWS, choose **Connect**. The status changes to **Available**.

### Step 6: Confirm the alert email

If you set `alertEmail`, look for an email titled **AWS Notification - Subscription Confirmation** and choose **Confirm subscription**. Until you do, alerts only appear in the log (see below).

### Step 7: Run the pipeline

The pipeline tried to run once when it was created. That first run failed at **Source** because the GitHub connection wasn't approved yet, which is expected. Start it again in either of these ways:

- Open `PipelineUrl` and choose **Release change**, or
- Push any commit: `git commit --allow-empty -m "Run pipeline" && git push`

## Watching it run

Open `PipelineUrl` (or go to **CodePipeline > Pipelines > robot-root**). Each stage turns blue while it runs and green when it succeeds.

| You want to see | Where to look |
|---|---|
| **The agent's review** | In the **Review** stage, choose **View details** on the **Agent** action, then open the build logs. Scroll to `===== Agent review =====`. |
| **Everything the agent tried to do** | Same logs, under `===== Tool calls the agent made =====`. |
| **Approve the release** | In the **Approve** stage, choose **Review**, select **Approve**, then **Submit**. The **Deploy** stage then copies the app to the release bucket. |
| **Alarms** | Your email, or the CloudWatch console: **Logs > Log groups > `/robot-root/tripwire`**. Alarms can take a few minutes to arrive. |

## What the demo teaches: four guardrails

Each guardrail fixes one common mistake. You turn them on one at a time during the session.

| Guardrail | The mistake (guardrail off) | The fix (guardrail on) |
|---|---|---|
| `least-privilege` | The agent's role has `AdministratorAccess`, so it can do almost anything. A pointer to the "production database password" sits in its settings, where the agent can read it. | The agent can only call its AI model. Nothing secret is in its settings. |
| `agent-policy` | Claude Code runs with every safety check switched off (`--dangerously-skip-permissions`). Claude Code refuses to do that as an admin user, so the setting `IS_SANDBOX=1` silences the refusal. The repository being reviewed can also give the agent instructions through its own config files. | The agent runs under rules set by the platform team. It can read files, but it has no shell, no internet access, and can't change anything. It has a spending cap per run and ignores config files in the repository. |
| `supply-chain` | Claude Code is installed by downloading a script and running it (`curl ... \| bash`), at whatever version happens to be newest that day. | Claude Code is installed at one exact version, its download is checked against a recorded fingerprint, and npm verifies the package signatures. |
| `policy-gate` | Nothing checks whether a change weakens the agent's guardrails. | A policy check (cfn-guard) runs in the Build stage and stops the pipeline if a change breaks the rules, for example by giving the agent more permissions. |

Two safety nets stay on the whole time, because this runs live in a real account:

- **A permissions boundary on the agent.** Even with `AdministratorAccess`, the agent can only touch this project's own resources (names starting with `robot-root-`). Most teams that wire agents into pipelines don't have one.
- **A tripwire.** This is a fake production password (`robot-root/orders-db-prod`) and a fake production bucket (`robot-root-prod-exports-...`). Nothing real uses either, so if the agent touches one, or calls any AWS service outside its job, an alarm fires.

The agent's rules are built into the deployed infrastructure, not read from the repository. A change under review therefore cannot loosen the rules that review it. Changing the rules means deploying the infrastructure again.

## Running the webinar demo (presenter notes)

**Spot the over-privileged agent (poll).** Show `infra/lib/agent-access.ts`, and the **robot-root-agent** project in the CodeBuild console (its buildspec and environment variables). There are four answers, one per row of the table above.

**Break it.** Push a commit whose content asks the agent to do something outside a code review, such as checking that a deploy password works or cleaning up "unused" buckets. In the "before" state the agent has the access to comply. Show the tool calls in the Review logs, then the alarm. Also point out that the agent could write straight to the release bucket, so the human approval step protects nothing.

**Fix it, one step at a time.** Each command below turns on one more guardrail. Each deploy takes a minute or two. After each one, choose **Release change** to run the same commit again.

```bash
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=<you@example.com> -c guardrails=least-privilege
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=<you@example.com> -c guardrails=least-privilege,agent-policy
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=<you@example.com> -c guardrails=least-privilege,agent-policy,supply-chain
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=<you@example.com> -c agentProfile=hardened
```

Use the same email you used in Step 4. A deploy without `-c alertEmail` removes the email alerts, so keep it on every command. If you didn't set one in Step 4, leave it out here too. The last line turns on all four guardrails. To show exactly what a step changes, run the same command with `diff` instead of `deploy`. During a live session, add `--require-approval never` to skip the `y/n` prompt.

**Show the policy check.** With everything on, push a commit that gives the agent more permissions, for example by adding `iam:*` in `infra/lib/agent-access.ts`. The **PolicyGate** action in the Build stage fails, and the change never reaches Approve.

## What it costs

A sandbox account running this demo should cost only a few dollars a month, plus the AI model usage. You pay for:

| Item | Roughly |
|---|---|
| 4 KMS encryption keys | about $1 per key per month |
| AI model calls (Bedrock) | per agent review, capped by `-c agentBudgetUsd` (default $3 per run) |
| CodeBuild | a few cents per pipeline run |
| S3, CloudWatch Logs, Secrets Manager | cents per month at demo scale |

The CloudTrail trail's record of account activity is free, because it is the account's first trail. Watching the fake bucket adds a tiny charge. Delete everything when you're done (next section) to stop the monthly charges.

## Cleaning up

From the `infra` folder:

```bash
npx cdk destroy --all -c githubRepo=$REPO
```

Type `y` when asked. This deletes both stacks, the pipeline, the agent role, the GitHub connection, and the fake secret and bucket. A few things are left behind on purpose or by AWS design:

- **The CloudTrail log bucket** is kept, because audit logs usually should outlive what they recorded. Its files expire after 30 days. To delete it sooner, find the bucket whose name starts with `robotroottripwire-trailbucket` in the S3 console, choose **Empty**, then **Delete**.
- **The KMS keys** are scheduled for deletion and removed after AWS's waiting period.
- **The `CDKToolkit` stack** from Step 3 stays, because other CDK projects can use it. You can delete it in the CloudFormation console if you don't need it.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| `aws: command not found`, or `aws login` isn't recognized | AWS CLI missing or older than 2.32.0 | Install or update it (see the tools table). |
| `ExpiredToken` or `Unable to locate credentials` | Your sign-in expired | Run `aws login` again. |
| `cdk deploy` mentions bootstrap or `CDKToolkit` | Step 3 was skipped | Run Step 3, then deploy again. |
| You can't find the pipeline or other resources in the console | The console is showing a different Region | Set the Region selector (top right) to **US East (N. Virginia)**. |
| **Source** fails with a message about the connection | The GitHub connection isn't approved yet | Do Step 5, then choose **Release change**. |
| **Review** fails with `AccessDeniedException` mentioning Bedrock | Bedrock use-case form not submitted, the models were never tried in the playground, or an organization rule blocks Bedrock | Do "Turn on Claude in Amazon Bedrock". If the message says `explicit deny in a service control policy`, ask your AWS organization's admin. |
| **PolicyGate** fails | The change breaks a guardrail rule. That's the gate working. | Read the build logs for lines starting with `Violation:`. |
| A redeploy fails because `robot-root/orders-db-prod` already exists or is scheduled for deletion | The fake secret from an earlier deploy is still in Secrets Manager's recovery window | Run `aws secretsmanager restore-secret --secret-id robot-root/orders-db-prod`, then `aws secretsmanager delete-secret --secret-id robot-root/orders-db-prod --force-delete-without-recovery`, and deploy again. Do this only for this fake secret. |

## For developers

### What's in the project

```
app/                         The small app the pipeline tests and releases
buildspecs/build.yml         Commands for the Test step (owned by the app team, read from the repo)
infra/                       Everything AWS, written with the CDK in TypeScript
  bin/app.ts                 Entry point: creates the two stacks
  lib/config.ts              The settings (-c ...) and the four guardrails
  lib/agent-access.ts        The agent's IAM role and permissions boundary
  lib/buildspecs.ts          The commands the agent and policy-check steps run, per guardrail
  lib/pipeline-stack.ts      The pipeline, CodeBuild projects, and buckets
  lib/tripwire-stack.ts      The fake secret and bucket, CloudTrail, and alarms
  agent/managed-settings.json  The rules Claude Code runs under when agent-policy is on
  agent/review-prompt.md     The instructions given to the agent
  agent/package*.json        The pinned Claude Code version for supply-chain
  policy/agent-guardrails.guard  The cfn-guard rules the policy check enforces
  test/stacks.test.ts        Automated tests
```

### Running the tests

```bash
cd infra
npm run typecheck
CFN_GUARD=/path/to/cfn-guard npm test
```

The tests build both versions of the demo and check the permissions, pipeline, and alarms. If [cfn-guard](https://github.com/aws-cloudformation/cloudformation-guard) is installed, they also run the policy rules against the real output, including a change that tries to give the agent `iam:*`. Without cfn-guard, those three tests are skipped.

### Check before the live session

None of this has been run end to end in AWS yet. Do one full rehearsal and confirm:

- **Organization rules.** Company accounts often use organization rules (SCPs) to block Bedrock model calls until someone has reviewed the license terms. AWS recommends this pattern, so expect it. The demo was tried in two such accounts. One blocks every model tried, so the demo can't run there. The other allows Claude Opus 4.5 but blocks the AWS Marketplace sign-up for any other model, which is why the demo uses Opus 4.5 for both the review and the background tasks. To run the demo in an account like that, the organization's admin has to allow `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, and `bedrock:GetInferenceProfile` for the Claude model you use. Unless step 6 of "Turn on Claude in Amazon Bedrock" already prints `AVAILABLE`, they also have to allow `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe`, and `aws-marketplace:ViewSubscriptions` for that step's one-time first call. A model call that fails with `is not available for this account` isn't an SCP; the error points you to AWS Sales instead. To check an account before you deploy, run `aws iam simulate-principal-policy --policy-source-arn <your user or role ARN> --action-names bedrock:InvokeModel --resource-arns 'arn:aws:bedrock:us-east-1:<account>:inference-profile/us.anthropic.claude-opus-4-5-20251101-v1:0'`. If the result shows `"AllowedByOrganizations": false`, an SCP is blocking it.
- **The diff step.** The Review step can read the latest commit (`git show HEAD`) from CodeBuild's copy of the repository.
- **The install.** Claude Code's install step runs under CodeBuild's npm, and `jq` is available on the build machine (`amazonlinux-x86_64-standard:6.0`).
- **The buildspec size.** CodeBuild accepts the agent's buildspec, which is about 11 KB.
- **The spending cap.** `--max-budget-usd` takes effect when Claude Code runs on Bedrock.
- **Alert timing.** Alarms can lag a few minutes, so trigger the "break it" moment early or have a recording ready.
- **False alarms.** Check whether the out-of-bounds alarm fires during a normal review. If it does, adjust `EXPECTED_AGENT_EVENT_SOURCES` in `infra/lib/tripwire-stack.ts`.
