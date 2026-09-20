import { describe, expect, it } from 'vitest'
import { selectModelSettings } from '../src/model-selection.ts'

describe('runtime model selection', () => {
  const models = [
    { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'ultra'], isDefault: true },
    { id: 'future-model', displayName: 'Future', defaultReasoningEffort: 'adaptive', supportedReasoningEfforts: ['adaptive'], isDefault: false },
  ]
  it('uses catalog ids and supports a new model/effort without a release', () => {
    expect(selectModelSettings(models, 'future-model', 'ultra')).toEqual({ model: 'future-model', effort: 'adaptive' })
    expect(selectModelSettings(models, 'gpt-6-astra', 'ultra')).toEqual({ model: 'gpt-6-astra', effort: 'ultra' })
  })
  it('falls back to the reported default when a retired model is removed', () => {
    expect(selectModelSettings(models, 'retired', 'xhigh')).toEqual({ model: 'gpt-6-astra', effort: 'medium' })
    expect(selectModelSettings([], 'retired', 'ultra')).toEqual({ model: '', effort: '' })
  })
})
