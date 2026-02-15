---
name: code-review
description: Perform comprehensive code reviews for the Tepora project, covering Rust, React, and architecture.
---

# Tepora Code Review Skill

## Skill Purpose

This skill enables the agent to perform comprehensive code reviews for the Tepora project, a privacy-focused local LLM assistant with episodic memory (EM-LLM) built with Rust, Tauri, React, and TypeScript.

## When to Use This Skill

Trigger this skill when:
- User asks to "review this code" or "check this PR" for Tepora project
- User requests quality assessment of Tepora codebase
- User wants architectural analysis of Tepora components
- User needs security or performance review of Tepora code
- User mentions "code review", "CR", "analyze code", or "check implementation" in Tepora context

## Core Principles

### 1. Context-Aware Review
Understand Tepora's unique characteristics:
- **Privacy-First**: All data stays local, no cloud uploads
- **Memory System**: EM-LLM for episodic memory storage
- **Dual-Agent**: Main agent (Tepora) + Professional agent
- **Cyber Tea Salon**: Focus on beautiful, calming UX
- **Tech Stack**: Rust (Tauri backend) + React/TypeScript (frontend)

### 2. Multi-Layered Analysis
Review must cover:
- Code Quality (syntax, patterns, maintainability)
- Architecture Alignment (fits Tepora's design)
- Security & Privacy (data protection, no leaks)
- Performance (memory, CPU, startup time)
- User Experience (UI/UX quality)

## Review Process

### Step 1: Initialize Review Context

```bash
# Before starting, understand project structure
# Use list_dir and view_file to explore
ls -R /path/to/tepora-project
cat /path/to/tepora-project/README.md
cat /path/to/tepora-project/docs/architecture/ARCHITECTURE.md
```

**Output**: Brief summary of project state and review scope.

### Step 2: Identify Review Scope

Determine what to review:

**For PR Review:**
```bash
# If reviewing a specific PR or branch
git diff --name-only main...feature-branch
git diff main...feature-branch
```

**For Module Review:**
Focus on specific directories:
- `Tepora-app/src-tauri/` - Rust backend
- `Tepora-app/src/` - React/TS frontend
- `docs/` - Documentation
- `.github/` - CI/CD workflows

**For Full Project Review:**
Review all major components systematically.

### Step 3: Execute Detailed Analysis

For each file reviewed, apply the appropriate checklist:

#### Rust Code Review (src-tauri/)

```bash
# Run automated checks first
cd Tepora-app && cargo clippy --all-features -- -D warnings
cd Tepora-app && cargo fmt -- --check
cd Tepora-app && cargo test
```

**Manual Review Checklist:**

1. **Ownership & Lifetimes**
   - Are borrows and moves handled correctly?
   - Are lifetimes explicit where needed?
   - Is there unnecessary cloning?

2. **Error Handling**
   - Are `Result` and `Option` used appropriately?
   - Are errors propagated with `?` operator?
   - Are custom error types defined for domain errors?
   - Are panics avoided in production code?

3. **Concurrency & Safety**
   - Are `Arc` and `Mutex` used correctly?
   - Are race conditions prevented?
   - Is `unsafe` code justified and documented?
   - Are thread boundaries clear?

4. **Tauri Integration**
   - Are commands properly annotated with `#[tauri::command]`?
   - Is state management handled via Tauri's state system?
   - Are IPC calls efficient and minimal?

5. **EM-LLM Specifics**
   - Is memory storage efficient (serialization, compression)?
   - Are memory queries optimized (indexing, caching)?
   - Is privacy maintained (encryption, no logging of sensitive data)?

6. **Performance**
   - Are allocations minimized in hot paths?
   - Are data structures optimal (Vec vs HashMap vs BTreeMap)?
   - Is lazy evaluation used where appropriate?

**Example Analysis Output:**

```markdown
### File: src-tauri/src/memory/episodic.rs

**Strengths:**
- ✅ Good use of `serde` for serialization
- ✅ Proper error handling with custom `MemoryError` type
- ✅ Thread-safe access with `Arc<RwLock<T>>`

**Issues:**
- ⚠️ Line 45: Unnecessary `.clone()` on `episode_id` - can use reference
- ⚠️ Line 78: Consider using `BTreeMap` instead of `HashMap` for sorted keys
- ❌ Line 120: Sensitive data (user content) stored without encryption

**Recommendations:**
1. Add encryption layer for stored memories
2. Implement LRU cache for frequently accessed memories
3. Add comprehensive unit tests for edge cases
```

#### TypeScript/React Code Review (src/)

```bash
# Run automated checks
cd Tepora-app && npm run type-check
cd Tepora-app && npm run lint
cd Tepora-app && npm test
```

**Manual Review Checklist:**

1. **Type Safety**
   - Are types explicit (avoid `any`)?
   - Are interfaces/types properly defined?
   - Are generics used effectively?

2. **React Best Practices**
   - Are hooks used correctly (dependencies array)?
   - Is component re-rendering optimized (memo, useMemo, useCallback)?
   - Are side effects properly managed (useEffect)?
   - Is state lifted only when necessary?

3. **Component Design**
   - Is separation of concerns clear (UI vs logic)?
   - Are components small and focused?
   - Is composition preferred over inheritance?

4. **Accessibility**
   - Are ARIA labels present?
   - Is keyboard navigation supported?
   - Is color contrast sufficient?

5. **Cyber Tea Salon UX**
   - Is design consistent with the "tea salon" aesthetic?
   - Are animations smooth (60fps)?
   - Are loading states handled gracefully?
   - Are error messages user-friendly?

**Example Analysis Output:**

```markdown
### File: src/components/ChatInterface.tsx

**Strengths:**
- ✅ Good separation of chat logic into custom hook
- ✅ Accessible with proper ARIA labels
- ✅ Smooth scroll-to-bottom animation

**Issues:**
- ⚠️ Line 34: Missing dependency in useEffect array (`userId`)
- ⚠️ Line 67: Inefficient - re-creating `handleSubmit` on every render
- ❌ Line 89: Using `any` type for message object

**Recommendations:**
1. Add `userId` to useEffect dependencies or use useCallback
2. Wrap `handleSubmit` in `useCallback` with proper dependencies
3. Define explicit `Message` interface
4. Consider virtualization for long chat histories
```

#### Security Review

**Always check:**

1. **Data Privacy**
   - No data sent to external servers without consent
   - Sensitive data encrypted at rest
   - Secure key management

2. **Input Validation**
   - User inputs sanitized
   - SQL/NoSQL injection prevented
   - XSS vulnerabilities avoided

3. **Dependencies**
   ```bash
   cargo audit
   npm audit
   ```

4. **Secrets Management**
   ```bash
   grep -r "password\|secret\|api_key" --include="*.rs" --include="*.ts" src/
   ```

### Step 4: Performance Analysis

```bash
# Rust performance
cargo build --release
cargo bench  # if benchmarks exist

# Frontend bundle analysis
npm run build
npx vite-bundle-visualizer
```

**Check:**
- Startup time < 3 seconds
- Memory usage reasonable (< 500MB for typical use)
- Bundle size optimized (< 5MB)
- CPU usage not excessive

### Step 5: Generate Review Report

Create a comprehensive report using this template:

```markdown
# Tepora Code Review Report

**Date**: [Current Date]
**Reviewer**: AI Agent
**Scope**: [PR #XXX / Module / Full Project]
**Status**: [✅ Approved / ⚠️ Minor Changes / ❌ Major Changes]

---

## Executive Summary

[2-3 sentence overview of findings]

## Strengths 🎯

1. [Positive finding 1]
2. [Positive finding 2]
3. ...

## Critical Issues ❌

### Issue 1: [Title]
- **File**: `path/to/file.rs:123`
- **Severity**: Critical
- **Description**: [What's wrong]
- **Impact**: [Why it matters]
- **Fix**: [How to resolve]
- **Code Example**:
  ```rust
  // Before
  [problematic code]
  
  // After
  [suggested fix]
  ```

## Major Issues ⚠️

[Same format as Critical]

## Minor Issues 💡

[Same format, but less urgent]

## Metrics 📊

- **Test Coverage**: XX%
- **Clippy Warnings**: XX
- **ESLint Warnings**: XX
- **Build Time**: XX seconds
- **Bundle Size**: XX KB
- **Security Vulnerabilities**: XX

## Architecture Analysis 🏗️

[Discussion of architectural patterns, consistency, scalability]

## Security Analysis 🔒

[Privacy, data protection, vulnerability assessment]

## Performance Analysis ⚡

[Speed, memory, resource usage analysis]

## Recommendations 💡

### Short-term (This Sprint)
1. [Action item]
2. [Action item]

### Long-term (Future Iterations)
1. [Improvement idea]
2. [Improvement idea]

## Conclusion

[Summary paragraph with overall assessment]

---

**Next Steps**: [What should happen next]
```

## Advanced Review Techniques

### 1. Architectural Pattern Recognition

Identify and validate patterns:
- **Command Pattern**: Tauri commands for frontend-backend communication
- **Repository Pattern**: EM-LLM memory storage abstraction
- **Observer Pattern**: React state management
- **Factory Pattern**: Agent creation and management

### 2. Privacy-First Validation

For Tepora specifically, always verify:
```rust
// ✅ Good: Local storage
let memory_path = app_data_dir().join("memories.db");

// ❌ Bad: External API call without user consent
let response = reqwest::get("https://api.example.com/log")
    .await?;
```

### 3. Memory Efficiency Check

Look for memory-intensive operations:
```rust
// ⚠️ Potential issue: Loading entire history into memory
let all_memories: Vec<Episode> = db.get_all_episodes()?;

// ✅ Better: Pagination or streaming
let recent_memories = db.get_episodes_paginated(0, 50)?;
```

### 4. Concurrency Analysis

Verify thread safety:
```rust
// ✅ Good: Proper synchronization
let state = Arc::new(RwLock::new(AppState::new()));

// ❌ Bad: Shared mutable state without synchronization
static mut GLOBAL_COUNTER: i32 = 0;
```

## Common Pitfalls to Watch For

### Rust-Specific

1. **Unnecessary Cloning**
   ```rust
   // ⚠️ Bad
   fn process(data: Vec<String>) {
       for item in data.clone() { ... }
   }
   
   // ✅ Good
   fn process(data: &[String]) {
       for item in data { ... }
   }
   ```

2. **Blocking in Async Context**
   ```rust
   // ❌ Bad
   async fn load_memory() {
       std::thread::sleep(Duration::from_secs(1)); // blocks executor
   }
   
   // ✅ Good
   async fn load_memory() {
       tokio::time::sleep(Duration::from_secs(1)).await;
   }
   ```

### TypeScript/React-Specific

1. **Infinite Re-render Loop**
   ```tsx
   // ❌ Bad
   useEffect(() => {
       setState({ ...state, updated: true });
   }); // Missing dependency array!
   
   // ✅ Good
   useEffect(() => {
       setState({ ...state, updated: true });
   }, [/* dependencies */]);
   ```

2. **Type Coercion Abuse**
   ```typescript
   // ⚠️ Bad
   const userId = props.user as any;
   
   // ✅ Good
   interface User { id: string; name: string; }
   const userId: string = props.user.id;
   ```

## Output Format

Always structure your review output as follows:

1. **Brief Summary** (2-3 sentences)
2. **Automated Check Results** (if applicable)
3. **Detailed Findings** (organized by severity)
4. **Code Examples** (show before/after)
5. **Metrics** (quantitative data)
6. **Actionable Recommendations**

## Example Review Execution

```
User: "Review the memory module in src-tauri/src/memory/mod.rs"

Agent Response:

I'll review the memory module following the Tepora code review workflow.

[Runs automated checks]
[Views the file]
[Analyzes code]
[Generates detailed report]

Here's my review:

# Memory Module Review

## Summary
The memory module implements the core EM-LLM functionality. Overall structure is solid, but found 3 critical issues related to encryption and 2 performance optimizations.

[... detailed findings ...]
```

## Continuous Improvement

After each review:
1. Learn from patterns found
2. Update checklist if new issues discovered
3. Refine understanding of Tepora's architecture
4. Suggest workflow improvements

## Integration with Development Workflow

This skill integrates with:
- **Git**: For PR reviews and diffs
- **CI/CD**: Can be triggered in GitHub Actions
- **IDE**: Via Agent tool integration
- **Manual**: Direct requests

## Limitations

Be aware of:
- Cannot execute code that requires compilation beyond static analysis tools
- Cannot access external APIs for third-party security scans
- May not catch runtime-only issues
- Cannot test UI/UX subjectively (provide heuristic assessment)

## Success Criteria

A successful review:
- ✅ Identifies concrete, actionable issues
- ✅ Provides code examples for fixes
- ✅ Considers Tepora's unique context
- ✅ Balances thoroughness with clarity
- ✅ Respects the "Cyber Tea Salon" philosophy

---

**Remember**: The goal is not just to find bugs, but to help Tepora become the best "memory-enhanced" AI companion it can be, while maintaining its privacy-first, user-friendly ethos.
