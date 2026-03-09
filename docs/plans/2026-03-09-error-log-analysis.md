# ExpenseSyncBot Error Log Analysis

This document provides a detailed analysis of the errors found in the `ExpenseSyncBot-error.log` file. The log contains several recurring errors that need to be addressed to ensure the stability and proper functioning of the bot.

## 1. TypeScript Execution Error

**Error:** `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`

**Analysis:** This error indicates that the Node.js runtime is attempting to execute TypeScript files (e.g., `index.ts`) directly. The `.ts` extension is not recognized by Node.js out of the box, which requires a separate compilation or execution step. The application is likely being started with a command like `node index.ts` instead of using a TypeScript-aware runner like `bun`, `ts-node`, or `tsx`.

**Recommendation:**

* **Use Bun:** The project seems to be using `bun` (as indicated by the `bun.lockb` file and the `Bun.serve` calls in the logs). Ensure that the application is always started with `bun` (e.g., `bun run index.ts`). This will transpile the TypeScript code in memory and execute it correctly.
* **Update `start.sh`:** The `start.sh` script should be updated to use `bun` to run the application. For example:

    ```bash
    #!/bin/bash
    bun run index.ts
    ```

## 2. Port in Use Error

**Error:** `error: Failed to start server. Is port 3000 in use?`

**Analysis:** The `EADDRINUSE` error means that the application is trying to start a server on port 3000, but that port is already occupied by another process. This often happens when a previous instance of the application (or another application) is still running in the background. The `startOAuthServer` function in `src/web/oauth-callback.ts` is the source of this error.

**Recommendation:**

* **Graceful Shutdown:** Implement a graceful shutdown mechanism to ensure that the server is properly stopped when the application exits or restarts. This can be done by catching signals like `SIGINT` and `SIGTERM` and calling a `server.stop()` method.
* **Process Management:** Use a process manager like `pm2` to manage the application's lifecycle. The `ecosystem.config.cjs` file in the project root suggests that `pm2` might already be in use. Ensure that `pm2` is configured to properly restart the application and avoid creating multiple instances. The command `pm2 restart ecosystem.config.cjs` could be used.
* **Check for Running Processes:** Before starting the application, check for any processes that might be using port 3000. This can be done with the command `lsof -i :3000` on macOS or Linux.

## 3. Missing Module Export

**Error:** `SyntaxError: Export named 'sendMessage' not found in module '/var/www/ExpenseSyncBot/src/bot/telegram-api.ts'`

**Analysis:** This error indicates that a file is trying to import the `sendMessage` function from `src/bot/telegram-api.ts`, but that file does not export a function with that name. This could be due to a typo in the function name, a missing export statement, or an incorrect file path.

**Recommendation:**

* **Verify Export:** Open the file `src/bot/telegram-api.ts` and verify that it contains a function named `sendMessage` and that it is properly exported. For example:

    ```typescript
    export function sendMessage(...) {
      // ...
    }
    ```

* **Check for Typos:** Check the import statements in the files that are trying to use `sendMessage` and make sure there are no typos in the function name or the file path.

## 4. Duplicate Export

**Error:** `SyntaxError: Cannot export a duplicate name 'saveExpenseToSheet'`

**Analysis:** This error occurs in `src/bot/handlers/message.handler.ts` and indicates that the `saveExpenseToSheet` name is being exported more than once from the same module. This is not allowed in JavaScript/TypeScript.

**Recommendation:**

* **Remove Duplicate Export:** Open the file `src/bot/handlers/message.handler.ts` and find all the `export` statements for `saveExpenseToSheet`. Remove the duplicate export. It's likely that the function is already exported inline or with another `export` statement. For example, if you have:

    ```typescript
    export function saveExpenseToSheet(...) {
      // ...
    }
    
    // ...
    
    export { saveExpenseToSheet }; // This is a duplicate
    ```

    You should remove the second `export { saveExpenseToSheet };` line.
