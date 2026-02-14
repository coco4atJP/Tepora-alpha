---
name: gemini-cli
description: Use this skill when the user wants to leverage Gemini CLI for coding tasks, bug fixes, test generation, refactoring, or code analysis. Triggers include requests to "use Gemini CLI", "run gemini", mentions of Google's coding agent, or when autonomous AI-assisted development is needed. This skill enables Claude to delegate complex coding workflows to Gemini's agentic capabilities while maintaining control and context.
---

# Gemini CLI Agent Skill

## Overview

Gemini CLI is Google's command-line AI coding agent with autonomous capabilities. It uses ReAct loops to plan, execute, and verify changes across codebases. This skill enables Claude to effectively orchestrate Gemini CLI for complex development tasks.

**Key Capabilities:**
- **Autonomous coding**: Plans and executes multi-step changes
- **MCP integration**: Access to tools and data sources
- **Session management**: Maintains context across interactions
- **Headless mode**: Scriptable for automation

**When to use Gemini CLI:**
- Complex refactoring spanning multiple files
- Generating comprehensive test suites
- Bug fixing requiring codebase analysis
- Implementing features with interdependent changes
- Tasks requiring autonomous planning and execution

## Quick Reference

| Task | Command Pattern |
|------|-----------------|
| Quick code generation | `gemini "create a REST API endpoint for user login"` |
| Interactive development | `gemini` (then chat interactively) |
| Bug fix | `gemini "fix the authentication bug in src/auth.js"` |
| Test generation | `gemini "add tests for all functions in utils/"` |
| Codebase analysis | `gemini "analyze the project structure and suggest improvements"` |
| Headless execution | `gemini "task description" --output-format json > result.json` |
| Resume session | `gemini --resume <tag>` |

---

## Basic Usage Patterns

### Pattern 1: One-shot Commands

For simple, well-defined tasks:

```bash
# Navigate to project directory first
cd /path/to/project

# Execute single command
gemini "add type hints to all Python functions in src/"
```

**Best for:**
- Single-file modifications
- Well-scoped tasks
- Quick additions or fixes

**Output handling:**
- Gemini modifies files directly in place
- Always check git diff after execution
- Claude should verify changes align with user intent

### Pattern 2: Interactive Sessions

For complex tasks requiring back-and-forth:

```bash
# Start interactive session
gemini

# Then provide prompts interactively
> Analyze this codebase and identify the authentication flow
> [wait for response]
> Add middleware to log all authentication attempts
> [wait for response]
> /chat save auth-logging
```

**Best for:**
- Exploratory tasks
- Multi-step workflows
- Tasks requiring clarification

**Important:** Claude cannot interact with stdin directly in bash. Use this pattern only when describing to the user how to use Gemini CLI manually.

### Pattern 3: Headless/Scripted Execution

For automation and programmatic use:

```bash
# One-shot with JSON output
gemini "generate API docs from code comments" --output-format json > docs.json

# Parse and use results
cat docs.json | jq -r '.content[0].text' > API_DOCS.md
```

**Best for:**
- CI/CD pipelines
- Batch processing
- Automated workflows

---

## Working with Files and Projects

### Project Context

**CRITICAL: Always execute gemini commands from the project root directory.**

```bash
# ✅ CORRECT
cd /path/to/project
gemini "add error handling to all API endpoints"

# ❌ WRONG - Gemini won't find project files
gemini "add error handling to all API endpoints"  # if not in project dir
```

### File References

Gemini CLI understands relative paths from project root:

```bash
# Reference specific files
gemini "refactor src/auth/login.js to use async/await"

# Reference directories
gemini "add JSDoc comments to all files in utils/"

# Multiple files
gemini "make sure config.js and .env.example are in sync"
```

### Creating New Files

```bash
# Gemini creates files as needed
gemini "create a new API endpoint at src/routes/users.js"

# Multiple related files
gemini "create a React component with tests and stories"
# → Creates component.jsx, component.test.jsx, component.stories.jsx
```

