/**
 * Quantities are stored as whole numbers in the smallest unit (millilitres, grams, hundredths of an acre),
 * like money in paise, so totals and averages are exact. Other units exist only at the edges.
 */

export const MASS_UNITS = ['g', 'kg', 'quintal', 'tonne'] as const;
export type MassUnit = (typeof MASS_UNITS)[number];
const GRAMS_PER: Record<MassUnit, number> = { g: 1, kg: 1000, quintal: 100_000, tonne: 1_000_000 };

/** True when the value has at most `places` decimal places (tolerates binary floating-point noise). */
export const hasAtMostDecimals = (value: number, places: number) => {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

export const litresToMillilitres = (litres: number) => Math.round(litres * 1000);
export const toGrams = (value: number, unit: MassUnit) => Math.round(value * GRAMS_PER[unit]);
export const acresToHundredths = (acres: number) => Math.round(acres * 100);

const number = (value: number, maxDecimals: number) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDecimals, minimumFractionDigits: 0 }).format(value);

/** 12500 -> "12.5 L" */
export const formatLitres = (millilitres: number) => `${number(millilitres / 1000, 2)} L`;

/** Grams shown in a farmer-friendly unit: under 100 kg in kg, else quintal (100 kg) with the kg in brackets. */
export function formatMass(grams: number): string {
  const kg = grams / 1000;
  if (kg < 100) return `${number(kg, 2)} kg`;
  return `${number(kg / 100, 2)} quintal (${number(kg, 1)} kg)`;
}

export const formatAcres = (hundredths: number) => `${number(hundredths / 100, 2)} acre${hundredths === 100 ? '' : 's'}`;
