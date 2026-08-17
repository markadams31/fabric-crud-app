import {
  Checkbox,
  Dropdown,
  Field as FluentField,
  Input,
  makeStyles,
  Option,
  SpinButton,
} from '@fluentui/react-components';
import { DatePicker, type DatePickerProps } from '@fluentui/react-datepicker-compat';
import { useState } from 'react';

import type { Row } from './db';
import { describeRow, type FieldView } from './entity';

/**
 * The viewer's declared language chain, not `undefined`: Chrome resolves an
 * `undefined` locale to its UI language, ships no en-AU (and most other
 * regional-English) UI builds, and so silently renders US formats for users
 * whose language preference says otherwise. `navigator.languages` is the
 * preference itself. Absent (tests, node) it falls back to the runtime default.
 */
export const LOCALES: readonly string[] | undefined =
  typeof navigator === 'undefined' ? undefined : navigator.languages;

// The locale's own date order, derived once: formatToParts on a reference date
// yields the placeholder pattern ("dd/mm/yyyy" in en-AU) and the positional
// mapping the typed-input parser uses.
const DATE_PARTS = new Intl.DateTimeFormat(LOCALES).formatToParts(new Date(2000, 0, 2));
const DATE_ORDER = DATE_PARTS.map((p) => p.type).filter(
  (t): t is 'year' | 'month' | 'day' => t === 'year' || t === 'month' || t === 'day'
);
export const DATE_PATTERN = DATE_PARTS.map((p) =>
  p.type === 'year' ? 'yyyy' : p.type === 'month' ? 'mm' : p.type === 'day' ? 'dd' : p.value
).join('');

// Weeks start where the viewer's locale says they do (en-AU: Monday). The
// Intl week-info API is new enough to guard; its Sunday is 7, the picker's 0.
const FIRST_DAY = (() => {
  try {
    const locale = new Intl.Locale(LOCALES?.[0] ?? 'en-US') as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
    };
    return ((locale.getWeekInfo?.().firstDay ?? 7) % 7) as DatePickerProps['firstDayOfWeek'];
  } catch {
    return undefined;
  }
})();

const useStyles = makeStyles({
  listbox: { maxHeight: '240px' },
});

/**
 * One input, chosen from the field's own constraints.
 *
 * Nothing here knows an entity or a field name. A `@set` becomes a dropdown
 * because its constraints say `type: 'enum'` and carry the values; a foreign key
 * becomes a dropdown of real records because the relationship metadata says what
 * it points at; a `@boolean` becomes a checkbox. The same component therefore
 * renders any Rayfin entity, including one this app has never seen.
 */
