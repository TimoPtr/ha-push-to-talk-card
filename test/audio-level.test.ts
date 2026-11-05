import { describe, expect, it } from "vitest";
import { nextLevel } from "../src/audio-level";

const constant = (value: number) => new Float32Array(512).fill(value);

describe("nextLevel", () => {
  it("is 0 for silence", () => {
    expect(nextLevel(constant(0), 0)).toBe(0);
  });

  it("is 1 for a full-scale signal", () => {
    expect(nextLevel(constant(1), 0)).toBe(1);
  });

  it("maps -35 dB to the middle", () => {
    expect(nextLevel(constant(10 ** (-35 / 20)), 0)).toBeCloseTo(0.5, 2);
  });

  it("falls slowly after a loud moment", () => {
    expect(nextLevel(constant(0), 1)).toBeCloseTo(0.95, 5);
  });

  it("rises at once", () => {
    expect(nextLevel(constant(1), 0.2)).toBe(1);
  });
});
