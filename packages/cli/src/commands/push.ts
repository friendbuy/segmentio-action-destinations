import { Command, flags } from '@oclif/command'
import { DestinationDefinition, fieldsToJsonSchema, jsonSchemaToFields } from '@segment/actions-core'
import { idToSlug, destinations as actionDestinations } from '@segment/destination-actions'
import chalk from 'chalk'
import { Dictionary, invert, pick, uniq } from 'lodash'
import ControlPlaneService, {
  DestinationMetadata,
  DestinationMetadataAction,
  DestinationMetadataActionCreateInput,
  DestinationMetadataActionFieldCreateInput,
  DestinationMetadataActionsUpdateInput,
  DestinationMetadataOptions,
  DestinationMetadataUpdateInput
} from '@segment/control-plane-service-client'
import { diffString } from 'json-diff'
import type { JSONSchema4 } from 'json-schema'
import ora from 'ora'
import { prompt } from 'src/lib/prompt'

const controlPlaneService = new ControlPlaneService({
  name: 'control-plane-service',
  url: 'http://control-plane-service.segment.local',
  userAgent: 'Segment (fab-5)',
  timeout: 10000,
  headers: {
    // All calls from this script are system-to-system and shouldn't require authz checks
    'skip-authz': '1'
  }
})

type BaseActionInput = Omit<DestinationMetadataActionCreateInput, 'metadataId'>

export default class Push extends Command {
  private spinner: ora.Ora = ora()

  static description = `Introspects your integration definition to build and upload your integration to Segment. Requires \`robo stage.ssh\` or \`robo prod.ssh\`.`

  static examples = [`$ segment push`]

  static flags = {
    help: flags.help({ char: 'h' }),
    force: flags.boolean({ char: 'f' })
  }

  static args = []

  async run() {
    const { flags } = this.parse(Push)
    const slugToId = invert(idToSlug)
    const availableSlugs = Object.keys(slugToId)
    const { chosenSlugs } = await prompt<{ chosenSlugs: string[] }>({
      type: 'multiselect',
      name: 'chosenSlugs',
      message: 'Integrations:',
      choices: availableSlugs.map((s) => ({
        title: s,
        value: s
      }))
    })

    const destinationIds: string[] = []
    for (const slug of chosenSlugs) {
      const id = slugToId[slug]
      destinationIds.push(id)
    }

    if (!destinationIds.length) {
      this.warn(`You must select at least one destination. Exiting...`)
      return
    }

    this.spinner.start(
      `Fetching existing definitions for ${chosenSlugs.map((slug) => chalk.greenBright(slug)).join(', ')}...`
    )
    const schemasByDestination = getJsonSchemas(actionDestinations, destinationIds, slugToId)
    const metadatas = await getDestinationMetadatas(destinationIds)

    if (metadatas.length !== Object.keys(schemasByDestination).length) {
      this.spinner.fail()
      throw new Error('Number of metadatas must match number of schemas')
    }

    this.spinner.stop()

    const promises = []
    for (const metadata of metadatas) {
      const schemaForDestination = schemasByDestination[metadata.id]
      const slug = schemaForDestination.slug

      this.log('')
      this.log(`${chalk.bold.whiteBright(slug)}`)
      this.spinner.start(`Generating diff for ${chalk.bold(slug)}...`)

      const options = getOptions(metadata, schemaForDestination)
      const basicOptions = getBasicOptions(metadata, options)
      const settingsDiff = diffString(
        asJson(pick(metadata, ['basicOptions', 'options'])),
        asJson({ basicOptions, options })
      )

      const newDefinition = definitionToJson(schemaForDestination.definition)

      // TODO switch to table definition diffs instead of legacy format
      if (settingsDiff) {
        this.spinner.warn(`Detected settings diff for ${chalk.bold(slug)}, please review:`)
        this.log(`\n${settingsDiff}`)
      } else if (flags.force) {
        this.spinner.warn(`No change detected for ${chalk.bold(slug)}. Using force, please review:`)
        this.log(`\n${newDefinition}`)
      } else {
        this.spinner.info(`No change for ${chalk.bold(slug)}. Skipping.`)
        continue
      }

      const { shouldContinue } = await prompt({
        type: 'confirm',
        name: 'shouldContinue',
        message: `Publish change for ${slug}?`,
        initial: false
      })

      if (!shouldContinue) {
        continue
      }

      promises.push(
        updateDestinationMetadata(metadata.id, {
          basicOptions,
          options
        })
      )
    }

    await Promise.all(promises)

    // Dual-write to new tables

    const actions = await getDestinationMetadataActions(destinationIds)

    const actionsToUpdate: DestinationMetadataActionsUpdateInput[] = []
    const actionsToCreate: DestinationMetadataActionCreateInput[] = []

    for (const metadata of metadatas) {
      const schemaForDestination = schemasByDestination[metadata.id]
      const existingActions = actions.filter((a) => a.metadataId === metadata.id)

      for (const action of schemaForDestination.actions) {
        // Note: this implies that changing the slug is a breaking change
        const existingAction = existingActions.find((a) => a.slug === action.slug && a.platform === 'cloud')
        const actionFields = jsonSchemaToFields(action.jsonSchema)

        const fields: DestinationMetadataActionFieldCreateInput[] = Object.keys(actionFields).map((fieldKey) => {
          const field = actionFields[fieldKey]
          return {
            fieldKey,
            type: field.type,
            label: field.label,
            description: field.description,
            defaultValue: field.default,
            required: field.required ?? false,
            multiple: field.multiple ?? false,
            // TODO implement
            choices: null,
            dynamic: field.dynamic ?? false,
            placeholder: field.placeholder ?? '',
            allowNull: field.allowNull ?? false
          }
        })

        const base: BaseActionInput = {
          slug: action.slug,
          name: action.jsonSchema.title ?? 'Unnamed Action',
          description: action.jsonSchema.description ?? '',
          platform: 'cloud',
          fields
        }

        if (existingAction) {
          actionsToUpdate.push({ ...base, actionId: existingAction.id })
        } else {
          actionsToCreate.push({ ...base, metadataId: metadata.id })
        }
      }
    }

    await Promise.all([
      updateDestinationMetadataActions(actionsToUpdate),
      createDestinationMetadataActions(actionsToCreate)
    ])
  }
}

