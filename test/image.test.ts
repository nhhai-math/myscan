import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHomography, DEFAULT_CORNERS, solveHomography, validateCorners,
} from '../src/lib/image.ts';
import type { Point, Quad } from '../src/lib/image.ts';

const near = (actual: Point, expected: Point, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual.x - expected.x) < tolerance, `x: ${actual.x} ≠ ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < tolerance, `y: ${actual.y} ≠ ${expected.y}`);
};

test('corner validation accepts full pages and convex perspective crops', () => {
  assert.equal(validateCorners(DEFAULT_CORNERS), true);
  assert.equal(validateCorners([
    { x: 0.18, y: 0.08 }, { x: 0.94, y: 0.24 },
    { x: 0.84, y: 0.93 }, { x: 0.06, y: 0.82 },
  ]), true);
});

test('corner validation rejects crossing, reverse winding, concavity, tiny crops and invalid points', () => {
  const invalid: Quad[] = [
    [DEFAULT_CORNERS[0], DEFAULT_CORNERS[2], DEFAULT_CORNERS[1], DEFAULT_CORNERS[3]],
    [DEFAULT_CORNERS[0], DEFAULT_CORNERS[3], DEFAULT_CORNERS[2], DEFAULT_CORNERS[1]],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.1, y: 0.1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0.05, y: 0 }, { x: 0.05, y: 0.05 }, { x: 0, y: 0.05 }],
    [{ x: -0.01, y: 0 }, ...DEFAULT_CORNERS.slice(1)] as Quad,
    [{ x: Number.NaN, y: 0 }, ...DEFAULT_CORNERS.slice(1)] as Quad,
    [{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  ];
  for (const corners of invalid) assert.equal(validateCorners(corners), false);
});

test('homography maps a projective quad exactly and preserves round trips inside the page', () => {
  const crop: Quad = [
    { x: 0.15, y: 0.1 }, { x: 0.9, y: 0.2 },
    { x: 0.8, y: 0.95 }, { x: 0.05, y: 0.75 },
  ];
  const forward = solveHomography(DEFAULT_CORNERS, crop);
  const inverse = solveHomography(crop, DEFAULT_CORNERS);
  DEFAULT_CORNERS.forEach((point, index) => near(applyHomography(forward, point), crop[index]));
  for (const point of [{ x: 0.3, y: 0.7 }, { x: 0.5, y: 0.5 }, { x: 0.01, y: 0.99 }]) {
    near(applyHomography(inverse, applyHomography(forward, point)), point);
  }
});

test('homography handles pixel coordinates and affine transformations', () => {
  const source: Quad = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }];
  const destination: Quad = [{ x: 10, y: 20 }, { x: 2010, y: 20 }, { x: 2010, y: 1520 }, { x: 10, y: 1520 }];
  near(applyHomography(solveHomography(source, destination), { x: 1000, y: 2000 }), { x: 510, y: 1020 });
});

test('homography rejects degenerate geometry and projections to infinity', () => {
  const line: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
  assert.throws(() => solveHomography(line, DEFAULT_CORNERS));
  assert.throws(() => applyHomography([1, 0, 0, 0, 1, 0, 1, 0, 0], { x: 0, y: 1 }));
});
