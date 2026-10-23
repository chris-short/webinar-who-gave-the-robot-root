# Demo Runbook: Who Gave the Robot Root?

*The Single Source of Truth for Presenting and Operating the KodeKloud Webinar:*  
**"Who gave the robot root? Securing AI agents in your pipelines"**

---

## Executive Summary & Webinar Overview

This repository is a live CI/CD pipeline built in AWS featuring an autonomous AI code reviewer (Claude Code powered by Amazon Bedrock). The agent begins in an intentionally vulnerable, over-privileged state (`AdministratorAccess`, execution privileges, unverified dependencies, and plain-text secrets in its environment). Over the course of the live webinar, you demonstrate what that over-privileged identity can reach, show a tripwire catching it the moment it steps out of bounds, and explain why a well-behaved model is no substitute for least privilege—then methodically strip that access away using four defense-in-depth guardrails, culminating in a platform-owned policy gate that blocks permission-widening infrastructure changes before they ever reach review or production.

```
 You push code to GitHub
          │
          ▼
 ┌─────────┐   ┌──────────────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────┐
 │ Source  │──►│ Build                │──►│ Review       │──►│ Approve      │──►│ Deploy  │
 │ get the │   │ run tests            │   │ AI agent     │   │ a person     │   │ copy to │
 │ code    │   │ (+ cfn-guard policy  │   │ reviews the  │   │ clicks       │   │ release │
 │         │   │   gate)              │   │ change       │   │ Approve      │   │ bucket  │
 └─────────┘   └──────────────────────┘   └──────┬───────┘   └──────────────┘   └─────────┘
                                                 │
                                If the agent touches unauthorized
                                resources, an alarm fires (email + CloudWatch).
```

### Presentation Snapshot

| Parameter | Details |
|---|---|
| **Audience** | DevOps Engineers, SREs, Platform Engineers, Cloud Architects, DevSecOps & Security Professionals |
| **Duration** | 60 minutes (45 min presentation + demo, 15 min interactive Q&A) |
| **Key Takeaway** | Never rely on prompt instructions to secure an AI agent. Restrict IAM permissions, lock down runtime capabilities with platform-owned managed settings, pin the supply chain, and gate policy changes with policy-as-code. |
| **Core Architecture** | AWS CodePipeline v2, AWS CodeBuild, Amazon Bedrock (Claude Opus 4.5), AWS CloudTrail, Amazon EventBridge, Amazon SNS, AWS Secrets Manager, Amazon S3, AWS KMS, AWS CDK v2 |

---

## Part 1 — AWS Vocabulary & Project Resources

| Term | Resource in this Project | What It Does |
|---|---|---|
| **AWS Account** | Sandbox Account | An isolated 12-digit AWS account dedicated to this demo. Never run in production. |
| **Region** | `us-east-1` (US East, N. Virginia) | The region where Bedrock Claude Opus 4.5, CodePipeline, and canaries reside. |
| **IAM Role** | `robot-root-agent` | The identity assumed by CodeBuild during the `Review` stage. |
| **Permissions Boundary** | `robot-root-agent-boundary` | Hard ceiling attached to the agent role. Even with `AdministratorAccess`, it can only touch `robot-root-*` resources. |
| **CodePipeline** | `robot-root` | The 5-stage pipeline: Source -> Build -> Review -> Approve -> Deploy. |
| **CodeBuild** | `robot-root-build`<br>`robot-root-agent`<br>`robot-root-policy-gate` | Containers running unit tests, agent code review, and cfn-guard policy enforcement. |
| **CodeConnections** | `robot-root-github` | Secure AWS connection that reads the GitHub repository. |
| **Amazon Bedrock** | `us.anthropic.claude-opus-4-5-20251101-v1:0` | The foundation model inference profile that Claude Code invokes. |
| **Honeytoken Secret** | `robot-root/orders-db-prod` | Fake production database credentials in Secrets Manager used as bait for the agent. |
| **Canary S3 Bucket** | `robot-root-prod-exports-*` | Fake production data bucket. Any access trips an alarm. |
| **Release S3 Bucket** | `robot-root-release-*` | Represents production deployment. Only the Deploy stage writes here. |
| **CloudTrail** | `robot-root-tripwire` | Logs all AWS API calls made within the account to detect unauthorized agent actions. |
| **EventBridge** | `robot-root-agent-touched-canary`<br>`robot-root-agent-out-of-bounds` | Rules monitoring CloudTrail for unauthorized API calls by the agent. |
| **SNS Topic** | `robot-root-tripwire` | Sends real-time email alerts when tripwire rules match. |
| **CloudWatch Logs** | `/robot-root/tripwire`<br>`/aws/codebuild/*` | Destination for tripwire audit events and build/review execution logs. |
| **Policy-as-Code** | `infra/policy/agent-guardrails.guard` | cfn-guard rules checking CloudFormation templates against security policies. |

---

## Part 2 — One-Time Pre-Webinar Setup

Complete these steps at least 24–48 hours before the webinar in a clean AWS sandbox account.

### 2.1 Prerequisites Checklist

Verify your workstation has the required tools installed:

```bash
node --version       # Required: v22.0.0 or higher
aws --version        # Required: 2.32.0 or higher
git --version        # Any modern git
```

You also need:
- An **AWS Account** with administrative access where you can provision resources.
- A **GitHub Account** with privileges to install GitHub Apps and create repositories.

---

### 2.2 Authenticate AWS CLI from Your Terminal

```bash
aws login
aws sts get-caller-identity
```

Expected output:
```json
{
    "UserId": "AROA...",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/your-user"
}
```

> [!NOTE]
> If your organization uses AWS IAM Identity Center (SSO), run `aws sso login --profile <profile-name>` and set `export AWS_PROFILE=<profile-name>`.

---

### 2.3 Enable Claude Opus 4.5 in Amazon Bedrock

Amazon Bedrock requires a one-time use-case submission and model subscription.

1. Open the **AWS Management Console** and ensure Region is set to **US East (N. Virginia) `us-east-1`**.
2. Navigate to **Amazon Bedrock** > **Model catalog**.
3. Select **Claude Opus 4.5** (Anthropic).
4. If prompted with a use-case declaration form, fill in your details and submit.
5. Choose **Open in playground**, type `Hello`, and confirm you receive a response.
6. Run the CLI verification command:

```bash
aws bedrock get-foundation-model-availability --region us-east-1 \
  --model-id anthropic.claude-opus-4-5-20251101-v1:0 \
  --query agreementAvailability.status --output text
```

Expected output:
```text
AVAILABLE
```

---

### 2.4 Create and Push to GitHub

