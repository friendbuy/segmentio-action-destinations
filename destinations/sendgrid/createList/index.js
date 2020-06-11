// TODO remove need for this
require('../../../lib/action-kit')

module.exports = action()
  // TODO make these automatic
  .validateSettings(require('../settings.schema.json'))
  .validatePayload(require('./payload.schema.json'))

  .deliver(async ({ payload, settings }) => (
    fetch(
      'https://api.sendgrid.com/v3/marketing/lists',
      {
        method: 'post',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    )
  ))
