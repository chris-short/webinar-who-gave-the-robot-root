# Who gave the robot root?

The live demo for the KodeKloud webinar *Who gave the robot root? Securing AI agents in your pipelines*.

It builds a small but real software delivery pipeline in AWS with an AI agent (Claude Code, reviewing each change through Amazon Bedrock) in it. The agent starts with far more access than it needs, and during the session that access is taken away one guardrail at a time — until a change that tries to widen it is blocked before it ships.

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

## Start here

Everything — setup, the live-demo run sheet, and the talk track — is in **[DEMO-RUNBOOK.md](DEMO-RUNBOOK.md)**, the single source of truth for this project.

- **Setting it up in a sandbox account:** Parts 1-3.
- **Running the webinar:** Part 4.
- **Cost, cleanup, troubleshooting, and developer notes:** Parts 5-8.

> **Warning:** The "before" state deliberately gives the agent `AdministratorAccess`, limited by a permissions boundary to this project's own resources. Deploy only to a **sandbox account** with nothing important in it. Never use a production account.
