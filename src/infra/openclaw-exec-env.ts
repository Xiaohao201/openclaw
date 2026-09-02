export const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export const OPENCLAW_CLI_ENV_VALUE = "1";
const PYTHON_IO_ENCODING_ENV_VAR = "PYTHONIOENCODING";
const PYTHON_IO_ENCODING_UTF8 = "utf-8";

export function markOpenClawExecEnv<T extends Record<string, string | undefined>>(
  env: T,
  platform: NodeJS.Platform = process.platform,
): T {
  const hasPythonIoEncoding = Object.entries(env).some(
    ([key, value]) => key.toUpperCase() === PYTHON_IO_ENCODING_ENV_VAR && value !== undefined,
  );
  return {
    ...env,
    ...(platform === "win32" && !hasPythonIoEncoding
      ? { [PYTHON_IO_ENCODING_ENV_VAR]: PYTHON_IO_ENCODING_UTF8 }
      : {}),
    [OPENCLAW_CLI_ENV_VAR]: OPENCLAW_CLI_ENV_VALUE,
  };
}

export function ensureOpenClawExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[OPENCLAW_CLI_ENV_VAR] = OPENCLAW_CLI_ENV_VALUE;
  return env;
}
