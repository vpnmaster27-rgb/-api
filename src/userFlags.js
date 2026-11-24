/** Normalize Access Yes/No values (BIT, boolean, numeric, or textual) to a boolean. */
export function isChecked(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value === 1 || value === -1;
  const normalized = String(value).trim().toLowerCase();
  return ['1', '-1', 'true', 'yes', 'y', '是', '勾選'].includes(normalized);
}