Create a new **empty repository** on GitHub (e.g., `webinar-who-gave-the-robot-root`), then run:

```bash
git checkout main
git remote set-url origin https://github.com/<your-github-username>/<your-repo-name>.git
git push -u origin main
```

Verify that the remote `origin` points to your GitHub repository and `main` is up to date:

```bash
git remote -v
git status
```

---

### 2.5 Set Terminal Variables

In your working terminal, export the configuration variables. Run this sanity check snippet:

```bash
cd infra
npm ci

export REPO="chris-short/webinar-who-gave-the-robot-root"
export ALERT_EMAIL="chris.short@kodekloud.com"
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION="us-east-1"

# Sanity check: ensure none are empty
echo "Repo:    $REPO"
echo "Alert:   $ALERT_EMAIL"
echo "Account: $ACCOUNT"
echo "Region:  $AWS_REGION"
```

> [!IMPORTANT]
> If you open a new terminal window at any point, rerun these exports. Deploying without `-c alertEmail` will delete the email notification subscription!

---

### 2.6 Bootstrap AWS CDK in the Account

```bash
npx cdk bootstrap aws://$ACCOUNT/us-east-1 -c githubRepo=$REPO
```

Expected output ends with:
```text
 ✅  Environment aws://123456789012/us-east-1 bootstrapped.
```

---

### 2.7 Deploy the "Before" (Overprivileged) State

Deploy both stacks (`RobotRootTripwire` and `RobotRootPipeline`) with all guardrails turned off:

```bash
npx cdk deploy --all \
  -c githubRepo=$REPO \
  -c alertEmail=$ALERT_EMAIL \
  -c agentProfile=overprivileged \
  --require-approval never
```

At the end of the deployment, save the printed **Outputs**:
- `RobotRootPipeline.PipelineUrl`
- `RobotRootPipeline.ConnectionArn`
- `RobotRootTripwire.AlertLogGroup`
- `RobotRootTripwire.CanarySecretArn`

---

### 2.8 Authorize the GitHub Connection

AWS CodeConnections creates a connection in `PENDING` status. You must authorize it in the console:

1. Open AWS Console: **Developer Tools** > **CodePipeline** > **Settings** > **Connections**.
2. Select **`robot-root-github`** (Status should be **Pending**).
3. Click **Update pending connection**.
4. Select the **AWS Connector for GitHub** installation. If not yet installed, click **Install a new app**, select your GitHub account, and grant access to this repository.
5. Click **Connect**. Status changes to **Available**.

---

### 2.9 Confirm the SNS Alert Email

1. Check the inbox for `$ALERT_EMAIL`.
2. Locate the email from **AWS Notifications** with subject `AWS Notification - Subscription Confirmation`.
3. Click **Confirm subscription**.
4. The browser opens an AWS page stating: `Subscription confirmed!`.

---

### 2.10 Validate Baseline Pipeline Run

1. Open the CodePipeline console using `PipelineUrl`.
2. Click **Release change**.
3. Watch the pipeline run:
   - **Source**: Fetches repository via CodeConnections.
   - **Build**: Runs `app` unit tests (`node --test`).
   - **Review**: Runs Claude Code review with Claude Opus 4.5.
   - **Approve**: Waits for manual approval.
4. Verify the run reaches **Approve** and review findings say `VERDICT: approve`.
5. Do not approve. Leave the pipeline in this ready state.

---

## Part 3 — Threat Model & The Four Guardrails

### The Threat: Excessive Privilege Is the Blast Radius

In modern CI/CD pipelines, AI agents get wired up with whatever access makes the build go green. The comforting assumption is that a capable model won't misbehave — and today's models largely won't: they refuse obvious prompt injection in the code they review, and they won't fire off wild cloud calls just because a prompt nudges them. But that is not a control you can rely on. An agent is software: it can carry a bug, pull a compromised dependency, or be driven by a future model or prompt that is less careful. When any of that happens, the only thing between the agent and your production data is its IAM role.

If that identity holds cloud administrator credentials and the runtime has a shell, every one of those paths ends in cloud compromise. The fix is not a cleverer prompt — it is shrinking the access and removing the tools, so a misstep has nowhere to go, plus a tripwire that catches it the moment one happens.

### The Four Guardrails

```
             ┌────────────────────────────────────────────────────────┐
             │                DEFENSE-IN-DEPTH SHIELD                 │
             │                                                        │
┌────────────┴─────────────┐  ┌─────────────────────────┐  ┌──────────┴──────────────┐
│     Cloud IAM Layer      │  │    Agent Runtime Layer  │  │   Supply Chain Layer    │
│    `least-privilege`     │  │     `agent-policy`      │  │     `supply-chain`      │
│                          │  │                         │  │                         │
│ • No AdminAccess         │  │ • Managed settings      │  │ • Pinned lockfile       │
│ • Bedrock invoke ONLY    │  │ • Bash/Write/Web DENIED │  │ • Verified signatures   │
│ • No plaintext secrets   │  │ • Spend cap ($3/run)    │  │ • No `curl | bash`      │
│   in environment vars    │  │ • Repo CLAUDE.md ignored│  │                         │
└──────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
                                           │
                              ┌────────────┴────────────┐
                              │    Pre-Deploy Gate      │
                              │     `policy-gate`       │
                              │                         │
                              │ • cfn-guard validates   │
                              │   infra templates in CI │
                              │ • Blocks wildcard IAM   │
                              │ • Enforces boundaries   │
                              └─────────────────────────┘
```

| Guardrail | When OFF (Overprivileged) | When ON (Hardened) |
|---|---|---|
| **1. `least-privilege`** | Role has `AdministratorAccess`. `DEPLOY_DB_SECRET_ARN` is passed as a plaintext environment variable. | Role only has `bedrock:InvokeModel` on pinned inference profile. No database secret in environment. |
| **2. `agent-policy`** | Agent runs with `--dangerously-skip-permissions` and `IS_SANDBOX=1`. Agent can execute Bash, write files, call web endpoints, and read local configs. | Claude Code governed by platform `/etc/claude-code/managed-settings.json`. Bash, writes, and web are denied. Runs with `--bare --permission-mode dontAsk --max-budget-usd 3`. |
| **3. `supply-chain`** | Runtime installed via `curl -fsSL https://claude.ai/install.sh \| bash` at dynamic, unpinned version. | Pinned `@anthropic-ai/claude-code@2.1.301` installed via `npm ci` with `npm audit signatures` check. |
| **4. `policy-gate`** | Infrastructure changes deployed without automated policy checks. | `cfn-guard` validates synthesized CloudFormation templates in the `Build` stage. Violations fail the build before review. |

