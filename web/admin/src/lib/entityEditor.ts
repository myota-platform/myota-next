export interface EntityEditorState {
  name: string;
  website: string;
  description: string;
  nameNote: string;
  categories: string[];
  geometry: string;
  geometryType: string;
  geometryNote: string;
  location: string;
}

function normalizedGeometry(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  } // Invalid drafts must also trigger discard protection.
}

export function dirtyEditorSections(
  saved: EntityEditorState,
  draft: EntityEditorState,
): string[] {
  const sections: string[] = [];
  if (saved.name !== draft.name || draft.nameNote) sections.push('Name');
  if (
    saved.website !== draft.website ||
    saved.description !== draft.description
  )
    sections.push('Website / description');
  if (JSON.stringify(saved.categories) !== JSON.stringify(draft.categories))
    sections.push('Categories');
  if (
    normalizedGeometry(saved.geometry) !== normalizedGeometry(draft.geometry) ||
    saved.geometryType !== draft.geometryType ||
    draft.geometryNote
  ) {
    sections.push('Geometry');
  }
  if (saved.location !== draft.location) sections.push('Location');
  return sections;
}
