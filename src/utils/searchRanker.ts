import { FSItem } from "../types";

export type SearchMode = "default";
export type SearchMatchField = "name" | "path";

export interface SearchMatchResult {
  matched: boolean;
  score: number;
  tier: number;
  field: SearchMatchField;
  indices: number[];
  matchedText: string;
}

export interface RankedSearchItem<T> {
  item: T;
  finalScore: number;
  primaryField: SearchMatchField;
  primaryResult: SearchMatchResult;
  nameResult: SearchMatchResult;
  pathResult: SearchMatchResult;
}

const EMPTY_RESULT: SearchMatchResult = {
  matched: false,
  score: Number.NEGATIVE_INFINITY,
  tier: 0,
  field: "name",
  indices: [],
  matchedText: "",
};

function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_.-]+/g, " ")
    .replace(/[^a-zA-Z0-9\\/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function getTokens(value: string): string[] {
  return normalizeForSearch(value).split(" ").filter(Boolean);
}

function getPathParts(value: string): string[] {
  return normalizeForSearch(value).split(/[\\/ ]+/).filter(Boolean);
}

function findContiguousIndices(text: string, query: string): number[] {
  const normalizedText = normalizeForSearch(text);
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedText || !normalizedQuery) return [];
  const start = normalizedText.indexOf(normalizedQuery);
  if (start < 0) return [];
  return Array.from({ length: normalizedQuery.length }, (_, index) => start + index);
}

export function getMatchHighlightIndices(text: string, query: string, mode: SearchMode = "default"): number[] {
  const directIndices = findContiguousIndices(text, query);
  if (directIndices.length > 0) return directIndices;
  return [];
}

function buildMatchResult(
  field: SearchMatchField,
  tier: number,
  score: number,
  text: string,
  query: string,
  indices: number[] = [],
): SearchMatchResult {
  return {
    matched: true,
    score,
    tier,
    field,
    indices,
    matchedText: query,
  };
}

function scoreNameMatch(name: string, query: string, mode: SearchMode): SearchMatchResult {
  const normalizedName = normalizeForSearch(name);
  const normalizedQuery = normalizeForSearch(query);

  if (!normalizedName || !normalizedQuery) return EMPTY_RESULT;

  if (normalizedName === normalizedQuery) {
    return buildMatchResult("name", 7, 120000 + (name === query ? 25 : 0), name, query, findContiguousIndices(name, query));
  }

  const tokens = getTokens(name);
  const containsIndex = normalizedName.indexOf(normalizedQuery);

  if (normalizedName.startsWith(normalizedQuery)) {
    return buildMatchResult("name", 6, 90000 + 250 + (name.toLowerCase().startsWith(query.toLowerCase()) ? 25 : 0), name, query, findContiguousIndices(name, query));
  }

  if (tokens.some((token) => token === normalizedQuery)) {
    return buildMatchResult("name", 5, 70000, name, query, findContiguousIndices(name, query));
  }

  if (tokens.some((token) => token.startsWith(normalizedQuery))) {
    return buildMatchResult("name", 4, 50000 + 120, name, query, findContiguousIndices(name, query));
  }

  if (containsIndex >= 0) {
    const extensionIndex = normalizedName.lastIndexOf(".");
    const extensionPenalty = extensionIndex >= 0 && containsIndex > extensionIndex ? -4000 : 0;
    const earlyBonus = Math.max(0, 800 - containsIndex * 30);
    return buildMatchResult("name", 3, 24000 + earlyBonus + extensionPenalty, name, query, findContiguousIndices(name, query));
  }

  return EMPTY_RESULT;
}

function scorePathMatch(relativePath: string, query: string, mode: SearchMode): SearchMatchResult {
  const normalizedPath = normalizeForSearch(relativePath);
  const normalizedQuery = normalizeForSearch(query);

  if (!normalizedPath || !normalizedQuery) return EMPTY_RESULT;

  const pathParts = getPathParts(relativePath);
  const fileName = pathParts[pathParts.length - 1] ?? "";
  const parentParts = pathParts.slice(0, -1);
  const containsIndex = normalizedPath.indexOf(normalizedQuery);

  if (fileName === normalizedQuery) {
    return buildMatchResult("path", 4, 22000, relativePath, query, findContiguousIndices(relativePath, query));
  }

  if (fileName.startsWith(normalizedQuery)) {
    return buildMatchResult("path", 3, 18000, relativePath, query, findContiguousIndices(relativePath, query));
  }

  if (parentParts.some((part) => part === normalizedQuery)) {
    return buildMatchResult("path", 2, 12000, relativePath, query, findContiguousIndices(relativePath, query));
  }

  if (parentParts.some((part) => part.startsWith(normalizedQuery))) {
    return buildMatchResult("path", 2, 9000, relativePath, query, findContiguousIndices(relativePath, query));
  }

  if (pathParts.some((part) => part.includes(normalizedQuery))) {
    return buildMatchResult("path", 1, 5200, relativePath, query, findContiguousIndices(relativePath, query));
  }

  if (containsIndex >= 0) {
    const depthPenalty = Math.max(0, parentParts.length * 120);
    return buildMatchResult("path", 1, 2500 - depthPenalty, relativePath, query, findContiguousIndices(relativePath, query));
  }

  return EMPTY_RESULT;
}

export function getRelativeSearchPath(item: Pick<FSItem, "path">, rootPath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedItemPath = item.path.replace(/\\/g, "/");
  if (!normalizedRoot) return normalizedItemPath;
  if (normalizedItemPath.toLowerCase() === normalizedRoot.toLowerCase()) return item.path.split(/[\\/]/).pop() || item.path;
  const prefix = `${normalizedRoot}/`;
  if (normalizedItemPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedItemPath.slice(prefix.length);
  }
  return normalizedItemPath;
}

export function rankSearchItem<T>(
  item: T,
  query: string,
  getName: (item: T) => string,
  getRelativePath: (item: T) => string,
  mode: SearchMode = "default",
): RankedSearchItem<T> {
  const name = getName(item);
  const relativePath = getRelativePath(item);
  const nameResult = scoreNameMatch(name, query, mode);
  const pathResult = scorePathMatch(relativePath, query, mode);
  const primaryResult = nameResult.score >= pathResult.score ? nameResult : pathResult;

  return {
    item,
    finalScore: Math.max(nameResult.score, pathResult.score),
    primaryField: primaryResult.field,
    primaryResult,
    nameResult,
    pathResult,
  };
}

export function rankAndSortItems<T>(
  items: T[],
  query: string,
  getName: (item: T) => string,
  getRelativePath: (item: T) => string,
  mode: SearchMode = "default",
): RankedSearchItem<T>[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items.map((item) => ({
      item,
      finalScore: 0,
      primaryField: "name" as const,
      primaryResult: { ...EMPTY_RESULT, matched: true, score: 0 },
      nameResult: { ...EMPTY_RESULT, matched: true, score: 0 },
      pathResult: { ...EMPTY_RESULT, matched: false },
    }));
  }

  const ranked = items.map((item, index) => ({
    ...rankSearchItem(item, trimmed, getName, getRelativePath, mode),
    index,
  }));

  return ranked
    .filter((entry) => entry.finalScore > Number.NEGATIVE_INFINITY)
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if (b.primaryResult.tier !== a.primaryResult.tier) return b.primaryResult.tier - a.primaryResult.tier;
      return a.index - b.index;
    })
    .map(({ index, ...entry }) => entry);
}

export function filterAndSortSearchItems<T>(
  items: T[],
  query: string,
  getName: (item: T) => string,
  getRelativePath: (item: T) => string,
  mode: SearchMode = "default",
): T[] {
  return rankAndSortItems(items, query, getName, getRelativePath, mode).map(({ item }) => item);
}
