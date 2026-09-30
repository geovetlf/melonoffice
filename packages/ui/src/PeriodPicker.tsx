import type { ReactNode } from 'react';

/**
 * One period (or frequency) out of a few, as a segmented control: each option is a button that
 * says whether it is the one chosen (`aria-pressed`). It emits the option itself, nothing more.
 */
export function PeriodPicker<T extends string>({
  options,
  value,
  onChange,
  renderOption,
  label,
  labelledBy,
  className,
}: {
  readonly options: readonly T[];
  readonly value: T;
  readonly onChange: (option: T) => void;
  readonly renderOption: (option: T) => ReactNode;
  /** The group's name; or `labelledBy`, the id of text that names it. */
  readonly label?: string;
  readonly labelledBy?: string;
  readonly className?: string;
}) {
  return (
    <div
      className={className === undefined ? 'mo-segmented' : `mo-segmented ${className}`}
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {renderOption(option)}
        </button>
      ))}
    </div>
  );
}