### Respecting .gitignore

Gemini CLI respects `.gitignore` by default. To include ignored files:

```bash
# Add specific directories to context
gemini "analyze the webpack config in node_modules/@custom/build"
```

---

## Session Management

### Saving Sessions

```bash
# During interactive session
> /chat save feature-auth

# Or from command line
gemini "..." && gemini --save-session auth-work
```

### Resuming Sessions

```bash
# Resume previous session
gemini --resume feature-auth

# List available sessions
gemini --list-sessions
```

### Best Practices

- **Save checkpoints**: After completing logical units of work
- **Descriptive tags**: Use clear names like "bug-fix-payment" not "session1"
- **Clean up**: Delete old sessions to avoid clutter

---

## Advanced Patterns

### Iterative Refinement

```bash
# Initial implementation
gemini "create a user authentication system"

# Review output, then refine
gemini "the auth system should use JWT tokens instead of sessions"

# Further iteration
gemini "add rate limiting to the login endpoint"
```

### Combining with Claude's Analysis

**Workflow:**
1. Claude analyzes requirements and breaks down task
2. Claude delegates implementation to Gemini CLI
3. Claude reviews output and suggests refinements
4. Repeat as needed

```bash
# Claude prepares context, then:
cd /path/to/project

# Execute Gemini task
gemini "implement the shopping cart feature with:
- Add to cart functionality
- Cart persistence in localStorage
- Checkout button
- Empty cart handling"

# Claude examines diff and validates
git diff

# If refinements needed
gemini "add input validation to the add-to-cart function"
```

### Using with MCP Tools

Gemini CLI can leverage MCP servers if configured:

```bash
# Example: Using Google Workspace tools
gemini "fetch data from 'Sales Report' spreadsheet and generate charts"

# Example: Using database tools
gemini "query the production database for user activity and create a summary"
```

**Setup required:** MCP servers must be configured in `~/.gemini/settings.json`

---

## Output Handling

### Parsing Gemini Output

Gemini CLI outputs to stdout. Capture and process as needed:

```bash
# Capture full output
output=$(gemini "analyze code complexity" 2>&1)
echo "$output"

# JSON format for structured data
gemini "list all TODO comments" --output-format json > todos.json
cat todos.json | jq -r '.content[0].text'
```

### Checking Results

**ALWAYS verify Gemini's changes:**

```bash
# View what changed
git diff

# Check specific files
git diff src/auth/

# Validate syntax/tests
npm test
python -m pytest
```

---

## Error Handling

### Common Issues

**Issue: "Project not found" or Gemini can't find files**

```bash
# Solution: Ensure you're in the project directory
pwd  # Verify location
cd /path/to/project
gemini "..."
```

**Issue: Authentication errors**

```bash
# Re-authenticate
gemini  # Will prompt for auth if needed

# Or set API key
export GOOGLE_API_KEY="your-key"
gemini "..."
```

**Issue: Gemini makes unwanted changes**

```bash
# Revert with git
git checkout -- .  # Discard all changes
git checkout -- src/file.js  # Discard specific file

# Or use git stash
git stash  # Save changes for later review
```

**Issue: Rate limiting**

```bash
# Wait and retry, or use a lighter model
gemini "..." --model gemini-3-flash-preview
```

### Validation Workflow

After Gemini execution:

1. **Check diff**: `git diff` to see what changed
2. **Run tests**: Execute test suite to verify functionality
3. **Code review**: Manually inspect critical changes
4. **Commit selectively**: Stage only desired changes

```bash
# Example validation workflow
gemini "add input validation to all forms"
git diff  # Review changes
npm test  # Verify tests pass
git add -p  # Interactively stage changes
git commit -m "Add form validation"
```

---

## Best Practices

### 1. Clear, Specific Prompts

