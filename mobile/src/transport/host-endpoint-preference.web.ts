/** A native write the page drops: the page never persists host metadata (see host-store.web.ts). */
export const preferConnectedHostEndpoint = (
  _hostId: string,
  _connectedEndpoint: string
): Promise<void> => Promise.resolve()
