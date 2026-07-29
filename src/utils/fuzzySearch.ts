export interface FuzzyMatchResult {
  matched: boolean;
  score: number;
  indices: number[];
}

function normalizeFuzzyText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getSubsequenceMatchIndices(text: string, query: string): number[] {
  const indices: number[] = [];
  if (!query) return indices;
  let queryIndex = 0;

  for (let i = 0; i < text.length && queryIndex < query.length; i += 1) {
    if (text[i] === query[queryIndex]) {
      indices.push(i);
      queryIndex += 1;
    }
  }

  return queryIndex === query.length ? indices : [];
}

function getSubsequenceScore(text: string, query: string): number {
  if (!query) return 1;
  const indices = getSubsequenceMatchIndices(text, query);
  if (indices.length === 0) return 0;

  let consecutive = 1;
  let bestConsecutive = 1;
  let gaps = 0;

  for (let i = 1; i < indices.length; i += 1) {
    const delta = indices[i] - indices[i - 1];
    if (delta === 1) {
      consecutive += 1;
      bestConsecutive = Math.max(bestConsecutive, consecutive);
    } else {
      consecutive = 1;
      gaps += delta - 1;
    }
  }

  return query.length * 10 + bestConsecutive * 6 - gaps;
}

export function fuzzyMatch(text: string, query: string): FuzzyMatchResult {
  const normalizedText = normalizeFuzzyText(text);
  const normalizedQuery = normalizeFuzzyText(query);

  if (!normalizedQuery) {
    return { matched: true, score: 0, indices: [] };
  }

  if (!normalizedText) {
    return { matched: false, score: -Infinity, indices: [] };
  }

  if (normalizedText.includes(normalizedQuery)) {
    const startIndex = normalizedText.indexOf(normalizedQuery);
    return {
      matched: true,
      score: 200 + normalizedQuery.length * 8 + Math.max(0, 24 - startIndex),
      indices: Array.from({ length: normalizedQuery.length }, (_, idx) => startIndex + idx),
    };
  }

  const subsequenceIndices = getSubsequenceMatchIndices(normalizedText, normalizedQuery);
  const subsequenceScore = getSubsequenceScore(normalizedText, normalizedQuery);
  if (subsequenceScore > 0) {
    return {
      matched: true,
      score: 100 + subsequenceScore,
      indices: subsequenceIndices,
    };
  }

  const textTokens = normalizedText.split(" ").filter(Boolean);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const tokenMatches = queryTokens.filter((queryToken) =>
    textTokens.some((textToken) => textToken.includes(queryToken) || queryToken.includes(textToken))
  );
  if (tokenMatches.length > 0) {
    return {
      matched: true,
      score: 40 + tokenMatches.join("").length * 5,
      indices: [],
    };
  }

  return { matched: false, score: -Infinity, indices: [] };
}

export function fuzzyFilterAndSort<T>(
  items: T[],
  query: string,
  getSearchText: (item: T) => string,
): T[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return items;

  return items
    .map((item, index) => ({
      item,
      index,
      result: fuzzyMatch(getSearchText(item), normalizedQuery),
    }))
    .filter(({ result }) => result.matched)
    .sort((a, b) => {
      if (b.result.score !== a.result.score) {
        return b.result.score - a.result.score;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}
