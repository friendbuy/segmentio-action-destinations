import validate from '@segment/fab5-subscriptions'
import { BadRequest } from 'http-errors'
import got, { CancelableRequest, Got, Response } from 'got'
import { Extensions, Action, Validate } from './action'
import { ExecuteInput, StepResult } from './step'
import Context, { Subscriptions } from '../context'
import { time, duration } from '../time'
import { JSONArray, JSONObject } from '../json-object'
import { redactSettings } from '../redact'

export interface DestinationConfig {
  name: string
  defaultSubscriptions: Subscription[]
}

interface Subscription {
  partnerAction: string
  subscribe:
    | string
    | {
        type: string
      }
  mapping?: JSONObject
}

interface PartnerActions {
  [key: string]: Action
}

interface TestAuth {
  type: string
  options: TestAuthOptions
}

interface TestAuthOptions {
  testCredentials: (req: Got, settings: TestAuthSettings) => CancelableRequest<Response<string>>
}

interface TestAuthSettings {
  settings: JSONObject
}

function instrumentSubscription(context: Context, input: Subscriptions): void {
  context.append('subscriptions', {
    duration: input.duration,
    destination: input.destination,
    action: input.action,
    input: input.input,
    output: input.output
  })
}

export class Destination {
  config: DestinationConfig
  defaultSubscriptions: Subscription[]
  partnerActions: PartnerActions
  requestExtensions: Extensions
  settingsSchema?: object
  auth?: TestAuth
  responses: Response[]

  constructor(config: DestinationConfig) {
    this.config = config
    this.partnerActions = {}
    this.requestExtensions = []
    this.settingsSchema = undefined
    this.auth = undefined
    this.responses = []
  }

  extendRequest(...extensions: Extensions): Destination {
    this.requestExtensions.push(...extensions)
    return this
  }

  validateSettings(schema: object): Destination {
    this.settingsSchema = schema
    return this
  }

  apiKeyAuth(options: TestAuthOptions): Destination {
    this.auth = {
      type: 'apiKey',
      options
    }

    return this
  }

  async testCredentials(settings: JSONObject): Promise<void> {
    const context: ExecuteInput = { settings, payload: {} }

    if (this.settingsSchema) {
      const step = new Validate('', 'settings', this.settingsSchema)
      await step.executeStep(context)
    }

    if (!this.auth) {
      return
    }

    let request = got.extend({
      retry: 0,
      timeout: 3000,
      headers: {
        'user-agent': undefined
      }
    })

    for (const extension of this.requestExtensions) {
      request = request.extend(extension(context))
    }

    try {
      await this.auth.options.testCredentials(request, { settings })
    } catch (error) {
      throw new Error('Credentials are invalid')
    }
  }

  public partnerAction(slug: string, actionFn: (action: Action) => Action): Destination {
    const action = new Action().extendRequest(...this.requestExtensions)

    action.on('response', response => {
      this.responses.push(response)
    })

    this.partnerActions[slug] = actionFn(action)
    return this
  }

  private async onSubscription(
    context: Context,
    subscription: Subscription,
    event: JSONObject,
    settings: JSONObject,
    privateSettings: JSONArray
  ): Promise<StepResult[]> {
    const isSubscribed = validate(subscription.subscribe, event)
    if (!isSubscribed) {
      return [{ output: 'not subscribed' }]
    }

    const actionSlug = subscription.partnerAction
    const action = this.partnerActions[actionSlug]
    if (!action) {
      throw new BadRequest(`"${actionSlug}" is not a valid action`)
    }

    const subscriptionStartedAt = time()

    const input: ExecuteInput = {
      // Payload starts as the event itself, but will get transformed based on the given `mapping` + `event`
      // In other arbitrary actions (like autocomplete) payload may be non-event data
      //
      // TODO: evaluate if actions like autocomplete should be defined the same, and have the same semantics as a normal partner action
      // these are effectively actions that power UI **inputs** and nothing else.
      payload: event,
      mapping: subscription.mapping,
      settings
    }

    const results = await action.execute(input)

    const subscriptionEndedAt = time()
    const subscriptionDuration = duration(subscriptionStartedAt, subscriptionEndedAt)

    instrumentSubscription(context, {
      duration: subscriptionDuration,
      destination: this.config.name,
      action: actionSlug,
      input: {
        ...input,
        settings: redactSettings(settings, privateSettings)
      },
      output: results
    })

    return results
  }

  /**
   * Note: Until we move subscriptions upstream (into int-consumer) we've opted
   * to have failures abort the set of subscriptions and get potentially retried by centrifuge
   */
  public async onEvent(
    context: Context,
    event: JSONObject,
    settings: JSONObject = {},
    privateSettings: JSONArray = []
  ): Promise<StepResult[]> {
    const subscriptions = getSubscriptions(settings)
    const destinationSettings = getDestinationSettings(settings)

    const promises = subscriptions.map(s =>
      this.onSubscription(context, s, event, destinationSettings, privateSettings)
    )

    const results = await Promise.all(promises)

    return results.flat()
  }
}

function getSubscriptions(settings: JSONObject): Subscription[] {
  const { subscriptions } = settings

  const parsedSubscriptions = typeof subscriptions === 'string' ? JSON.parse(subscriptions) : subscriptions

  return parsedSubscriptions as Subscription[]
}

function getDestinationSettings(settings: JSONObject): JSONObject {
  const { subscriptions, ...otherSettings } = settings

  return otherSettings
}
