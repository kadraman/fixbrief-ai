/** Env for spawned engine processes during e2e tests. */

/**
 * Copy `process.env` for a child engine run, clearing GitHub Actions file sinks
 * so mock reviews cannot append to the parent job summary / env / outputs.
 */
export function engineTestEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_STEP_SUMMARY: "",
    GITHUB_ENV: "",
    GITHUB_OUTPUT: "",
    GITHUB_PATH: "",
    ...extra,
  };
}
