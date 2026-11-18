import { invoke, isTauri } from "@tauri-apps/api/core";

/** Personalization is saved to the same local SQLite database as Library images. */
export type OrganizationKind = "category" | "collection";
export type InterestKind = "league" | "team" | "player" | "tv";

export interface NamedGroup {
  id: string;
  name: string;
  parentId: string | null;
}
export interface GroupAssignment {
  wallpaperId: string;
  groupId: string;
}
export interface FollowedInterest {
  id: string;
  kind: InterestKind;
  provider: "sportsdb" | "tmdb" | "custom";
  providerId: string;
  title: string;
  parentId: string | null;
  preferences: Record<string, unknown>;
}
export type InterestInput = Omit<FollowedInterest, "id">;
export interface PersonalizationSnapshot {
  categories: NamedGroup[];
  collections: NamedGroup[];
  followedInterests: FollowedInterest[];
  wallpaperCategories: GroupAssignment[];
  wallpaperCollections: GroupAssignment[];
}

function requireHost() {
  if (!isTauri()) throw new Error("Personalization requires Haven Walls for Windows.");
}

export async function getPersonalization(): Promise<PersonalizationSnapshot> {
  requireHost();
  return invoke<PersonalizationSnapshot>("get_personalization");
}
export async function createGroup(kind: OrganizationKind, name: string): Promise<NamedGroup> {
  requireHost();
  return invoke<NamedGroup>("create_personalization_group", { kind, name });
}
export async function renameGroup(kind: OrganizationKind, id: string, name: string): Promise<void> {
  requireHost();
  return invoke<void>("rename_personalization_group", { kind, id, name });
}
export async function deleteGroup(kind: OrganizationKind, id: string): Promise<void> {
  requireHost();
  return invoke<void>("delete_personalization_group", { kind, id });
}
export async function saveWallpaperOrganization(
  wallpaperId: string, categoryIds: string[], collectionIds: string[],
): Promise<void> {
  requireHost();
  return invoke<void>("save_wallpaper_organization", { wallpaperId, categoryIds, collectionIds });
}
export async function saveFollowedInterest(input: InterestInput): Promise<void> {
  requireHost();
  return invoke<void>("save_followed_interest", { input });
}
export async function removeFollowedInterest(id: string): Promise<void> {
  requireHost();
  return invoke<void>("remove_followed_interest", { id });
}

/** IDs, not display names, are the source of truth for all associations. */
export function groupIdsForImage(
  links: GroupAssignment[], wallpaperId: string,
): string[] {
  return links.filter((link) => link.wallpaperId === wallpaperId).map((link) => link.groupId);
}
