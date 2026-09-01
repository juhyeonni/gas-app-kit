/**
 * URL builders. Moved from the consumer's scripts/links.mjs unchanged, minus
 * `deploymentIdFor` — its `env === 'production' ? … : …` branch only ever
 * supported two hardcoded env names and is replaced by a registry lookup.
 */

export const editorUrl = (scriptId: string): string =>
  `https://script.google.com/home/projects/${scriptId}/edit`

export const webAppUrl = (deploymentId: string): string =>
  `https://script.google.com/macros/s/${deploymentId}/exec`
