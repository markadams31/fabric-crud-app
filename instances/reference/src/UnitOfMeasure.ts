import { authenticated, boolean, decimal, entity, set, text, uuid } from '@microsoft/rayfin-core';

import { Audited, AUDIT_IMMUTABLE } from '@app/shared';

/** Units and their conversion to a base unit. Exercises: @decimal, @set. */
@entity()
@authenticated(['read', 'create', 'delete'])
@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })
export class UnitOfMeasure extends Audited() {
  @uuid() id!: string;
  @text({ max: 10, unique: true }) code!: string;
  @text({ max: 100 }) name!: string;
  @set('Mass', 'Volume', 'Length', 'Time', 'Count')
  dimension!: 'Mass' | 'Volume' | 'Length' | 'Time' | 'Count';
  /**
   * How many base units one of these is.
   *
   * The scale is not decoration: `@decimal()` defaults to two places, which
   * stores a milligram, a millilitre and a millimetre all as 0.00 — silently,
   * on write. Nine places holds a pound (0.45359237) exactly and still leaves
   * room for a year in seconds.
   */
  @decimal({ min: 0, precision: 18, scale: 9 }) factorToBase!: number;
  @boolean({ default: false }) isBaseUnit!: boolean;
}