export function Field({
  field,
  value,
  error,
  disabled,
  options,
  inlinePopup,
  onChange,
}: {
  field: FieldView;
  value: string;
  error?: string;
  disabled?: boolean;
  /** Rows of the entity a foreign key points at, when it has one. */
  options?: Row[];
  /**
   * Render the date calendar in place rather than in a portal.
   *
   * Needed inside a `Popover`: a portalled calendar is DOM-outside the popover,
   * so opening it counts as a click outside and dismisses the whole panel —
   * measured, and the reason the filter's date bounds were plain text first.
   */
  inlinePopup?: boolean;
  onChange: (value: string) => void;
}) {
  const styles = useStyles();
  const c = field.constraints;
  // The date picker reports unparseable typed input as an event, not a
  // rendered message — held here and surfaced through the field below, where
  // the form validator's own error takes precedence when both exist.
  const [pickerError, setPickerError] = useState<string>();
  const shownError = error ?? pickerError;

  const control = field.lookup ? (
    <Dropdown
      disabled={disabled || !options}
      selectedOptions={value ? [value] : []}
      value={options ? describeRow(options.find((o) => o.id === value), field) : 'Loading…'}
      onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
      placeholder={`Select a ${field.label.toLowerCase()}…`}
      // A reference table can hold hundreds of rows, and the list grows to fit
      // them: with 50 currencies it was 642px tall and covered the form behind
      // it. Fluent's `autoSize` writes that height as an inline style, which no
      // class can override — turning it off lets the cap below apply, and the
      // list scrolls instead.
      positioning={{ autoSize: false }}
      listbox={{ className: styles.listbox }}
    >
      {/* An optional value must be un-choosable again; without this, the
          first selection is forever. Empty string reaches the server as
          null — "set this to nothing" — via the same path a cleared text
          field takes. */}
      {c.optional && (
        <Option value="" text="—">
          —
        </Option>
      )}
      {(options ?? []).map((o) => (
        <Option key={o.id} value={o.id} text={describeRow(o, field)}>
          {describeRow(o, field)}
        </Option>
      ))}
    </Dropdown>
  ) : c.type === 'enum' ? (
    <Dropdown
      value={value}
      selectedOptions={value ? [value] : []}
      disabled={disabled}
      onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
      placeholder="Select…"
    >
      {c.optional && (
        <Option value="" text="—">
          —
        </Option>
      )}
      {c.values.map((v) => (
        <Option key={v} value={v}>
          {v}
        </Option>
      ))}
    </Dropdown>
  ) : c.type === 'boolean' && c.optional ? (
    // An optional boolean has three answers — unknown, yes, no — and the grid
    // renders unknown as its own thing (an em-dash). A checkbox can only say
    // yes or no, so one mis-click would turn unknown into no forever; the
    // dropdown keeps unknown reachable, like the enum's "—" above.
    <Dropdown
      value={value === 'true' ? 'Yes' : value === 'false' ? 'No' : ''}
      selectedOptions={[value]}
      disabled={disabled}
      onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
      placeholder="—"
    >
      <Option value="" text="—">
        —
      </Option>
      <Option value="true" text="Yes">
        Yes
      </Option>
      <Option value="false" text="No">
        No
      </Option>
    </Dropdown>
  ) : c.type === 'boolean' ? (
    <Checkbox
      checked={value === 'true'}
      disabled={disabled}
      label={value === 'true' ? 'Yes' : 'No'}
      onChange={(_, d) => onChange(d.checked ? 'true' : 'false')}
    />
  ) : c.type === 'number' ? (
    <SpinButton
      value={value === '' ? null : Number(value)}
      displayValue={value}
      min={c.min}
      max={c.max}
      // `@int` steps by one; a decimal's step follows its declared scale.
      step={c.format === 'int' ? 1 : 10 ** -(c.scale ?? 2)}
      disabled={disabled}
      // Keep what was typed unless it is a real number. SpinButton reports
      // `NaN` for text it cannot parse and for anything outside min/max, and
      // storing that put the literal string "NaN" in the box — worse than the
      // "-5" the person typed, which the validator can at least explain.
      onChange={(_, d) =>
        onChange(typeof d.value === 'number' && Number.isFinite(d.value)
          ? String(d.value)
          : (d.displayValue ?? ''))
      }
    />
  ) : c.type === 'date' ? (
    // Fluent's picker rather than <input type="date">: the native widget
    // formats per the browser's UI locale, which ignores the language
    // preference the rest of the app renders by (see LOCALES above).
    <DatePicker
      value={value ? isoToLocalDate(value.slice(0, 10)) : null}
      onSelectDate={(d) => {
        setPickerError(undefined);
        onChange(d ? localDateToIso(d) : '');
      }}
      formatDate={(d) => (d ? d.toLocaleDateString(LOCALES) : '')}
      parseDateFromString={parseDateInLocale}
      // Typing stays possible — it is also how an optional date is cleared.
      allowTextInput
      inlinePopup={inlinePopup}
      placeholder={DATE_PATTERN}
      disabled={disabled}
      firstDayOfWeek={FIRST_DAY}
      onValidationResult={(data) =>
        setPickerError(data.error ? `Enter a real date as ${DATE_PATTERN}` : undefined)
      }
    />
  ) : (
    <Input
      type={c.type === 'string' && c.format === 'email' ? 'email' : 'text'}
      value={value}
      maxLength={c.type === 'string' ? c.max : undefined}
      disabled={disabled}
      onChange={(_, d) => onChange(d.value)}
    />
  );

  return (
    <FluentField
      label={field.label}
      hint={shownError ? undefined : hintFor(field, value)}
      validationState={shownError ? 'error' : 'none'}
      validationMessage={shownError}
      required={!c.optional && c.type !== 'boolean'}
    >
      {control}
    </FluentField>
  );
}

/** "2024-02-01" → local midnight, so the calendar highlights the right day in every timezone. */
function isoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Local Date → the wire's ISO date, from local components — no UTC day-shift. */
export function localDateToIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parse what a person typed: ISO (yyyy-mm-dd) always works, and otherwise the
 * three numbers are read in the viewer's own order — dd/mm/yyyy in en-AU,
 * mm/dd/yyyy in en-US. Never JavaScript's own Date parser, which is US-biased
 * and lenient. Anything else is null, which the picker reports as invalid;
 * two-digit years are refused rather than guessed, like the validator does.
 */
export function parseDateInLocale(text: string): Date | null {
  const nums = text.trim().split(/\D+/).filter(Boolean).map(Number);
  if (nums.length !== 3) return null;
  const isoFirst = /^\d{4}/.test(text.trim());
  const y = isoFirst ? nums[0] : nums[DATE_ORDER.indexOf('year')];
  const m = isoFirst ? nums[1] : nums[DATE_ORDER.indexOf('month')];
  const d = isoFirst ? nums[2] : nums[DATE_ORDER.indexOf('day')];
  if (y < 1000) return null;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
    ? date
    : null;
}

/**
 * Describe the rule in words. Never print the regex — `@email()` compiles to
 * two hundred characters of pattern, which is noise to everyone and help to
 * nobody. The validator still enforces it, and its message names the field.
 */
function hintFor({ constraints: c }: FieldView, value: string): string | undefined {
  if (c.type === 'string') {
    // The input stops accepting characters at `max`, which is silent — a
    // pasted value is clipped with nothing to show for it. Say so, but only
    // once it bites: a limit nobody is near is the noise this hint avoids.
    if (c.max && value.length >= c.max) return `At the ${c.max}-character limit`;
    if (c.format === 'email') return 'Email address';
    if (c.min && c.max && c.min === c.max) return `${c.max} characters`;
    if (c.max && c.max <= 20) return `Up to ${c.max} characters`;
    return undefined; // A 200-character limit is not worth saying.
  }
  if (c.type === 'number') {
    if (c.min != null && c.max != null) return `${c.min}–${c.max}`;
    if (c.min != null) return `${c.min} or more`;
    if (c.max != null) return `Up to ${c.max}`;
  }
  return undefined;
}
