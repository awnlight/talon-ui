import { describe, expect, it } from 'vitest'
import { readModelChoices, routeKey, type LlmCatalog, type ModelTarget } from '../src/backend/models.ts'

const catalog = (over: Partial<LlmCatalog> = {}): LlmCatalog => ({
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'pi', name: 'Pi' }],
  listModels: async (provider) => provider === 'deepseek'
    ? [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner', description: 'thinks first' }]
    : [{ id: 'pi-1', name: 'Pi One' }],
  resolveModelInfo: async (_provider, model) => model === 'deepseek-reasoner'
    ? { context: { contextWindow: 128_000 }, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
    : { context: { contextWindow: 64_000 } },
  ...over,
})

describe('readModelChoices (spec §3.7)', () => {
  it('flattens every provider × model, carrying window and efforts from the resolved route', async () => {
    const choices = await readModelChoices(catalog(), undefined)
    expect(choices.map((c) => routeKey(c.provider, c.model))).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'pi/pi-1'])
    expect(choices[1]).toMatchObject({
      providerName: 'DeepSeek', name: 'Reasoner', description: 'thinks first',
      contextWindow: 128_000, defaultEffort: 'low', current: false,
    })
    expect(choices[1]!.efforts.map((e) => e.id)).toEqual(['low', 'high'])
    expect(choices[0]!.efforts).toEqual([])                       // never a hard-coded ladder
  })

  it('marks the current route, and APPENDS it when the catalog does not list it', async () => {
    const listed = await readModelChoices(catalog(), { provider: 'pi', model: 'pi-1' })
    expect(listed.filter((c) => c.current).map((c) => c.model)).toEqual(['pi-1'])
    expect(listed).toHaveLength(3)                                 // already there: not duplicated

    const handSet: ModelTarget = { provider: 'local', model: 'my-own-build' }
    const appended = await readModelChoices(catalog(), handSet)
    expect(appended).toHaveLength(4)
    expect(appended.at(-1)).toMatchObject({ provider: 'local', model: 'my-own-build', name: 'my-own-build', current: true })
  })

  it('DEGRADES around a failing provider or route instead of emptying the list', async () => {
    const halfDead = await readModelChoices(catalog({
      listModels: async (provider) => {
        if (provider === 'deepseek') throw new Error('provider is down')
        return [{ id: 'pi-1', name: 'Pi One' }]
      },
    }), undefined)
    expect(halfDead.map((c) => c.model)).toEqual(['pi-1'])          // one dead provider, not an empty selector

    const unresolvable = await readModelChoices(catalog({
      resolveModelInfo: async () => { throw new Error('no metadata') },
    }), undefined)
    expect(unresolvable).toHaveLength(3)                            // the routes survive…
    expect(unresolvable[0]).toMatchObject({ contextWindow: undefined, efforts: [], defaultEffort: undefined })
  })

  it('answers an empty catalog with an empty list, and with only the current route when one is set', async () => {
    const empty = catalog({ listProviders: () => [] })
    expect(await readModelChoices(empty, undefined)).toEqual([])
    expect(await readModelChoices(empty, { provider: 'p', model: 'm' })).toHaveLength(1)
  })
})
