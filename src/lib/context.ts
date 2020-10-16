import { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http'
import { ExecuteInput, StepResult } from './destination-kit/step'
import logger, { LEVEL } from './logger'
import stats from './stats'

interface Fields {
  // Standard HTTP
  http_req_method?: string
  http_req_path?: string
  http_req_query?: { [k: string]: unknown }
  http_req_headers?: IncomingHttpHeaders
  http_req_ip?: string
  http_res_status?: number
  http_res_headers?: OutgoingHttpHeaders
  http_res_size?: number

  // Service
  req_route?: string
  req_duration?: number
  req_source?: string
  req_destination?: string
  error?: unknown

  // Subscriptions executed during the request
  subscriptions: Subscriptions[]
}

export interface Subscriptions {
  duration: number
  destination: string
  action: string
  input: ExecuteInput
  output: StepResult[]
}

type SetFields = Exclude<keyof Fields, AppendFields>
type AppendFields = 'subscriptions'

/** The request context, which gathers info about what happened during the request for debugging purposes */
export default class Context {
  // Add empty properties to control the order in the log output
  private fields: Fields = {
    http_req_method: undefined,
    http_req_path: undefined,
    http_req_query: undefined,
    http_req_headers: undefined,
    http_req_ip: undefined,
    http_res_status: undefined,
    http_res_headers: undefined,
    http_res_size: undefined,
    req_route: undefined,
    req_duration: undefined,
    req_source: undefined,
    req_destination: undefined,
    error: undefined,
    subscriptions: []
  }

  /**
   * Only used for tests
   * @private
   * */
  __get<F extends keyof Fields>(field: F): Fields[F] {
    return this.fields[field]
  }

  /** Sets a field to the specified value, overwriting any existing value */
  set<F extends SetFields>(field: F, value: Fields[F]): void {
    this.fields[field] = value
  }

  /** Appends a value to the specified array field */
  append<F extends AppendFields>(field: F, value: Fields[F][0]): void {
    // TypeScript isn't quite smart enough to figure out that this is type safe. The parameters are typed correctly though.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.fields[field].push(value as any)
  }

  /**  Emits a log to the console or s3logs */
  log(level: LEVEL, message: string, data?: { [k: string]: unknown }): void {
    const logData = Object.assign({}, this.fields, data)
    logger.log(level, message, logData)
  }

  /** Gets the request error */
  getError(): unknown | undefined {
    return this.fields.error
  }

  private sendRequestMetrics(): void {
    const statusCode = this.fields.http_res_status || 500
    const statusGroup = ((statusCode / 100) | 0) + 'xx' // Outputs 5xx, 4xx, etc
    const responseSize = this.fields.http_res_size
    // Replace the colon from routes params
    const endpoint = `${this.fields.http_req_method} ${this.fields.http_req_path}`.replace(/:/g, '_')
    const rawUserAgent = this.fields.http_req_headers?.['user-agent'] ?? 'unknown'

    const tags = [
      `status_code:${statusCode}`,
      `status_group:${statusGroup}`,
      `endpoint:${endpoint}`,
      `user_agent:${rawUserAgent}`
    ]

    stats.increment('request', 1, tags)
    stats.histogram('request_duration', this.fields.req_duration, tags)

    if (responseSize) {
      stats.histogram('response_size', responseSize, tags)
    }

    if (this.fields.error) {
      stats.increment('error', 1, tags)
    }
  }

  /** Sends all the metrics for the request */
  sendMetrics(): void {
    this.sendRequestMetrics()
  }
}

class NoopContext extends Context {
  sendMetrics(): void {
    /* noop */
  }

  log(_level: LEVEL, _message: string, _data?: { [k: string]: unknown }): void {
    /* noop */
  }
}

export const NOOP = new NoopContext()
