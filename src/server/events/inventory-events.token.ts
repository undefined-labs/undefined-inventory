import type { InjectionToken } from 'tsyringe'
import type { OpenCoreServerLibrary } from '@open-core/framework/server'

/**
 * DI token for the inventory event library. The library is a runtime value (not a class),
 * so it is injected under an explicit token rather than by constructor type.
 */
export const INVENTORY_EVENTS: InjectionToken<OpenCoreServerLibrary> = Symbol('INVENTORY_EVENTS')
