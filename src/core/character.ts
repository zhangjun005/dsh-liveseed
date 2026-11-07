/** Read-only browser asset catalogue. No file paths or bone controls are exposed to the model. */
export interface CharacterResource { name: string; url: string }
export interface CharacterModel {
  id: string;
  title: string;
  model: string;
  resources: CharacterResource[];
}
export interface CharacterCatalog { models: CharacterModel[] }

