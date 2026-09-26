import { translateMain } from '../i18n/main-i18n'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { buildNotificationText } from '../notifications/agent-notification-text'

export function buildNotificationOptions(args: NotificationDispatchRequest): {
  title: string
  body: string
  silent?: boolean
  sound?: string
} {
  return buildNotificationText(args, translateMain)
}