function asJson(obj: unknown) {
  if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
    return obj
  }

  const newObj: Record<string, unknown> = { ...obj }
  for (const key of Object.keys(newObj)) {
    let value = newObj[key]
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch (_err) {
        // do nothing
      }
    }
    newObj[key] = asJson(value)
  }

  return newObj
}

function definitionToJson(definition: DestinationDefinition) {
  // Create a copy that only includes serializable properties
  const copy = JSON.parse(JSON.stringify(definition))

  for (const action of Object.keys(copy.actions)) {
    delete copy.actions[action].dynamicFields
    delete copy.actions[action].cachedFields
    copy.actions[action].hidden = copy.actions[action].hidden ?? false
  }

  return copy
}

function getBasicOptions(metadata: DestinationMetadata, options: DestinationMetadataOptions): string[] {
  return uniq([...metadata.basicOptions, ...Object.keys(options)])
}

function getOptions(metadata: DestinationMetadata, destinationSchema: DestinationSchema): DestinationMetadataOptions {
  const options: DestinationMetadataOptions = { ...metadata.options }

  // We store the destination-level JSON Schema in an option with key `metadata`
  options.metadata = {
    default: '',
    description: JSON.stringify({
      name: destinationSchema.name,
      slug: destinationSchema.slug,
      presets: destinationSchema.definition.presets,
      settings: destinationSchema.jsonSchema
    }),
    encrypt: false,
    hidden: true,
    label: `Destination Metadata`,
    private: true,
    scope: 'event_destination',
    type: 'string',
    validators: []
  }

  // We store each action-level JSON Schema in separate options
  for (const actionPayload of destinationSchema.actions) {
    options[`action${actionPayload.slug}`] = {
      default: '',
      description: JSON.stringify({
        slug: actionPayload.slug,
        schema: actionPayload.jsonSchema,
        defaultSubscription: actionPayload.defaultSubscription,
        // TODO figure out if `settings` property is used anywhere
        settings: []
      }),
      encrypt: false,
      hidden: actionPayload.hidden,
      label: `Action Metadata: ${actionPayload.slug}`,
      private: true,
      scope: 'event_destination',
      type: 'string',
      validators: []
    }
  }

  const requiredProperties = (destinationSchema.jsonSchema?.required as string[]) ?? []
  const properties = destinationSchema.jsonSchema?.properties ?? {}
  for (const name in properties) {
    const property = properties[name]

    if (typeof property === 'boolean') {
      continue
    }

    const validators: string[][] = []

    if (requiredProperties.includes(name)) {
      validators.push(['required', `The ${name} property is required.`])
    }

    options[name] = {
      default: '',
      description: property.description,
      encrypt: false,
      hidden: false,
      label: property.title,
      private: true,
      scope: 'event_destination',
      type: 'string',
      validators
    }
  }

  return options
}

