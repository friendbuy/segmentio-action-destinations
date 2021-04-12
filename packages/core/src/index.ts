export { Destination, fieldsToJsonSchema, jsonSchemaToFields } from './destination-kit'
export { transform } from './mapping-kit'
export { createTestEvent } from './create-test-event'
export { createTestIntegration } from './create-test-integration'
export { defaultValues } from './defaults'
export { UnsupportedActionError } from './errors'
export { get } from './get'
export { omit } from './omit'
export { removeUndefined } from './remove-undefined'
export { time, duration } from './time'

export { realTypeOf, isObject, isArray, isString } from './real-type-of'

export type { RequestOptions } from './request-client'
export { default as fetch, Request, Response, Headers } from './fetch'

export type {
  ActionDefinition,
  DestinationDefinition,
  ExecuteInput,
  Subscription,
  SubscriptionStats,
  AuthenticationScheme,
  BasicAuthentication,
  CustomAuthentication,
  RequestFn,
  DecoratedResponse
} from './destination-kit'

export type { AutocompleteResponse, AutocompleteItem, InputField, RequestExtension } from './destination-kit/types'

export type { JSONPrimitive, JSONValue, JSONObject, JSONArray, JSONLike, JSONLikeObject } from './json-object'

export type { SegmentEvent } from './segment-event'
