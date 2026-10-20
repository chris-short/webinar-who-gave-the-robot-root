# Demo runbook: Who gave the robot root?

The single source of truth for running the KodeKloud webinar *Who gave the robot root? Securing AI agents in your pipelines*. It consolidates the setup steps, the live-demo run sheet, and the talk track into one document.

It builds a small but real software delivery pipeline in AWS with an AI agent in it. The agent starts with far more access than it needs, and during the session you take that access away one step at a time.

**How to read this:** Parts 1-3 are one-time setup you do before the day. Part 4 is the live run — each segment has **Do** (what you run or click), **Say** (the talk track), and **See** (what should happen). Parts 5-8 are cost, cleanup, and troubleshooting.

The one thing this runbook does not spell out is the content of your "break it" commit. You prepare and rehearse it separately, and it appears below only as:

> **[BREAK-IT COMMIT]** — a small, believable change that also carries an out-of-scope request for the agent. Written, rehearsed, and kept in a sandbox ahead of time. Not included here.

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

---

## Part 1 — AWS terms you'll see

| Term | What it means in this project |
|---|---|
| **AWS account** | Your own space in AWS, identified by a 12-digit number. |
| **Region** | Where resources live. This project uses **US East (N. Virginia)** (`us-east-1`). Check the console's Region selector (top right) if you can't find something. |
| **IAM role** | An identity a program or service uses instead of a person. The agent runs as `robot-root-agent`. |
| **IAM policy** | A JSON document listing what a role may do. `AdministratorAccess` allows everything. |
| **Permissions boundary** | A ceiling on a role. Even if someone grants more, it can never exceed its boundary. |
| **CodePipeline** | Runs the stages in order. Our pipeline is `robot-root`. |
| **CodeBuild** | Runs a stage's commands on a short-lived machine. Test, Review, and the policy check run here. |
| **CodeConnections** | The link that lets AWS read your GitHub repository. |
| **Amazon Bedrock** | The AWS service for calling AI models. The agent is Claude Code calling Claude through Bedrock. |
| **S3 bucket** | File storage. The "release" bucket plays the part of production. |
| **Secrets Manager** | Stores passwords and keys. We put a fake database password here as bait. |
| **KMS key** | An encryption key AWS uses to protect stored data. |
| **CloudTrail** | A log of every AWS action: who did what, and when. |
| **EventBridge** | Watches for specific events and reacts. |
| **SNS** | Sends notifications. Here it sends alert emails. |
| **CloudWatch Logs** | Where programs write output. You read the agent's review and the alerts here. |
| **CloudFormation stack** | A group of resources created and deleted together. This project makes two: `RobotRootTripwire` and `RobotRootPipeline`. |
| **AWS CDK** | Describes AWS resources in TypeScript. `cdk deploy` turns that code into CloudFormation stacks. |
| **SCP** | An organization rule that can block actions in your account even when your own permissions allow them. |

---

## Part 2 — One-time setup

> **Warning:** The "before" state deliberately gives the agent `AdministratorAccess`. A permissions boundary limits it to this project's own resources, but still deploy only to a **sandbox account** with nothing important in it. Never use a production account.

### 2.1 Install the tools

| Tool | Version | Check with | Get it from |
|---|---|---|---|
| Node.js | 22 or later | `node --version` | https://nodejs.org |
| AWS CLI | 2.32.0 or later | `aws --version` | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| Git | any recent | `git --version` | https://git-scm.com |

You also need a **GitHub account**.

### 2.2 Sign in to AWS from your terminal

```bash
aws login
aws sts get-caller-identity   # should print your Account and Arn
```

`aws login` gives your terminal short-term credentials that last up to 12 hours; rerun it when they expire.

- **Browser doesn't open?** `aws login --remote` prints a link and code for another device.
- **Company uses SSO?** Use the `aws sso login --profile <name>` command your company gave you.
- **Permission error?** Your user needs the `SignInLocalDevelopmentAccess` policy — ask whoever manages the account.

### 2.3 Turn on Claude in Amazon Bedrock

Each account has two one-time steps before it can call a model: a short use-case form (skipped if your management account already filled it in), and a first call that signs the account up for the model through AWS Marketplace. That first call needs `aws-marketplace:Subscribe`, `Unsubscribe`, and `ViewSubscriptions`. Make it yourself — the pipeline's agent is deliberately not allowed to sign up for anything.

