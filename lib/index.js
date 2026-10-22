/**
 * Balance/tokens status strip, node half.
 *
 * Pure UI plugin: the empty apply exists so the plugin appears in the Host
 * Loader (load and lifecycle follow the Host; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration).
 */

/** Host plugin body — no host-side behavior for the status strip. */
export function apply() {}