async function getDestinationMetadatas(destinationIds: string[]): Promise<DestinationMetadata[]> {
  const { data, error } = await controlPlaneService.getAllDestinationMetadatas(
    {},
    {
      byIds: destinationIds
    }
  )

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Could not load metadatas')
  }

  return data.metadatas
}

async function getDestinationMetadataActions(destinationIds: string[]): Promise<DestinationMetadataAction[]> {
  const { data, error } = await controlPlaneService.getDestinationMetadataActions(
    {},
    {
      metadataIds: destinationIds
    }
  )

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Could not load actions')
  }

  return data.actions
}

async function updateDestinationMetadata(
  destinationId: string,
  input: DestinationMetadataUpdateInput
): Promise<DestinationMetadata> {
  const { data, error } = await controlPlaneService.updateDestinationMetadata(
    {},
    {
      destinationId,
      input
    }
  )

  if (error) {
    console.log(error)
    throw error
  }

  if (!data) {
    throw new Error('Could not update metadata')
  }

  return data.metadata
}

async function createDestinationMetadataActions(
  input: DestinationMetadataActionCreateInput[]
): Promise<DestinationMetadataAction[]> {
  const { data, error } = await controlPlaneService.createDestinationMetadataActions(
    {},
    {
      input
    }
  )

  if (error) {
    console.log(error)
    throw error
  }

  if (!data) {
    throw new Error('Could not create metadata actions')
  }

  return data.actions
}

async function updateDestinationMetadataActions(
  input: DestinationMetadataActionsUpdateInput[]
): Promise<DestinationMetadataAction[]> {
  const { data, error } = await controlPlaneService.updateDestinationMetadataActions(
    {},
    {
      input
    }
  )

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Could not update metadata actions')
  }

  return data.actions
}

interface SchemasByDestination {
  [destinationId: string]: DestinationSchema
}

interface DestinationSchema {
  name: string
  slug: string
  jsonSchema: JSONSchema4 | undefined
  actions: Action[]
  definition: DestinationDefinition
}

interface Action {
  slug: string
  hidden: boolean
  defaultSubscription?: string
  jsonSchema: JSONSchema4
}

function getJsonSchemas(
  destinations: Record<string, DestinationDefinition<unknown>>,
  destinationIds: string[],
  slugToId: Dictionary<string>
): SchemasByDestination {
  const schemasByDestination: SchemasByDestination = {}

  for (const destinationSlug in destinations) {
    const destinationId = slugToId[destinationSlug]
    if (!destinationIds.includes(destinationId)) {
      continue
    }

    const actionPayloads: Action[] = []
    const destination = destinations[destinationSlug]

    const actions = destination.actions
    for (const actionSlug in actions) {
      const action = actions[actionSlug]
      actionPayloads.push({
        slug: actionSlug,
        hidden: action.hidden ?? false,
        defaultSubscription: action.defaultSubscription,
        jsonSchema: {
          title: action.title,
          description: action.description,
          // For parity with what is happening today
          defaultSubscription: action.defaultSubscription,
          ...fieldsToJsonSchema(action.fields)
        }
      })
    }

    schemasByDestination[destinationId] = {
      name: destination.name,
      slug: destinationSlug,
      jsonSchema: fieldsToJsonSchema(destination.authentication?.fields),
      actions: actionPayloads,
      definition: destination
    }
  }

  return schemasByDestination
}
