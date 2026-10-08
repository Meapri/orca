// Why its own module: renderer code names the capability, but e2ee-text-compression needs node:zlib.
/** A client that advertises this decodes host->client text frames compressed before encryption. */
export const E2EE_TEXT_DEFLATE_CAPABILITY = 'e2ee.text-deflate.v1' as const
