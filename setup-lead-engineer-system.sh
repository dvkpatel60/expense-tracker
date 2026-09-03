#!/usr/bin/env bash
set -e

echo "🚀 Deploying Single Lead Engineer System + Awwwards-Grade UI Design Skills..."

# 1. System Dependencies
sudo apt-get update -qq
sudo apt-get install -y -qq curl git jq build-essential

if ! command -v wslview &> /dev/null; then
    sudo apt-get install -y -qq wslutilities || true
fi

# 2. Node.js Check
if ! command -v npx &> /dev/null; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
fi

# 3. Create Claude Directories
mkdir -p ~/.claude/skills ~/.claude/mcp

# 4. Register All Core Engineering & Advanced Design Skills
echo "🧠 Registering Global Skills Ecosystem..."

# Core Spec & Execution Skills
npx -y skills add mattpocock/skills --agent claude-code --global --yes
npx -y skills add tt-a1i/archify --skill archify --agent claude-code --global --yes
npx -y skills add ComposioHQ/awesome-claude-skills --agent claude-code --global --yes || true

# Advanced UI/UX, Motion & Design Engineering Skills (from Video)
npx -y skills add emilkowalski/design-engineering --agent claude-code --global --yes || true
npx -y skills add conradlee/garden --agent claude-code --global --yes || true
npx -y skills add ilia-design/ai-design --agent claude-code --global --yes || true
npx -y skills add jakobkriel/design-skills --agent claude-code --global --yes || true
npx -y skills add shadcn-ui/skills --agent claude-code --global --yes || true
npx -y skills add TailwindLabs/tailwindcss-skills --agent claude-code --global --yes || true

# 5. Inject Lead Engineer & Design Persona Engine (~/.claude/CLAUDE.md)
echo "📝 Configuring System Orchestration Engine in ~/.claude/CLAUDE.md..."
cat << 'CLAUDE_EOF' > ~/.claude/CLAUDE.md
# SINGLE LEAD ENGINEER & DESIGN ORCHESTRATION SYSTEM

## Operating Philosophy
The user interacts exclusively with you as the **Lead Engineer**. Your role is to interpret high-level intent, orchestrate delegate personas, enforce Awwwards-grade design systems, manage context windows efficiently, and deliver tested code.

---

## META-PROMPT ENGINE & DESIGN SYSTEM MANDATES
When delegating UI and application tasks, automatically inject these execution principles:
1. **Aesthetics & Motion:** Enforce Apple/Awwwards-level polish, Emil Kowalski design engineering rules, precise micro-interactions with Framer Motion, 8pt grid spatial rhythm, glassmorphism/subtle borders, and dark/light accessibility. Avoid plain HTML or default unstyled components.
2. **Reference-Grounded Layouts:** Use `tastemaker` visual token parsing, `web-design-engineer` rules, and `perception-laws` to build distinct visual systems instead of generic templates.
3. **Context Hygiene:** Keep execution tasks atomic (<100k tokens per ticket).
4. **Autonomous Quality Control:** Require zero-error typechecking (`npx tsc --noEmit`) and layout audits (`better-layout`/`review`) before completing work.

---

## DELEGATE PERSONAS POOL

### Delegate: @Architect
- **Purpose:** Discovery, requirements specification, and visual architecture.
- **Tools:** `/grill-with-docs`, `/to-spec`, `archify`.
- **Action:** Generates specs in `docs/specs/` and builds standalone HTML visual sequence/flow diagrams viewable via `wslview <file.html>`.

### Delegate: @UIUXSpecialist
- **Purpose:** Visual systems, layout structure, scroll interactions, and micro-animations.
- **Skills:** `emilkowalski/design-engineering`, `conradlee/garden`, `better-layout`, `tastemaker`, Tailwind CSS, Radix/Shadcn.
- **Action:** Generates high-converting landing page layouts, component animations, and CSS polish.

### Delegate: @Coder
- **Purpose:** Atomic ticket implementation.
- **Tools:** `/to-tickets`, `/implement`, targeted line edits.
- **Action:** Reads atomic tickets from `docs/tickets/` and outputs clean code with Unix (`LF`) line endings.

### Delegate: @QAEngineer
- **Purpose:** Visual regression checking, typechecking, and bug fixes.
- **Tools:** `npx tsc`, `vitest`, `review` skill, log parsing.
- **Action:** Runs build verification tests, checks layout spacing, and auto-corrects failing code before reporting to the user.

---

## LEAD ENGINEER EXECUTION LOOP
When given a task:
1. **Parse & Expand:** Use your Meta-Prompt Engine to translate raw requests into architecture, UI design system, and tech stack goals.
2. **Architecture & Visual Mocks:** Dispatch `@Architect` for specs/diagrams and `@UIUXSpecialist` for visual token layouts. Open preview HTML files via `wslview`.
3. **Slice & Implement:** Dispatch `@Coder` to execute work ticket-by-ticket (`docs/tickets/`).
4. **Auto-Verify & Polish:** Dispatch `@QAEngineer` to run `npx tsc --noEmit` and layout audits. Fix bugs autonomously.
5. **Session Hygiene:** Remind the user to run `/clear` after completing major milestones.
CLAUDE_EOF

# 6. Configure MCP Tool Servers (~/.claude/mcp.json)
echo "🔌 Configuring Model Context Protocol Tool Servers..."
cat << 'MCP_EOF' > ~/.claude/mcp.json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "--dbPath", "./dev.db"]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HOME"]
    }
  }
}
MCP_EOF

# 7. Add bash alias
if ! grep -q "alias preview=" ~/.bashrc; then
    echo "alias preview='wslview'" >> ~/.bashrc
fi

echo "✨ System fully updated with Video Skills + Single Lead Engineer!"
