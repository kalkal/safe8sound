export const packageName = '@cold-reserve/ssm-parameters';
// Only the ParameterReader factories are public (review of #162): readParameter stays inside the package.
export { cachedOnSuccess, extensionReader, sdkReader, ssmTimeoutMs, type GetParameter, type ParameterReader } from './readers.js';