**Good prompts:**
```bash
gemini "refactor the authentication middleware to use async/await and add error handling"
gemini "create unit tests for all functions in utils/string-helpers.js with at least 80% coverage"
gemini "fix the bug where users can't log in after password reset"
```

**Vague prompts (avoid):**
```bash
gemini "make it better"  # Too vague
gemini "fix bugs"  # Not specific
gemini "update code"  # No clear goal
```

### 2. Task Decomposition

For complex tasks, break them down:

```bash
# ❌ Don't: Single massive prompt
gemini "build a complete e-commerce system with authentication, cart, payment, and admin panel"

# ✅ Do: Sequential, focused tasks
gemini "create the authentication system with login, logout, and session management"
# Review and commit
gemini "add shopping cart functionality with add, remove, and persist to localStorage"
# Review and commit
gemini "integrate Stripe payment processing"
# Review and commit
```

### 3. Version Control Integration

**Always work with git:**

```bash
# Create a branch before Gemini makes changes
git checkout -b feature/gemini-auth

# Let Gemini work
gemini "implement OAuth2 authentication"

# Review carefully
git diff

# Commit or discard
git commit -am "Add OAuth2 auth" || git checkout -- .
```

### 4. Model Selection

Choose the right model for the task:

| Model | Use When | Speed | Quality |
|-------|----------|-------|---------|
| `gemini-3-pro` | Complex refactoring, architecture | Slow | Best |
| `gemini-3-flash` | Quick fixes, simple additions | Fast | Good |
| `gemini-3-auto` | Unsure / Let Gemini decide | Auto | Auto |

```bash
# Specify model
gemini "complex task" --model gemini-3-pro
gemini "simple fix" --model gemini-3-flash
```

### 5. Combining with Claude's Strengths

**Optimal division of labor:**

| Claude Should Handle | Gemini CLI Should Handle |
|---------------------|-------------------------|
| Requirements analysis | Code implementation |
| Architecture decisions | File modifications |
| Code review and validation | Multi-file refactoring |
| User communication | Test generation |
| Strategic planning | Bug fixing |

**Example workflow:**
1. User: "I need a new feature for real-time notifications"
2. Claude: Analyzes requirements, asks clarifying questions, designs architecture
3. Claude: Delegates to Gemini CLI: `gemini "implement WebSocket notifications with the following spec: ..."`
4. Claude: Reviews output, runs tests, suggests refinements
5. Claude: Reports results to user with explanation

---

## Security and Privacy

### Sensitive Information

**NEVER pass secrets in prompts:**

```bash
# ❌ NEVER DO THIS
gemini "connect to database with password 'secret123'"

# ✅ DO THIS
# Use environment variables or config files
gemini "connect to database using credentials from .env file"
```

### Code Review

**Always review generated code for:**
- Hardcoded credentials
- SQL injection vulnerabilities
- XSS vulnerabilities
- Insecure dependencies
- Exposed API keys

```bash
# After Gemini generates code
git diff | grep -E "(password|api_key|secret|token)" -i
```

### Compliance

For regulated industries (healthcare, finance):
- Review all generated code thoroughly
- Test extensively before deployment
- Maintain audit logs of changes
- Consider running in isolated environments

---

## Troubleshooting

### Debug Mode

Enable verbose output for troubleshooting:

```bash
# See detailed execution logs
gemini "..." --debug

# Check Gemini version
gemini --version

# View configuration
cat ~/.gemini/settings.json
```

### Performance Issues

If Gemini is slow:

```bash
# Use faster model
gemini "..." --model gemini-3-flash-preview

# Limit scope
gemini "refactor only the auth.js file"  # instead of entire project

# Check for network issues
curl -I https://generativelanguage.googleapis.com
```

### Unexpected Behavior

If Gemini produces unexpected results:

1. **Check context**: Are you in the correct directory?
2. **Simplify prompt**: Break complex requests into steps
3. **Review recent changes**: Use `git log` and `git diff`
4. **Start fresh**: Use a new session without prior context
5. **Report issues**: Check Gemini CLI GitHub issues