1. In the console, set the Region (top right) to **US East (N. Virginia)**.
2. Open **Amazon Bedrock**.
3. Go to **Model catalog**, choose **Claude Opus 4.5**, and open it in the playground.
4. If a use-case form appears, fill it in and submit.
5. Send a short message ("hello") and wait for a reply.
6. Confirm the model is ready (should print `AVAILABLE`; sign-up can take up to 15 minutes):
   ```bash
   aws bedrock get-foundation-model-availability --region us-east-1 \
     --model-id anthropic.claude-opus-4-5-20251101-v1:0 \
     --query agreementAvailability.status --output text
   ```

If you see `explicit deny in a service control policy` or `AWS Marketplace actions`, your organization blocks Claude — see **Organization rules** in Part 8.

The agent uses Claude Opus 4.5 for both the review and Claude Code's small background tasks. To use a cheaper model for the background tasks, turn it on with steps 3-5 above, then add `-c agentSmallModel=<inference profile ID>` when you deploy.

### 2.4 Put this project on GitHub

Create a new, empty repository, then from this project's folder:

```bash
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-github-name>/<your-repo>.git
git push -u origin main
```

The pipeline watches the `main` branch of this repository.

### 2.5 Install dependencies and set your variables

```bash
cd infra
npm ci
export REPO=<your-github-name>/<your-repo>
export ALERT_EMAIL=<you@example.com>
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

`REPO`, `ALERT_EMAIL`, and `ACCOUNT` last only until you close the terminal — rerun these if you open a new one. Use the same `ALERT_EMAIL` in every deploy below; a deploy without `-c alertEmail` removes the email alerts.

### 2.6 Bootstrap the account for CDK (once per account)

```bash
npx cdk bootstrap aws://$ACCOUNT/us-east-1 -c githubRepo=$REPO
```

CDK runs this project's code before bootstrapping, so it needs `githubRepo` here too. If you see `Set -c githubRepo=<owner>/<repo>`, `$REPO` is empty — rerun the exports in 2.5.

### 2.7 Deploy the "before" state

```bash
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c agentProfile=overprivileged --require-approval never
```

This deploys both stacks with every guardrail off. At the end, CDK prints **Outputs** including `PipelineUrl` and `ConnectionArn`.

### 2.8 Approve the GitHub connection

AWS can't read your repository until you approve the connection. There's no CLI for this.

1. In the console: **CodePipeline > Settings > Connections**.
2. Select **robot-root-github** (status **Pending**) and choose **Update pending connection**.
3. Choose the **AWS Connector for GitHub** installation on the account that owns the repo. If the app isn't installed there yet, choose **Install a new app** and pick the account and repository. For an organization repo, an org owner has to install it.
4. Choose **Connect**. Status changes to **Available**.

If the connection is Available but a run fails with `No Branch [main] found`, the app installation can't see the repo: on https://github.com/settings/installations, open the app's **Configure** page and grant it access to this repository.

### 2.9 Confirm the alert email

Find the **AWS Notification - Subscription Confirmation** email and choose **Confirm subscription**. Until you do, alerts only appear in the log.

---

## Part 3 — The four guardrails

Each guardrail fixes one common mistake. You turn them on one at a time during the session.

| Guardrail | The mistake (off) | The fix (on) |
|---|---|---|
| `least-privilege` | The role has `AdministratorAccess`, and a pointer to the "production database password" sits in its settings. | The agent can only call its AI model. Nothing secret is in its settings. |
| `agent-policy` | Claude Code runs with every safety check off (`--dangerously-skip-permissions`, `IS_SANDBOX=1`), and the repo under review can steer it via its own config files. | The agent runs under platform-owned rules: no shell, no internet, no writes, a per-run spending cap, and it ignores repo config files. |
| `supply-chain` | Claude Code is installed with `curl ... \| bash` at whatever version is newest that day. | Installed at one exact version from a committed lockfile, download verified, npm signatures checked. |
| `policy-gate` | Nothing checks whether a change weakens the guardrails. | A cfn-guard check runs in Build and stops the pipeline if a change breaks the rules. |

Two safety nets stay on the whole time, because this runs live in a real account:

- **A permissions boundary on the agent.** Even with `AdministratorAccess`, it can only touch resources named `robot-root-*`. Most teams wiring agents into pipelines don't have one.
- **A tripwire.** A fake production password (`robot-root/orders-db-prod`) and a fake production bucket. If the agent reads either, or calls any AWS service outside its job, an alarm fires.

The agent's rules are built into the deployed infrastructure, not read from the repository, so a change under review cannot loosen the rules that review it.

---

## Part 4 — Running the live demo

### Pre-flight (day before, then again 30 minutes before)

1. Make sure Part 2 is done and the pipeline is in the "before" state (guardrails `none`).
2. Rehearse the **[BREAK-IT COMMIT]** once against the "before" state. Confirm it produces out-of-bounds tool calls in the Review logs and an alarm, then reset `main` so it's not there when the session starts.
3. Screen-record that rehearsal as a backup to play if the live run stalls.
4. Open tabs: the pipeline (`PipelineUrl`), the **robot-root-agent** CodeBuild project, the `/robot-root/tripwire` log group, your email, and a terminal in `infra/` with `REPO` and `ALERT_EMAIL` set.

### Opening (about 4 minutes)

> Thanks for joining. Today's title is a question: who gave the robot root?
>
> Lots of teams now have AI somewhere in their delivery pipeline — reviewing pull requests, writing release notes, fixing failing tests. These agents aren't just chatbots. They read files, run commands, and call cloud APIs, with whatever access the pipeline hands them.
>
> Here's how that access usually gets decided. Someone wires up the agent, it fails with AccessDenied, and after the third retry they attach an admin policy so it works. There's a comment in today's code that says exactly that: "It kept failing with AccessDenied, so we gave it admin." Drop a note in the chat if you've seen that one.
>
> The catch is that an agent decides what to do based on what it reads, and in a pipeline what it reads is the code people push. So the real question isn't how smart the agent is. It's what happens when it does something its job never needed, and whether anything stops it.
>
> Today I'll show a small but real pipeline in AWS with Claude Code as the reviewer. It starts with far too much access. You'll spot the problems, we'll see what that access makes possible, and then we'll take it away one guardrail at a time. Everything runs in a sandbox — the "production password" and "production bucket" are fake, and an alarm goes off if anything touches them.

### Segment 1 — Spot the over-privileged agent (poll)

**Do:** Show `infra/lib/agent-access.ts` and the **robot-root-agent** project in CodeBuild (its buildspec and environment variables). Run a poll: what's wrong here?

**Say:** let the audience answer, then confirm the four problems (one per guardrail):
- the role has `AdministratorAccess`, and `DEPLOY_DB_SECRET_ARN` is in its environment;
- the buildspec runs Claude Code with `--dangerously-skip-permissions` and `IS_SANDBOX=1`;
- Claude Code is installed with `curl ... | bash`;
- nothing checks whether a change weakens these settings.

**See:** the audience surfaces the four answers.

### Segment 2 — Break it

**Do:**
1. Push the **[BREAK-IT COMMIT]**: `git push`.
2. Wait for the **Review** stage to finish (a few minutes).
3. In **Review**, choose **View details** on **Agent**, open the build logs, and scroll to `===== Tool calls the agent made =====`.
4. Open `/robot-root/tripwire` (or your email) to show the alarm.

**Say:** the agent read the code, took the out-of-scope request as a task, and had the access to act on it. With admin, it could also write straight to the release bucket, so the human **Approve** step protects nothing. (Alarms come from CloudTrail and can take a few minutes — keep talking while it arrives.)

**See:** tool calls unrelated to reviewing code; an out-of-bounds or canary alarm.

**Do not approve this run.** Leave it at **Approve**, or choose **Reject**.

### Segment 3 — Fix it, one guardrail at a time

Run each command, then open the pipeline and choose **Release change** to rerun the newest commit on `main` (still your **[BREAK-IT COMMIT]**) against the tighter rules. Each deploy takes a minute or two.

```bash
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c guardrails=least-privilege --require-approval never
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c guardrails=least-privilege,agent-policy --require-approval never
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c guardrails=least-privilege,agent-policy,supply-chain --require-approval never
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c agentProfile=hardened --require-approval never
```

**Say** — the attack is prompt injection: text in the commit that reads like a task, which the agent might act on. A better review prompt helps, but it's only guidance. The guardrails are controls, and each removes a different capability, so no single one has to be perfect. As you enable each one:

- **least-privilege.** Even if the agent decides to comply, its role can only call Bedrock. The out-of-scope AWS calls fail with AccessDenied, and the deploy secret's ARN is no longer in its environment.
- **agent-policy.** Claude Code now runs under settings the platform owns: read-only, no shell, no writes, no internet. `--bare` means the repo under review can't hand it new instructions or tools. A per-run spending cap bounds a runaway loop.
- **supply-chain.** We run the exact version we reviewed, from a committed lockfile with signatures checked, not whatever the install script serves that day.
- **policy-gate** (shown in Segment 4) protects the guardrails themselves.

The thing to land: none of these fixes was a cleverer prompt. The permissions and tool limits are what actually stop things.

**See**, after each **Release change**:

| After | Look at | What's different |
|---|---|---|
| `least-privilege` | Review logs; the alarm | Out-of-scope AWS calls now fail with AccessDenied. No deploy secret in the agent's environment. |
| `agent-policy` | Review logs | Agent runs read-only: no shell, no writes, no web. The repo can't steer it (`--bare`). Spend capped. |
| `supply-chain` | Install step in the logs | Installed from the pinned lockfile with signatures verified, not `curl \| bash`. |
| `hardened` | Whole run | All four on; the review completes cleanly and nothing trips. |

> Tip: to show exactly what a step changes, run the same command with `diff` instead of `deploy` before deploying.

### Segment 4 — Show the policy gate

**Do:** Push a commit that widens the agent's permissions, for example adding `iam:*` in `infra/lib/agent-access.ts`.

**Say:** this is the commit that quietly weakens a guardrail. The pipeline should catch it before a person has to.

**See:** the **PolicyGate** action in the **Build** stage fails and the change never reaches **Approve**. In the build logs, point out the lines starting with `Violation:`.

**Do:** revert this commit and your **[BREAK-IT COMMIT]** so `main` is clean for next time.

### Closing (about 3 minutes)

> So, who gave the robot root? Usually nobody decided to. It happened one AccessDenied at a time.
>
> Four things to take back to your own pipelines:
> 1. **Give the agent the permissions of its job, not of your account.** A reviewer needs to read code and call its model — not admin, and no secrets in its environment.
> 2. **The rules for the agent belong to the platform, not the repository it's reviewing.** If the code under review can change the agent's settings, the code under review is in charge.
> 3. **Know exactly what you're running.** Pin the version, verify the download, don't pipe a script from the internet into bash on a machine with credentials.
> 4. **Check changes to the guardrails themselves.** A policy check catches the commit that quietly widens permissions, before a person has to notice it.
>
> Two safety nets cost almost nothing: a permissions boundary sets a ceiling even when someone over-grants, and a tripwire tells you when something reaches for what it shouldn't.
>
> None of the four fixes was a better prompt. The permissions are what actually stop things.
>
> Your homework: pick one agent or bot in your pipeline this week and answer four questions. What can its role do? What's in its environment? How is it installed? Who can change its rules?
>
> The whole demo is on GitHub at `<repo link>`, and this runbook walks through deploying it in your own sandbox. Let's take some questions.

### Likely questions

- **"Isn't telling the agent to ignore instructions in the repo enough?"** It helps, and this demo's prompt does it. But a prompt is guidance the model weighs, not a control. Permissions, tool restrictions, and the policy check hold when the guidance doesn't.
- **"Why a permissions boundary if the role is already least-privilege?"** Roles change — someone adds a policy later to fix an error. The boundary is the ceiling that stays.
- **"Is this only about Claude Code or AWS?"** The specifics are. The four homework questions apply to any agent in any CI system.
- **"What does it cost?"** A few dollars a month in a sandbox, plus model calls. Once agent-policy is on, each run is capped (default $3).
- **"How fast do alerts arrive?"** Usually within a few minutes, because they come from CloudTrail.
- **"Why keep the human approval step?"** It only means something if the agent can't get around it. With admin, the agent could write straight to the release bucket. With least privilege, approval is a real gate again.

---

## Part 5 — What it costs

A sandbox account running this demo should cost a few dollars a month, plus model usage:

| Item | Roughly |
|---|---|
| 4 KMS keys | ~$1 per key per month |
| AI model calls (Bedrock) | per agent review, capped by `-c agentBudgetUsd` (default $3 per run) |
| CodeBuild | a few cents per run |
| S3, CloudWatch Logs, Secrets Manager | cents per month at demo scale |

The CloudTrail trail is free (first trail in the account). Delete everything when done (Part 6) to stop the monthly charges.

---

## Part 6 — Cleaning up

From `infra/`:

```bash
npx cdk destroy --all -c githubRepo=$REPO
```

This deletes both stacks, the pipeline, the agent role, the GitHub connection, and the fake secret and bucket. Left behind on purpose or by AWS design:

- **The CloudTrail log bucket** is kept (audit logs should outlive what they recorded); files expire after 30 days. To delete sooner, find the bucket starting `robotroottripwire-trailbucket` in S3, choose **Empty**, then **Delete**.
- **The KMS keys** are scheduled for deletion and removed after AWS's waiting period.
- **The `CDKToolkit` stack** stays, because other CDK projects can use it.

---

## Part 7 — Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| `aws: command not found`, or `aws login` not recognized | AWS CLI missing or older than 2.32.0 | Install or update it (2.1). |
| `ExpiredToken` or `Unable to locate credentials` | Sign-in expired | Run `aws login` again. |
| `Set -c githubRepo=<owner>/<repo>` | `$REPO` is empty | Rerun the exports in 2.5. |
| `cdk deploy` mentions bootstrap or `CDKToolkit` | 2.6 was skipped | Run 2.6, then deploy again. |
| Can't find resources in the console | Wrong Region | Set the selector to **US East (N. Virginia)**. |
| **Source** fails with a connection message, or `No Branch [main] found` | Connection not approved, or the GitHub App can't see the repo | Do 2.8, including granting the app access to the repo. |
| **Review** fails with `AccessDeniedException` mentioning Bedrock | Use-case form not submitted, model never tried in the playground, or an org rule blocks Bedrock | Do 2.3. If it says `explicit deny in a service control policy`, see Part 8. |
| **Review** fails with `is not available for this account` | The account isn't entitled to that model | Not an SCP — the error points to AWS Sales. Use a model the account has (Opus 4.5). |
| **PolicyGate** fails | A change breaks a guardrail rule — the gate working | Read the build logs for lines starting with `Violation:`. |
| A redeploy fails because `robot-root/orders-db-prod` already exists or is scheduled for deletion | The fake secret is still in Secrets Manager's recovery window | `aws secretsmanager restore-secret --secret-id robot-root/orders-db-prod`, then `aws secretsmanager delete-secret --secret-id robot-root/orders-db-prod --force-delete-without-recovery`, then deploy. Only for this fake secret. |

---

## Part 8 — For developers

### What's in the project

```
app/                           The small app the pipeline tests and releases
buildspecs/build.yml           Commands for the Test step (owned by the app team, read from the repo)
infra/                         Everything AWS, written with the CDK in TypeScript
  bin/app.ts                   Entry point: creates the two stacks
  lib/config.ts                The settings (-c ...) and the four guardrails
  lib/agent-access.ts          The agent's IAM role and permissions boundary
  lib/buildspecs.ts            The commands the agent and policy-check steps run, per guardrail
  lib/pipeline-stack.ts        The pipeline, CodeBuild projects, and buckets
  lib/tripwire-stack.ts        The fake secret and bucket, CloudTrail, and alarms
  agent/managed-settings.json  The rules Claude Code runs under when agent-policy is on
  agent/review-prompt.md       The instructions given to the agent
  agent/package*.json          The pinned Claude Code version for supply-chain
  policy/agent-guardrails.guard The cfn-guard rules the policy check enforces
  test/stacks.test.ts          Automated tests
