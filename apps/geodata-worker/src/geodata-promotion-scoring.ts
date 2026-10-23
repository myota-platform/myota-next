import { Injectable } from '@nestjs/common';
import { pythonRound } from '@app/platform/python-number.js';
import { pythonStrip } from '@app/platform/python-string.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';

type BoundingBox = [number, number, number, number];

@Injectable()
export class GeodataPromotionScoring {
  score(
    candidateName: string,
    candidateRef: string,
    candidateJurisdiction: string | null,
    candidateBox: BoundingBox,
    existingName: string,
    existingRef: string,
    existingJurisdiction: string | null,
    existingBox: BoundingBox,
  ) {
    const normalizedCandidate = unicodeCaseFold(pythonStrip(candidateName));
    const normalizedExisting = unicodeCaseFold(pythonStrip(existingName));
    const nameScore =
      normalizedCandidate && normalizedExisting
        ? sequenceMatcherRatio(normalizedCandidate, normalizedExisting)
        : 0;
    const sourceIdentifier =
      candidateRef && candidateRef === existingRef ? 1 : 0;
    const intersection = boxIntersection(candidateBox, existingBox);
    const candidateArea = boxArea(candidateBox);
    const existingArea = boxArea(existingBox);
    const union = candidateArea + existingArea - intersection;
    const overlap = union ? intersection / union : 0;
    const containment =
      candidateBox[0] >= existingBox[0] &&
      candidateBox[1] >= existingBox[1] &&
      candidateBox[2] <= existingBox[2] &&
      candidateBox[3] <= existingBox[3]
        ? 1
        : 0;
    const distanceKm = haversineKm(
      boxCenter(candidateBox),
      boxCenter(existingBox),
    );
    const distanceScore = Math.max(0, 1 - distanceKm / 2);
    const jurisdiction =
      candidateJurisdiction && candidateJurisdiction === existingJurisdiction
        ? 1
        : 0;
    const score = round6(
      sourceIdentifier * 0.3 +
        nameScore * 0.2 +
        containment * 0.2 +
        overlap * 0.15 +
        distanceScore * 0.1 +
        jurisdiction * 0.05,
    );
    return {
      score,
      signals: {
        sourceIdentifier,
        name: round6(nameScore),
        containment,
        overlap: round6(overlap),
        distanceKm: round6(distanceKm),
        jurisdiction,
      },
    };
  }
}

function sequenceMatcherRatio(left: string, right: string) {
  const leftSymbols = Array.from(left);
  const rightSymbols = Array.from(right);
  if (!leftSymbols.length && !rightSymbols.length) return 1;

  const popular = new Set<string>();
  if (rightSymbols.length >= 200) {
    const counts = new Map<string, number>();
    for (const symbol of rightSymbols)
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    const popularityThreshold = Math.floor(rightSymbols.length / 100) + 1;
    for (const [symbol, count] of counts)
      if (count > popularityThreshold) popular.add(symbol);
  }
  const rightIndices = new Map<string, number[]>();
  for (let index = 0; index < rightSymbols.length; index += 1) {
    const symbol = rightSymbols[index];
    if (popular.has(symbol)) continue;
    const indices = rightIndices.get(symbol);
    if (indices) indices.push(index);
    else rightIndices.set(symbol, [index]);
  }

  const pending: [number, number, number, number][] = [
    [0, leftSymbols.length, 0, rightSymbols.length],
  ];
  let matchingCharacters = 0;
  while (pending.length) {
    const [leftStart, leftEnd, rightStart, rightEnd] = pending.pop()!;
    let bestLeft = leftStart;
    let bestRight = rightStart;
    let bestSize = 0;
    let previous = new Map<number, number>();
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      const current = new Map<number, number>();
      for (const rightIndex of rightIndices.get(leftSymbols[leftIndex]) ?? []) {
        if (rightIndex < rightStart) continue;
        if (rightIndex >= rightEnd) break;
        const size = (previous.get(rightIndex - 1) ?? 0) + 1;
        current.set(rightIndex, size);
        if (size > bestSize) {
          bestLeft = leftIndex - size + 1;
          bestRight = rightIndex - size + 1;
          bestSize = size;
        }
      }
      previous = current;
    }

    while (
      bestLeft > leftStart &&
      bestRight > rightStart &&
      leftSymbols[bestLeft - 1] === rightSymbols[bestRight - 1]
    ) {
      bestLeft -= 1;
      bestRight -= 1;
      bestSize += 1;
    }
    while (
      bestLeft + bestSize < leftEnd &&
      bestRight + bestSize < rightEnd &&
      leftSymbols[bestLeft + bestSize] === rightSymbols[bestRight + bestSize]
    )
      bestSize += 1;

    if (!bestSize) continue;
    matchingCharacters += bestSize;
    if (leftStart < bestLeft && rightStart < bestRight)
      pending.push([leftStart, bestLeft, rightStart, bestRight]);
    const leftAfter = bestLeft + bestSize;
    const rightAfter = bestRight + bestSize;
    if (leftAfter < leftEnd && rightAfter < rightEnd)
      pending.push([leftAfter, leftEnd, rightAfter, rightEnd]);
  }
  return (2 * matchingCharacters) / (leftSymbols.length + rightSymbols.length);
}

function boxArea(box: BoundingBox) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function boxIntersection(left: BoundingBox, right: BoundingBox) {
  const minX = Math.max(left[0], right[0]);
  const minY = Math.max(left[1], right[1]);
  const maxX = Math.min(left[2], right[2]);
  const maxY = Math.min(left[3], right[3]);
  if (minX >= maxX || minY >= maxY) return 0;
  return (maxX - minX) * (maxY - minY);
}

function boxCenter(box: BoundingBox) {
  return {
    lon: pythonRound((box[0] + box[2]) / 2, 7),
    lat: pythonRound((box[1] + box[3]) / 2, 7),
  };
}

function haversineKm(
  left: { lon: number; lat: number },
  right: { lon: number; lat: number },
) {
  const radius = 6371.0088;
  const lat1 = (left.lat * Math.PI) / 180;
  const lat2 = (right.lat * Math.PI) / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = ((right.lon - left.lon) * Math.PI) / 180;
  const term =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return (
    radius * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(Math.max(0, 1 - term)))
  );
}

function round6(value: number) {
  return pythonRound(value, 6);
}
