interface MaybeChrome {
  chrome?: { runtime?: { id?: unknown } };
}

/**
 * False once this script's extension context is gone (extension reloaded,
 * updated or removed while the page stays open). The runtime id lives in the
 * content script's own world, so page scripts cannot influence this check.
 */
export function isExtensionContextValid(): boolean {
  // The typings model a live extension; an orphaned script loses runtime.id.
  const { chrome } = globalThis as MaybeChrome;
  return typeof chrome?.runtime?.id === 'string';
}
