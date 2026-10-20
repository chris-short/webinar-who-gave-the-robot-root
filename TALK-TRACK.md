# Talk track: Who gave the robot root?

What to say at the start and end of the webinar. Run the demo in between, from "Running the webinar demo (presenter notes)" in the README.

## Opening (about 4 minutes)

Thanks for joining. Today's title is a question: who gave the robot root?

Lots of teams now have AI somewhere in their delivery pipeline. It reviews pull requests, writes release notes, or fixes failing tests. These agents aren't just chatbots. They read files, run commands, and call cloud APIs, and they do it with whatever access the pipeline hands them.

Here's how that access usually gets decided. Someone wires up the agent and it fails with AccessDenied. After the third retry, they attach an admin policy so it works. There's a comment in today's code that says exactly that: "It kept failing with AccessDenied, so we gave it admin." Drop a note in the chat if you've seen that one in real life.

The catch is that an agent decides what to do based on what it reads. In a pipeline, what it reads is the code people push. So the real question isn't how smart the agent is. It's what happens when it does something its job never needed, and whether anything stops it.

Today I'll show you a small but real pipeline in AWS with Claude Code as the reviewer. It starts with far too much access. You'll spot the problems, we'll see what that access makes possible, and then we'll take it away one guardrail at a time. By the end, the agent can do its job and nothing else, and a change that tries to give it more gets blocked before it ships.

Everything runs in a sandbox account. The "production password" and "production bucket" you'll see are fake, and an alarm goes off if anything touches them.

*Now run the demo, starting with the poll.*

## Closing (about 3 minutes)

So, who gave the robot root? Usually nobody decided to. It happened one AccessDenied at a time.

Four things to take back to your own pipelines:

1. **Give the agent the permissions of its job, not of your account.** A reviewer needs to read code and call its model. It doesn't need admin, and it shouldn't have secrets sitting in its environment.
2. **The rules for the agent belong to the platform, not to the repository it's reviewing.** If the code under review can change the agent's settings, the code under review is in charge.
3. **Know exactly what you're running.** Pin the version, verify the download, and don't pipe a script from the internet into bash on a machine that has credentials.
4. **Check changes to the guardrails themselves.** A policy check in the pipeline catches the commit that quietly widens permissions, before a person has to notice it.

Two safety nets cost almost nothing. A permissions boundary sets a ceiling even when someone grants too much. A tripwire tells you when something reaches for what it shouldn't.

Notice that none of the four fixes was a better prompt. The review prompt already tells the agent to treat the repository as untrusted. That helps, but it's guidance. The permissions are what actually stop things.

Your homework: pick one agent or bot in your pipeline this week and answer four questions. What can its role do? What's in its environment? How is it installed? Who can change its rules?

The whole demo is on GitHub at `<repo link>`, and the README walks you through deploying it in your own sandbox account. Let's take some questions.

## Likely questions

- **"Isn't telling the agent to ignore instructions in the repository enough?"** It helps, and this demo's prompt does it. But a prompt is guidance the model weighs, not a control. Permissions, tool restrictions, and the policy check are what hold when the guidance doesn't.
- **"Why a permissions boundary if the role is already least-privilege?"** Roles change. Someone adds a policy later to fix an error. The boundary is the ceiling that stays.
- **"Is this only about Claude Code or AWS?"** The specifics are. The four homework questions apply to any agent in any CI system.
- **"What does it cost to run?"** A few dollars a month in a sandbox, plus model calls. Once the agent-policy guardrail is on, each run is capped (default $3). The README has the details.
- **"How fast do the alerts arrive?"** Usually within a few minutes, because they come from CloudTrail.
- **"Why keep the human approval step?"** It only means something if the agent can't get around it. With admin, the agent could write straight to the release bucket. With least privilege, approval is a real gate again.