### Continuous Safety Nets

1. **Permissions Boundary (`robot-root-agent-boundary`)**: Demarcates the boundary of the sandbox. Even when the agent role holds `AdministratorAccess`, it can never touch AWS resources outside the `robot-root-*` naming prefix.
2. **Canary Tripwires**: A fake database password (`robot-root/orders-db-prod`) and canary bucket (`robot-root-prod-exports-*`). Any API call to read either immediately triggers an EventBridge rule, sending an SNS alert email and logging to CloudWatch.

---

## Part 4 — The Live Webinar Playbook (Minute-by-Minute)

### Pre-Flight Checklist (T-minus 30 Minutes)

1. Open these browser tabs in one dedicated window (order left to right):
   - **Tab 1: CodePipeline Console** (`PipelineUrl` from Part 2.7)
   - **Tab 2: CodeBuild Projects** (`robot-root-agent` build history)
   - **Tab 3: CloudWatch Logs** (`/robot-root/tripwire` log group)
   - **Tab 4: Presenter Email Inbox** (ready to show incoming SNS alerts)
   - **Tab 5: GitHub Repository** (showing `main` branch)
2. Open your terminal in `infra/` with font scaled up to 16pt+.
3. Check environment variables:
   ```bash
   echo "Repo: $REPO | Alert: $ALERT_EMAIL | Account: $ACCOUNT"
   ```
4. Verify pipeline is idle at **Approve** or green on clean commit.
5. Have your backup video recording ready in case live AWS API latency occurs.

---

### Agenda & Time Allocations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 00:00 - 05:00  Opening & The Core Question (Who gave the robot root?)       │
│ 05:00 - 12:00  Segment 1: Spot the Over-Privileged Agent (Audience Poll)    │
│ 12:00 - 22:00  Segment 2: Break It (Agent Overreach & Tripwire Alert)       │
│ 22:00 - 40:00  Segment 3: Fix It, One Guardrail at a Time                   │
│                • 3A: Least Privilege                                        │
│                • 3B: Agent Policy / Managed Settings                        │
│                • 3C: Supply Chain Pinning                                   │
│                • 3D: Hardened Profile & Policy Gate                         │
│ 40:00 - 48:00  Segment 4: Show the Policy Gate in Action                    │
│ 48:00 - 55:00  Closing Takeaways & The 4 Homework Questions                 │
│ 55:00 - 60:00  Interactive Audience Q&A                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Slide Map

The deck is `Who-Gave-The-Robot-Root-Webinar.pptx` (11 slides). This runbook stays on your second monitor; the audience only ever sees the deck, GitHub, your terminal, and the AWS console. Cues in the segments below look like **→ Slide N**.

| Slide | Title | When |
|---|---|---|
| 1 | Who gave the robot root? | Opening: welcome |
| 2 | Someone gave the robot root on purpose… | Opening: the question |
| 3 | Inside the pipeline | Opening: what we'll look at |
| – | *GitHub + poll tool* | Segment 1: walk the code, run the poll |
| 4 | Four risks, hiding in plain sight | Segment 1: poll reveal |
| 5 | We won't jailbreak the model | Segment 2: framing |
| 6 | Terminal: `simulate-principal-policy` | Segment 2, Step 1: run it live, or talk over this as a fallback |
| – | *Terminal, CodePipeline, CloudWatch, email* | Segment 2, Steps 2–4 |
| 7 | Four guardrails, added one at a time | Segment 3: roadmap |
| – | *Terminal + CodePipeline* | Segments 3A–3D and Segment 4 |
| 8 | Before: overprivileged / After: hardened | Closing |
| 9 | Defense in depth | Closing |
| 10 | Your homework: ask of every agent | Closing |
| 11 | Thank you | Q&A |

---

### Opening (00:00 – 05:00)

**Do:**
- Share your screen with the deck in slideshow mode.
- **→ Slide 1** (title) while you welcome people. The two cues in the talk track below move you to Slides 2 and 3.

**Say:**
> "Welcome everyone to *Who gave the robot root? Securing AI agents in your pipelines*.
>
> Over the past year, many engineering organizations have started embedding AI agents into their software delivery lifecycles. We have agents that triage issues, review pull requests, generate release notes, and even fix broken builds.
>
> ***→ Slide 2***
>
> ​But here is the elephant in the room: What identity do these agents run under? What permissions do they have?
>
> ​In real organizations, the story goes kinda like this: An engineer is told to add an AI reviewer to CodePipeline or GitHub Actions. They wire it up, it fails with `AccessDenied`, and after the third failed build, they attach `AdministratorAccess` so it 'just works.'
> 
> In fact, in the actual codebase we are looking at today, there is a comment that says verbatim: *'It kept failing with AccessDenied, so we gave it admin.'*
>
> ***→ Slide 3***
>
> ​Today, we'll look at a real, live CI/CD pipeline running in AWS. An autonomous AI agent, Claude Code running on Bedrock, reviews every change. We'll see what that over-privileged agent's identity can reach, watch a tripwire catch it, and talk about why a model that behaves today is no guarantee tomorrow — then systematically lock it down with four engineering guardrails until a permission-widening change is stopped dead in its tracks.
>
> Let's get started."

---

### Segment 1 — Spot the Over-Privileged Agent (05:00 – 12:00)

