/** Renders a pairing URL as a terminal QR code, or null when the terminal cannot show one. */
export async function renderTerminalPairingQr(pairingUrl: string): Promise<string | null> {
  // Why dynamic: qrcode is only reachable from mobile pairing, so launch should
  // not parse it for the majority who never pair a device.
  const QRCode = await import('qrcode')
  try {
    return await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
  } catch {
    try {
      return await QRCode.toString(pairingUrl, { type: 'utf8' })
    } catch {
      return null
    }
  }
}
