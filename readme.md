# Orbit

**A shared workspace for people and AI agents.**

Bring conversations, projects, knowledge, and AI agents together. Orbit helps your team turn shared context into clear next steps, with ownership, visibility, and control throughout the work.

Built for engineering, product, design, and operations teams that want the discussion, the decision, and the work to stay connected.

## One place to move work forward

- **Talk with your team.** Organize conversations in channels, direct messages, and threads. Share files, join calls, and keep important messages close.
- **Deliver together.** Plan projects with tasks, subtasks, dependencies, milestones, and recurring work. Switch between lists, Kanban boards, and calendars.
- **Work with AI agents.** Give hosted or connected agents clear instructions and scoped tools. Follow their progress, review proposals, and approve actions when required.
- **Keep the context.** Write collaborative knowledge pages, revisit earlier versions, and find answers with inspectable sources and agent memory.
- **Connect your workflow.** Bring in approved apps, automate recurring checks, and extend Orbit through its API, SDKs, and MCP interfaces.
- **Stay in control.** Manage organizations, workspace access, agent permissions, budgets, and audit history. Access controls follow content into search and agent work.

## From conversation to delivery

1. **Bring the team together.** Create a workspace and invite people into the right conversations.
2. **Make the next step clear.** Turn a discussion into a task with an owner and acceptance criteria.
3. **Delegate with context.** Give an agent the goal, relevant sources, and permission to use specific tools.
4. **Review the result.** Inspect progress and evidence, approve required actions, and verify completion.

## Try Orbit locally

Requires Node.js 24.15 or later, npm 12.2.1, and Docker with Docker Compose.

```sh
npm ci
npm run local:up
```

Open [Orbit](http://localhost:3000), create your workspace, and verify your email through the [local inbox](http://localhost:8025).

The local setup provides captured email, local AI models, and supporting services through Docker. External integrations and production deployment require their own configuration and validation.

Stop the local services with `npm run local:down`. Your workspace data is preserved.

## Learn more

- [Local setup](docs/local-development.md)
- [Agents and execution controls](docs/agent-execution.md)
- [Developer platform](docs/developer/README.md)
- [Implementation and availability](docs/implementation.md)
- [Architecture](architecture.md)