---

## Integration Patterns

### With CI/CD

```yaml
# GitHub Actions example
name: AI Code Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install Gemini CLI
        run: npm install -g @google/gemini-cli
      - name: Run Review
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
        run: |
          gemini "review this PR for potential issues" --output-format json > review.json
      - name: Comment on PR
        # Post review.json content as comment
```

### With Pre-commit Hooks

```bash
# .git/hooks/pre-commit
#!/bin/bash

# Run Gemini for quick checks
gemini "check staged files for console.log statements" --model gemini-3-flash

if [ $? -ne 0 ]; then
  echo "Gemini found issues. Fix and try again."
  exit 1
fi
```

### With Testing Frameworks

```bash
# Generate tests before committing
gemini "create tests for any new functions without test coverage"
npm test
git add tests/
```

---

## Command Reference

### Core Commands

```bash
# Basic execution
gemini "prompt"

# With options
gemini "prompt" --model gemini-3-pro --output-format json

# Interactive mode
gemini

# Resume session
gemini --resume <tag>

# List sessions
gemini --list-sessions

# Show version
gemini --version

# Show help
gemini --help
```

### Interactive Mode Commands

When in interactive mode (`gemini` with no args):

```
/help               - Show available commands
/tools              - List available MCP tools
/model              - Switch model
/chat save <tag>    - Save current session
/chat resume <tag>  - Resume saved session
/settings           - Open settings editor
/directory add <path> - Add directory to context
/exit               - Exit session
```

---

## Common Workflows

### 1. Feature Implementation

```bash
cd /path/to/project
git checkout -b feature/new-endpoint

# Implement
gemini "create a REST API endpoint for POST /api/users with validation"

# Review
git diff
npm test

# Commit
git commit -am "Add user creation endpoint"
```

### 2. Bug Fix

```bash
cd /path/to/project
git checkout -b fix/login-issue

# Describe the bug
gemini "fix the bug where users get 'Invalid credentials' even with correct password. The issue is in src/auth/login.js"

# Verify fix
git diff
npm test

# Test manually if needed
npm start

# Commit
git commit -am "Fix login validation bug"
```

### 3. Test Generation

```bash
cd /path/to/project

# Generate tests
gemini "create comprehensive unit tests for src/utils/validators.js"

# Run tests
npm test

# Check coverage
npm run coverage

# Commit
git add tests/
git commit -m "Add validator tests"
```

### 4. Refactoring

```bash
cd /path/to/project
git checkout -b refactor/async-await

# Refactor
gemini "refactor all Promise chains in src/api/ to use async/await"

# Verify no functionality changes
npm test
git diff --stat

# Commit
git commit -am "Refactor API calls to async/await"
```

---

## Critical Rules

1. **Always work from project root**: `cd /path/to/project` before running gemini
2. **Review all changes**: Use `git diff` to inspect what Gemini modified
3. **Run tests**: Execute test suite after Gemini makes changes
4. **Never commit blindly**: Review and stage changes selectively with `git add -p`
5. **Use version control**: Always work on a git branch
6. **Be specific**: Clear, detailed prompts produce better results
7. **Validate output**: Gemini can make mistakes - verify logic and security
8. **Save sessions**: Use `/chat save` for complex multi-step workflows
9. **Check for secrets**: Never commit API keys or passwords Gemini might include
10. **Choose right tool**: Some tasks are better for Claude's analysis vs Gemini's execution

---

## Resources

### Documentation
- Official docs: https://geminicli.com/docs/
- Command reference: https://geminicli.com/docs/cli/commands/
- GitHub: https://github.com/google-gemini/gemini-cli

### Community
- GitHub Discussions: https://github.com/google-gemini/gemini-cli/discussions
- Stack Overflow: Tag `gemini-cli`

### Related Tools
- Model Context Protocol (MCP): https://modelcontextprotocol.io/
- Google AI Studio: https://aistudio.google.com/
