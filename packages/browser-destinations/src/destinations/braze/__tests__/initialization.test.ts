import appboy from '@braze/web-sdk'
import { Analytics, Context } from '@segment/analytics-next'
import * as jsdom from 'jsdom'
import brazeDestination from '../index'

describe('initialization', () => {
  const settings = {
    safariWebsitePushId: 'safari',
    allowCrawlerActivity: true,
    doNotLoadFontAwesome: true,
    enableLogging: true,
    localization: 'pt',
    minimumIntervalBetweenTriggerActionsInSeconds: 60,
    openInAppMessagesInNewTab: true,
    sessionTimeoutInSeconds: 60,
    requireExplicitInAppMessageDismissal: true,
    enableHtmlInAppMessages: true,
    devicePropertyAllowlist: ['ay', 'Dios', 'mio'],
    devicePropertyWhitelist: ['foo', 'bar'],
    allowUserSuppliedJavascript: true,
    contentSecurityNonce: 'bar',
    endpoint: 'endpoint',
    sdkVersion: '3.3'
  }

  beforeEach(async () => {
    jest.restoreAllMocks()
    jest.resetAllMocks()

    const html = `
  <!DOCTYPE html>
    <head>
      <script>'hi'</script>
    </head>
    <body>
    </body>
  </html>
  `.trim()

    const jsd = new jsdom.JSDOM(html, {
      runScripts: 'dangerously',
      resources: 'usable',
      url: 'https://segment.com'
    })

    const windowSpy = jest.spyOn(window, 'window', 'get')
    windowSpy.mockImplementation(() => jsd.window as unknown as Window & typeof globalThis)

    // we're not really testing that appboy loads here, so we'll just mock it out
    jest.spyOn(appboy, 'initialize').mockImplementation(() => true)
    jest.spyOn(appboy, 'openSession').mockImplementation(() => true)
  })

  test('load initialization options', async () => {
    const initialize = jest.spyOn(appboy, 'initialize')

    const [trackEvent] = await brazeDestination({
      api_key: 'b_123',
      subscriptions: [
        {
          partnerAction: 'trackEvent',
          name: 'Log Custom Event',
          enabled: true,
          subscribe: 'type = "track"',
          mapping: {
            eventName: {
              '@path': '$.event'
            },
            eventProperties: {
              '@path': '$.properties'
            }
          }
        }
      ],
      ...settings
    })

    await trackEvent.load(Context.system(), {} as Analytics)

    const { endpoint, ...expectedSettings } = settings
    expect(initialize).toHaveBeenCalledWith(
      'b_123',
      expect.objectContaining({ baseUrl: endpoint, ...expectedSettings })
    )
  })
})
