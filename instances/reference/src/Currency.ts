import { authenticated, boolean, entity, int, text, uuid } from '@microsoft/rayfin-core';

import { Audited, AUDIT_IMMUTABLE } from '@app/shared';

/** ISO 4217 currencies. Exercises: pattern, exact-length text, int range, default. */
@entity()
@authenticated(['read', 'create', 'delete'])
@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })
export class Currency extends Audited() {
  @uuid() id!: string;
  @text({ min: 3, max: 3, unique: true, regex: /^[A-Z]{3}$/ }) code!: string;
  @text({ max: 100 }) name!: string;
  @text({ max: 5, optional: true }) symbol?: string;
  @int({ min: 0, max: 4, default: 2 }) decimalPlaces!: number;
  @boolean({ default: true }) isActive!: boolean;
}
