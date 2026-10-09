// Development always uses its isolated ordinary library; production vault
// variables must not bind a test process to the user's authoritative files.
export function developmentEnvironment(environment, { apiPort, dataDir }) {
  const result = { ...environment };
  // Windows environment names are case insensitive. Remove aliases before
  // setting the authoritative development values, including mixed-case ones.
  const replaced = new Set(['DEV_API_PORT', 'PORT', 'PAPERDESK_DATA_DIR', 'PAPERDESK_VAULT_DIR', 'PAPERDESK_VAULT_SUBDIR']);
  for (const key of Object.keys(result)) if (replaced.has(key.toUpperCase())) delete result[key];
  Object.assign(result, { DEV_API_PORT: String(apiPort), PORT: String(apiPort), PAPERDESK_DATA_DIR: dataDir });
  return result;
}
