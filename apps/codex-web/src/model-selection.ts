import type { ModelOption } from '@codex-plus/serve-client'

export function selectModelSettings(models: readonly ModelOption[], model: string, effort: string) {
  const selected = models.find(option => option.id === model) ?? models.find(option => option.isDefault) ?? models[0]
  if (selected === undefined) return { model: '', effort: '' }
  return {
    model: selected.id,
    effort: selected.supportedReasoningEfforts.includes(effort) ? effort : selected.defaultReasoningEffort,
  }
}
