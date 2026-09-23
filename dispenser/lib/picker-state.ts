export type PickerState = {
  modelIds: string[];
  selectedIds: Set<string>;
};

export function createPickerState(modelIds: string[], selectedIds: string[]): PickerState {
  const known = new Set(modelIds);
  return {
    modelIds,
    selectedIds: new Set(selectedIds.filter((id) => known.has(id))),
  };
}

export function toggleModel(state: PickerState, modelId: string): PickerState {
  const next = new Set(state.selectedIds);
  if (next.has(modelId)) next.delete(modelId);
  else next.add(modelId);
  return { ...state, selectedIds: next };
}

export function selectAllModels(state: PickerState): PickerState {
  return { ...state, selectedIds: new Set(state.modelIds) };
}

export function clearAllModels(state: PickerState): PickerState {
  return { ...state, selectedIds: new Set() };
}
