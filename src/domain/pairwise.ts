/**
 * Greedy pairwise (t=2) covering-array generator.
 *
 * Given N dimensions (each an array of choices), returns a small set of rows in
 * which EVERY pair of dimension values co-occurs in at least one row. This is
 * the industry-standard answer to combinatorial explosion: exhaustive coverage
 * of pairwise interactions catches the overwhelming majority of interaction
 * bugs at a tiny fraction of the full cartesian cost (NIST/PICT practice).
 */
export function pairwise<T>(dimensions: T[][]): T[][] {
  const k = dimensions.length;
  if (k === 0) return [];
  if (k === 1) return dimensions[0].map((v) => [v]);

  // Enumerate all required pairs as "d1:index1|d2:index2" keys.
  const required = new Set<string>();
  for (let d1 = 0; d1 < k; d1++) {
    for (let d2 = d1 + 1; d2 < k; d2++) {
      for (let i = 0; i < dimensions[d1].length; i++) {
        for (let j = 0; j < dimensions[d2].length; j++) {
          required.add(`${d1}:${i}|${d2}:${j}`);
        }
      }
    }
  }

  const rows: T[][] = [];
  const rowCount = dimensions.reduce((n, d) => n * d.length, 1);

  // Deterministic candidate order: seed with the largest dimension vertical,
  // then extend each row greedily, choosing the value that covers the most
  // still-uncovered pairs (classic IPOG-style greedy).
  const order = dimensions.map((d, i) => ({ i, size: d.length })).sort((a, b) => b.size - a.size);

  const covers = (row: (number | undefined)[], pair: string): boolean => {
    const [a, b] = pair.split("|").map((x) => x.split(":").map(Number) as [number, number]);
    const va = row[a[0]];
    const vb = row[b[0]];
    return va === a[1] && vb === b[1];
  };

  let candidates = 0;
  for (let n = 0; n < rowCount && required.size > 0; n++) {
    const row: (number | undefined)[] = new Array(k).fill(undefined);
    row[order[0].i] = n % dimensions[order[0].i].length;
    candidates++;
    for (const { i } of order.slice(1)) {
      let bestVal = 0;
      let bestScore = -1;
      for (let v = 0; v < dimensions[i].length; v++) {
        let score = 0;
        for (const pair of required) {
          const [a, b] = pair.split("|").map((x) => x.split(":").map(Number) as [number, number]);
          if (a[0] === i && row[b[0]] === b[1] && coversPair(row, a[0], v, b[0], b[1])) score++;
          else if (b[0] === i && row[a[0]] === a[1] && coversPair(row, b[0], v, a[0], a[1])) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestVal = v;
        }
      }
      row[i] = bestVal;
    }
    // Remove all pairs this row covers.
    for (const pair of Array.from(required)) {
      if (covers(row, pair)) required.delete(pair);
    }
    rows.push(row.map((idx, d) => dimensions[d][idx as number]));
  }

  function coversPair(
    row: (number | undefined)[],
    d1: number,
    v1: number,
    d2: number,
    v2: number
  ): boolean {
    if (d1 === d2) return row[d1] === v1;
    return row[d1] === v1 && row[d2] === v2;
  }

  void candidates;
  return rows;
}