```

### Running the tests

```bash
cd infra
npm run typecheck
CFN_GUARD=/path/to/cfn-guard npm test
```

The tests build both versions of the demo and check the permissions, pipeline, and alarms. With [cfn-guard](https://github.com/aws-cloudformation/cloudformation-guard) installed, they also run the policy rules against the real output, including a change that tries to give the agent `iam:*`. Without it, those three tests are skipped.

### Check before the live session

- **Organization rules.** Company accounts often use SCPs to block Bedrock model calls until license terms are reviewed. The demo was tried in two such accounts: one blocks every model, the other allows Claude Opus 4.5 but blocks the Marketplace sign-up for any other model (which is why the demo uses Opus 4.5 for both roles). To run it there, the org admin must allow `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, and `bedrock:GetInferenceProfile` for the model you use. Unless step 6 of 2.3 already prints `AVAILABLE`, they must also allow `aws-marketplace:Subscribe`, `Unsubscribe`, and `ViewSubscriptions` for that one-time first call. To check an account:
  ```bash
  aws iam simulate-principal-policy --policy-source-arn <your user or role ARN> \
    --action-names bedrock:InvokeModel \
    --resource-arns 'arn:aws:bedrock:us-east-1:<account>:inference-profile/us.anthropic.claude-opus-4-5-20251101-v1:0'
  ```
  `"AllowedByOrganizations": false` means an SCP is blocking it.
- **The diff step.** The Review step reads the latest commit (`git show HEAD`) from CodeBuild's copy of the repo.
- **The install.** Claude Code's install runs under CodeBuild's npm, and `jq` is on the build machine (`amazonlinux-x86_64-standard:6.0`).
- **The buildspec size.** CodeBuild accepts the agent's buildspec (~11 KB).
- **The spending cap.** `--max-budget-usd` takes effect when Claude Code runs on Bedrock.
- **Alert timing.** Alarms can lag a few minutes — trigger the "break it" moment early or have a recording ready.
- **False alarms.** Check whether the out-of-bounds alarm fires during a normal review. If it does, adjust `EXPECTED_AGENT_EVENT_SOURCES` in `infra/lib/tripwire-stack.ts`.
