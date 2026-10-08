// Development always uses its isolated ordinary library; production vault
// variables must not bind a test process to the user's authoritative files.
export function developmentEnvironment(environment, { apiPort, dataDir }) {
  const result = { ...environment, DEV_API_PORT: String(apiPort), PORT: String(apiPort), PAPERDESK_DATA_DIR: dataDir };
  delete result.PAPERDESK_VAULT_DIR;
  delete result.PAPERDESK_VAULT_SUBDIR;
  return result;
}
