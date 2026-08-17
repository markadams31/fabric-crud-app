import { authenticated, boolean, entity, int, one, set, text, uuid } from '@microsoft/rayfin-core';

import { Audited, AUDIT_IMMUTABLE } from '@app/shared';
import { Currency } from './Currency.js';

/** ISO 3166 countries. Exercises: @set enum, @one relationship, optional int. */
@entity()
@authenticated(['read', 'create', 'delete'])
@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })
export class Country extends Audited() {
  @uuid() id!: string;
  @text({ min: 2, max: 2, unique: true, regex: /^[A-Z]{2}$/ }) code!: string;
  @text({ max: 200 }) name!: string;
  @set('Americas', 'Europe', 'Asia Pacific', 'Middle East', 'Africa')
  region!: 'Americas' | 'Europe' | 'Asia Pacific' | 'Middle East' | 'Africa';
  @int({ min: 0, optional: true }) population?: number;
  @boolean({ default: true }) isActive!: boolean;

  /** Declared because the form has to set it; Rayfin would generate it anyway. */
  @uuid() currency_id!: string;
  @one(() => Currency) currency?: Currency;
}
