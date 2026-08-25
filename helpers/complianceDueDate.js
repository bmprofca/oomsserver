/**
 * Compliance due_date is a signed day offset from period end:
 *   +N  → N days after period ends
 *    0  → on period end day
 *   -N  → N days before period ends (within the period)
 */

export function normalizeComplianceFrequency(frequency) {
  const key = String(frequency || '').trim().toLowerCase();
  if (key === 'halfyearly' || key === 'hypearly') return 'half-yearly';
  if (key === 'annual') return 'yearly';
  return key || 'monthly';
}

/** Frequency-aware allowed range for due_date offsets. */
export function getDueDateBounds(frequency) {
  const freq = normalizeComplianceFrequency(frequency);
  if (freq === 'monthly') return { min: -31, max: 62 };
  if (freq === 'quarterly') return { min: -92, max: 120 };
  if (freq === 'half-yearly') return { min: -183, max: 183 };
  if (freq === 'yearly') return { min: -366, max: 366 };
  return { min: -366, max: 366 };
}

export function dueDateBoundsMessage(frequency) {
  const { min, max } = getDueDateBounds(frequency);
  return `due_date must be an integer between ${min} and ${max} (days from period end; negative = within period)`;
}

/**
 * @param {*} value
 * @param {string} [frequency]
 * @param {{ required?: boolean, defaultValue?: number|null }} [options]
 * @returns {{ value: number|null, error: string|null }}
 */
export function parseDueDateOffset(value, frequency, options = {}) {
  const { required = false, defaultValue = null } = options;
  const empty = value === undefined || value === null || value === '';

  if (empty) {
    if (required) {
      return { value: null, error: dueDateBoundsMessage(frequency) };
    }
    if (defaultValue !== null && defaultValue !== undefined) {
      return { value: defaultValue, error: null };
    }
    return { value: null, error: null };
  }

  const dueDate = Number(value);
  if (!Number.isInteger(dueDate)) {
    return { value: null, error: dueDateBoundsMessage(frequency) };
  }

  const { min, max } = getDueDateBounds(frequency);
  if (dueDate < min || dueDate > max) {
    return { value: null, error: dueDateBoundsMessage(frequency) };
  }

  return { value: dueDate, error: null };
}

/** Clamp a stored catalog default into bounds (branch setup). */
export function clampDueDateOffset(value, frequency, fallback = 10) {
  const dueDate = Number(value);
  if (!Number.isInteger(dueDate)) return fallback;
  const { min, max } = getDueDateBounds(frequency);
  if (dueDate < min || dueDate > max) return fallback;
  return dueDate;
}