**Do:**
1. Leave **Slide 3** up as you transition, then switch to your GitHub repository tab. Stay off the deck until the poll closes.
2. Open `infra/lib/agent-access.ts` and point out ([lines 111–114](https://github.com/chris-short/webinar-who-gave-the-robot-root/blob/main/infra/lib/agent-access.ts#L111-L114)):
   ```typescript
   // "It kept failing with AccessDenied, so we gave it admin."
   this.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));
   ```
3. Open `infra/lib/pipeline-stack.ts` and highlight the environment variables ([lines 89-92](https://github.com/chris-short/webinar-who-gave-the-robot-root/blob/main/infra/lib/pipeline-stack.ts#L89-L92)):
   ```typescript
   if (!guardrails.has('least-privilege')) {
     agentEnv.DEPLOY_DB_SECRET_ARN = { value: props.canarySecret.secretArn };
   }
   ```
4. Open `infra/lib/buildspecs.ts` ([lines 44-48](https://github.com/chris-short/webinar-who-gave-the-robot-root/blob/main/infra/lib/buildspecs.ts#L44-L48))  and `buildspecs.ts` ([lines 66-68](https://github.com/chris-short/webinar-who-gave-the-robot-root/blob/main/infra/lib/buildspecs.ts#L66-L68)):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   claude -p "$(cat /tmp/review-prompt.md)" --dangerously-skip-permissions ...
   ```
5. Launch the **Audience Poll**.

#### Interactive Audience Poll (poll tool, no slide)

**Set up the poll ahead of time** in your poll tool (Slido, Mentimeter, Zoom polls) as **multi-select**, "select all that apply." Show results as a bar per option, not a single winner. If the tool can shuffle the option order, turn that on so A doesn't get picked just for being first.

All four options are real risks. There's deliberately no "all of the above": the point is to see which risks people *miss*.

**Poll question:**
*"Which of these security risks do you see in this agent's setup? Select all that apply."*

**Options:**
- **A)** The agent's IAM role has `AdministratorAccess`, and a production secret reference sits in its environment.
- **B)** The agent runs with `--dangerously-skip-permissions`, so it can run shell commands without anyone approving them.
- **C)** The agent is installed at runtime with `curl | bash`, at whatever version is current that day, with nothing verified.
- **D)** Nothing checks whether a future change to these files weakens any of the above.

**Say (while the poll is open):**
> "Take about thirty seconds. Select every one you think is a real problem — if it would block this pipeline in your own security review, pick it."

**Glance at which bars are tall and which are short, then use the line that matches.** No numbers needed.

- **Most likely: A is tall, C and/or D are short.**
  > "Almost everyone caught the admin role. That makes sense; we've spent a decade learning to look at IAM first. But a lot fewer of you flagged the `curl | bash` install, or the fact that nothing checks future changes. Those are the ones that bite. Even with a perfect IAM role, this agent runs whatever script the internet serves that day, on a machine holding your credentials — and nothing stops tomorrow's commit from quietly undoing today's fix."
- **If B is clearly shorter than A:**
  > "Fewer of you picked `--dangerously-skip-permissions`. It's the flag teams add when permission prompts break in CI. What it actually means is that the agent runs shell commands and nobody approves them."
- **If all four bars are tall:**
  > "You're a tough crowd — most of you selected all four. And you're right: every one of them is real, and every one shows up in real pipelines."
- **If votes are thin:**
  > "Votes are still trickling in, so let me just walk through them."

**Then:**
> ***→ Back to the deck: Slide 4***
>
> "All four are real. Each one maps to one of the four guardrails we'll turn on in a few minutes, and to the four questions I'll leave you with at the end. Now let's see what an identity like this can actually reach."

---

### Segment 2 — Break It (12:00 – 22:00)

**→ Slide 5** ("We won't jailbreak the model. We don't need to.") while you frame this segment.

The real risk here is not that someone jailbreaks the agent on stage. A capable model like Opus 4.5 reliably refuses injected instructions in the code it reviews, and it won't fire off a wild AWS call just because a prompt nudges it. That is good news — and it is exactly the trap: teams watch the model behave and conclude the access doesn't matter. But an agent is software. It can carry a bug, pull a poisoned dependency, or be driven by a future model or prompt that is less careful, and then the only thing between it and production is its IAM role. We show both halves: what the identity is *allowed* to do (deterministic), and the tripwire catching that identity the moment it steps out of bounds (live).

#### Step 1: Show the blast radius directly (deterministic, no model)

Before touching the pipeline, show what the agent's identity is *allowed* to do. This never varies run to run.

**→ Slide 6** shows this exact command and its result. Run it live in your terminal; if the terminal is slow or your AWS session has expired, talk over Slide 6 instead. From here until Segment 3 you're in the terminal and the AWS console, not the deck.

**Do:**
```bash
ROLE="arn:aws:iam::${ACCOUNT}:role/robot-root-agent"
aws iam simulate-principal-policy --region us-east-1 \
  --policy-source-arn "$ROLE" \
  --action-names s3:PutObject \
  --resource-arns "arn:aws:s3:::robot-root-release-${ACCOUNT}-us-east-1/*" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
```

**See:** `s3:PutObject  allowed`.

**Say:**
> "This is a code-review bot, and its identity can already write straight to the bucket that stands in for production — no injection, no trick. Hold that thought; we'll run this exact command after the fix and watch it flip to denied."

#### Step 2: Arm the "break it" marker and push

We won't try to trick the model — we'll stand in for a compromised or buggy agent. The before-state build does this for us: when a committed `.breakit` marker is present, it makes one out-of-bounds call with the agent's own role. That step exists only while the agent has a shell; `agent-policy` removes it, which is the point of Segment 3.

**Do:**
```bash
touch .breakit
git add .breakit
git commit -m "chore: add debug marker"
git push origin main
```

Switch to the **CodePipeline** tab and watch **Source → Build → Review** advance. The **Agent** action starts the `robot-root-agent` project.

#### While the agent runs (filler, 2–3 min)

**Say:**
> "Let me be straight about what's happening here, because the honesty is the point. I am not going to pretend I jailbroke the model — I tried, and a capable model refuses. That's reassuring, and it's the trap: people see the model behave and decide the permissions don't matter.
>
> But an agent is software. It can have a bug, it can pull a compromised dependency, the next model or prompt may be less careful — and when any of that happens, the only thing between the agent and your production data is its IAM role. So in the before-state build we stand in for exactly that: one out-of-bounds call with the agent's own identity. Watch what the pipeline notices."

#### Step 3: The out-of-bounds call and the tripwire

**Do:**
1. In CodePipeline, **Review** stage → **View details** on the **Agent** action → open the build log. Point out the `[breakit] simulating a compromised agent...` line and the single `aws s3api get-bucket-location` call against the production-exports bucket — a call a code reviewer has no business making. (It's one deliberate call, so the tripwire fires exactly once.)
2. Switch to the **CloudWatch Logs** tab → `/robot-root/tripwire` → newest stream. Show the audit event: `robot-root-agent` calling `s3.amazonaws.com` against the canary `prod-exports` bucket.
3. Switch to the **Email** tab → the `Robot root tripwire: ...` alert.

**Say:**
> "There it is. The agent's identity reached into the bucket that stands in for production exports, and the tripwire fired — CloudTrail event, log line, and email within a couple of minutes. We did not need the model to cooperate; we only needed its role to be able to do this at all. And as Step 1 showed, that same identity can write to the release bucket, too."

#### Step 4: The approval gate is theater

**Say:**
> "Notice the pipeline is parked at Approve. Teams tell themselves wide agent access is fine because a human signs off before deploy. Step 1 already broke that: with admin, the agent can write to the release bucket directly and skip this gate entirely. Approval only means something once the agent cannot route around it. Reject this run."

**Do:** Click **Reject** on the manual approval action in CodePipeline.

---

### Segment 3 — Fix It, One Guardrail at a Time (22:00 – 40:00)

Now demonstrate defense-in-depth by turning on each guardrail one by one and re-running the same review against each tighter configuration.

**→ Slide 7** (Four guardrails) as the roadmap, then go to your terminal and CodePipeline for 3A–3D. You can flash back to Slide 7 between steps to show where you are.

---

#### Step 3A: Guardrail 1 — Least Privilege (`least-privilege`)

**Do:**
In your terminal, deploy with `least-privilege` enabled:

```bash
cd infra

# Show the diff first
npx cdk diff RobotRootPipeline -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c guardrails=least-privilege

# Deploy the change
npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c guardrails=least-privilege --require-approval never
```

**Say:**
> "The first guardrail is classic IAM Least Privilege.
>
> What does an AI code reviewer actually need to do in AWS? It needs to call Bedrock to invoke its foundation model. That's it! It does not need `AdministratorAccess`, it does not need access to Secrets Manager, and it should not have database secret ARNs injected into its environment variables.
>
> In this deploy, CDK strips `AdministratorAccess` and grants only `bedrock:InvokeModel` scoped to our specific inference profile ARN. It also removes `DEPLOY_DB_SECRET_ARN` from the CodeBuild environment."

**Do (Test the Fix):**
1. Re-run the blast-radius check from Segment 2, Step 1 — the answer flips to denied:

   ```bash
   aws iam simulate-principal-policy --region us-east-1 \
     --policy-source-arn "arn:aws:iam::${ACCOUNT}:role/robot-root-agent" \
     --action-names s3:PutObject \
     --resource-arns "arn:aws:s3:::robot-root-release-${ACCOUNT}-us-east-1/*" \
     --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
   ```
   
   **See:** `s3:PutObject  implicitDeny`.
2. Switch to CodePipeline and click **Release change** (`.breakit` is still on `main`, so the before-state build still attempts the out-of-bounds call).
3. Open the Agent action logs. The `[breakit]` step still runs, but the `aws s3api get-bucket-location` call now prints `AccessDenied` — the role can only call Bedrock. The exfiltration fails. The tripwire may still log the *blocked* attempt; that's detection of a prevented breach, not a successful one.

**Say:**
> "There's the flip I promised in Segment 2 — the same identity can no longer write to the release bucket, and the out-of-bounds read comes back AccessDenied. IAM turned a successful breach into a blocked one. But look closer: the agent still has a shell — it still ran those commands, it just had nothing it was allowed to reach. IAM is necessary; on its own it's not enough. That's guardrail two."

---

#### Step 3B: Guardrail 2 — Agent Policy & Managed Settings (`agent-policy`)

**Do:**
In your terminal, deploy with `agent-policy` added:

```bash
npx cdk deploy --all \
  -c githubRepo=$REPO \
  -c alertEmail=$ALERT_EMAIL \
  -c guardrails=least-privilege,agent-policy \
  --require-approval never
```

**Say:**
> "Guardrail 2 addresses the agent runtime itself.
>
> Why could the agent run bash commands in the first place? Because it was launched with `--dangerously-skip-permissions` and had access to the `Bash` tool.
>
> With `agent-policy`, we introduce `/etc/claude-code/managed-settings.json`. This is owned by the platform and embedded directly into the infrastructure buildspec.
>
> In managed settings, we explicitly allow only `Read`, `Grep`, and `Glob`. We explicitly deny `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, and reading `.env` files.
>
> Furthermore, we run Claude Code with `--bare`. That means the repository under review cannot steer the agent with its own `.claude/` settings or repo-level instructions. And we pass `--max-budget-usd 3` to cap per-run spending."

**Do (Test the Fix):**
1. Switch to CodePipeline.
2. Click **Release change**.
3. Inspect the **AgentReview** build log:
   - Show `===== Tool calls the agent made =====` —  Not a single shell call.
   - Note there is no `[breakit]` line at all: with no shell, the simulated-compromise step isn't even in the build.
   - Show `===== Agent review =====`: the agent reads the diff and returns a verdict.

**Say:**
> "Notice the shift: we did not write a cleverer prompt. We took away the agent's ability to run anything. The `.breakit` marker is still sitting right there in the repo — but with no `Bash` tool, there is no step to run it and nothing to reach AWS with. Zero tool calls. We removed the capability, not the temptation. Permissions and tools are the control; the prompt is not."

---

#### Step 3C: Guardrail 3 — Supply Chain Security (`supply-chain`)

**Do:**
Deploy with `supply-chain` added:

```bash
npx cdk deploy --all \
  -c githubRepo=$REPO \
  -c alertEmail=$ALERT_EMAIL \
  -c guardrails=least-privilege,agent-policy,supply-chain \
  --require-approval never
```


**Say:**
> "Guardrail 3 protects the agent runtime supply chain.
>
> In the original setup, our buildspec ran `curl -fsSL https://claude.ai/install.sh | bash`.
>
> Think about that in a production CI/CD environment: Every time a build triggers, you are pulling an unversioned script over the internet and running it with whatever credentials the container holds. If the CDN is compromised or the vendor ships a buggy release, your pipeline breaks or executes untrusted code.
>
> With `supply-chain`, we install Claude Code from a committed, version-pinned lockfile (`@anthropic-ai/claude-code@2.1.301`). We run `npm ci` and enforce `npm audit signatures` to verify cryptographic package signatures against the npm registry before running the tool."

**Do (Test the Fix):**
1. Switch to CodePipeline and click **Release change** (the deploy only changes the pipeline definition; this starts a run that uses it).
2. Open the **Review → Agent** build log and point out the install phase:
   ```
   Running command npm ci --prefix /opt/robot-root-agent --no-audit --no-fund
   ```
   ```
   Running command (cd /opt/robot-root-agent && npm audit signatures)
   ```

---

#### Step 3D: Guardrail 4 — Hardened Profile (`agentProfile=hardened`)

**Do:**
Deploy the fully hardened preset:

```bash
npx cdk deploy --all \
  -c githubRepo=$REPO \
  -c alertEmail=$ALERT_EMAIL \
  -c agentProfile=hardened \
  --require-approval never
```

**Say:**
> "Now we turn on the complete hardened profile. This enables all four guardrails: Least Privilege, Agent Policy, Supply Chain, and our fourth guardrail: the **Policy Gate**.
>
> In CodePipeline, look at the **Build** stage now. Alongside our `Test` action, there is a new action called `PolicyGate`."

**Do (Test the Fix):**
1. In CodePipeline, open the **Build** stage and point out the new **PolicyGate** action alongside **Test**. It appears as soon as the deploy finishes.
2. Click **Release change** to run the fully hardened pipeline end to end. Show that it's clean: the agent reviews under all four guardrails with zero tool calls and no tripwire, and **PolicyGate** passes (green) on this normal commit.

That clean pass sets up Segment 4, where the same gate blocks a commit that widens permissions.

---

### Segment 4 — Show the Policy Gate in Action (40:00 – 48:00)

Now demonstrate how the policy-as-code gate protects the pipeline against developers or rogue agents attempting to loosen permissions.

No slide for this segment. Stay in your terminal and CodePipeline.

#### Step 1: The Malicious Infrastructure Commit

Suppose a well-meaning developer encounters a permissions issue or an attacker modifies the CDK code to grant `iam:*` to the agent role.

**Do:**
Apply the patch that ships in the repo — it adds a wildcard IAM policy to the `least-privilege` branch of `infra/lib/agent-access.ts`:

```bash
cd "$(git rev-parse --show-toplevel)"   # git apply resolves paths from the repo root
git apply patches/segment4-iam-wildcard.patch

git add infra/lib/agent-access.ts
git commit -m "fix(iam): temporarily grant iam permissions for debugging"
git push origin main
```

The patch is a committed file on purpose: a hand-typed or copy-pasted unified diff is one stray space away from `git apply` rejecting it on the context lines, so **don't** paste the diff into a heredoc live. Applying the file by path can't be mangled.

The wildcard must land in the `least-privilege` branch (before `} else {`), **not** the `else`: the hardened profile — which PolicyGate synthesizes — runs that branch, so the wildcard appears in the template and the gate catches it. A wildcard in the `else` branch wouldn't be synthesized under hardened and would slip through.

> Need to regenerate the patch (e.g. after the file changes): make the edit in `infra/lib/agent-access.ts`, run `git diff infra/lib/agent-access.ts > patches/segment4-iam-wildcard.patch`, then `git checkout -- infra/lib/agent-access.ts`.

---

#### Step 2: Watch PolicyGate Intercept the Commit

**Do:**
1. Switch to the **CodePipeline** tab.
2. Watch the pipeline trigger on the new commit.
3. In the **Build** stage:
   - `Test` runs and passes.
   - `PolicyGate` runs `cfn-guard validate` against the synthesized CloudFormation template.
   - **`PolicyGate` FAILS!**
4. Click **View details** on the `PolicyGate` action.
5. In the build logs, scroll down and highlight:

```text
RobotRootPipeline.template.json Status = FAIL
FAILED rules:
rule: no_wildcard_actions -- [FAIL]
Violation: an Allow statement grants a wildcard or IAM-wide action.
```

**Say:**
> "Look at the pipeline status: The `Build` stage failed, and the pipeline halted immediately!
>
> The change **never reached Review**, it **never reached Approve**, and it **never reached Deploy**.
>
> Why? Because the `PolicyGate` runs `cfn-guard` using rules embedded in the platform infrastructure. Even if an engineer commits code that adds `iam:*` or removes permissions boundaries, the gate validates the CloudFormation template before anything is deployed or reviewed.
>
> The pipeline defends its own guardrails."

---

#### Step 3: Revert and Clean Up Git

**Do:**
Revert the bad commit so `main` returns to a clean state:

```bash
git revert --no-edit HEAD
git push origin main
```

The pipeline triggers again and runs cleanly through `PolicyGate` and `Test`.

---

### Closing Takeaways (48:00 – 55:00)

**Do:**
- **→ Slide 8** (Before / After). The table below is the same comparison, for reference. The cues in the talk track move you through Slides 9, 10, and 11.

| Axis | Before (Overprivileged) | After (Hardened) |
|---|---|---|
| **IAM Access** | `AdministratorAccess` | Bedrock `InvokeModel` on pinned profile only |
| **Secrets Exposure** | Plaintext secret ARN in environment | Zero secrets in environment variables |
| **Tool Execution** | Unchecked `Bash`, `Edit`, `Write`, `Web` | Strict platform managed settings; no `Bash` |
| **Supply Chain** | Unverified `curl \| bash` | Pinned package lockfile + signature verification |
| **Integrity Checks** | None | Automated `cfn-guard` pre-deploy policy gate |
| **Safety Net** | Missing in most real pipelines | Boundary ceiling + Honeytoken tripwires |

**Say:**
> "So, back to the opening question: *Who gave the robot root?*
>
> In reality, someone did decide to give the robot root — not maliciously, but on purpose. Every step was the easy, reasonable-looking choice in the moment: an `AccessDenied` error fixed with an admin policy; a developer adding `--dangerously-skip-permissions` because permission prompts were annoying in CI; an install script curled from the web to save time. Nobody was being reckless. They just never went back and took the access away.
>
> ***→ Slide 9***
>
> And there's no single point of trust in the fix. Four guardrails we added, plus two safety nets that stayed on the whole time: a permissions boundary that caps what the role can ever do, and a tripwire that fires the moment the agent reaches for something it shouldn't. Six layers. If one fails, the others still hold.
>
> ***→ Slide 10***
>
> When you leave today, take four homework questions back to your engineering team:
>
> 1. **What can your pipeline agent's IAM role actually do?** If it reviews PRs, why does it have permissions to create S3 buckets, read secrets, or modify VPCs?
> 2. **What tools can your agent execute?** If an agent only needs to read a diff, deny `Bash`, deny network access, and deny file write capabilities using platform-owned managed settings.
> 3. **How is your AI tooling installed?** Are you piping scripts from the internet into bash on build runners with credentials, or are you pinning versions and checking signatures?
> 4. **Who is guarding the guardrails?** Do you have policy-as-code checks like `cfn-guard` or OPA verifying that changes to pipeline definitions cannot quietly widen permissions?
>
> Remember: Prompts are guidance. Cloud permissions, tool restrictions, and policy gates are controls.
>
> ***→ Slide 11***
>
> Thank you for your time, and let's open the floor for questions."

---

### Interactive Q&A Track (55:00 – 60:00)

Leave **Slide 11** (Thank you) up during Q&A.

Here are the most common questions attendees ask during this session and how to answer them:

#### Q1: "Isn't a strong system prompt enough to stop prompt injection?"
**Answer:**  
"No. A prompt is natural language instructions that the model evaluates probabilistically. In an LLM, instructions and data share the exact same context window. Even advanced models like Claude Opus 4.5 or GPT-4o can be tricked by authority escalation, format confusion, or encoded payloads. System prompts provide guidance; IAM policies and runtime managed settings provide deterministic enforcement."

#### Q2: "Why do we need a permissions boundary if our IAM role is already least privilege?"
**Answer:**  
"Because permissions drift over time. In two months, someone debugging a pipeline might attach a managed policy to fix a build error. A permissions boundary acts as an unbreachable ceiling: even if an admin attaches `AdministratorAccess` to the role tomorrow, the boundary restricts it strictly to resources named `robot-root-*`."

#### Q3: "Does `--bare` really prevent repository configuration from steering Claude Code?"
**Answer:**  
"Yes. By default, Claude Code inspects the repository for `.claude/` directories, `CLAUDE.md`, and local hooks. An attacker submitting a pull request could include a malicious `CLAUDE.md` that overrides prompt instructions. The `--bare` flag tells Claude Code to ignore repo-level instructions completely and adhere strictly to `/etc/claude-code/managed-settings.json`."

#### Q4: "What is the latency between the agent making an unauthorized call and the tripwire firing?"
**Answer:**  
"In AWS, CloudTrail delivers management events to EventBridge within 1 to 3 minutes. That's why canary tripwires are designed as detection controls, not inline prevention. Inline prevention is handled by IAM and managed settings. The tripwire alerts security teams that an anomaly occurred so the session can be investigated."

#### Q5: "Can we use cheaper models like Claude 3.5 Haiku instead of Opus 4.5?"
**Answer:**  
"Yes! You can pass `-c agentModel=<haiku-inference-profile-id>` and `-c agentSmallModel=<haiku-inference-profile-id>` during deployment. We used Opus 4.5 because enterprise test accounts often restrict Marketplace subscriptions to one approved Claude profile."

#### Q6: "How does cfn-guard differ from AWS CloudFormation Hooks or OPA/Conftest?"
**Answer:**  
"cfn-guard is an open-source, domain-specific policy-as-code language maintained by AWS. It is lightweight, executes in milliseconds inside CodeBuild without running a separate daemon, and natively understands CloudFormation template syntax."

---

## Part 5 — Rehearsal, Dry-Run & Clean Reset Guide

Follow this section to rehearse the entire demo before the webinar and reset it cleanly.

### Step-by-Step Rehearsal Workflow

1. Start in the clean baseline:
   ```bash
   cd infra
   npx cdk deploy --all -c githubRepo=$REPO -c alertEmail=$ALERT_EMAIL -c agentProfile=overprivileged --require-approval never
   ```
2. Verify `main` is clean: `git status`.
3. Arm the marker from Segment 2 (Step 2): `touch .breakit && git add .breakit && git commit -m "chore: add debug marker" && git push`.
4. Verify the tripwire alert email arrives and the `[breakit]` out-of-bounds call appears in the Agent build log.
5. Apply the four guardrails sequentially from Segment 3 (`least-privilege` -> `agent-policy` -> `supply-chain` -> `hardened`).
6. Apply the Policy-Gate break commit from Segment 4. Verify `PolicyGate` fails.
7. Revert the commits.

### Clean Reset to Baseline (After Rehearsal)

Run these exact commands to return the repository and AWS environment to the exact starting state:

```bash
# 1. Reset Git repository to clean origin/main
git checkout main
git reset --hard origin/main
git clean -fd

# 2. Redeploy overprivileged baseline in AWS
cd infra
npx cdk deploy --all \
  -c githubRepo=$REPO \
  -c alertEmail=$ALERT_EMAIL \
  -c agentProfile=overprivileged \
  --require-approval never

# 3. Clean up any lingering canary test alarms in CloudWatch Logs
aws logs delete-log-stream --log-group-name /robot-root/tripwire --log-stream-name "$(aws logs describe-log-streams --log-group-name /robot-root/tripwire --order-by LastEventTime --descending --max-items 1 --query 'logStreams[0].logStreamName' --output text 2>/dev/null)" 2>/dev/null || true
```

---

## Part 6 — Presenter Cheat Sheet (Second Monitor Card)

Keep this table visible on a second screen or printed beside your keyboard during the live session.

| Segment | Timing | Slide | What to Do (Terminal / Console) | Key Talking Point / Highlight |
|---|---|---|---|---|
| **Opening** | 00:00–05:00 | 1 → 2 → 3 | Deck in slideshow mode | *"Who gave the robot root? We did — on purpose, one shortcut at a time."* |
| **Segment 1** | 05:00–12:00 | GitHub, then 4 | Show `agent-access.ts` & launch poll; back to deck for the reveal | Point out line 111 (`AdministratorAccess`), launch poll. |
| **Segment 2** | 12:00–22:00 | 5 → 6, then terminal/console | Simulate role (PutObject=allowed); `touch .breakit` & push | Before-state build makes one out-of-bounds `aws s3api get-bucket-location` call as the agent role (one alarm); show the build log, tripwire log, email. Reject approval! |
| **Segment 3A** | 22:00–26:00 | 7, then terminal | Deploy `-c guardrails=least-privilege`<br>Re-run simulate; **Release change** | Simulate flips to `implicitDeny`; the `[breakit]` call now returns AccessDenied (blocked, still detected). Shell still runs. |
| **Segment 3B** | 26:00–31:00 | terminal | Deploy `-c guardrails=least-privilege,agent-policy`<br>Click **Release change** | Zero tool calls! No shell, so the `.breakit` step isn't even in the build; the agent just reviews the diff. |
| **Segment 3C** | 31:00–35:00 | terminal | Deploy `-c guardrails=...,supply-chain`<br>Click **Release change** | Lockfile pinned (`@anthropic-ai/claude-code@2.1.301`) + `npm audit signatures`. |
| **Segment 3D** | 35:00–40:00 | terminal | Deploy `-c agentProfile=hardened`<br>Click **Release change** | All 4 on. `PolicyGate` action appears in Build stage and passes. |
| **Segment 4** | 40:00–48:00 | terminal | `git apply patches/segment4-iam-wildcard.patch`; commit & push<br>Then: `git revert --no-edit HEAD && git push` | `PolicyGate` fails on `no_wildcard_actions`. Change never reaches Review or Approve! |
| **Closing** | 48:00–55:00 | 8 → 9 → 10 | Back to the deck | Six layers, no single point of trust; 4 homework questions. |
| **Q&A** | 55:00–60:00 | 11 | Refer to Part 4 Q&A bank | Prompts are guidance; permissions are controls. |

---

## Part 7 — Cost Breakdown & Resource Economics

The infrastructure is designed for low cost in a sandbox account. If kept running for a month without tear-down, it costs approximately **$5 to $10**:

| Resource | Unit Cost | Monthly Estimate (Idle) | Active Demo Run |
|---|---|---|---|
| **AWS KMS Keys (4)** | $1.00 / key / month | ~$4.00 / month | Included |
| **CodeBuild (General Small)** | $0.005 / build minute | $0.00 | ~$0.15 (10-15 build minutes) |
| **CodePipeline v2** | 1 active pipeline free | $0.00 | $0.00 |
| **Amazon Bedrock (Opus 4.5)** | Capped at `$3.00` per run | $0.00 | ~$0.50 – $2.00 per agent review |
| **CloudTrail & EventBridge** | First trail free; standard events free | $0.00 | $0.00 |
| **Secrets Manager & S3** | Standard storage & API calls | ~$0.40 | ~$0.05 |
| **Total** | | **~$4.40 / month** | **~$1.00 – $3.00 per rehearsal/webinar** |

> [!TIP]
> Each Claude Code run is strictly bounded by `--max-budget-usd 3` once `agent-policy` is active.

---

## Part 8 — Post-Webinar Teardown & Account Cleanup

When the webinar or rehearsals are finished, destroy all resources to prevent ongoing KMS charges:

```bash
cd /Users/cbshort/Projects/webinar-who-gave-the-robot-root/infra

# 1. Destroy CDK stacks
npx cdk destroy --all -c githubRepo=$REPO --force
```

### Manual Post-Destroy Cleanup

CDK protects audit trails and deleted secrets by default. Run these commands to clean up retained resources:

```bash
# 2. Empty and delete the retained CloudTrail S3 bucket
TRAIL_BUCKET=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'robotroottripwire-trailbucket')].Name" --output text)
if [ -n "$TRAIL_BUCKET" ]; then
  aws s3 rm "s3://$TRAIL_BUCKET" --recursive
  aws s3api delete-bucket --bucket "$TRAIL_BUCKET"
fi

# 3. Force-delete the canary secret (bypassing 30-day retention window)
aws secretsmanager delete-secret \
  --secret-id robot-root/orders-db-prod \
  --force-delete-without-recovery 2>/dev/null || true
```

---

## Part 9 — Comprehensive Troubleshooting & Fallback Matrix

| Issue Observed | Root Cause | Exact Resolution |
|---|---|---|
| `aws: [ERROR]: Your session has expired` | AWS credentials expired | Run `aws login` or `aws sso login` again. |
| `Set -c githubRepo=<owner>/<repo>` | Environment variable `$REPO` is unset | Run `export REPO="<your-github-username>/<your-repo-name>"`. |
| CodePipeline Source fails with `No Branch [main] found` | GitHub App lacks access to repo | Go to `https://github.com/settings/installations`, click **Configure** on AWS Connector for GitHub, and add this repository. |
| Review stage fails with `AccessDeniedException` mentioning Bedrock | Bedrock model not enabled or terms not accepted | Go to Bedrock console, open Claude Opus 4.5 in Playground, send a message. Verify with `aws bedrock get-foundation-model-availability`. |
| Review stage fails with `is not available for this account` | Organization SCP blocks model | Bedrock requires explicit allow from Org SCP. See Part 10 for SCP policy simulator command. |
| Tripwire alert email takes 3+ minutes to arrive | CloudTrail delivery latency to EventBridge | Keep talking and explain how CloudTrail collects management events. Show the `/robot-root/tripwire` CloudWatch log group first, which often updates faster than SNS. |
| Redeployment fails with `Secret already exists or scheduled for deletion` | Secrets Manager 30-day recovery window | Run `aws secretsmanager restore-secret --secret-id robot-root/orders-db-prod` followed by `aws secretsmanager delete-secret --secret-id robot-root/orders-db-prod --force-delete-without-recovery`. |
| `cfn-guard: command not found` during local tests | cfn-guard binary missing from local `$PATH` | Install cfn-guard or set `CFN_GUARD=/path/to/cfn-guard`. (CodeBuild installs it automatically during the pipeline build). |

### Presenter Fallback Plan (If Live Demo Stalls)

If an unexpected AWS service outage occurs or Bedrock experiences transient throttling during the live stream:
1. Switch to your pre-recorded video screen capture (recorded during the Part 5 rehearsal).
2. Voice over the video live:
   > *"While AWS completes this build step, let's look at the recorded output from our dry-run rehearsal so you can see the exact log output immediately."*
3. Continue following the talk track seamlessly.

---

## Part 10 — Repository Architecture & Developer Reference

### Repository Layout

```
.
├── app/                           # Node.js microservice tested and released by pipeline
│   ├── src/release-notes.js       # Small app module edited to trigger a pipeline run
│   ├── scripts/build.mjs          # Packaging script creating dist/release.json
│   └── test/release-notes.test.js # Unit test suite run during Build stage
├── buildspecs/
│   └── build.yml                  # Buildspec for Test step (owned by app team, read from repo)
├── infra/                         # AWS CDK infrastructure codebase
│   ├── bin/app.ts                 # CDK entry point instantiating both stacks
│   ├── lib/config.ts              # Configuration loader and guardrail parsing
│   ├── lib/agent-access.ts        # Agent IAM role and permissions boundary definitions
│   ├── lib/buildspecs.ts          # Agent review and policy gate buildspec generators
│   ├── lib/pipeline-stack.ts      # CodePipeline, CodeBuild projects, artifact buckets
│   ├── lib/tripwire-stack.ts      # Honeytoken secret, canary bucket, CloudTrail, EventBridge
│   ├── agent/
│   │   ├── managed-settings.json  # Platform-owned settings locking down Claude Code
│   │   ├── review-prompt.md       # Base prompt passed to Claude Code
│   │   └── package.json           # Version-pinned runtime (@anthropic-ai/claude-code@2.1.301)
│   ├── policy/
│   │   └── agent-guardrails.guard # cfn-guard rules enforced by PolicyGate
│   └── test/stacks.test.ts        # Comprehensive unit & policy test suite (19 tests)
├── README.md                      # Project introduction and quickstart overview
└── DEMO-RUNBOOK.md                # This runbook: single source of truth for the webinar
```

### Running Local Validation Tests

Before any presentation, confirm all tests and types pass locally:

```bash
cd /Users/cbshort/Projects/webinar-who-gave-the-robot-root

# Run app tests
cd app && npm test

# Run infrastructure typecheck and test suite
cd ../infra
npm run typecheck
npm test
```

Expected output:
```text
✔ config (2.25ms)
✔ overprivileged profile (4.82ms)
✔ hardened profile (1.80ms)
✔ policy gate rules (203.42ms)
ℹ tests 19
ℹ pass 19
ℹ fail 0
```
