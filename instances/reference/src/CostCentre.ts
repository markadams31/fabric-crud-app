import { authenticated, date, decimal, email, entity, text, uuid } from '@microsoft/rayfin-core';

import { Audited, AUDIT_IMMUTABLE } from '@app/shared';

/** Finance cost centres. Exercises: @email, @date, optional date, optional decimal. */
@entity()
@authenticated(['read', 'create', 'delete'])
@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })
export class CostCentre extends Audited() {
  @uuid() id!: string;
  @text({ max: 10, unique: true, regex: /^CC[0-9]{4}$/ }) code!: string;
  @text({ max: 200 }) name!: string;
  @email({ max: 320 }) owner!: string;
  @date() openedOn!: Date;
  @date({ optional: true }) closedOn?: Date;
  /** Scale 2 is right for money — and explicit, so the silent-truncation
   *  default (see UnitOfMeasure.factorToBase) is a choice here, not a trap. */
  @decimal({ min: 0, optional: true, precision: 18, scale: 2 }) annualBudget?: number;
}
